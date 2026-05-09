import { Context, Effect, Layer } from 'effect';
import { HarnessNotFoundError } from '../errors.ts';
import { HarnessName } from '../ids.ts';
import type { Harness } from '../types.ts';

export interface HarnessRegistryService {
	readonly resolve: (name: HarnessName) => Effect.Effect<Harness, HarnessNotFoundError>;
	readonly list: Effect.Effect<ReadonlyArray<HarnessName>>;
}

export class HarnessRegistry extends Context.Tag('@factory/HarnessRegistry')<
	HarnessRegistry,
	HarnessRegistryService
>() {}

const makeService = (harnesses: ReadonlyArray<Harness>): HarnessRegistryService => {
	const names = harnesses.map((h) => HarnessName.make(h.name));
	const map = new Map(
		harnesses.map((h, i): [HarnessName, Harness] => [names[i] ?? HarnessName.make(h.name), h]),
	);
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
