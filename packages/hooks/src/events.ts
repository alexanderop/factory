import { Schema } from 'effect';
import { HarnessName, RunId, StepId } from '@factory/core';

const EventBase = {
	runId: RunId,
	stepId: StepId,
	iter: Schema.Number,
	harness: HarnessName,
};

export const SessionStartEvent = Schema.TaggedStruct('sessionStart', {
	...EventBase,
	source: Schema.Literal('startup', 'resume'),
});
export type SessionStartEvent = typeof SessionStartEvent.Type;

export const UserPromptSubmitEvent = Schema.TaggedStruct('userPromptSubmit', {
	...EventBase,
	prompt: Schema.String,
});
export type UserPromptSubmitEvent = typeof UserPromptSubmitEvent.Type;

const ToolFields = {
	tool: Schema.String,
	input: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
	toolCallId: Schema.String,
};

export const PreToolUseEvent = Schema.TaggedStruct('preToolUse', {
	...EventBase,
	...ToolFields,
});
export type PreToolUseEvent = typeof PreToolUseEvent.Type;

export const PostToolUseEvent = Schema.TaggedStruct('postToolUse', {
	...EventBase,
	...ToolFields,
	output: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
	durationMs: Schema.Number,
});
export type PostToolUseEvent = typeof PostToolUseEvent.Type;

export const PostToolUseFailureEvent = Schema.TaggedStruct('postToolUseFailure', {
	...EventBase,
	...ToolFields,
	error: Schema.String,
});
export type PostToolUseFailureEvent = typeof PostToolUseFailureEvent.Type;

export const StopEvent = Schema.TaggedStruct('stop', {
	...EventBase,
	lastAssistantMessage: Schema.String,
});
export type StopEvent = typeof StopEvent.Type;

export const PermissionRequestEvent = Schema.TaggedStruct('permissionRequest', {
	...EventBase,
	...ToolFields,
});
export type PermissionRequestEvent = typeof PermissionRequestEvent.Type;

export const FactoryHookEvent = Schema.Union(
	SessionStartEvent,
	UserPromptSubmitEvent,
	PreToolUseEvent,
	PostToolUseEvent,
	PostToolUseFailureEvent,
	StopEvent,
	PermissionRequestEvent,
);
export type FactoryHookEvent = typeof FactoryHookEvent.Type;
export type HookEventType = FactoryHookEvent['_tag'];

export const HOOK_EVENT_TYPES: ReadonlyArray<HookEventType> = [
	'sessionStart',
	'userPromptSubmit',
	'preToolUse',
	'postToolUse',
	'postToolUseFailure',
	'stop',
	'permissionRequest',
];
