import { FileSystem } from '@effect/platform';
import { NodeContext } from '@effect/platform-node';
import { describe, it } from '@effect/vitest';
import { assertInstanceOf, assertTrue, strictEqual } from '@effect/vitest/utils';
import { Cause, Effect, Exit, Layer } from 'effect';
import { StepLoadError } from './errors.ts';
import { FileStepLoader, InMemoryStepLoader, StepLoader } from './services/StepLoader.ts';

const FileLoaderLayer = FileStepLoader.layer.pipe(Layer.provideMerge(NodeContext.layer));

describe('StepLoader', () => {
	describe('FileStepLoader', () => {
		it.scoped('reads markdown + frontmatter from disk', () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-loader-' });
				yield* fs.writeFileString(
					`${dir}/plan.md`,
					'---\nname: plan\nharness: claude-code\nmaxIters: 1\n---\nWrite a plan for the PRD.\n',
				);

				const loader = yield* StepLoader;
				const loaded = yield* loader.load('plan.md', dir);
				strictEqual(loaded.frontmatter.name, 'plan');
				strictEqual(loaded.frontmatter.harness, 'claude-code');
				strictEqual(loaded.frontmatter.maxIters, 1);
				strictEqual(loaded.prompt, 'Write a plan for the PRD.');
				strictEqual(loaded.id, 'plan');
			}).pipe(Effect.provide(FileLoaderLayer)),
		);

		it.scoped('fails with StepLoadError when the file is missing', () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-loader-' });

				const loader = yield* StepLoader;
				const exit = yield* Effect.exit(loader.load('nope.md', dir));
				assertTrue(Exit.isFailure(exit));
				const failure = Cause.failureOption(exit.cause);
				assertTrue(failure._tag === 'Some');
				assertInstanceOf(failure.value, StepLoadError);
			}).pipe(Effect.provide(FileLoaderLayer)),
		);
	});

	describe('InMemoryStepLoader', () => {
		it.effect('returns parsed steps from the supplied map', () =>
			Effect.gen(function* () {
				const loader = yield* StepLoader;
				const loaded = yield* loader.load('./steps/plan.md', '/irrelevant');
				strictEqual(loaded.frontmatter.name, 'plan');
				strictEqual(loaded.prompt, 'Plan body.');
			}).pipe(
				Effect.provide(
					InMemoryStepLoader.layer(
						new Map([['./steps/plan.md', '---\nname: plan\n---\nPlan body.']]),
					),
				),
			),
		);

		it.effect('parses permissions frontmatter values', () =>
			Effect.gen(function* () {
				const loader = yield* StepLoader;
				const loaded = yield* loader.load('./steps/plan.md', '/irrelevant');
				strictEqual(loaded.frontmatter.permissions, 'read-only');
			}).pipe(
				Effect.provide(
					InMemoryStepLoader.layer(
						new Map([
							['./steps/plan.md', '---\nname: plan\npermissions: read-only\n---\nPlan body.'],
						]),
					),
				),
			),
		);

		it.effect('parses a requires block with nested capability requirements', () =>
			Effect.gen(function* () {
				const loader = yield* StepLoader;
				const loaded = yield* loader.load('./steps/plan.md', '/irrelevant');
				strictEqual(loaded.frontmatter.requires?.session?.resume, true);
				strictEqual(loaded.frontmatter.requires?.prompt?.image, true);
			}).pipe(
				Effect.provide(
					InMemoryStepLoader.layer(
						new Map([
							[
								'./steps/plan.md',
								'---\nname: plan\nrequires:\n  session:\n    resume: true\n  prompt:\n    image: true\n---\nPlan body.',
							],
						]),
					),
				),
			),
		);

		it.effect('rejects requires fields with the wrong type as a schema error', () =>
			Effect.gen(function* () {
				const loader = yield* StepLoader;
				const exit = yield* Effect.exit(loader.load('./steps/plan.md', '/irrelevant'));
				assertTrue(Exit.isFailure(exit));
				const failure = Cause.failureOption(exit.cause);
				assertTrue(failure._tag === 'Some');
				assertInstanceOf(failure.value, StepLoadError);
			}).pipe(
				Effect.provide(
					InMemoryStepLoader.layer(
						new Map([
							[
								'./steps/plan.md',
								'---\nname: plan\nrequires:\n  session:\n    resume: "yes"\n---\nPlan body.',
							],
						]),
					),
				),
			),
		);

		it.effect('rejects invalid permissions values with a schema error', () =>
			Effect.gen(function* () {
				const loader = yield* StepLoader;
				const exit = yield* Effect.exit(loader.load('./steps/plan.md', '/irrelevant'));
				assertTrue(Exit.isFailure(exit));
				const failure = Cause.failureOption(exit.cause);
				assertTrue(failure._tag === 'Some');
				assertInstanceOf(failure.value, StepLoadError);
			}).pipe(
				Effect.provide(
					InMemoryStepLoader.layer(
						new Map([['./steps/plan.md', '---\nname: plan\npermissions: yolo\n---\nPlan body.']]),
					),
				),
			),
		);

		it.effect('fails with StepLoadError for unknown sources', () =>
			Effect.gen(function* () {
				const loader = yield* StepLoader;
				const exit = yield* Effect.exit(loader.load('./missing.md', '/irrelevant'));
				assertTrue(Exit.isFailure(exit));
				const failure = Cause.failureOption(exit.cause);
				assertTrue(failure._tag === 'Some');
				assertInstanceOf(failure.value, StepLoadError);
			}).pipe(Effect.provide(InMemoryStepLoader.layer(new Map()))),
		);
	});
});
