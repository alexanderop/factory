import { FileSystem } from '@effect/platform';
import { NodeContext } from '@effect/platform-node';
import { describe, it } from '@effect/vitest';
import { assertTrue, strictEqual } from '@effect/vitest/utils';
import { Effect, Layer } from 'effect';
import { UntilEvalError } from './errors.ts';
import { DefaultUntilEvaluator, UntilEvaluator } from './services/UntilEvaluator.ts';
import { assertExitFailedWith, makeStepId } from './testing/index.ts';
import type { ExecResult } from './types.ts';

const makeExecResult = (overrides: Partial<ExecResult> = {}): ExecResult => ({
	exitCode: 0,
	stdout: '',
	stderr: '',
	...overrides,
});

const step = makeStepId('ralph');

// `evaluate` always returns `Effect<…, …, CommandExecutor>` (even branches that
// never spawn). NodeContext supplies CommandExecutor + FileSystem + Path, so we
// merge it into the layer for every test.
const testLayer = DefaultUntilEvaluator.layer.pipe(Layer.provideMerge(NodeContext.layer));

describe('DefaultUntilEvaluator', () => {
	describe('"output contains: <needle>"', () => {
		it.effect('returns true when stdout includes the needle', () =>
			Effect.gen(function* () {
				const evaluator = yield* UntilEvaluator;
				const verdict = yield* evaluator.evaluate('output contains: DONE', {
					step,
					cwd: '/unused',
					lastResult: makeExecResult({ stdout: 'work finished — DONE\n' }),
				});
				strictEqual(verdict, true);
			}).pipe(Effect.provide(testLayer)),
		);

		it.effect('returns false when stdout does not include the needle', () =>
			Effect.gen(function* () {
				const evaluator = yield* UntilEvaluator;
				const verdict = yield* evaluator.evaluate('output contains: DONE', {
					step,
					cwd: '/unused',
					lastResult: makeExecResult({ stdout: 'in progress\n' }),
				});
				strictEqual(verdict, false);
			}).pipe(Effect.provide(testLayer)),
		);

		it.effect('matches the prefix case-insensitively (needle match remains exact)', () =>
			Effect.gen(function* () {
				const evaluator = yield* UntilEvaluator;
				const verdict = yield* evaluator.evaluate('OUTPUT CONTAINS: DONE', {
					step,
					cwd: '/unused',
					lastResult: makeExecResult({ stdout: 'big banner: DONE!\n' }),
				});
				strictEqual(verdict, true);
			}).pipe(Effect.provide(testLayer)),
		);
	});

	it.effect('treats unknown DSL as already-satisfied (returns true)', () =>
		Effect.gen(function* () {
			const evaluator = yield* UntilEvaluator;
			const verdict = yield* evaluator.evaluate('manual review please', {
				step,
				cwd: '/unused',
				lastResult: makeExecResult(),
			});
			strictEqual(verdict, true);
		}).pipe(Effect.provide(testLayer)),
	);

	describe('"tests pass"', () => {
		it.scoped('returns true when `pnpm test` exits 0', () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-until-' });
				yield* fs.writeFileString(
					`${dir}/package.json`,
					JSON.stringify({
						name: 'factory-until-pass',
						scripts: { test: "node -e 'process.exit(0)'" },
					}),
				);

				const evaluator = yield* UntilEvaluator;
				const verdict = yield* evaluator.evaluate('tests pass', {
					step,
					cwd: dir,
					lastResult: makeExecResult(),
				});
				strictEqual(verdict, true);
			}).pipe(Effect.provide(testLayer)),
		);

		it.scoped('returns false when `pnpm test` exits non-zero', () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-until-' });
				yield* fs.writeFileString(
					`${dir}/package.json`,
					JSON.stringify({
						name: 'factory-until-fail',
						scripts: { test: "node -e 'process.exit(1)'" },
					}),
				);

				const evaluator = yield* UntilEvaluator;
				const verdict = yield* evaluator.evaluate('tests pass', {
					step,
					cwd: dir,
					lastResult: makeExecResult(),
				});
				strictEqual(verdict, false);
			}).pipe(Effect.provide(testLayer)),
		);

		it.effect('wraps a spawn failure in UntilEvalError with step + until fields', () =>
			Effect.gen(function* () {
				const evaluator = yield* UntilEvaluator;
				const exit = yield* evaluator
					.evaluate('tests pass', {
						step,
						cwd: '/nonexistent/path/9999',
						lastResult: makeExecResult(),
					})
					.pipe(Effect.exit);

				const error = assertExitFailedWith(exit, UntilEvalError);
				strictEqual(error.step, step);
				strictEqual(error.until, 'tests pass');
				assertTrue(error.message.includes(step));
			}).pipe(Effect.provide(testLayer)),
		);
	});
});
