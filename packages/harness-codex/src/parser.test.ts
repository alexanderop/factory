import { describe, expect, it } from 'vitest';
import { parseLine } from './parser.ts';

describe('codex parseLine', () => {
	it('returns empty events for non-JSON lines', () => {
		const { events } = parseLine('not json', {});
		expect(events).toHaveLength(0);
	});

	it('parses function_call as tool_use', () => {
		const line = JSON.stringify({
			type: 'function_call',
			call_id: 'call_abc',
			name: 'shell',
			arguments: '{"command":"ls -la"}',
		});

		const { events } = parseLine(line, {});
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: 'tool_use',
			id: 'call_abc',
			name: 'shell',
			input: { command: 'ls -la' },
		});
	});

	it('parses function_call_output as tool_result', () => {
		const line = JSON.stringify({
			type: 'function_call_output',
			call_id: 'call_abc',
			output: 'file1.txt\nfile2.txt',
			error: false,
		});

		const { events } = parseLine(line, {});
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: 'tool_result',
			id: 'call_abc',
			ok: true,
			output: 'file1.txt\nfile2.txt',
		});
	});

	it('parses function_call_output with error', () => {
		const line = JSON.stringify({
			type: 'function_call_output',
			call_id: 'call_xyz',
			output: 'command not found',
			error: true,
		});

		const { events } = parseLine(line, {});
		expect(events[0]).toMatchObject({
			type: 'tool_result',
			id: 'call_xyz',
			ok: false,
		});
	});

	it('parses usage event', () => {
		const line = JSON.stringify({
			type: 'usage',
			input_tokens: 150,
			output_tokens: 75,
			model: 'o4-mini',
		});

		const { events } = parseLine(line, {});
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: 'usage',
			model: 'o4-mini',
			inputTokens: 150,
			outputTokens: 75,
		});
	});

	it('handles object arguments in function_call', () => {
		const line = JSON.stringify({
			type: 'function_call',
			call_id: 'call_obj',
			name: 'edit_file',
			input: { path: '/foo.ts', content: 'hello' },
		});

		const { events } = parseLine(line, {});
		expect(events[0]).toMatchObject({
			type: 'tool_use',
			id: 'call_obj',
			name: 'edit_file',
			input: { path: '/foo.ts', content: 'hello' },
		});
	});

	it('handles tool_call alias for older codex format', () => {
		const line = JSON.stringify({
			type: 'tool_call',
			id: 'tc_1',
			name: 'bash',
			arguments: '{"cmd":"echo hi"}',
		});

		const { events } = parseLine(line, {});
		expect(events[0]).toMatchObject({
			type: 'tool_use',
			id: 'tc_1',
			name: 'bash',
		});
	});
});
