import { Schema } from 'effect';
import { HookId } from './ids.ts';

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

// ── HookSpec ──────────────────────────────────────────────────────────────────

const HookEventTag = Schema.Literal(
	'preToolUse',
	'postToolUse',
	'sessionStart',
	'stop',
	'permissionRequest',
);
type HookEventTag = typeof HookEventTag.Type;

/** Declarative rule — covers deny-paths, deny-commands, format-on-write, audit-log, and custom rules. */
export class RuleSpec extends Schema.TaggedClass<RuleSpec>()('RuleSpec', {
	id: HookId,
	on: HookEventTag,
	decide: Schema.Literal('allow', 'deny'),
	pathPatterns: Schema.optional(Schema.Array(Schema.String)),
	commandPatterns: Schema.optional(Schema.Array(Schema.String)),
	matchTools: Schema.optional(Schema.Array(Schema.String)),
	reason: Schema.optional(Schema.String),
	formatRun: Schema.optional(Schema.String),
	auditTo: Schema.optional(Schema.String),
}) {}

/** Effect-based escape hatch — handler is behaviour-shaped, validated by use. */
export class EffectSpec extends Schema.TaggedClass<EffectSpec>()('EffectSpec', {
	id: HookId,
	on: HookEventTag,
	handler: Schema.Any,
}) {}

export const HookSpec = Schema.Union(RuleSpec, EffectSpec);
export type HookSpec = typeof HookSpec.Type;
