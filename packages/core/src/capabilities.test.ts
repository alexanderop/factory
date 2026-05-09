import { describe, expect, it } from 'vitest';
import {
	matchRequirements,
	type HarnessCapabilities,
	type StepRequirements,
} from './capabilities.ts';

const fullCaps: HarnessCapabilities = {
	loadSession: true,
	mcp: { http: true, sse: true },
	prompt: { image: true, audio: true, embeddedContext: true },
	session: { list: true, resume: true, close: true },
	factory: { permissions: ['skip', 'accept-edits', 'read-only', 'prompt'], toolEvents: true },
};

const emptyCaps: HarnessCapabilities = {
	loadSession: false,
	mcp: { http: false, sse: false },
	prompt: { image: false, audio: false, embeddedContext: false },
	session: { list: false, resume: false, close: false },
	factory: { permissions: [], toolEvents: false },
};

describe('matchRequirements', () => {
	it('returns no missing fields when requirements are undefined', () => {
		const noReq: StepRequirements | undefined = undefined;
		expect(matchRequirements(emptyCaps, noReq)).toEqual([]);
	});

	it('returns no missing fields for empty requirements', () => {
		expect(matchRequirements(emptyCaps, {})).toEqual([]);
	});

	it('returns no missing fields when capabilities satisfy all requirements', () => {
		const req: StepRequirements = {
			loadSession: true,
			prompt: { image: true, embeddedContext: true },
			session: { resume: true, list: true },
			factory: { toolEvents: true },
		};
		expect(matchRequirements(fullCaps, req)).toEqual([]);
	});

	it('returns dotted paths for missing nested fields', () => {
		const req: StepRequirements = {
			loadSession: true,
			prompt: { image: true, audio: true },
			session: { resume: true, close: true },
			factory: { toolEvents: true },
		};
		const missing = matchRequirements(emptyCaps, req);
		expect(missing).toContain('loadSession');
		expect(missing).toContain('prompt.image');
		expect(missing).toContain('prompt.audio');
		expect(missing).toContain('session.resume');
		expect(missing).toContain('session.close');
		expect(missing).toContain('factory.toolEvents');
	});

	it('returns only the partially missing fields', () => {
		const partial: HarnessCapabilities = {
			...emptyCaps,
			session: { list: false, resume: true, close: false },
		};
		const req: StepRequirements = {
			session: { resume: true, list: true },
		};
		expect(matchRequirements(partial, req)).toEqual(['session.list']);
	});

	it('treats false requirements as no requirement (only `true` is asked for)', () => {
		const req: StepRequirements = {
			loadSession: false,
			prompt: { image: false },
		};
		expect(matchRequirements(emptyCaps, req)).toEqual([]);
	});
});
