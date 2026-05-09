import type { HarnessEvent, HarnessTokenUsage } from '@factory/core';
import { Predicate } from 'effect';

/**
 * Parse one line of Claude Code's `--output-format stream-json --verbose`
 * output. Each NDJSON line is an event with a `type` field; some carry nested
 * `message.content[]` arrays of typed content blocks (text / tool_use /
 * tool_result / thinking).
 *
 * Returns zero or more `HarnessEvent`s. Unknown / malformed lines emit a
 * single `stderr` event tagged as a parse error so the operator can see them
 * without the orchestrator crashing.
 */
export const parseClaudeStreamJsonLine = (line: string): ReadonlyArray<HarnessEvent> => {
	const trimmed = line.trim();
	if (trimmed === '') return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return [
			{
				type: 'stderr',
				line: `[claude-code stream-json parse error] ${trimmed.slice(0, 256)}`,
			},
		];
	}

	if (!Predicate.isRecord(parsed) || typeof parsed.type !== 'string') {
		return [{ type: 'stdout', line: trimmed }];
	}

	switch (parsed.type) {
		case 'system':
			return [];
		case 'assistant':
			return parseAssistant(parsed);
		case 'user':
			return parseUser(parsed);
		case 'result':
			return parseResult(parsed);
		default:
			return [];
	}
};

const parseAssistant = (parsed: Record<string, unknown>): ReadonlyArray<HarnessEvent> => {
	const message = parsed.message;
	if (!Predicate.isRecord(message)) return [];
	const content = message.content;
	if (!Array.isArray(content)) return [];

	const events: HarnessEvent[] = [];
	for (const block of content) {
		if (!Predicate.isRecord(block)) continue;
		switch (block.type) {
			case 'text':
				if (typeof block.text === 'string' && block.text.length > 0) {
					events.push({ type: 'assistant.message', text: block.text });
				}
				break;
			case 'tool_use': {
				const id = typeof block.id === 'string' ? block.id : undefined;
				const name = typeof block.name === 'string' ? block.name : undefined;
				if (id && name) {
					events.push({ type: 'tool.start', id, name, input: block.input });
				}
				break;
			}
			default:
				break;
		}
	}
	return events;
};

const parseUser = (parsed: Record<string, unknown>): ReadonlyArray<HarnessEvent> => {
	const message = parsed.message;
	if (!Predicate.isRecord(message)) return [];
	const content = message.content;
	if (!Array.isArray(content)) return [];

	const events: HarnessEvent[] = [];
	for (const block of content) {
		if (!Predicate.isRecord(block)) continue;
		if (block.type !== 'tool_result') continue;
		const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
		if (!id) continue;
		const ok = block.is_error !== true;
		events.push({ type: 'tool.end', id, ok, output: block.content });
	}
	return events;
};

const parseTokens = (usage: unknown): HarnessTokenUsage | undefined => {
	if (!Predicate.isRecord(usage)) return undefined;
	const input = numberOr(usage.input_tokens, 0);
	const output = numberOr(usage.output_tokens, 0);
	const cacheRead = numberOrUndef(usage.cache_read_input_tokens);
	const cacheCreate = numberOrUndef(usage.cache_creation_input_tokens);
	return { input, output, cacheRead, cacheCreate };
};

const parseResult = (parsed: Record<string, unknown>): ReadonlyArray<HarnessEvent> => {
	const ok = parsed.is_error !== true;
	const costUsd = numberOrUndef(parsed.total_cost_usd);
	const durationMs = numberOr(parsed.duration_ms, 0);
	const tokens = parseTokens(parsed.usage);
	const message = Predicate.isRecord(parsed.message) ? parsed.message : undefined;
	const model = typeof message?.model === 'string' ? message.model : undefined;
	return [{ type: 'result', ok, costUsd, durationMs, tokens, model }];
};

const numberOr = (v: unknown, fallback: number): number =>
	typeof v === 'number' && Number.isFinite(v) ? v : fallback;

const numberOrUndef = (v: unknown): number | undefined =>
	typeof v === 'number' && Number.isFinite(v) ? v : undefined;
