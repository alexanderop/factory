import { Schema } from 'effect';

// ── HookEvent ────────────────────────────────────────────────────────────────

export class PreToolUseEvent extends Schema.TaggedClass<PreToolUseEvent>()('PreToolUse', {
	toolName: Schema.optional(Schema.String),
	path: Schema.optional(Schema.String),
	command: Schema.optional(Schema.String),
	args: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
}) {}

export class PostToolUseEvent extends Schema.TaggedClass<PostToolUseEvent>()('PostToolUse', {
	toolName: Schema.optional(Schema.String),
	path: Schema.optional(Schema.String),
	command: Schema.optional(Schema.String),
	output: Schema.optional(Schema.String),
}) {}

export class SessionStartEvent extends Schema.TaggedClass<SessionStartEvent>()('SessionStart', {
	sessionId: Schema.optional(Schema.String),
}) {}

export class StopEvent extends Schema.TaggedClass<StopEvent>()('Stop', {
	reason: Schema.optional(Schema.String),
}) {}

export class PermissionRequestEvent extends Schema.TaggedClass<PermissionRequestEvent>()(
	'PermissionRequest',
	{
		toolName: Schema.optional(Schema.String),
		path: Schema.optional(Schema.String),
		command: Schema.optional(Schema.String),
	},
) {}

export const HookEvent = Schema.Union(
	PreToolUseEvent,
	PostToolUseEvent,
	SessionStartEvent,
	StopEvent,
	PermissionRequestEvent,
);
export type HookEvent = typeof HookEvent.Type;

// ── HookDecision ─────────────────────────────────────────────────────────────

export class AllowDecision extends Schema.TaggedClass<AllowDecision>()('Allow', {}) {}

export class DenyDecision extends Schema.TaggedClass<DenyDecision>()('Deny', {
	reason: Schema.optional(Schema.String),
}) {}

export class AskDecision extends Schema.TaggedClass<AskDecision>()('Ask', {
	prompt: Schema.String,
}) {}

export class ModifyDecision extends Schema.TaggedClass<ModifyDecision>()('Modify', {
	args: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
}) {}

export const HookDecision = Schema.Union(AllowDecision, DenyDecision, AskDecision, ModifyDecision);
export type HookDecision = typeof HookDecision.Type;
