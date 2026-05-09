import { Command, type CommandExecutor } from '@effect/platform';
import { Context, Effect, Layer } from 'effect';
import { UntilEvalError } from '../errors.ts';
import type { StepId } from '../ids.ts';
import type { ExecResult } from '../types.ts';

export interface UntilEvalCtx {
	readonly step: StepId;
	readonly cwd: string;
	readonly lastResult: ExecResult;
}

export interface UntilEvaluatorService {
	readonly evaluate: (
		until: string,
		ctx: UntilEvalCtx,
	) => Effect.Effect<boolean, UntilEvalError, CommandExecutor.CommandExecutor>;
}

export class UntilEvaluator extends Context.Tag('@factory/UntilEvaluator')<
	UntilEvaluator,
	UntilEvaluatorService
>() {}

const OUTPUT_CONTAINS_PREFIX = 'output contains:';

/**
 * Production until evaluator.
 *
 * Recognised DSL:
 *  - `"tests pass"` — run `pnpm test` in `cwd`, succeed on exit code 0.
 *  - `"output contains: <needle>"` — match `<needle>` against the last harness stdout.
 *  - anything else — treated as already-satisfied (so unknown predicates terminate
 *    after one iteration rather than looping forever).
 */
export const DefaultUntilEvaluator = {
	layer: Layer.succeed(UntilEvaluator, {
		evaluate: (until, ctx) => {
			const trimmed = until.trim();
			const lower = trimmed.toLowerCase();

			if (lower === 'tests pass') {
				const cmd = Command.make('pnpm', 'test').pipe(
					Command.workingDirectory(ctx.cwd),
					Command.stdout('inherit'),
					Command.stderr('inherit'),
				);
				return Command.exitCode(cmd).pipe(
					Effect.map((code) => code === 0),
					Effect.catchAll((e) =>
						Effect.fail(
							new UntilEvalError({
								message: `failed to run 'pnpm test' for step '${ctx.step}': ${
									e instanceof Error ? e.message : String(e)
								}`,
								step: ctx.step,
								until,
							}),
						),
					),
				);
			}

			if (lower.startsWith(OUTPUT_CONTAINS_PREFIX)) {
				const needle = trimmed.slice(OUTPUT_CONTAINS_PREFIX.length).trim();
				return Effect.succeed(ctx.lastResult.stdout.includes(needle));
			}

			return Effect.succeed(true);
		},
	} satisfies UntilEvaluatorService),
};

/** Test layer: returns the next entry from `verdicts` on each call, cycling. */
export const scriptedUntilEvaluator = {
	layer: (verdicts: ReadonlyArray<boolean>): Layer.Layer<UntilEvaluator> => {
		let cursor = 0;
		return Layer.succeed(UntilEvaluator, {
			evaluate: () => {
				const verdict = verdicts[cursor % Math.max(verdicts.length, 1)] ?? true;
				cursor++;
				return Effect.succeed(verdict);
			},
		} satisfies UntilEvaluatorService);
	},
};
