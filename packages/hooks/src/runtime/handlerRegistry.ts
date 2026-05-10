import { Effect, Layer, Predicate } from 'effect';
import type { HookSpec } from '../schema.ts';
import { HookRegistry } from '../services/HookRegistry.ts';

const isHookSpec = (item: unknown): item is HookSpec =>
	Predicate.isRecord(item) &&
	typeof item['_tag'] === 'string' &&
	typeof item['id'] === 'string' &&
	typeof item['on'] === 'string';

const isHookSpecArray = (v: unknown): v is ReadonlyArray<HookSpec> =>
	Array.isArray(v) && v.every(isHookSpec);

const CANDIDATES = ['.factory/hooks.ts', '.factory/hooks.js'];

const loadSpecsEffect: Effect.Effect<ReadonlyArray<HookSpec>> = Effect.gen(function* () {
	const cwd = process.cwd();
	for (const rel of CANDIDATES) {
		const result = yield* Effect.tryPromise({
			try: () => import(`${cwd}/${rel}`),
			catch: (e) => e,
		}).pipe(Effect.either);

		if (result._tag === 'Left') {
			const e = result.left;
			if (
				Predicate.isRecord(e) &&
				(e['code'] === 'ERR_MODULE_NOT_FOUND' || e['code'] === 'MODULE_NOT_FOUND')
			) {
				continue;
			}
			return [];
		}

		const mod: unknown = result.right;
		if (!Predicate.isRecord(mod)) continue;

		const specs: unknown = mod['default'] ?? mod['hooks'];
		if (isHookSpecArray(specs)) return specs;
	}
	return [];
});

/** Load .factory/hooks.ts from CWD and return a HookRegistry layer. */
export const handlerRegistry = (): Layer.Layer<HookRegistry> =>
	Layer.effect(
		HookRegistry,
		loadSpecsEffect.pipe(
			Effect.map((specs) => ({
				all: Effect.succeed(specs),
				byId: (id: string) => Effect.succeed(specs.find((s) => s.id === id)),
				byEvent: (event: string) => Effect.succeed(specs.filter((s) => s.on === event)),
			})),
		),
	);
