import { Context, Effect, Layer } from 'effect';
import { HarnessNotFoundError } from '../errors.ts';
import type { Harness } from '../types.ts';

export interface HarnessRegistryService {
	readonly resolve: (name: string) => Effect.Effect<Harness, HarnessNotFoundError>;
	readonly list: Effect.Effect<ReadonlyArray<string>>;
}

export class HarnessRegistry extends Context.Tag('@factory/HarnessRegistry')<
	HarnessRegistry,
	HarnessRegistryService
>() {}

const makeService = (harnesses: ReadonlyArray<Harness>): HarnessRegistryService => {
	const map = new Map(harnesses.map((h) => [h.name, h]));
	const names = harnesses.map((h) => h.name);
	return {
		resolve: (name) => {
			const h = map.get(name);
			if (h) return Effect.succeed(h);
			return Effect.fail(
				new HarnessNotFoundError({
					message: `unknown harness '${name}' — registered: ${names.join(', ') || '(none)'}`,
					harness: name,
					available: names,
				}),
			);
		},
		list: Effect.succeed(names),
	};
};

export const harnessRegistryLayer = (
	harnesses: ReadonlyArray<Harness>,
): Layer.Layer<HarnessRegistry> => Layer.succeed(HarnessRegistry, makeService(harnesses));
