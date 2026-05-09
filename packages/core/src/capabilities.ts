import { Data, Schema } from 'effect';
import type { HarnessName } from './ids.ts';
import { PermissionMode } from './permissionMode.ts';

export const McpCapabilities = Schema.Struct({
	http: Schema.Boolean,
	sse: Schema.Boolean,
});
export type McpCapabilities = typeof McpCapabilities.Type;

export const PromptCapabilities = Schema.Struct({
	image: Schema.Boolean,
	audio: Schema.Boolean,
	embeddedContext: Schema.Boolean,
});
export type PromptCapabilities = typeof PromptCapabilities.Type;

export const SessionCapabilities = Schema.Struct({
	list: Schema.Boolean,
	resume: Schema.Boolean,
	close: Schema.Boolean,
});
export type SessionCapabilities = typeof SessionCapabilities.Type;

export const FactoryCapabilities = Schema.Struct({
	permissions: Schema.Array(PermissionMode),
	toolEvents: Schema.Boolean,
});
export type FactoryCapabilities = typeof FactoryCapabilities.Type;

export const HarnessCapabilities = Schema.Struct({
	loadSession: Schema.Boolean,
	mcp: McpCapabilities,
	prompt: PromptCapabilities,
	session: SessionCapabilities,
	factory: FactoryCapabilities,
	meta: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});
export type HarnessCapabilities = typeof HarnessCapabilities.Type;

export const StepRequirements = Schema.Struct({
	loadSession: Schema.optional(Schema.Boolean),
	prompt: Schema.optional(
		Schema.Struct({
			image: Schema.optional(Schema.Boolean),
			audio: Schema.optional(Schema.Boolean),
			embeddedContext: Schema.optional(Schema.Boolean),
		}),
	),
	session: Schema.optional(
		Schema.Struct({
			resume: Schema.optional(Schema.Boolean),
			list: Schema.optional(Schema.Boolean),
			close: Schema.optional(Schema.Boolean),
		}),
	),
	factory: Schema.optional(
		Schema.Struct({
			toolEvents: Schema.optional(Schema.Boolean),
		}),
	),
});
export type StepRequirements = typeof StepRequirements.Type;

export class CapabilityMismatchError extends Data.TaggedError('CapabilityMismatchError')<{
	readonly message: string;
	readonly harness: HarnessName;
	readonly missing: ReadonlyArray<string>;
}> {}

export const matchRequirements = (
	caps: HarnessCapabilities,
	req: StepRequirements | undefined,
): ReadonlyArray<string> => {
	if (!req) return [];
	const missing: string[] = [];

	if (req.loadSession === true && !caps.loadSession) {
		missing.push('loadSession');
	}

	if (req.prompt) {
		if (req.prompt.image === true && !caps.prompt.image) missing.push('prompt.image');
		if (req.prompt.audio === true && !caps.prompt.audio) missing.push('prompt.audio');
		if (req.prompt.embeddedContext === true && !caps.prompt.embeddedContext) {
			missing.push('prompt.embeddedContext');
		}
	}

	if (req.session) {
		if (req.session.resume === true && !caps.session.resume) missing.push('session.resume');
		if (req.session.list === true && !caps.session.list) missing.push('session.list');
		if (req.session.close === true && !caps.session.close) missing.push('session.close');
	}

	if (req.factory) {
		if (req.factory.toolEvents === true && !caps.factory.toolEvents) {
			missing.push('factory.toolEvents');
		}
	}

	return missing;
};
