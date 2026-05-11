import { Context, Effect, Layer } from 'effect';
import type { HookId } from '../ids.ts';
import type { HookSpec } from '../schema.ts';

export interface HookRegistryService {
	readonly all: Effect.Effect<ReadonlyArray<HookSpec>>;
	readonly byId: (id: HookId) => Effect.Effect<HookSpec | undefined>;
	readonly byEvent: (event: string) => Effect.Effect<ReadonlyArray<HookSpec>>;
}

export class HookRegistry extends Context.Tag('@factory/hooks/HookRegistry')<
	HookRegistry,
	HookRegistryService
>() {
	static layer(specs: ReadonlyArray<HookSpec>): Layer.Layer<HookRegistry> {
		return Layer.succeed(HookRegistry, {
			all: Effect.succeed(specs),
			byId: (id: HookId) => Effect.succeed(specs.find((s) => s.id === id)),
			byEvent: (event: string) => Effect.succeed(specs.filter((s) => s.on === event)),
		} satisfies HookRegistryService);
	}

	static readonly Test: Layer.Layer<HookRegistry> = HookRegistry.layer([]);
}
