import type { HarnessEvent, ParseLine, ParserState } from '@factory/core';

/**
 * Per-tool-use-id input accumulator for streaming JSON deltas.
 * Claude Code emits `input_json_delta` events that must be concatenated before parsing.
 */
interface ToolAccumulator {
	name: string;
	inputJson: string;
}

interface ClaudeCodeParserState extends ParserState {
	readonly tools: Record<string, ToolAccumulator>;
	readonly model: string | undefined;
}

const emptyState = (): ClaudeCodeParserState => ({ tools: {}, model: undefined });

/**
 * Parses one line of `claude --output-format stream-json --verbose` JSONL output.
 *
 * Claude Code stream-json format (each line is a JSON object):
 *
 *   {"type":"system","subtype":"init",...}
 *   {"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_X","name":"Bash","input":{...}}],...,"model":"claude-opus-4-5","usage":{...}}}
 *   {"type":"tool","tool_use_id":"toolu_X","tool_name":"Bash","content":[{"type":"tool_result","content":[{"type":"text","text":"..."}],"is_error":false}]}
 *   {"type":"result","subtype":"success","cost_usd":0.01,"usage":{"input_tokens":100,"output_tokens":50,...}}
 *
 * Streaming variant (when content arrives incrementally):
 *   {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_X","name":"Bash","input":{}}}
 *   {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"command\":"}}
 *   {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"ls\""}}
 *   {"type":"content_block_stop","index":0}
 *   {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":15}}
 */
const toState = (rawState: ParserState): ClaudeCodeParserState => {
	const tools = rawState['tools'];
	const model = rawState['model'];
	return {
		tools: (typeof tools === 'object' && tools !== null ? tools : {}) as Record<string, ToolAccumulator>,
		model: typeof model === 'string' ? model : undefined,
	};
};

export const parseLine: ParseLine = (line, rawState) => {
	const state = toState(rawState);

	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return { events: [], state };
	}

	if (typeof parsed !== 'object' || parsed === null) return { events: [], state };
	const obj = parsed as Record<string, unknown>;
	const events: HarnessEvent[] = [];
	let nextState: ClaudeCodeParserState = state;

	const type = obj['type'];

	// Non-streaming: full assistant message with complete tool_use blocks
	if (type === 'assistant') {
		const message = obj['message'] as Record<string, unknown> | undefined;
		if (!message) return { events, state: nextState };

		const model = typeof message['model'] === 'string' ? message['model'] : nextState.model;
		if (model) nextState = { ...nextState, model };

		const content = message['content'];
		if (Array.isArray(content)) {
			for (const block of content) {
				if (typeof block !== 'object' || block === null) continue;
				const b = block as Record<string, unknown>;
				if (b['type'] === 'tool_use' && typeof b['id'] === 'string' && typeof b['name'] === 'string') {
					events.push({ type: 'tool_use', id: b['id'], name: b['name'], input: b['input'] ?? {} });
				}
			}
		}

		const usage = message['usage'] as Record<string, unknown> | undefined;
		if (usage) {
			events.push({
				type: 'usage',
				model: model ?? undefined,
				inputTokens: typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : undefined,
				outputTokens: typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : undefined,
				cacheReadTokens:
					typeof usage['cache_read_input_tokens'] === 'number'
						? usage['cache_read_input_tokens']
						: undefined,
				cacheCreationTokens:
					typeof usage['cache_creation_input_tokens'] === 'number'
						? usage['cache_creation_input_tokens']
						: undefined,
			});
		}
	}

	// Tool result event
	if (type === 'tool') {
		const toolUseId = typeof obj['tool_use_id'] === 'string' ? obj['tool_use_id'] : undefined;
		if (!toolUseId) return { events, state: nextState };

		let isError = false;
		let outputText: string | undefined;

		const content = obj['content'];
		if (Array.isArray(content)) {
			for (const item of content) {
				if (typeof item !== 'object' || item === null) continue;
				const c = item as Record<string, unknown>;
				if (c['is_error'] === true) isError = true;
				const inner = c['content'];
				if (Array.isArray(inner)) {
					for (const part of inner) {
						if (typeof part !== 'object' || part === null) continue;
						const p = part as Record<string, unknown>;
						if (p['type'] === 'text' && typeof p['text'] === 'string') {
							outputText = p['text'];
						}
					}
				} else if (typeof inner === 'string') {
					outputText = inner;
				}
			}
		}

		events.push({
			type: 'tool_result',
			id: toolUseId,
			ok: !isError,
			output: outputText,
			error: isError ? outputText : undefined,
		});
	}

	// Streaming: content_block_start with tool_use
	if (type === 'content_block_start') {
		const cb = obj['content_block'] as Record<string, unknown> | undefined;
		if (
			cb &&
			cb['type'] === 'tool_use' &&
			typeof cb['id'] === 'string' &&
			typeof cb['name'] === 'string'
		) {
			const tools = { ...nextState.tools, [cb['id']]: { name: cb['name'], inputJson: '' } };
			nextState = { ...nextState, tools };
		}
	}

	// Streaming: content_block_delta accumulates partial JSON
	if (type === 'content_block_delta') {
		const delta = obj['delta'] as Record<string, unknown> | undefined;
		if (delta && delta['type'] === 'input_json_delta' && typeof delta['partial_json'] === 'string') {
			// Find the accumulator for the current block (by index)
			// Claude Code provides the tool id in content_block_start; accumulate by most recent
			const toolIds = Object.keys(nextState.tools);
			const lastId = toolIds[toolIds.length - 1];
			if (lastId) {
				const existing = nextState.tools[lastId];
				if (existing) {
					const tools = {
						...nextState.tools,
						[lastId]: { ...existing, inputJson: existing.inputJson + delta['partial_json'] },
					};
					nextState = { ...nextState, tools };
				}
			}
		}
	}

	// Streaming: content_block_stop — emit the tool_use event with accumulated input
	if (type === 'content_block_stop') {
		const toolIds = Object.keys(nextState.tools);
		const lastId = toolIds[toolIds.length - 1];
		if (lastId) {
			const acc = nextState.tools[lastId];
			if (acc) {
				let parsedInput: unknown = {};
				try {
					if (acc.inputJson) parsedInput = JSON.parse(acc.inputJson);
				} catch {
					parsedInput = acc.inputJson;
				}
				events.push({ type: 'tool_use', id: lastId, name: acc.name, input: parsedInput });
				const tools = { ...nextState.tools };
				delete tools[lastId];
				nextState = { ...nextState, tools };
			}
		}
	}

	// Result summary with aggregated usage
	if (type === 'result') {
		const usage = obj['usage'] as Record<string, unknown> | undefined;
		if (usage) {
			events.push({
				type: 'usage',
				model: nextState.model,
				inputTokens: typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : undefined,
				outputTokens: typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : undefined,
				cacheReadTokens:
					typeof usage['cache_read_input_tokens'] === 'number'
						? usage['cache_read_input_tokens']
						: undefined,
				cacheCreationTokens:
					typeof usage['cache_creation_input_tokens'] === 'number'
						? usage['cache_creation_input_tokens']
						: undefined,
			});
		}
	}

	return { events, state: nextState };
};
