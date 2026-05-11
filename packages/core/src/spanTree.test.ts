import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { describe, it } from '@effect/vitest';
import { assertTrue, deepStrictEqual, strictEqual } from '@effect/vitest/utils';
import { Effect } from 'effect';
import { runFactoryEffect } from './orchestrator.ts';
import { cycledHarness, getFinishedSpans, makeTestRig, OtelTestLayer } from './testing/index.ts';

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
			const { layer } = makeTestRig({
				harnesses: [
					cycledHarness('claude-code', [
						{ stdout: 'plan-out\n' },
						{ stdout: 'branch-out\n' },
						{ stdout: 'ralph-out\n' },
					]),
				],
				stepFiles: new Map([
					['./steps/plan.md', '---\nname: plan\n---\nPlan it.'],
					['./steps/branch.md', '---\nname: branch\n---\nBranch it.'],
					['./steps/ralph.md', '---\nname: ralph\n---\nRalph it.'],
				]),
				verdicts: [true, true, true],
			});

			yield* runFactoryEffect(
				{ name: 'effect-review', harness: 'claude-code' },
				[
					{ kind: 'step', id: '00-plan', source: './steps/plan.md', options: {} },
					{ kind: 'step', id: '01-branch', source: './steps/branch.md', options: {} },
					{ kind: 'step', id: '02-ralph', source: './steps/ralph.md', options: {} },
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
			const { layer } = makeTestRig({
				harnesses: [
					cycledHarness('claude-code', [
						{ stdout: 'iter-1\n' },
						{ stdout: 'iter-2\n' },
						{ stdout: 'iter-3\n' },
					]),
				],
				stepFiles: new Map([
					[
						'./steps/ralph.md',
						`---\nname: ralph\nuntil: "output contains: DONE"\nmaxIters: 3\n---\nIterate.`,
					],
				]),
				verdicts: [false, false, true],
			});

			yield* runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code' },
				[{ kind: 'step', id: '02-ralph', source: './steps/ralph.md', options: {} }],
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
