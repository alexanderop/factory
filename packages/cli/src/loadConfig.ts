import { Path } from '@effect/platform';
import { Effect, Predicate } from 'effect';
import { ConfigLoadError, type Factory } from '@factory/core';

const CANDIDATES = [
	'.factory/factory.ts',
	'.factory/factory.js',
	'factory.config.ts',
	'factory.config.js',
] as const;

const isModuleNotFound = (e: unknown): boolean =>
	Predicate.isRecord(e) && e.code === 'ERR_MODULE_NOT_FOUND';

const isFactory = (v: unknown): v is Factory =>
	Predicate.isRecord(v) &&
	typeof v.name === 'string' &&
	typeof v.step === 'function' &&
	typeof v.run === 'function' &&
	typeof v.runEffect === 'function';

export const loadFactoryConfig = (
	cwd: string,
	name: string,
): Effect.Effect<Factory, ConfigLoadError, Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;

		for (const rel of CANDIDATES) {
			const candidate = path.resolve(cwd, rel);
			const result = yield* Effect.tryPromise({
				try: () => import(/* @vite-ignore */ candidate),
				catch: (e) => e,
			}).pipe(Effect.either);

			if (result._tag === 'Left') {
				if (isModuleNotFound(result.left)) continue;
				const e = result.left;
				return yield* Effect.fail(
					new ConfigLoadError({
						message: `failed to import ${candidate}: ${e instanceof Error ? e.message : String(e)}`,
						cwd,
					}),
				);
			}

			const mod: unknown = result.right;
			if (!Predicate.isRecord(mod)) {
				return yield* Effect.fail(
					new ConfigLoadError({
						message: `${candidate} did not export a module object`,
						cwd,
					}),
				);
			}
			const def = mod.default ?? mod[name];
			if (!isFactory(def)) {
				return yield* Effect.fail(
					new ConfigLoadError({
						message: `${candidate} does not export a factory (default or named '${name}')`,
						cwd,
					}),
				);
			}
			if (def.name !== name) {
				return yield* Effect.fail(
					new ConfigLoadError({
						message: `factory in ${candidate} is named '${def.name}', expected '${name}'`,
						cwd,
					}),
				);
			}
			return def;
		}

		return yield* Effect.fail(
			new ConfigLoadError({
				message: `no factory config found in ${cwd}. Expected one of: ${CANDIDATES.join(', ')}`,
				cwd,
			}),
		);
	});
