import { Effect, Layer } from 'effect';
import type { HookId } from '../ids.ts';
import type { HookSpec } from '../schema.ts';
import { HookRegistry } from '../services/HookRegistry.ts';

export const InMemoryHookRegistry = {
	withSpec: (spec: HookSpec): Layer.Layer<HookRegistry> => {
		const specsMap = new Map<string, HookSpec>([[spec.id, spec]]);
		return Layer.succeed(HookRegistry, {
			all: Effect.succeed([spec]),
			byId: (id: HookId) => Effect.succeed(specsMap.get(id)),
			byEvent: (event: string) => Effect.succeed(spec.on === event ? [spec] : []),
		});
	},
};
