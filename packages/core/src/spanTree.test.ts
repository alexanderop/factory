import { NodeContext } from '@effect/platform-node';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { describe, it } from '@effect/vitest';
import { assertTrue, deepStrictEqual, strictEqual } from '@effect/vitest/utils';
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

const childrenOf = (
	spans: ReadonlyArray<ReadableSpan>,
	parent: ReadableSpan,
): ReadonlyArray<ReadableSpan> => {
	const parentSpanId = parent.spanContext().spanId;
	return spans.filter((s) => s.parentSpanContext?.spanId === parentSpanId);
};

describe('span tree', () => {
	it.effect('factory.run has factory.step <id> children, each with load + run', () =>
		Effect.gen(function* () {
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
			const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);

			const layer = Layer.mergeAll(
				SilentDisplay.layer(displayRef),
				recordingEventEmitter.layer(eventsRef),
				harnessRegistryLayer([
					scriptedHarness('claude-code', [
						{ stdout: 'plan-out\n' },
						{ stdout: 'branch-out\n' },
						{ stdout: 'ralph-out\n' },
					]),
				]),
				InMemoryStepLoader.layer(
					new Map([
						['./steps/plan.md', '---\nname: plan\n---\nPlan it.'],
						['./steps/branch.md', '---\nname: branch\n---\nBranch it.'],
						['./steps/ralph.md', '---\nname: ralph\n---\nRalph it.'],
					]),
				),
				scriptedUntilEvaluator.layer([true, true, true]),
				InMemoryRunWorkspace.layer({ runId: RunId.make('test-run') }),
			).pipe(Layer.provideMerge(NodeContext.layer));

			yield* runFactoryEffect(
				{ name: 'effect-review', harness: 'claude-code' },
				[
					{ id: '00-plan', source: './steps/plan.md', options: {} },
					{ id: '01-branch', source: './steps/branch.md', options: {} },
					{ id: '02-ralph', source: './steps/ralph.md', options: {} },
				],
				{ prd: 'inline PRD text', cwd: process.cwd(), permissions: 'skip' },
			).pipe(Effect.provide(layer));

			const spans = yield* getFinishedSpans();

			const run = spans.find((s) => s.name === 'factory.run effect-review');
			assertTrue(run !== undefined);

			const stepPhases = childrenOf(spans, run).filter((s) => s.name.startsWith('factory.step '));
			strictEqual(stepPhases.length, 3);
			deepStrictEqual(stepPhases.map((s) => s.name).toSorted(), [
				'factory.step 00-plan',
				'factory.step 01-branch',
				'factory.step 02-ralph',
			]);

			for (const phase of stepPhases) {
				const stepId = phase.name.slice('factory.step '.length);
				const children = childrenOf(spans, phase);
				const childNames = new Set(children.map((s) => s.name));
				assertTrue(
					childNames.has(`factory.step.load ${stepId}`),
					`phase ${phase.name} missing factory.step.load ${stepId} child`,
				);
				assertTrue(
					childNames.has(`factory.step.run ${stepId}`),
					`phase ${phase.name} missing factory.step.run ${stepId} child`,
				);
			}
		}).pipe(Effect.provide(OtelTestLayer)),
	);

	it.effect('iter span names embed step id and iter index for a 3-iter ralph step', () =>
		Effect.gen(function* () {
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
			const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);

			const layer = Layer.mergeAll(
				SilentDisplay.layer(displayRef),
				recordingEventEmitter.layer(eventsRef),
				harnessRegistryLayer([
					scriptedHarness('claude-code', [
						{ stdout: 'iter-1\n' },
						{ stdout: 'iter-2\n' },
						{ stdout: 'iter-3\n' },
					]),
				]),
				InMemoryStepLoader.layer(
					new Map([
						[
							'./steps/ralph.md',
							`---\nname: ralph\nuntil: "output contains: DONE"\nmaxIters: 3\n---\nIterate.`,
						],
					]),
				),
				scriptedUntilEvaluator.layer([false, false, true]),
				InMemoryRunWorkspace.layer({ runId: RunId.make('test-run') }),
			).pipe(Layer.provideMerge(NodeContext.layer));

			yield* runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code' },
				[{ id: '02-ralph', source: './steps/ralph.md', options: {} }],
				{ prd: 'inline PRD text', cwd: process.cwd(), permissions: 'skip' },
			).pipe(Effect.provide(layer));

			const spans = yield* getFinishedSpans();
			const iterNames = spans
				.map((s) => s.name)
				.filter((n) => n.startsWith('factory.iter '))
				.toSorted();
			deepStrictEqual(iterNames, [
				'factory.iter 02-ralph#1',
				'factory.iter 02-ralph#2',
				'factory.iter 02-ralph#3',
			]);

			const untilNames = spans
				.map((s) => s.name)
				.filter((n) => n.startsWith('factory.until.eval '))
				.toSorted();
			deepStrictEqual(untilNames, [
				'factory.until.eval 02-ralph#1',
				'factory.until.eval 02-ralph#2',
				'factory.until.eval 02-ralph#3',
			]);
		}).pipe(Effect.provide(OtelTestLayer)),
	);
});
