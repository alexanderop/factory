import type { HarnessEvent, ParseLine, ParserState } from '@factory/core';

/**
 * Parses one line of `codex exec --json` JSONL output.
 *
 * Codex JSON format (each line is a JSON object):
 *
 *   {"type":"message","role":"assistant","content":[{"type":"output_text","text":"..."}]}
 *   {"type":"function_call","call_id":"call_X","name":"shell","arguments":"{\"command\":\"ls\"}"}
 *   {"type":"function_call_output","call_id":"call_X","output":"file1.txt\nfile2.txt","error":false}
 *   {"type":"usage","input_tokens":100,"output_tokens":50,"model":"o4-mini"}
 *
 * The parser also handles older formats that emit `tool_call` / `tool_call_result`.
 */
export const parseLine: ParseLine = (line, state) => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return { events: [], state };
	}

	if (typeof parsed !== 'object' || parsed === null) return { events: [], state };
	const obj = parsed as Record<string, unknown>;
	const events: HarnessEvent[] = [];
	const nextState = state;

	const type = obj['type'];

	// function_call → tool_use
	if (type === 'function_call' || type === 'tool_call') {
		const id = typeof obj['call_id'] === 'string' ? obj['call_id'] : typeof obj['id'] === 'string' ? obj['id'] : undefined;
		const name = typeof obj['name'] === 'string' ? obj['name'] : undefined;
		if (id && name) {
			let input: unknown = {};
			const args = obj['arguments'] ?? obj['input'];
			if (typeof args === 'string') {
				try {
					input = JSON.parse(args);
				} catch {
					input = args;
				}
			} else if (args !== undefined) {
				input = args;
			}
			events.push({ type: 'tool_use', id, name, input });
		}
	}

	// function_call_output → tool_result
	if (type === 'function_call_output' || type === 'tool_call_result') {
		const id = typeof obj['call_id'] === 'string' ? obj['call_id'] : typeof obj['id'] === 'string' ? obj['id'] : undefined;
		if (id) {
			const isError = obj['error'] === true || typeof obj['error'] === 'string';
			const output = obj['output'] ?? obj['content'];
			events.push({
				type: 'tool_result',
				id,
				ok: !isError,
				output: typeof output === 'string' ? output : output,
				error: isError ? String(obj['error']) : undefined,
			});
		}
	}

	// usage event
	if (type === 'usage') {
		events.push({
			type: 'usage',
			model: typeof obj['model'] === 'string' ? obj['model'] : undefined,
			inputTokens: typeof obj['input_tokens'] === 'number' ? obj['input_tokens'] : undefined,
			outputTokens: typeof obj['output_tokens'] === 'number' ? obj['output_tokens'] : undefined,
			cacheReadTokens:
				typeof obj['cached_tokens'] === 'number' ? obj['cached_tokens'] : undefined,
		});
	}

	// reasoning or message with model info
	if (type === 'message') {
		const role = obj['role'];
		if (role === 'assistant' || role === 'user' || role === 'system') {
			const content = obj['content'];
			let text = '';
			if (typeof content === 'string') {
				text = content;
			} else if (Array.isArray(content)) {
				for (const part of content) {
					if (typeof part === 'object' && part !== null) {
						const p = part as Record<string, unknown>;
						if (typeof p['text'] === 'string') text += p['text'];
					}
				}
			}
			if (text) events.push({ type: 'message', role, text });
		}
	}

	return { events, state: nextState };
};
