import { Effect } from 'effect';
import type { HookConfig } from './config.ts';
import { ALLOW, type HookDecision, mergeDecisions } from './decision.ts';
import type { FactoryHookEvent } from './events.ts';
import { matches } from './matcher.ts';

type AnyEffectHandler = (event: FactoryHookEvent) => Effect.Effect<HookDecision | void>;

const isFunction = (handler: unknown): handler is AnyEffectHandler => typeof handler === 'function';

const runHandler = (handler: unknown, event: FactoryHookEvent): Effect.Effect<HookDecision> => {
	if (!isFunction(handler)) {
		// `command` / `http` / `prompt` handler types are not yet supported — they
		// no-op (allow). The Effect (in-process) handler is the default; the others
		// are parity shims and will land with their own transports.
		return Effect.succeed(ALLOW);
	}
	// A handler defect is a bug: let it crash the run (fail-stop) rather than
	// swallowing it into a decision. Expected, typed failures only exist on the
	// command/http/prompt transports (handlers/*), where the fail-closed policy
	// for blockable events is applied.
	return handler(event).pipe(Effect.map((d) => d ?? ALLOW));
};

export const dispatch = (
	config: HookConfig,
	event: FactoryHookEvent,
): Effect.Effect<HookDecision> => {
	const entries = config[event._tag];
	if (entries === undefined || entries.length === 0) return Effect.succeed(ALLOW);
	return Effect.gen(function* () {
		const collected: Array<HookDecision> = [];
		for (const entry of entries) {
			if (!matches(entry.match, event)) continue;
			const decision = yield* runHandler(entry.handler, event);
			collected.push(decision);
			if (decision.action === 'deny') break;
		}
		return mergeDecisions(collected);
	});
};
