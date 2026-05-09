import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeContext } from '@effect/platform-node';
import { Cause, Effect, Exit, Layer } from 'effect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StepLoadError } from './errors.ts';
import { FileStepLoader, InMemoryStepLoader, StepLoader } from './services/StepLoader.ts';

describe('StepLoader', () => {
	describe('FileStepLoader', () => {
		let dir: string;

		beforeAll(() => {
			dir = mkdtempSync(join(tmpdir(), 'factory-loader-'));
			writeFileSync(
				join(dir, 'plan.md'),
				'---\nname: plan\nharness: claude-code\nmaxIters: 1\n---\nWrite a plan for the PRD.\n',
			);
		});

		afterAll(() => {
			rmSync(dir, { recursive: true, force: true });
		});

		it('reads markdown + frontmatter from disk', async () => {
			const program = Effect.gen(function* () {
				const loader = yield* StepLoader;
				return yield* loader.load('plan.md', dir);
			}).pipe(Effect.provide(FileStepLoader.layer.pipe(Layer.provide(NodeContext.layer))));

			const loaded = await Effect.runPromise(program);
			expect(loaded.frontmatter.name).toBe('plan');
			expect(loaded.frontmatter.harness).toBe('claude-code');
			expect(loaded.frontmatter.maxIters).toBe(1);
			expect(loaded.prompt).toBe('Write a plan for the PRD.');
			expect(loaded.id).toBe('plan');
		});

		it('fails with StepLoadError when the file is missing', async () => {
			const program = Effect.gen(function* () {
				const loader = yield* StepLoader;
				return yield* loader.load('nope.md', dir);
			}).pipe(Effect.provide(FileStepLoader.layer.pipe(Layer.provide(NodeContext.layer))));

			const exit = await Effect.runPromiseExit(program);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				const error = exit.cause.toString();
				expect(error).toContain('StepLoadError');
			}
		});
	});

	describe('InMemoryStepLoader', () => {
		it('returns parsed steps from the supplied map', async () => {
			const map = new Map([['./steps/plan.md', '---\nname: plan\n---\nPlan body.']]);

			const program = Effect.gen(function* () {
				const loader = yield* StepLoader;
				return yield* loader.load('./steps/plan.md', '/irrelevant');
			}).pipe(Effect.provide(InMemoryStepLoader.layer(map)));

			const loaded = await Effect.runPromise(program);
			expect(loaded.frontmatter.name).toBe('plan');
			expect(loaded.prompt).toBe('Plan body.');
		});

		it('fails with StepLoadError for unknown sources', async () => {
			const program = Effect.gen(function* () {
				const loader = yield* StepLoader;
				return yield* loader.load('./missing.md', '/irrelevant');
			}).pipe(Effect.provide(InMemoryStepLoader.layer(new Map())));

			const exit = await Effect.runPromiseExit(program);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				const failure = Cause.failureOption(exit.cause);
				expect(failure._tag === 'Some' && failure.value instanceof StepLoadError).toBe(true);
			}
		});
	});
});
