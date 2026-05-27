import { describe, expect, it } from 'vitest';
import { ALLOW, mergeDecisions } from './decision.ts';

describe('mergeDecisions', () => {
	it('empty list collapses to allow', () => {
		expect(mergeDecisions([])).toEqual(ALLOW);
	});

	it('single allow passes through', () => {
		expect(mergeDecisions([ALLOW])).toEqual(ALLOW);
	});

	it('deny short-circuits — anything after a deny is ignored', () => {
		const result = mergeDecisions([
			ALLOW,
			{ action: 'deny', reason: 'first denial' },
			{ action: 'deny', reason: 'should not appear' },
			{ action: 'allow', additionalContext: 'unreachable' },
		]);
		expect(result).toEqual({ action: 'deny', reason: 'first denial' });
	});

	it('ask beats allow when no deny is present', () => {
		const result = mergeDecisions([ALLOW, { action: 'ask', reason: 'needs confirmation' }, ALLOW]);
		expect(result).toEqual({ action: 'ask', reason: 'needs confirmation' });
	});

	it('additionalContext strings concatenate with double newline', () => {
		const result = mergeDecisions([
			{ action: 'allow', additionalContext: 'env=prod' },
			{ action: 'allow', additionalContext: 'branch=main' },
		]);
		expect(result).toEqual({
			action: 'allow',
			additionalContext: 'env=prod\n\nbranch=main',
		});
	});

	it('updatedInput is last-writer-wins', () => {
		const result = mergeDecisions([
			{ action: 'allow', updatedInput: { command: 'echo a' } },
			{ action: 'allow', updatedInput: { command: 'echo b' } },
		]);
		expect(result).toEqual({
			action: 'allow',
			updatedInput: { command: 'echo b' },
		});
	});

	it('mixing additionalContext and updatedInput preserves both', () => {
		const result = mergeDecisions([
			{ action: 'allow', additionalContext: 'A' },
			{ action: 'allow', updatedInput: { x: 1 } },
			{ action: 'allow', additionalContext: 'B' },
		]);
		expect(result).toEqual({
			action: 'allow',
			additionalContext: 'A\n\nB',
			updatedInput: { x: 1 },
		});
	});

	it('block reasons join with newline (stop event)', () => {
		const result = mergeDecisions([
			{ action: 'block', reason: 'tests failing' },
			{ action: 'block', reason: 'lint dirty' },
		]);
		expect(result).toEqual({ action: 'block', reason: 'tests failing\nlint dirty' });
	});

	it('block still loses to deny (deny is the strongest)', () => {
		const result = mergeDecisions([
			{ action: 'block', reason: 'keep going' },
			{ action: 'deny', reason: 'absolutely not' },
		]);
		expect(result).toEqual({ action: 'deny', reason: 'absolutely not' });
	});
});
