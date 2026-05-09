import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { STEPS, buildPrompt, parseAssistantText, runStep, type Step } from './run.ts';

const here = import.meta.dir;
const fakeBin = resolve(here, 'tests/fixtures/fake-claude.ts');

const collect = () => {
	const chunks: string[] = [];
	const write = (chunk: string) => {
		chunks.push(chunk);
	};
	const text = () => chunks.join('');
	return { write, text };
};

describe('buildPrompt', () => {
	test('embeds prd and step body', () => {
		const out = buildPrompt('THE PRD', 'THE STEP');
		expect(out).toContain('# PRD\n\nTHE PRD');
		expect(out).toContain('# Step\n\nTHE STEP');
	});
});

describe('parseAssistantText', () => {
	test('extracts text content blocks', () => {
		const line = JSON.stringify({
			type: 'assistant',
			message: { content: [{ type: 'text', text: 'hi' }] },
		});
		expect(parseAssistantText(line)).toBe('hi');
	});

	test('joins multiple text blocks in one message', () => {
		const line = JSON.stringify({
			type: 'assistant',
			message: {
				content: [
					{ type: 'text', text: 'a' },
					{ type: 'tool_use', name: 'Edit' },
					{ type: 'text', text: 'b' },
				],
			},
		});
		expect(parseAssistantText(line)).toBe('ab');
	});

	test('returns empty for non-assistant events', () => {
		expect(parseAssistantText(JSON.stringify({ type: 'system' }))).toBe('');
		expect(parseAssistantText(JSON.stringify({ type: 'result', is_error: false }))).toBe('');
	});

	test('returns empty for non-json and blank lines', () => {
		expect(parseAssistantText('not json')).toBe('');
		expect(parseAssistantText('')).toBe('');
		expect(parseAssistantText('   ')).toBe('');
	});
});

describe('STEPS config', () => {
	test('has plan, ralph, review in that order', () => {
		expect(STEPS.map((s) => s.name)).toEqual(['plan', 'ralph', 'review']);
	});

	test('ralph done predicate matches the COMPLETE sentinel', () => {
		const ralph = STEPS.find((s) => s.name === 'ralph');
		expect(ralph).toBeDefined();
		expect(ralph!.done('still going')).toBe(false);
		expect(ralph!.done('done\n<promise>COMPLETE</promise>\n')).toBe(true);
	});

	test('plan and review are single-pass and 2-iter', () => {
		expect(STEPS.find((s) => s.name === 'plan')!.maxIters).toBe(1);
		expect(STEPS.find((s) => s.name === 'review')!.maxIters).toBe(2);
	});
});

describe('runStep against a fake bin', () => {
	const baseOpts = {
		cwd: here,
		prd: 'PRD',
		stepBody: 'STEP',
		planPath: resolve(here, 'IMPLEMENTATION_PLAN.md'),
		bin: 'bun',
		extraArgs: [fakeBin],
	};

	test('runs once when done returns true on first iter', async () => {
		const sink = collect();
		const step: Step = { name: 'plan', maxIters: 3, done: () => true };
		await runStep(step, { ...baseOpts, write: sink.write });
		const out = sink.text();
		expect(out).toContain('--- plan iter 1/3 ---');
		expect(out).not.toContain('--- plan iter 2/3 ---');
		expect(out).toContain('hello from fake claude');
	});

	test('iterates until COMPLETE sentinel appears', async () => {
		const sink = collect();
		// fake-claude emits COMPLETE only when FAKE_EMIT_COMPLETE=1; keep it off so
		// every iter prints "still working" and we burn through maxIters.
		const step: Step = {
			name: 'ralph',
			maxIters: 3,
			done: (out) => out.includes('<promise>COMPLETE</promise>'),
		};
		await runStep(step, { ...baseOpts, write: sink.write });
		const out = sink.text();
		expect(out).toContain('--- ralph iter 1/3 ---');
		expect(out).toContain('--- ralph iter 3/3 ---');
		expect(out).toContain('reached maxIters=3');
	});

	test('throws when subprocess exits non-zero', async () => {
		const sink = collect();
		const step: Step = { name: 'plan', maxIters: 1, done: () => true };
		const err = await runStep(step, {
			...baseOpts,
			extraArgs: [fakeBin, '--fail'],
			write: sink.write,
		}).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(Error);
		expect(err instanceof Error ? err.message : '').toMatch(/exited with code 2/);
	});
});
