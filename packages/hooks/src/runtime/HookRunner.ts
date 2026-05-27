import { Effect, Layer, Schema } from 'effect';
import { HOOK_DECISION_ALLOW, type HookEvent, HookRunner } from '@factory/core';
import type { HookConfig } from '../config.ts';
import { dispatch } from '../dispatcher.ts';
import { FactoryHookEvent } from '../events.ts';

const decodeEvent = Schema.decodeUnknown(FactoryHookEvent);

/** Live runner: in-process dispatcher backed by the user's HookConfig. The
 *  orchestrator (and the socket server, for cross-process callbacks) hand us a
 *  structural `HookEvent`; we decode it to the typed `FactoryHookEvent`
 *  (schema-at-the-edge) before running handlers. A decode failure means the
 *  payload isn't part of the known vocabulary → fail-open allow, since the
 *  structural seam intentionally permits forward-compat fields. */
export const liveHookRunner = {
	layer: (config: HookConfig): Layer.Layer<HookRunner> =>
		Layer.succeed(HookRunner, {
			dispatch: (event: HookEvent) =>
				decodeEvent(event).pipe(
					Effect.flatMap((decoded) => dispatch(config, decoded)),
					Effect.catchAll(() => Effect.succeed(HOOK_DECISION_ALLOW)),
				),
		}),
};

export { HookRunner };
