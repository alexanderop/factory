import type { Effect } from 'effect';
import type {
	FactoryHookEvent,
	HookEventType,
	PostToolUseEvent,
	PostToolUseFailureEvent,
	PreToolUseEvent,
	PermissionRequestEvent,
	SessionStartEvent,
	StopEvent,
	UserPromptSubmitEvent,
} from './events.ts';
import type { HookDecision } from './decision.ts';
import type { HookMatcher } from './matcher.ts';

export type EventByType = {
	sessionStart: SessionStartEvent;
	userPromptSubmit: UserPromptSubmitEvent;
	preToolUse: PreToolUseEvent;
	postToolUse: PostToolUseEvent;
	postToolUseFailure: PostToolUseFailureEvent;
	stop: StopEvent;
	permissionRequest: PermissionRequestEvent;
};

export type EffectHandler<E extends HookEventType> = (
	event: EventByType[E],
) => Effect.Effect<HookDecision | void>;

export type CommandHandler = {
	readonly type: 'command';
	readonly command: string;
	readonly args?: ReadonlyArray<string>;
	readonly timeoutMs?: number;
};

export type HttpHandler = {
	readonly type: 'http';
	readonly url: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly timeoutMs?: number;
};

export type PromptHandler = {
	readonly type: 'prompt';
	readonly prompt: string;
	readonly model?: string;
	readonly timeoutMs?: number;
};

export type HookHandler<E extends HookEventType = HookEventType> =
	| EffectHandler<E>
	| CommandHandler
	| HttpHandler
	| PromptHandler;

export interface HookEntry<E extends HookEventType = HookEventType> {
	readonly match?: HookMatcher;
	readonly handler: HookHandler<E>;
}

export type HookConfig = {
	readonly [E in HookEventType]?: ReadonlyArray<HookEntry<E>>;
};

export const eventTypeOf = (event: FactoryHookEvent): HookEventType => event._tag;
