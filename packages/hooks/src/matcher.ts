import type { FactoryHookEvent } from './events.ts';

export type HookMatcher =
	| string
	| { readonly tool?: string | RegExp }
	| ((event: FactoryHookEvent) => boolean);

const toolOf = (event: FactoryHookEvent): string | undefined => {
	switch (event._tag) {
		case 'preToolUse':
		case 'postToolUse':
		case 'postToolUseFailure':
		case 'permissionRequest':
			return event.tool;
		case 'sessionStart':
		case 'userPromptSubmit':
		case 'stop':
			return undefined;
	}
};

/** True if the event passes the matcher. An omitted matcher (caller passes
 *  `undefined`) matches every event. String matchers and `{ tool }` matchers
 *  only match events that carry a `tool` field. */
export const matches = (matcher: HookMatcher | undefined, event: FactoryHookEvent): boolean => {
	if (matcher === undefined) return true;
	if (typeof matcher === 'function') return matcher(event);
	if (typeof matcher === 'string') return toolOf(event) === matcher;
	if (matcher.tool === undefined) return true;
	const tool = toolOf(event);
	if (tool === undefined) return false;
	if (matcher.tool instanceof RegExp) {
		// A config-level RegExp is reused across every dispatch; reset lastIndex so
		// a `/g` or `/y` flag can't make `.test()` flip-flop on repeated events.
		matcher.tool.lastIndex = 0;
		return matcher.tool.test(tool);
	}
	return tool === matcher.tool;
};
