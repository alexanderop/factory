import { describe, expect, it } from 'vitest';
import { parseLine } from './parser.ts';

describe('claude-code parseLine', () => {
	it('returns empty events for non-JSON lines', () => {
		const { events } = parseLine('not json', {});
		expect(events).toHaveLength(0);
	});

	it('returns empty events for irrelevant JSON', () => {
		const { events } = parseLine(JSON.stringify({ type: 'system', subtype: 'init' }), {});
		expect(events).toHaveLength(0);
	});

	it('parses a non-streaming assistant message with tool_use block', () => {
		const line = JSON.stringify({
			type: 'assistant',
			message: {
				model: 'claude-opus-4-5',
				content: [
					{
						type: 'tool_use',
						id: 'toolu_abc',
						name: 'Bash',
						input: { command: 'ls -la' },
					},
				],
				usage: {
					input_tokens: 100,
					output_tokens: 15,
					cache_read_input_tokens: 50,
					cache_creation_input_tokens: 0,
				},
			},
		});

		const { events, state } = parseLine(line, {});
		const toolUse = events.find((e) => e.type === 'tool_use');
		expect(toolUse).toMatchObject({
			type: 'tool_use',
			id: 'toolu_abc',
			name: 'Bash',
			input: { command: 'ls -la' },
		});

		const usage = events.find((e) => e.type === 'usage');
		expect(usage).toMatchObject({
			type: 'usage',
			model: 'claude-opus-4-5',
			inputTokens: 100,
			outputTokens: 15,
			cacheReadTokens: 50,
			cacheCreationTokens: 0,
		});

		expect(state).toMatchObject({ model: 'claude-opus-4-5' });
	});

	it('parses a tool result event', () => {
		const line = JSON.stringify({
			type: 'tool',
			tool_use_id: 'toolu_abc',
			tool_name: 'Bash',
			content: [
				{
					type: 'tool_result',
					is_error: false,
					content: [{ type: 'text', text: 'file1.txt\nfile2.txt' }],
				},
			],
		});

		const { events } = parseLine(line, {});
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: 'tool_result',
			id: 'toolu_abc',
			ok: true,
			output: 'file1.txt\nfile2.txt',
		});
	});

	it('parses a tool result with error', () => {
		const line = JSON.stringify({
			type: 'tool',
			tool_use_id: 'toolu_xyz',
			tool_name: 'Bash',
			content: [
				{
					type: 'tool_result',
					is_error: true,
					content: [{ type: 'text', text: 'command not found' }],
				},
			],
		});

		const { events } = parseLine(line, {});
		expect(events[0]).toMatchObject({
			type: 'tool_result',
			id: 'toolu_xyz',
			ok: false,
			error: 'command not found',
		});
	});

	it('accumulates streaming content_block_delta and emits tool_use on stop', () => {
		let state = {};

		// start
		const { state: s1 } = parseLine(
			JSON.stringify({
				type: 'content_block_start',
				index: 0,
				content_block: { type: 'tool_use', id: 'toolu_stream', name: 'Edit', input: {} },
			}),
			state,
		);
		state = s1;

		// delta 1
		const { state: s2 } = parseLine(
			JSON.stringify({
				type: 'content_block_delta',
				index: 0,
				delta: { type: 'input_json_delta', partial_json: '{"file_path":"/a' },
			}),
			state,
		);
		state = s2;

		// delta 2
		const { state: s3 } = parseLine(
			JSON.stringify({
				type: 'content_block_delta',
				index: 0,
				delta: { type: 'input_json_delta', partial_json: '.ts"}' },
			}),
			state,
		);
		state = s3;

		// stop — should emit tool_use
		const { events } = parseLine(
			JSON.stringify({ type: 'content_block_stop', index: 0 }),
			state,
		);

		const toolUse = events.find((e) => e.type === 'tool_use');
		expect(toolUse).toMatchObject({
			type: 'tool_use',
			id: 'toolu_stream',
			name: 'Edit',
			input: { file_path: '/a.ts' },
		});
	});

	it('parses result event with aggregated usage', () => {
		const line = JSON.stringify({
			type: 'result',
			subtype: 'success',
			cost_usd: 0.005,
			usage: {
				input_tokens: 500,
				output_tokens: 200,
				cache_read_input_tokens: 100,
				cache_creation_input_tokens: 0,
			},
		});

		const { events } = parseLine(line, {});
		const usage = events.find((e) => e.type === 'usage');
		expect(usage).toMatchObject({
			type: 'usage',
			inputTokens: 500,
			outputTokens: 200,
			cacheReadTokens: 100,
		});
	});
});
