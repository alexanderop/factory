import { describe, expect, it } from 'vitest';
import { parseClaudeStreamJsonLine } from './streamJson.ts';

describe('parseClaudeStreamJsonLine', () => {
	it('returns no events for blank lines', () => {
		expect(parseClaudeStreamJsonLine('')).toEqual([]);
		expect(parseClaudeStreamJsonLine('   ')).toEqual([]);
	});

	it('emits a parse-error stderr event for invalid JSON', () => {
		const events = parseClaudeStreamJsonLine('not-json {');
		expect(events).toHaveLength(1);
		const first = events[0];
		expect(first?.type).toBe('stderr');
		if (first?.type === 'stderr') {
			expect(first.line).toContain('parse error');
		}
	});

	it('drops system init events silently', () => {
		const line = JSON.stringify({
			type: 'system',
			subtype: 'init',
			session_id: 'abc',
			cwd: '/tmp',
			tools: ['Bash'],
		});
		expect(parseClaudeStreamJsonLine(line)).toEqual([]);
	});

	it('extracts assistant text and tool_use blocks', () => {
		const line = JSON.stringify({
			type: 'assistant',
			message: {
				content: [
					{ type: 'text', text: 'Reading the file.' },
					{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/x' } },
				],
			},
		});
		const events = parseClaudeStreamJsonLine(line);
		expect(events).toEqual([
			{ type: 'assistant.message', text: 'Reading the file.' },
			{ type: 'tool.start', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/x' } },
		]);
	});

	it('skips empty assistant text and tool_use without id/name', () => {
		const line = JSON.stringify({
			type: 'assistant',
			message: {
				content: [
					{ type: 'text', text: '' },
					{ type: 'tool_use', name: 'Read' }, // missing id
					{ type: 'tool_use', id: 'toolu_2' }, // missing name
				],
			},
		});
		expect(parseClaudeStreamJsonLine(line)).toEqual([]);
	});

	it('extracts tool_result blocks from user messages', () => {
		const line = JSON.stringify({
			type: 'user',
			message: {
				content: [
					{
						type: 'tool_result',
						tool_use_id: 'toolu_1',
						content: 'file contents',
						is_error: false,
					},
				],
			},
		});
		expect(parseClaudeStreamJsonLine(line)).toEqual([
			{ type: 'tool.end', id: 'toolu_1', ok: true, output: 'file contents' },
		]);
	});

	it('marks failed tool_result with ok=false', () => {
		const line = JSON.stringify({
			type: 'user',
			message: {
				content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'oops', is_error: true }],
			},
		});
		expect(parseClaudeStreamJsonLine(line)).toEqual([
			{ type: 'tool.end', id: 'toolu_1', ok: false, output: 'oops' },
		]);
	});

	it('extracts cost, tokens, model, durationMs from result events', () => {
		const line = JSON.stringify({
			type: 'result',
			subtype: 'success',
			is_error: false,
			duration_ms: 1234,
			total_cost_usd: 0.0567,
			usage: {
				input_tokens: 100,
				output_tokens: 50,
				cache_read_input_tokens: 10,
				cache_creation_input_tokens: 5,
			},
			message: { model: 'claude-sonnet-4-6' },
		});
		expect(parseClaudeStreamJsonLine(line)).toEqual([
			{
				type: 'result',
				ok: true,
				costUsd: 0.0567,
				durationMs: 1234,
				tokens: { input: 100, output: 50, cacheRead: 10, cacheCreate: 5 },
				model: 'claude-sonnet-4-6',
			},
		]);
	});

	it('handles result events without optional fields', () => {
		const line = JSON.stringify({
			type: 'result',
			subtype: 'success',
			is_error: false,
			duration_ms: 100,
		});
		expect(parseClaudeStreamJsonLine(line)).toEqual([
			{
				type: 'result',
				ok: true,
				costUsd: undefined,
				durationMs: 100,
				tokens: undefined,
				model: undefined,
			},
		]);
	});

	it('parses multiple tool_use blocks in one assistant message', () => {
		const line = JSON.stringify({
			type: 'assistant',
			message: {
				content: [
					{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } },
					{ type: 'tool_use', id: 'b', name: 'Read', input: { file_path: '/x' } },
				],
			},
		});
		const events = parseClaudeStreamJsonLine(line);
		expect(events).toHaveLength(2);
		const [first, second] = events;
		if (first?.type === 'tool.start') expect(first.id).toBe('a');
		if (second?.type === 'tool.start') expect(second.id).toBe('b');
	});
});
