import { FileSystem, Path } from '@effect/platform';
import { Context, Effect, Layer } from 'effect';
import matter from 'gray-matter';
import { StepLoadError } from '../errors.ts';
import type { LoadedStep, StepFrontmatter } from '../types.ts';

export interface StepLoaderService {
	readonly load: (source: string, cwd: string) => Effect.Effect<LoadedStep, StepLoadError>;
}

export class StepLoader extends Context.Tag('@factory/StepLoader')<
	StepLoader,
	StepLoaderService
>() {}

const parseStep = (path: string, raw: string): LoadedStep => {
	const parsed = matter(raw);
	const frontmatter = parsed.data as StepFrontmatter;
	return {
		id: frontmatter.name ?? path,
		path,
		frontmatter,
		prompt: parsed.content.trim(),
	};
};

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
						Effect.map((raw) => parseStep(resolved, raw)),
						Effect.catchAll((e) =>
							Effect.fail(
								new StepLoadError({
									message: `failed to read step '${source}': ${e instanceof Error ? e.message : String(e)}`,
									path: resolved,
								}),
							),
						),
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
				return Effect.succeed(parseStep(source, raw));
			},
		}),
};
