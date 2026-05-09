import { FileSystem, Path } from '@effect/platform';
import { Context, Effect, Layer, Schema } from 'effect';
import matter from 'gray-matter';
import { StepLoadError } from '../errors.ts';
import { StepId } from '../ids.ts';
import { StepFrontmatter, type LoadedStep } from '../types.ts';

export interface StepLoaderService {
	readonly load: (source: string, cwd: string) => Effect.Effect<LoadedStep, StepLoadError>;
}

export class StepLoader extends Context.Tag('@factory/StepLoader')<
	StepLoader,
	StepLoaderService
>() {}

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
			frontmatter,
			prompt: parsed.content.trim(),
		};
	});

export const FileStepLoader = {
	layer: Layer.effect(
		StepLoader,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			return {
				load: (source, cwd) => {
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
			};
		}),
	),
};

export const InMemoryStepLoader = {
	layer: (map: ReadonlyMap<string, string>): Layer.Layer<StepLoader> =>
		Layer.succeed(StepLoader, {
			load: (source) => {
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
};
