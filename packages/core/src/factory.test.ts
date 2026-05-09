import { describe, expectTypeOf, it } from 'vitest';
import { factory } from './factory.ts';
import { scriptedHarness } from './testing/scriptedHarness.ts';
import type { Factory } from './types.ts';

const claudeCode = scriptedHarness('claude-code', []);
const codex = scriptedHarness('codex', []);

describe('factory() — types', () => {
	it('infers harness names as a literal union', () => {
		const f = factory({
			name: 'demo',
			harnesses: [claudeCode, codex],
		});
		expectTypeOf(f).toEqualTypeOf<Factory<'claude-code' | 'codex'>>();
	});

	it('accepts a default harness that matches a registered name', () => {
		factory({
			name: 'demo',
			harness: 'claude-code',
			harnesses: [claudeCode],
		});
	});

	it('rejects a default harness that is not registered', () => {
		factory({
			name: 'demo',
			// @ts-expect-error — 'claude-cod' is not in the registered harness union
			harness: 'claude-cod',
			harnesses: [claudeCode],
		});
	});

	it('accepts a step harness that matches a registered name', () => {
		factory({ name: 'demo', harnesses: [claudeCode, codex] }).step('plan', 'plan.md', {
			harness: 'codex',
		});
	});

	it('rejects a step harness that is not registered', () => {
		factory({ name: 'demo', harnesses: [claudeCode] }).step('plan', 'plan.md', {
			// @ts-expect-error — 'gpt' is not in the registered harness union
			harness: 'gpt',
		});
	});

	it('accumulates step ids in the Factory type', () => {
		const f = factory({ name: 'demo', harnesses: [claudeCode] })
			.step('plan', 'plan.md')
			.step('build', 'build.md');
		expectTypeOf(f).toEqualTypeOf<Factory<'claude-code', 'plan' | 'build'>>();
	});

	it('rejects duplicate step ids', () => {
		factory({ name: 'demo', harnesses: [claudeCode] })
			.step('plan', 'plan.md')
			// @ts-expect-error — 'plan' was already declared
			.step('plan', 'again.md');
	});
});
