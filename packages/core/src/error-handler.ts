import { Effect } from 'effect';

const isTagged = (e: unknown): e is { readonly _tag: string; readonly message?: string } =>
	typeof e === 'object' &&
	e !== null &&
	'_tag' in e &&
	typeof (e as { _tag: unknown })._tag === 'string';

export const formatErrorMessage = (error: unknown): string => {
	if (isTagged(error)) {
		const message = typeof error.message === 'string' ? error.message : String(error);
		return `[${error._tag}] ${message}`;
	}
	if (error instanceof Error) return error.message;
	return String(error);
};

/**
 * Print a one-line friendly summary on error and let `NodeRuntime.runMain`
 * drive the non-zero exit so layer finalizers (OTel span flush, etc.) run.
 * Pair with `runMain(eff, { disableErrorReporting: true })` to suppress the
 * default cause dump.
 */
export const withFriendlyErrors = <A, R>(
	effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, unknown, R> =>
	effect.pipe(
		Effect.tapError((error) =>
			Effect.sync(() => {
				console.error(`✖ ${formatErrorMessage(error)}`);
			}),
		),
	);
