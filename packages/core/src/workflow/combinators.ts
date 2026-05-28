import { Effect, Option } from 'effect';

export interface ConcurrencyOptions {
	readonly concurrency?: number | 'unbounded';
}

/**
 * Run a batch of agent thunks as a barrier with bounded concurrency. A failing
 * thunk becomes `null` (via `Effect.option`) rather than failing the whole
 * batch — callers `.filter(Boolean)` the result. The overall Effect never fails.
 */
export const parallel = <A, E, R>(
	thunks: ReadonlyArray<() => Effect.Effect<A, E, R>>,
	options: ConcurrencyOptions = {},
): Effect.Effect<ReadonlyArray<A | null>, never, R> =>
	Effect.all(
		thunks.map((t) => Effect.option(t())),
		{ concurrency: options.concurrency ?? 'unbounded' },
	).pipe(Effect.map((opts) => opts.map((o) => Option.getOrNull(o))));

/**
 * Flow each item through every stage with bounded concurrency. There is NO
 * barrier between stages: each item proceeds through all stages independently,
 * so stage 2 of item A can run while stage 1 of item B is still running.
 *
 * Stages share a single carried type `T` (each stage maps `T -> Effect<T>`),
 * which keeps the variadic-stage surface fully typed without casts.
 */
export const pipeline = <T, E, R>(
	items: ReadonlyArray<T>,
	stages: ReadonlyArray<(input: T) => Effect.Effect<T, E, R>>,
	options: ConcurrencyOptions = {},
): Effect.Effect<ReadonlyArray<T>, E, R> =>
	Effect.forEach(
		items,
		(item) =>
			stages.reduce<Effect.Effect<T, E, R>>(
				(acc, stage) => Effect.flatMap(acc, stage),
				Effect.succeed(item),
			),
		{ concurrency: options.concurrency ?? 'unbounded' },
	);
