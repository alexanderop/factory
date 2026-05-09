import * as Reactivity from '@effect/experimental/Reactivity';
import { FileSystem } from '@effect/platform';
import { NodeContext } from '@effect/platform-node';
import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient';
import { SqlClient } from '@effect/sql/SqlClient';
import * as SqlSchema from '@effect/sql/SqlSchema';
import { describe, it } from '@effect/vitest';
import { assertTrue, deepStrictEqual, strictEqual } from '@effect/vitest/utils';
import { Effect, Layer, Ref, Schema } from 'effect';
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

describe('runWorkspace integration (Slice 1)', () => {
	it.scoped('writes run/step/event rows + prd.md and step.md to disk', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const tmp = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-run-' });
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);

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

			yield* runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code', harnesses: [fakeHarness] },
				[
					{ id: 'plan', source: './steps/plan.md', options: {} },
					{ id: 'ralph', source: './steps/ralph.md', options: {} },
				],
				{ prd: 'inline PRD text', cwd: tmp },
			).pipe(Effect.provide(layer));

			const runDir = `${tmp}/.factory/runs/${runId}`;
			const dbPath = `${runDir}/run.db`;

			const prd = yield* fs.readFileString(`${runDir}/prd.md`);
			strictEqual(prd, 'inline PRD text');

			const planStepMd = yield* fs.readFileString(`${runDir}/steps/00-plan/step.md`);
			strictEqual(planStepMd, planMd);

			const ralphStepMd = yield* fs.readFileString(`${runDir}/steps/01-ralph/step.md`);
			strictEqual(ralphStepMd, ralphMd);

			const { runs, steps, events, iters } = yield* readDb(dbPath);

			strictEqual(runs.length, 1);
			strictEqual(runs[0]?.id, runId);
			strictEqual(runs[0]?.pipeline, 'sdd');
			strictEqual(runs[0]?.status, 'ok');
			strictEqual(runs[0]?.default_harness, 'claude-code');
			strictEqual(runs[0]?.cwd, tmp);
			strictEqual(runs[0]?.prd_source, 'inline PRD text');
			assertTrue((runs[0]?.ended_at ?? 0) >= (runs[0]?.started_at ?? 0));

			strictEqual(steps.length, 2);
			deepStrictEqual(
				steps.map((s) => [s.ord, s.step_id, s.status]),
				[
					[0, 'plan', 'ok'],
					[1, 'ralph', 'ok'],
				],
			);
			strictEqual(steps[0]?.harness, 'claude-code');
			strictEqual(steps[0]?.max_iters, 1);

			strictEqual(iters.length, 2);
			assertTrue(iters.every((i) => i.exit_code === 0));

			const eventTypes = events.map((e) => e.type);
			strictEqual(eventTypes[0], 'run.start');
			assertTrue(eventTypes.includes('step.start'));
			assertTrue(eventTypes.includes('step.end'));
			strictEqual(eventTypes[eventTypes.length - 1], 'run.end');
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('streams stdout/stderr to per-iter log files and forwards to display', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const tmp = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-stream-' });
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);

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

			yield* runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code', harnesses: [harness] },
				[{ id: 'ralph', source: './steps/ralph.md', options: {} }],
				{ prd: 'inline PRD', cwd: tmp },
			).pipe(Effect.provide(layer));

			const runDir = `${tmp}/.factory/runs/${runId}`;
			const dbPath = `${runDir}/run.db`;

			const stdout1 = yield* fs.readFileString(`${runDir}/steps/00-ralph/iters/001/stdout.log`);
			strictEqual(stdout1, fiveLines);
			const stderr1 = yield* fs.readFileString(`${runDir}/steps/00-ralph/iters/001/stderr.log`);
			strictEqual(stderr1, 'oops\n');

			const prompt1 = yield* fs.readFileString(`${runDir}/steps/00-ralph/iters/001/prompt.md`);
			assertTrue(prompt1.includes('# PRD'));
			assertTrue(prompt1.includes('# Step'));

			const stdout2 = yield* fs.readFileString(`${runDir}/steps/00-ralph/iters/002/stdout.log`);
			strictEqual(stdout2, 'DONE\n');

			const display = yield* Ref.get(displayRef);
			const harnessLines = display.filter(
				(d): d is Extract<DisplayEntry, { _tag: 'harnessLine' }> => d._tag === 'harnessLine',
			);
			strictEqual(harnessLines.length, 7);
			const stdoutLines = harnessLines.filter((d) => d.stream === 'stdout');
			deepStrictEqual(
				stdoutLines.map((d) => d.line),
				['a', 'b', 'c', 'd', 'e', 'DONE'],
			);

			const { iters } = yield* readDb(dbPath);
			strictEqual(iters.length, 2);
			strictEqual(iters[0]?.n, 1);
			assertTrue((iters[0]?.ended_at ?? 0) >= (iters[0]?.started_at ?? 0));
			strictEqual(iters[1]?.n, 2);
			strictEqual(iters[1]?.exit_code, 0);
		}).pipe(Effect.provide(NodeContext.layer)),
	);
});
