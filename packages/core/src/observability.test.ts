import { NodeContext } from '@effect/platform-node';
import { describe, it } from '@effect/vitest';
import { assertTrue, deepStrictEqual } from '@effect/vitest/utils';
import { Effect, Layer, Ref } from 'effect';
import { runFactoryEffect } from './orchestrator.ts';
import { RunId } from './ids.ts';
import { InMemoryRunWorkspace } from './services/RunWorkspace.ts';
import {
	type DisplayEntry,
	getFinishedSpans,
	harnessRegistryLayer,
	InMemoryStepLoader,
	OtelTestLayer,
	recordingEventEmitter,
	scriptedHarness,
	scriptedUntilEvaluator,
	SilentDisplay,
} from './testing/index.ts';
import type { FactoryEvent } from './types.ts';

describe('observability', () => {
	it.effect('emits the expected span tree for a single-iter run', () =>
		Effect.gen(function* () {
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
			const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);

			const layer = Layer.mergeAll(
				SilentDisplay.layer(displayRef),
				recordingEventEmitter.layer(eventsRef),
				harnessRegistryLayer([scriptedHarness('claude-code', [{ stdout: 'iter-1\n' }])]),
				InMemoryStepLoader.layer(new Map([['./steps/only.md', '---\nname: only\n---\nDo it.']])),
				scriptedUntilEvaluator.layer([true]),
				InMemoryRunWorkspace.layer({ runId: RunId.make('test-run') }),
			).pipe(Layer.provideMerge(NodeContext.layer));

			yield* runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code' },
				[{ id: 'only', source: './steps/only.md', options: {} }],
				{ prd: 'inline PRD text', cwd: process.cwd() },
			).pipe(Effect.provide(layer));

			const spans = yield* getFinishedSpans();
			const names = new Set(spans.map((s) => s.name));

			assertTrue(names.has('factory.run'));
			assertTrue(names.has('factory.step'));
			assertTrue(names.has('factory.iter'));
			assertTrue(names.has('factory.step.load'));

			const run = spans.find((s) => s.name === 'factory.run');
			assertTrue(run !== undefined);
			deepStrictEqual(run.attributes['factory.pipeline'], 'sdd');
			deepStrictEqual(run.attributes['factory.run.id'], 'test-run');

			const step = spans.find((s) => s.name === 'factory.step');
			assertTrue(step !== undefined);
			deepStrictEqual(step.attributes['factory.step'], 'only');
			deepStrictEqual(step.attributes['factory.harness'], 'claude-code');

			const iter = spans.find((s) => s.name === 'factory.iter');
			assertTrue(iter !== undefined);
			deepStrictEqual(iter.attributes['factory.iter'], 1);
			deepStrictEqual(iter.attributes['factory.iter.max'], 1);
		}).pipe(Effect.provide(OtelTestLayer)),
	);

	it.effect('annotates the step span with factory.error._tag on failure', () =>
		Effect.gen(function* () {
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
			const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);

			const layer = Layer.mergeAll(
				SilentDisplay.layer(displayRef),
				recordingEventEmitter.layer(eventsRef),
				harnessRegistryLayer([scriptedHarness('claude-code', [{ stdout: 'nope\n' }])]),
				InMemoryStepLoader.layer(
					new Map([
						[
							'./steps/ralph.md',
							`---\nname: ralph\nuntil: "output contains: DONE"\nmaxIters: 1\n---\nIterate.`,
						],
					]),
				),
				scriptedUntilEvaluator.layer([false]),
				InMemoryRunWorkspace.layer({ runId: RunId.make('test-run') }),
			).pipe(Layer.provideMerge(NodeContext.layer));

			yield* Effect.exit(
				runFactoryEffect(
					{ name: 'sdd', harness: 'claude-code' },
					[{ id: 'ralph', source: './steps/ralph.md', options: {} }],
					{ prd: 'inline PRD text', cwd: process.cwd() },
				).pipe(Effect.provide(layer)),
			);

			const spans = yield* getFinishedSpans();
			const step = spans.find((s) => s.name === 'factory.step');
			assertTrue(step !== undefined);
			deepStrictEqual(step.attributes['factory.error._tag'], 'StepMaxItersError');
		}).pipe(Effect.provide(OtelTestLayer)),
	);
});
