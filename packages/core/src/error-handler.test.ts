import { describe, expect, it } from 'vitest';
import { formatErrorMessage } from './error-handler.ts';
import {
	makeConfigLoadError,
	makeHarnessExecError,
	makeHarnessNotFoundError,
	makeHarnessSpawnError,
	makeMissingHarnessError,
	makePrdLoadError,
	makeStepIdleTimeoutError,
	makeStepLoadError,
	makeStepMaxItersError,
	makeUntilEvalError,
} from './testing/index.ts';

describe('formatErrorMessage', () => {
	const cases = [
		makeStepLoadError(),
		makeHarnessNotFoundError({ message: 'unknown harness foo' }),
		makeHarnessExecError(),
		makeHarnessSpawnError(),
		makeStepIdleTimeoutError(),
		makeStepMaxItersError(),
		makeUntilEvalError(),
		makeMissingHarnessError(),
		makePrdLoadError(),
		makeConfigLoadError(),
	];

	it.each(cases.map((e) => [e._tag, e] as const))(
		'renders %s with the [tag] message format',
		(tag, error) => {
			const out = formatErrorMessage(error);
			expect(out).toContain(`[${tag}]`);
			expect(out).toContain(error.message);
		},
	);

	it('falls back gracefully for plain Errors', () => {
		expect(formatErrorMessage(new Error('boom'))).toBe('boom');
	});

	it('stringifies arbitrary values', () => {
		expect(formatErrorMessage('oops')).toBe('oops');
		expect(formatErrorMessage(42)).toBe('42');
	});
});
