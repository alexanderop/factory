import { FileSystem, Path } from '@effect/platform';
import { NodeContext } from '@effect/platform-node';
import { describe, it } from '@effect/vitest';
import { assertTrue, deepStrictEqual, strictEqual } from '@effect/vitest/utils';
import { Effect, Layer, Predicate, Ref, Schema } from 'effect';
import { RunId } from './ids.ts';
import { runFactoryEffect } from './orchestrator.ts';
import { decodeRun, decodeStep, IterRecord } from './services/runManifest.ts';
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

const decodeIterRecord = Schema.decodeUnknown(IterRecord);

const listTreeRelative = (
	root: string,
): Effect.Effect<ReadonlyArray<string>, unknown, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const out: string[] = [];
		const walk = (dir: string): Effect.Effect<void, unknown> =>
			Effect.gen(function* () {
				const entries = yield* fs.readDirectory(dir);
				for (const name of entries) {
					const full = path.join(dir, name);
					const stat = yield* fs.stat(full);
					if (stat.type === 'Directory') {
						yield* walk(full);
					} else {
						out.push(path.relative(root, full));
					}
				}
			});
		yield* walk(root);
		return out.toSorted();
	});

describe('runWorkspace integration (file-only manifests)', () => {
	it.scoped('writes the canonical run directory layout', () =>
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

			const prd = yield* fs.readFileString(`${runDir}/prd.md`);
			strictEqual(prd, 'inline PRD text');

			const planStepMd = yield* fs.readFileString(`${runDir}/steps/00-plan/step.md`);
			strictEqual(planStepMd, planMd);

			const ralphStepMd = yield* fs.readFileString(`${runDir}/steps/01-ralph/step.md`);
			strictEqual(ralphStepMd, ralphMd);

			const tree = yield* listTreeRelative(runDir);
			// The scripted harness emits only stdout/stderr/exit, so per-iter
			// events.jsonl is never created. It would appear once the harness
			// streams a tool.* / assistant.message / result event.
			deepStrictEqual(tree, [
				'events.jsonl',
				'prd.md',
				'run.json',
				'steps/00-plan/iters/001/prompt.md',
				'steps/00-plan/iters/001/stdout.log',
				'steps/00-plan/iters/001/summary.json',
				'steps/00-plan/step.json',
				'steps/00-plan/step.md',
				'steps/01-ralph/iters/001/prompt.md',
				'steps/01-ralph/iters/001/stdout.log',
				'steps/01-ralph/iters/001/summary.json',
				'steps/01-ralph/step.json',
				'steps/01-ralph/step.md',
			]);

			const run = yield* decodeRun(yield* fs.readFileString(`${runDir}/run.json`));
			strictEqual(run.id, runId);
			strictEqual(run.pipeline, 'sdd');
			strictEqual(run.status, 'ok');
			strictEqual(run.defaultHarness, 'claude-code');
			strictEqual(run.cwd, tmp);
			strictEqual(run.prdSource, 'inline PRD text');
			assertTrue((run.endedAt ?? 0) >= run.startedAt);

			const planStep = yield* decodeStep(
				yield* fs.readFileString(`${runDir}/steps/00-plan/step.json`),
			);
			strictEqual(planStep.ord, 0);
			strictEqual(planStep.stepId, 'plan');
			strictEqual(planStep.status, 'ok');
			strictEqual(planStep.harness, 'claude-code');
			strictEqual(planStep.maxIters, 1);
			strictEqual(planStep.iters.length, 1);
			strictEqual(planStep.iters[0]?.exitCode, 0);

			const ralphStep = yield* decodeStep(
				yield* fs.readFileString(`${runDir}/steps/01-ralph/step.json`),
			);
			strictEqual(ralphStep.ord, 1);
			strictEqual(ralphStep.status, 'ok');

			const eventLines = (yield* fs.readFileString(`${runDir}/events.jsonl`))
				.split('\n')
				.filter((l) => l.length > 0);
			const eventTypes = eventLines.map((line) => {
				const parsed: unknown = JSON.parse(line);
				if (Predicate.isRecord(parsed) && typeof parsed.type === 'string') {
					return parsed.type;
				}
				return '';
			});
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

			const step = yield* decodeStep(
				yield* fs.readFileString(`${runDir}/steps/00-ralph/step.json`),
			);
			strictEqual(step.iters.length, 2);
			strictEqual(step.iters[0]?.n, 1);
			assertTrue((step.iters[0]?.endedAt ?? 0) >= (step.iters[0]?.startedAt ?? 0));
			strictEqual(step.iters[1]?.n, 2);
			strictEqual(step.iters[1]?.exitCode, 0);

			const summaryRaw: unknown = JSON.parse(
				yield* fs.readFileString(`${runDir}/steps/00-ralph/iters/002/summary.json`),
			);
			const summary = yield* decodeIterRecord(summaryRaw);
			strictEqual(summary.n, 2);
			strictEqual(summary.untilPassed, true);
		}).pipe(Effect.provide(NodeContext.layer)),
	);
});
