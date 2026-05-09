import { describe, expect, it } from 'vitest';
import {
	ConfigLoadError,
	HarnessExecError,
	HarnessNotFoundError,
	HarnessSpawnError,
	MissingHarnessError,
	PrdLoadError,
	StepIdleTimeoutError,
	StepLoadError,
	StepMaxItersError,
	UntilEvalError,
} from './errors.ts';
import { formatErrorMessage } from './error-handler.ts';

describe('formatErrorMessage', () => {
	const cases = [
		new StepLoadError({ message: 'cannot read', path: '/x.md' }),
		new HarnessNotFoundError({
			message: 'unknown harness foo',
			harness: 'foo',
			available: ['claude-code'],
		}),
		new HarnessExecError({
			message: 'exit 1',
			harness: 'claude-code',
			exitCode: 1,
			stderr: '',
		}),
		new HarnessSpawnError({
			message: 'ENOENT',
			harness: 'claude-code',
			bin: 'claude',
		}),
		new StepIdleTimeoutError({
			message: 'idle 60s',
			step: 'ralph',
			timeoutMs: 60_000,
		}),
		new StepMaxItersError({
			message: 'gave up',
			step: 'ralph',
			maxIters: 10,
		}),
		new UntilEvalError({ message: 'pnpm test failed', step: 'ralph', until: 'tests pass' }),
		new MissingHarnessError({ message: 'no harness', step: 'plan' }),
		new PrdLoadError({ message: 'cannot read PRD', path: '/feature.md' }),
		new ConfigLoadError({ message: 'no config', cwd: '/repo' }),
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
