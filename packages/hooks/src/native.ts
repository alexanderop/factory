import type { HookDecision } from '@factory/core';
import { Predicate } from 'effect';
import type { HookEventType } from './events.ts';

/** Best-effort codec between a harness's native hook JSON and factory's event
 *  vocabulary. The three CLIs converged on near-identical payloads, so a shared
 *  alias-based decoder covers them; a harness can override `decodeRequest` /
 *  `encodeDecision` if its shape diverges. A field we can't find degrades to a
 *  sensible default — the runner re-validates via Schema and fails open on a
 *  bad decode, so a missing field never wedges the harness. */

const asRecord = (v: unknown): Record<string, unknown> => (Predicate.isRecord(v) ? v : {});
const asString = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const asNumber = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback);

const pick = (body: Record<string, unknown>, keys: ReadonlyArray<string>): unknown => {
	for (const key of keys) {
		if (body[key] !== undefined) return body[key];
	}
	return undefined;
};

export const decodeNativeRequest = (args: {
	readonly event: HookEventType;
	readonly body: unknown;
}): Record<string, unknown> => {
	const body = asRecord(args.body);
	const tool = asString(pick(body, ['tool_name', 'toolName', 'tool']));
	const input = asRecord(pick(body, ['tool_input', 'toolInput', 'input', 'arguments']));
	const toolCallId = asString(pick(body, ['tool_use_id', 'tool_call_id', 'toolCallId', 'id']));
	switch (args.event) {
		case 'sessionStart':
			return {
				source: asString(pick(body, ['source']), 'startup') === 'resume' ? 'resume' : 'startup',
			};
		case 'userPromptSubmit':
			return { prompt: asString(pick(body, ['prompt', 'user_prompt'])) };
		case 'preToolUse':
			return { tool, input, toolCallId };
		case 'postToolUse':
			return {
				tool,
				input,
				output: asRecord(pick(body, ['tool_response', 'output', 'result'])),
				toolCallId,
				durationMs: asNumber(pick(body, ['duration_ms', 'durationMs'])),
			};
		case 'postToolUseFailure':
			return { tool, input, error: asString(pick(body, ['error', 'message'])), toolCallId };
		case 'stop':
			return {
				lastAssistantMessage: asString(
					pick(body, ['last_assistant_message', 'lastAssistantMessage', 'message']),
				),
			};
		case 'permissionRequest':
			return { tool, input, toolCallId };
	}
};

export const encodeNativeDecision = (args: {
	readonly event: HookEventType;
	readonly decision: HookDecision;
}): unknown => {
	const { decision } = args;
	switch (decision.action) {
		case 'allow': {
			const out: Record<string, unknown> = {};
			if (decision.additionalContext !== undefined)
				out.additionalContext = decision.additionalContext;
			// A hook that rewrites tool input via `updatedInput` must reach the
			// harness; harnesses that don't understand the field ignore it.
			if (decision.updatedInput !== undefined) out.updatedInput = decision.updatedInput;
			return out;
		}
		case 'ask':
			return { decision: 'ask', reason: decision.reason ?? '' };
		case 'deny':
		case 'block':
			return { decision: 'block', reason: decision.reason ?? '' };
	}
};
