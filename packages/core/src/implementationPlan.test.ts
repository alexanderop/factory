import { readFileSync, writeFileSync } from 'node:fs';
import { FileSystem } from '@effect/platform';
import { NodeContext } from '@effect/platform-node';
import { describe, it } from '@effect/vitest';
import { assertTrue, deepStrictEqual, strictEqual } from '@effect/vitest/utils';
import { Effect, Layer, Ref } from 'effect';
import { runFactoryEffect } from './orchestrator.ts';
import { LiveRunWorkspace } from './services/RunWorkspace.ts';
import {
	cycledHarness,
	type DisplayEntry,
	harnessRegistryLayer,
	StepLoader,
	makeRunId,
	noopEventEmitter,
	scriptedHarness,
	scriptedUntilEvaluator,
	SilentDisplay,
} from './testing/index.ts';
import type { ExecOpts } from './types.ts';

describe('IMPLEMENTATION_PLAN.md slice ledger', () => {
	it.scoped('exposes FACTORY_RUN_DIR + FACTORY_PROJECT_PLAN to the harness', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const tmp = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-plan-env-' });
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
			const observed: ExecOpts[] = [];

			const stepsMap = new Map([['./steps/plan.md', '---\nname: plan\n---\nWrite plan.']]);

			const runId = makeRunId('plan-env-run');
			const harness = scriptedHarness('claude-code', [{ stdout: 'plan written\n' }], {
				onCall: (opts) => observed.push(opts),
			});

			const layer = Layer.mergeAll(
				SilentDisplay.layer(displayRef),
				noopEventEmitter.layer,
				harnessRegistryLayer([harness]),
				StepLoader.inMemory(stepsMap),
				scriptedUntilEvaluator.layer([true]),
				LiveRunWorkspace.layer({ runId, cwd: tmp }),
			).pipe(Layer.provideMerge(NodeContext.layer));

			yield* runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code', harnesses: [harness] },
				[{ kind: 'step', id: 'plan', source: './steps/plan.md', options: {} }],
				{ prd: 'PRD', cwd: tmp },
			).pipe(Effect.provide(layer));

			strictEqual(observed.length, 1);
			const env = observed[0]?.env ?? {};
			strictEqual(env.FACTORY_RUN_DIR, `${tmp}/.factory/runs/${runId}`);
			strictEqual(env.FACTORY_PROJECT_PLAN, `${tmp}/IMPLEMENTATION_PLAN.md`);
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('plan→ralph flow ticks off the first unchecked slice', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const tmp = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-plan-flow-' });
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);

			const stepsMap = new Map([
				['./steps/plan.md', '---\nname: plan\n---\nWrite plan.'],
				['./steps/ralph.md', '---\nname: ralph\n---\nImplement.'],
			]);

			const runId = makeRunId('plan-flow-run');
			let callIndex = 0;
			const harness = cycledHarness(
				'claude-code',
				[{ stdout: 'wrote plan' }, { stdout: 'shipped slice-1' }],
				{
					onCall: (opts) => {
						const planFile = opts.env?.FACTORY_PROJECT_PLAN;
						if (!planFile) return;
						if (callIndex === 0) {
							writeFileSync(
								planFile,
								`# Implementation plan\n\n- [ ] slice-1: ship A\n- [ ] slice-2: ship B\n`,
							);
						} else {
							const current = readFileSync(planFile, 'utf8');
							writeFileSync(
								planFile,
								current.replace('- [ ] slice-1: ship A', '- [x] slice-1: ship A — shipped'),
							);
						}
						callIndex++;
					},
				},
			);

			const layer = Layer.mergeAll(
				SilentDisplay.layer(displayRef),
				noopEventEmitter.layer,
				harnessRegistryLayer([harness]),
				StepLoader.inMemory(stepsMap),
				scriptedUntilEvaluator.layer([true, true]),
				LiveRunWorkspace.layer({ runId, cwd: tmp }),
			).pipe(Layer.provideMerge(NodeContext.layer));

			yield* runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code', harnesses: [harness] },
				[
					{ kind: 'step', id: 'plan', source: './steps/plan.md', options: {} },
					{ kind: 'step', id: 'ralph', source: './steps/ralph.md', options: {} },
				],
				{ prd: 'PRD', cwd: tmp },
			).pipe(Effect.provide(layer));

			const planPath = `${tmp}/IMPLEMENTATION_PLAN.md`;
			const final = yield* fs.readFileString(planPath);
			const lines = final.split('\n').filter((l) => l.length > 0);
			const slice1 = lines.find((l) => l.includes('slice-1'));
			const slice2 = lines.find((l) => l.includes('slice-2'));
			assertTrue(slice1?.startsWith('- [x]') ?? false);
			assertTrue(slice2?.startsWith('- [ ]') ?? false);
			deepStrictEqual(slice1, '- [x] slice-1: ship A — shipped');
		}).pipe(Effect.provide(NodeContext.layer)),
	);
});
