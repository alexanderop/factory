import { describe, expect, it } from 'vitest';
import { Hook } from './builders.ts';
import type { HookSpec } from './schema.ts';

describe('Hook builders produce correct _tags', () => {
	it('Hook.denyPaths produces RuleSpec', () => {
		const spec = Hook.denyPaths(['**/.env*', '**/secrets/**']);
		expect(spec._tag).toBe('RuleSpec');
		expect(spec.on).toBe('preToolUse');
		expect(spec.decide).toBe('deny');
		expect(spec.pathPatterns).toEqual(['**/.env*', '**/secrets/**']);
	});

	it('Hook.denyCommands produces RuleSpec', () => {
		const spec = Hook.denyCommands(['rm -rf /']);
		expect(spec._tag).toBe('RuleSpec');
		expect(spec.on).toBe('preToolUse');
		expect(spec.decide).toBe('deny');
		expect(spec.commandPatterns).toEqual(['rm -rf /']);
	});

	it('Hook.formatOnWrite produces RuleSpec', () => {
		const spec = Hook.formatOnWrite({ run: 'pnpm prettier --write {{path}}' });
		expect(spec._tag).toBe('RuleSpec');
		expect(spec.on).toBe('postToolUse');
		expect(spec.decide).toBe('allow');
		expect(spec.formatRun).toBe('pnpm prettier --write {{path}}');
	});

	it('Hook.auditLog produces RuleSpec', () => {
		const spec = Hook.auditLog({ to: '.factory/runs/{{runId}}/tools.jsonl' });
		expect(spec._tag).toBe('RuleSpec');
		expect(spec.on).toBe('preToolUse');
		expect(spec.decide).toBe('allow');
		expect(spec.auditTo).toBe('.factory/runs/{{runId}}/tools.jsonl');
	});

	it('Hook.rule produces RuleSpec with correct fields', () => {
		const spec = Hook.rule({ on: 'preToolUse', decide: 'deny', reason: 'blocked' });
		expect(spec._tag).toBe('RuleSpec');
		expect(spec.on).toBe('preToolUse');
		expect(spec.decide).toBe('deny');
		expect(spec.reason).toBe('blocked');
	});

	it('Hook.effect produces EffectSpec', () => {
		const handler = () => Promise.resolve(Hook.allow);
		const spec = Hook.effect({ on: 'preToolUse', handler });
		expect(spec._tag).toBe('EffectSpec');
		expect(spec.on).toBe('preToolUse');
		expect(spec.handler).toBe(handler);
	});

	it('Hook.allow, Hook.deny, Hook.ask, Hook.modify produce correct _tags', () => {
		expect(Hook.allow._tag).toBe('Allow');
		expect(Hook.deny('reason')._tag).toBe('Deny');
		expect(Hook.ask('prompt')._tag).toBe('Ask');
		expect(Hook.modify({ command: 'safe' })._tag).toBe('Modify');
	});

	it('specs have stable HookId assigned', () => {
		const a = Hook.denyPaths(['**/.env*']);
		const b = Hook.denyPaths(['**/.env*']);
		expect(a.id).toBe(b.id);
		expect(typeof a.id).toBe('string');
	});

	it('HookSpec is a closed union covering all spec _tags', () => {
		const spec: HookSpec = Hook.denyPaths(['**/.env*']);
		const tags = ['RuleSpec', 'EffectSpec'];
		expect(tags).toContain(spec._tag);
	});
});
