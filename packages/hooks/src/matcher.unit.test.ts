import { describe, expect, it } from 'vitest';
import { matches } from './matcher.ts';
import {
	makePostToolUseEvent,
	makePreToolUseEvent,
	makeSessionStartEvent,
} from './testing/events.ts';

describe('matches', () => {
	it('undefined matcher matches every event', () => {
		expect(matches(undefined, makePreToolUseEvent())).toBe(true);
		expect(matches(undefined, makeSessionStartEvent())).toBe(true);
	});

	it('string matcher compares against event.tool exactly', () => {
		expect(matches('Bash', makePreToolUseEvent({ tool: 'Bash' }))).toBe(true);
		expect(matches('Bash', makePreToolUseEvent({ tool: 'Write' }))).toBe(false);
	});

	it('string matcher on a tool-less event is always false', () => {
		expect(matches('Bash', makeSessionStartEvent())).toBe(false);
	});

	it('{ tool: regex } applies the regex to event.tool', () => {
		expect(matches({ tool: /^mcp__/ }, makePreToolUseEvent({ tool: 'mcp__memory__read' }))).toBe(
			true,
		);
		expect(matches({ tool: /^mcp__/ }, makePreToolUseEvent({ tool: 'Bash' }))).toBe(false);
	});

	it('{ tool: regex } with a global flag matches consistently across repeated events', () => {
		const matcher = { tool: /mcp/g };
		const event = makePreToolUseEvent({ tool: 'mcp__memory__read' });
		expect(matches(matcher, event)).toBe(true);
		expect(matches(matcher, event)).toBe(true);
		expect(matches(matcher, event)).toBe(true);
	});

	it('{ tool: string } is shorthand for exact-match string matcher', () => {
		expect(matches({ tool: 'Edit' }, makePreToolUseEvent({ tool: 'Edit' }))).toBe(true);
		expect(matches({ tool: 'Edit' }, makePreToolUseEvent({ tool: 'Write' }))).toBe(false);
	});

	it('empty structured matcher (no fields) matches every event', () => {
		expect(matches({}, makePreToolUseEvent())).toBe(true);
		expect(matches({}, makeSessionStartEvent())).toBe(true);
	});

	it('function matcher is called with the event and its return value is used verbatim', () => {
		const calls: Array<string> = [];
		const pred = (event: { readonly _tag: string }) => {
			calls.push(event._tag);
			return event._tag === 'postToolUse';
		};
		expect(matches(pred, makePostToolUseEvent())).toBe(true);
		expect(matches(pred, makePreToolUseEvent())).toBe(false);
		expect(calls).toEqual(['postToolUse', 'preToolUse']);
	});
});
