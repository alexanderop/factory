import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Reactivity from '@effect/experimental/Reactivity';
import { FileSystem } from '@effect/platform';
import { NodeContext } from '@effect/platform-node';
import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient';
import { SqlClient } from '@effect/sql/SqlClient';
import * as SqlSchema from '@effect/sql/SqlSchema';
import { Effect, Layer, Ref, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { RunId } from './ids.ts';
import { runFactoryEffect } from './orchestrator.ts';
import { LiveRunWorkspace } from './services/RunWorkspace.ts';
import {
	type DisplayEntry,
	harnessRegistryLayer,
	InMemoryStepLoader,
	noopEventEmitter,
	scriptedHarness,
	scriptedUntilEvaluator,
	SilentDisplay,
} from './testing/index.ts';

const RunRow = Schema.Struct({
	id: Schema.String,
	pipeline: Schema.String,
	status: Schema.String,
	default_harness: Schema.NullOr(Schema.String),
	cwd: Schema.String,
	prd_source: Schema.String,
	started_at: Schema.Number,
	ended_at: Schema.NullOr(Schema.Number),
});

const StepRow = Schema.Struct({
	run_id: Schema.String,
	ord: Schema.Number,
	step_id: Schema.String,
	source: Schema.String,
	harness: Schema.String,
	until_pred: Schema.NullOr(Schema.String),
	max_iters: Schema.Number,
	status: Schema.String,
});

const EventRow = Schema.Struct({
	seq: Schema.Number,
	type: Schema.String,
	step_id: Schema.NullOr(Schema.String),
	iter: Schema.NullOr(Schema.Number),
});

const IterRow = Schema.Struct({
	run_id: Schema.String,
	step_ord: Schema.Number,
	n: Schema.Number,
	started_at: Schema.Number,
	ended_at: Schema.NullOr(Schema.Number),
	exit_code: Schema.NullOr(Schema.Number),
});

const readDb = (dbPath: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient;
		const findRuns = SqlSchema.findAll({
			Request: Schema.Void,
			Result: RunRow,
			execute: () => sql`SELECT * FROM run`,
		});
		const findSteps = SqlSchema.findAll({
			Request: Schema.Void,
			Result: StepRow,
			execute: () => sql`SELECT * FROM step ORDER BY ord`,
		});
		const findEvents = SqlSchema.findAll({
			Request: Schema.Void,
			Result: EventRow,
			execute: () => sql`SELECT seq, type, step_id, iter FROM event ORDER BY seq`,
		});
		const findIters = SqlSchema.findAll({
			Request: Schema.Void,
			Result: IterRow,
			execute: () => sql`SELECT * FROM iter ORDER BY step_ord, n`,
		});
		const runs = yield* findRuns();
		const steps = yield* findSteps();
		const events = yield* findEvents();
		const iters = yield* findIters();
		return { runs, steps, events, iters };
	}).pipe(
		Effect.provide(SqliteClient.layer({ filename: dbPath, readonly: true })),
		Effect.provide(Reactivity.layer),
	);

const fsRead = (p: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return yield* fs.readFileString(p);
	}).pipe(Effect.provide(NodeContext.layer));

describe('runWorkspace integration (Slice 1)', () => {
	it('writes run/step/event rows + prd.md and step.md to disk', async () => {
		const tmp = mkdtempSync(join(tmpdir(), 'factory-run-'));
		const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);

		const planMd = '---\nname: plan\n---\nWrite a plan.';
		const ralphMd = '---\nname: ralph\n---\nIterate.';
		const stepsMap = new Map([
			['./steps/plan.md', planMd],
			['./steps/ralph.md', ralphMd],
		]);

		const runId = RunId.make('integration-test-run');

		const fakeHarness = scriptedHarness('claude-code', [
			{ stdout: 'iter-1\n' },
			{ stdout: 'iter-2\n' },
		]);

		const layer = Layer.mergeAll(
			SilentDisplay.layer(displayRef),
			noopEventEmitter.layer,
			harnessRegistryLayer([fakeHarness]),
			InMemoryStepLoader.layer(stepsMap),
			scriptedUntilEvaluator.layer([true]),
			LiveRunWorkspace.layer({ runId, cwd: tmp }),
		).pipe(Layer.provideMerge(NodeContext.layer));

		await Effect.runPromise(
			runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code', harnesses: [fakeHarness] },
				[
					{ id: 'plan', source: './steps/plan.md', options: {} },
					{ id: 'ralph', source: './steps/ralph.md', options: {} },
				],
				{ prd: 'inline PRD text', cwd: tmp },
			).pipe(Effect.provide(layer)),
		);

		const runDir = join(tmp, '.factory', 'runs', runId);
		const dbPath = join(runDir, 'run.db');

		const prd = await Effect.runPromise(fsRead(join(runDir, 'prd.md')));
		expect(prd).toBe('inline PRD text');

		const planStepMd = await Effect.runPromise(fsRead(join(runDir, 'steps', '00-plan', 'step.md')));
		expect(planStepMd).toBe(planMd);

		const ralphStepMd = await Effect.runPromise(
			fsRead(join(runDir, 'steps', '01-ralph', 'step.md')),
		);
		expect(ralphStepMd).toBe(ralphMd);

		const { runs, steps, events, iters } = await Effect.runPromise(readDb(dbPath));

		expect(runs).toHaveLength(1);
		expect(runs[0]?.id).toBe(runId);
		expect(runs[0]?.pipeline).toBe('sdd');
		expect(runs[0]?.status).toBe('ok');
		expect(runs[0]?.default_harness).toBe('claude-code');
		expect(runs[0]?.cwd).toBe(tmp);
		expect(runs[0]?.prd_source).toBe('inline PRD text');
		expect(runs[0]?.ended_at).toBeGreaterThanOrEqual(runs[0]?.started_at ?? 0);

		expect(steps).toHaveLength(2);
		expect(steps.map((s) => [s.ord, s.step_id, s.status])).toEqual([
			[0, 'plan', 'ok'],
			[1, 'ralph', 'ok'],
		]);
		expect(steps[0]?.harness).toBe('claude-code');
		expect(steps[0]?.max_iters).toBe(1);

		expect(iters).toHaveLength(2);
		expect(iters.every((i) => i.exit_code === 0)).toBe(true);

		const eventTypes = events.map((e) => e.type);
		expect(eventTypes[0]).toBe('run.start');
		expect(eventTypes).toContain('step.start');
		expect(eventTypes).toContain('step.end');
		expect(eventTypes[eventTypes.length - 1]).toBe('run.end');
	});

	it('streams stdout/stderr to per-iter log files and forwards to display', async () => {
		const tmp = mkdtempSync(join(tmpdir(), 'factory-stream-'));
		const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);

		const stepsMap = new Map([
			[
				'./steps/ralph.md',
				'---\nname: ralph\nuntil: "output contains: DONE"\nmaxIters: 2\n---\nIterate.',
			],
		]);

		const runId = RunId.make('stream-test-run');

		const fiveLines = 'a\nb\nc\nd\ne\n';
		const harness = scriptedHarness('claude-code', [
			{ stdout: fiveLines, stderr: 'oops\n' },
			{ stdout: 'DONE\n' },
		]);

		const layer = Layer.mergeAll(
			SilentDisplay.layer(displayRef),
			noopEventEmitter.layer,
			harnessRegistryLayer([harness]),
			InMemoryStepLoader.layer(stepsMap),
			scriptedUntilEvaluator.layer([false, true]),
			LiveRunWorkspace.layer({ runId, cwd: tmp }),
		).pipe(Layer.provideMerge(NodeContext.layer));

		await Effect.runPromise(
			runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code', harnesses: [harness] },
				[{ id: 'ralph', source: './steps/ralph.md', options: {} }],
				{ prd: 'inline PRD', cwd: tmp },
			).pipe(Effect.provide(layer)),
		);

		const runDir = join(tmp, '.factory', 'runs', runId);
		const dbPath = join(runDir, 'run.db');

		const stdout1 = await Effect.runPromise(
			fsRead(join(runDir, 'steps', '00-ralph', 'iters', '001', 'stdout.log')),
		);
		expect(stdout1).toBe(fiveLines);
		const stderr1 = await Effect.runPromise(
			fsRead(join(runDir, 'steps', '00-ralph', 'iters', '001', 'stderr.log')),
		);
		expect(stderr1).toBe('oops\n');

		const prompt1 = await Effect.runPromise(
			fsRead(join(runDir, 'steps', '00-ralph', 'iters', '001', 'prompt.md')),
		);
		expect(prompt1).toContain('# PRD');
		expect(prompt1).toContain('# Step');

		const stdout2 = await Effect.runPromise(
			fsRead(join(runDir, 'steps', '00-ralph', 'iters', '002', 'stdout.log')),
		);
		expect(stdout2).toBe('DONE\n');

		const display = await Effect.runPromise(Ref.get(displayRef));
		const harnessLines = display.filter(
			(d): d is Extract<DisplayEntry, { _tag: 'harnessLine' }> => d._tag === 'harnessLine',
		);
		expect(harnessLines).toHaveLength(7);
		const stdoutLines = harnessLines.filter((d) => d.stream === 'stdout');
		expect(stdoutLines.map((d) => d.line)).toEqual(['a', 'b', 'c', 'd', 'e', 'DONE']);

		const { iters } = await Effect.runPromise(readDb(dbPath));
		expect(iters).toHaveLength(2);
		expect(iters[0]?.n).toBe(1);
		expect(iters[0]?.ended_at).toBeGreaterThanOrEqual(iters[0]?.started_at ?? 0);
		expect(iters[1]?.n).toBe(2);
		expect(iters[1]?.exit_code).toBe(0);
	});
});
