import { strictEqual } from '@effect/vitest/utils';
import { describe, it } from 'vitest';
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
		[makeStepLoadError(), '[StepLoadError] cannot read'],
		[
			makeHarnessNotFoundError({ message: 'unknown harness foo' }),
			'[HarnessNotFoundError] unknown harness foo',
		],
		[makeHarnessExecError(), '[HarnessExecError] exit 1'],
		[makeHarnessSpawnError(), '[HarnessSpawnError] ENOENT'],
		[makeStepIdleTimeoutError(), '[StepIdleTimeoutError] idle 60s'],
		[makeStepMaxItersError(), '[StepMaxItersError] gave up'],
		[makeUntilEvalError(), '[UntilEvalError] pnpm test failed'],
		[makeMissingHarnessError(), '[MissingHarnessError] no harness'],
		[makePrdLoadError(), '[PrdLoadError] cannot read PRD'],
		[makeConfigLoadError(), '[ConfigLoadError] no config'],
	] as const;

	it.each(cases.map(([error, expected]) => [error._tag, error, expected] as const))(
		'renders %s as `[tag] message`',
		(_tag, error, expected) => {
			strictEqual(formatErrorMessage(error), expected);
		},
	);

	it('falls back gracefully for plain Errors', () => {
		strictEqual(formatErrorMessage(new Error('boom')), 'boom');
	});

	it('stringifies arbitrary values', () => {
		strictEqual(formatErrorMessage('oops'), 'oops');
		strictEqual(formatErrorMessage(42), '42');
	});
});
