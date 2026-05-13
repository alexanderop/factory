import { FileSystem, Path } from '@effect/platform';
import { Effect, Layer, Schema } from 'effect';
import matter from 'gray-matter';
import { StepLoadError } from '../errors.ts';
import { StepId } from '../ids.ts';
import { StepFrontmatter, type LoadedStep } from '../types.ts';

// Hoisted decoder — constructing `Schema.decodeUnknown` parses the AST. Build
// once, reuse for every step. See `patterns/schema-at-the-edge.md` rule 1.
const decodeFrontmatter = Schema.decodeUnknown(StepFrontmatter);

const parseStep = (path: string, raw: string): Effect.Effect<LoadedStep, StepLoadError> =>
	Effect.gen(function* () {
		const parsed = matter(raw);
		const frontmatter = yield* decodeFrontmatter(parsed.data).pipe(
			Effect.mapError(
				(e) =>
					new StepLoadError({
						message: `invalid frontmatter in ${path}: ${e.message}`,
						path,
					}),
			),
		);
		return {
			id: frontmatter.name ?? StepId.make(path),
			path,
			raw,
			frontmatter,
			prompt: parsed.content.trim(),
		};
	});

export interface StepLoaderService {
	readonly load: (source: string, cwd: string) => Effect.Effect<LoadedStep, StepLoadError>;
}

/**
 * StepLoader service.
 *
 * - `StepLoader.Default` — production layer: reads markdown + frontmatter from
 *   disk via `FileSystem` / `Path`. Caller provides `NodeContext` (or
 *   equivalent) for those.
 * - `StepLoader.inMemory(map)` — test layer: serves steps from a
 *   `ReadonlyMap<source, raw>`.
 *
 * Uses `Effect.Service` (over `Context.Tag` + hand-written `Layer.effect`)
 * because it has dependencies (`FileSystem`, `Path`) and benefits from
 * `accessors: true` — callers can `yield* StepLoader.load(...)` without first
 * binding the service.
 */
export class StepLoader extends Effect.Service<StepLoader>()('@factory/StepLoader', {
	accessors: true,
	effect: Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		return {
			load: (source: string, cwd: string): Effect.Effect<LoadedStep, StepLoadError> => {
				const resolved = path.isAbsolute(source) ? source : path.resolve(cwd, source);
				return fs.readFileString(resolved).pipe(
					Effect.mapError(
						(e) =>
							new StepLoadError({
								message: `failed to read step '${source}': ${e instanceof Error ? e.message : String(e)}`,
								path: resolved,
							}),
					),
					Effect.flatMap((raw) => parseStep(resolved, raw)),
				);
			},
		} satisfies StepLoaderService;
	}),
}) {
	static inMemory = (map: ReadonlyMap<string, string>): Layer.Layer<StepLoader> =>
		Layer.succeed(
			StepLoader,
			new StepLoader({
				load: (source: string): Effect.Effect<LoadedStep, StepLoadError> => {
					const raw = map.get(source);
					if (raw === undefined) {
						return Effect.fail(
							new StepLoadError({
								message: `step '${source}' not found in in-memory loader`,
								path: source,
							}),
						);
					}
					return parseStep(source, raw);
				},
			}),
		);
}
