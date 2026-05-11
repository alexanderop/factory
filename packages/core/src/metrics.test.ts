import { describe, it } from '@effect/vitest';
import { assertTrue, strictEqual } from '@effect/vitest/utils';
import { Cause, Effect, Exit, Metric, Ref } from 'effect';
import { runFactoryEffect } from './orchestrator.ts';
import {
	type DisplayEntry,
	makeTestLayer,
	OtelTestLayer,
	scriptedHarness,
} from './testing/index.ts';
import type { FactoryEvent, HarnessEvent } from './types.ts';

const findMetric = (
	pairs: ReadonlyArray<{
		readonly metricKey: {
			readonly name: string;
			readonly tags: ReadonlyArray<{ readonly key: string; readonly value: string }>;
		};
	}>,
	name: string,
	requiredTags: Readonly<Record<string, string>>,
) =>
	pairs.find((pair) => {
		if (pair.metricKey.name !== name) return false;
		for (const [k, v] of Object.entries(requiredTags)) {
			const matched = pair.metricKey.tags.some((t) => t.key === k && t.value === v);
			if (!matched) return false;
		}
		return true;
	});

describe('factory metrics', () => {
	it.effect('emits runs_total and run_duration_ms with pipeline + outcome tags', () =>
		Effect.gen(function* () {
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
			const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);

			const layer = makeTestLayer({
				displayRef,
				eventsRef,
				harnesses: [scriptedHarness('claude-code', [{ stdout: 'iter-1\n' }])],
				stepFiles: new Map([['./steps/only.md', '---\nname: only\n---\nDo it.']]),
			});

			yield* runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code' },
				[{ kind: 'step', id: 'only', source: './steps/only.md', options: {} }],
				{ prd: 'inline PRD text', cwd: process.cwd() },
			).pipe(Effect.provide(layer));

			const snapshot = yield* Metric.snapshot;

			const runsOk = findMetric(snapshot, 'factory.runs_total', {
				outcome: 'ok',
				pipeline: 'sdd',
			});
			assertTrue(runsOk !== undefined);

			const runDuration = findMetric(snapshot, 'factory.run_duration_ms', {
				outcome: 'ok',
				pipeline: 'sdd',
			});
			assertTrue(runDuration !== undefined);

			const stepsOk = findMetric(snapshot, 'factory.steps_total', {
				outcome: 'ok',
				step: 'only',
				harness: 'claude-code',
			});
			assertTrue(stepsOk !== undefined);

			const itersOk = findMetric(snapshot, 'factory.iters_total', {
				terminated_by: 'no-until',
				harness: 'claude-code',
			});
			assertTrue(itersOk !== undefined);
		}).pipe(Effect.provide(OtelTestLayer)),
	);

	it.effect('emits tool_calls_total + tool_call_duration_ms per tool', () =>
		Effect.gen(function* () {
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
			const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);

			const script: ReadonlyArray<HarnessEvent> = [
				{ type: 'tool.start', id: 't1', name: 'Bash', input: { command: 'ls' } },
				{ type: 'tool.end', id: 't1', ok: true, output: 'a\n' },
				{ type: 'tool.start', id: 't2', name: 'Read', input: { file_path: '/x' } },
				{ type: 'tool.end', id: 't2', ok: false, output: 'oops' },
				{
					type: 'result',
					ok: true,
					costUsd: 0.001,
					durationMs: 100,
					tokens: { input: 10, output: 5 },
					model: 'm',
				},
			];

			const layer = makeTestLayer({
				displayRef,
				eventsRef,
				harnesses: [scriptedHarness('claude-code', [{ events: script }])],
				stepFiles: new Map([['./steps/only.md', '---\nname: only\n---\nDo it.']]),
			});

			yield* runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code' },
				[{ kind: 'step', id: 'only', source: './steps/only.md', options: {} }],
				{ prd: 'inline PRD text', cwd: process.cwd() },
			).pipe(Effect.provide(layer));

			const snapshot = yield* Metric.snapshot;

			const bashOk = findMetric(snapshot, 'factory.tool_calls_total', {
				tool: 'Bash',
				ok: 'true',
			});
			assertTrue(bashOk !== undefined);

			const readFail = findMetric(snapshot, 'factory.tool_calls_total', {
				tool: 'Read',
				ok: 'false',
			});
			assertTrue(readFail !== undefined);

			const inputTokens = findMetric(snapshot, 'factory.tokens_total', {
				kind: 'input',
				model: 'm',
			});
			assertTrue(inputTokens !== undefined);

			const cost = findMetric(snapshot, 'factory.cost_micro_usd', { model: 'm' });
			assertTrue(cost !== undefined);
		}).pipe(Effect.provide(OtelTestLayer)),
	);

	it.effect('emits errors_total tagged with the FactoryError _tag on failure', () =>
		Effect.gen(function* () {
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
			const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);

			const layer = makeTestLayer({
				displayRef,
				eventsRef,
				harnesses: [scriptedHarness('claude-code', [{ stdout: 'nope\n' }])],
				stepFiles: new Map([
					[
						'./steps/ralph.md',
						`---\nname: ralph\nuntil: "output contains: DONE"\nmaxIters: 1\n---\nIterate.`,
					],
				]),
				verdicts: [false],
			});

			const exit = yield* Effect.exit(
				runFactoryEffect(
					{ name: 'sdd', harness: 'claude-code' },
					[{ kind: 'step', id: 'ralph', source: './steps/ralph.md', options: {} }],
					{ prd: 'inline PRD text', cwd: process.cwd() },
				).pipe(Effect.provide(layer)),
			);
			assertTrue(Exit.isFailure(exit));
			const failure = Cause.failureOption(exit.cause);
			assertTrue(failure._tag === 'Some');
			strictEqual(failure.value._tag, 'StepMaxItersError');

			const snapshot = yield* Metric.snapshot;
			const errorMetric = findMetric(snapshot, 'factory.errors_total', {
				tag: 'StepMaxItersError',
			});
			assertTrue(errorMetric !== undefined);

			const runsError = findMetric(snapshot, 'factory.runs_total', {
				outcome: 'error',
				pipeline: 'sdd',
			});
			assertTrue(runsError !== undefined);
		}).pipe(Effect.provide(OtelTestLayer)),
	);
});
