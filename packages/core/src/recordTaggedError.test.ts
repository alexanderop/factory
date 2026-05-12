import { describe, it } from '@effect/vitest';
import { assertTrue, deepStrictEqual, strictEqual } from '@effect/vitest/utils';
import { Effect, Metric } from 'effect';
import { StepIdleTimeoutError } from './errors.ts';
import { idleTimeoutsTotal } from './metrics.ts';
import { recordTaggedError } from './observability.ts';
import {
	assertExitFailedWith,
	getFinishedSpans,
	makeStepIdleTimeoutError,
	makeStepMaxItersError,
	OtelTestLayer,
} from './testing/index.ts';

describe('recordTaggedError', () => {
	it.effect('annotates the active span with factory.error._tag and message', () =>
		Effect.gen(function* () {
			yield* Effect.fail(makeStepIdleTimeoutError()).pipe(
				recordTaggedError,
				Effect.withSpan('test.parent'),
				Effect.exit,
			);

			const spans = yield* getFinishedSpans();
			const parent = spans.find((s) => s.name === 'test.parent');
			assertTrue(parent !== undefined);
			deepStrictEqual(parent.attributes['factory.error._tag'], 'StepIdleTimeoutError');
			deepStrictEqual(parent.attributes['factory.error.message'], 'idle 60s');
		}).pipe(Effect.provide(OtelTestLayer)),
	);

	it.effect('does not increment idle counter for non-idle errors', () =>
		Effect.gen(function* () {
			const before = yield* Metric.value(idleTimeoutsTotal);

			yield* Effect.fail(makeStepMaxItersError()).pipe(
				recordTaggedError,
				Effect.withSpan('test.parent'),
				Effect.exit,
			);

			const spans = yield* getFinishedSpans();
			const parent = spans.find((s) => s.name === 'test.parent');
			assertTrue(parent !== undefined);
			deepStrictEqual(parent.attributes['factory.error._tag'], 'StepMaxItersError');

			const after = yield* Metric.value(idleTimeoutsTotal);
			strictEqual(after.count, before.count);
		}).pipe(Effect.provide(OtelTestLayer)),
	);

	it.effect('increments idle counter for StepIdleTimeoutError', () =>
		Effect.gen(function* () {
			const before = yield* Metric.value(idleTimeoutsTotal);

			yield* Effect.fail(makeStepIdleTimeoutError()).pipe(
				recordTaggedError,
				Effect.withSpan('test.parent'),
				Effect.exit,
			);

			const after = yield* Metric.value(idleTimeoutsTotal);
			strictEqual(after.count, before.count + 1);
		}).pipe(Effect.provide(OtelTestLayer)),
	);

	it.effect('re-fails the original error untouched', () =>
		Effect.gen(function* () {
			const original = makeStepIdleTimeoutError();

			const exit = yield* Effect.fail(original).pipe(
				recordTaggedError,
				Effect.withSpan('test.parent'),
				Effect.exit,
			);

			const out = assertExitFailedWith(exit, StepIdleTimeoutError);
			strictEqual(out.message, original.message);
			strictEqual(out.step, original.step);
			strictEqual(out.timeoutMs, original.timeoutMs);
		}).pipe(Effect.provide(OtelTestLayer)),
	);
});
