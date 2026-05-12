import { describe, it } from '@effect/vitest';
import { assertTrue, strictEqual } from '@effect/vitest/utils';
import { Effect, Exit } from 'effect';
import { afterEach, vi } from 'vitest';
import { withFriendlyErrors } from './error-handler.ts';
import { StepLoadError } from './errors.ts';
import { assertExitFailedWith, makeStepLoadError } from './testing/index.ts';

const spyConsoleError = () => vi.spyOn(console, 'error').mockImplementation(() => {});

describe('withFriendlyErrors', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.effect('logs a friendly summary for tagged errors and re-raises the original failure', () =>
		Effect.gen(function* () {
			const spy = spyConsoleError();

			const exit = yield* withFriendlyErrors(Effect.fail(makeStepLoadError())).pipe(Effect.exit);

			strictEqual(spy.mock.calls.length, 1);
			strictEqual(spy.mock.calls[0]?.[0], '✖ [StepLoadError] cannot read');
			assertExitFailedWith(exit, StepLoadError);
		}),
	);

	it.effect.each([
		{ name: 'plain Error', failure: new Error('boom'), expected: '✖ boom' },
		{ name: 'string', failure: 'oops', expected: '✖ oops' },
		{ name: 'number', failure: 42, expected: '✖ 42' },
	])('logs a friendly summary for $name failures', ({ failure, expected }) =>
		Effect.gen(function* () {
			const spy = spyConsoleError();

			yield* withFriendlyErrors(Effect.fail(failure)).pipe(Effect.exit);

			strictEqual(spy.mock.calls.length, 1);
			strictEqual(spy.mock.calls[0]?.[0], expected);
		}),
	);

	it.effect('does not log when the effect succeeds', () =>
		Effect.gen(function* () {
			const spy = spyConsoleError();

			const exit = yield* withFriendlyErrors(Effect.succeed('ok')).pipe(Effect.exit);

			strictEqual(spy.mock.calls.length, 0);
			assertTrue(Exit.isSuccess(exit));
		}),
	);
});
