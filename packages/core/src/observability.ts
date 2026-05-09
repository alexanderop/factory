import { Effect, Inspectable, Metric, Predicate } from 'effect';
import { errorsTotal, idleTimeoutsTotal } from './metrics.ts';

/**
 * Wraps an effect so any tagged error annotates the active span with
 * `factory.error._tag` / `factory.error.message`, increments
 * `factory.errors_total{tag=…}`, bumps `factory.idle_timeouts_total` if
 * applicable, and logs at error level. Re-fails the original error untouched.
 */
export const recordTaggedError = <
	R,
	A,
	E extends { readonly _tag: string; readonly message?: string },
>(
	eff: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
	eff.pipe(
		Effect.tapError((error) => {
			const incrementErrorMetric = Metric.increment(errorsTotal).pipe(
				Effect.tagMetrics('tag', error._tag),
			);
			const incrementIdle =
				error._tag === 'StepIdleTimeoutError' ? Metric.increment(idleTimeoutsTotal) : Effect.void;
			return Effect.all(
				[
					Effect.annotateCurrentSpan({
						'factory.error._tag': error._tag,
						'factory.error.message': error.message ?? '',
					}),
					incrementErrorMetric,
					incrementIdle,
					Effect.logError(`factory error [${error._tag}]`, error),
				],
				{ discard: true },
			);
		}),
	);

const TOOL_INPUT_SUMMARY_MAX = 200;

const stringifyOnce = (value: unknown): string =>
	value === undefined || value === null ? '' : Inspectable.toStringUnknown(value, 0);

const truncate = (s: string, max: number): string =>
	s.length <= max ? s : `${s.slice(0, max)}…(${s.length - max} more)`;

/**
 * Single-pass stringify for span-attribute summaries: returns the truncated
 * summary and the original byte length, so callers don't `JSON.stringify`
 * the same value twice in the hot path.
 */
export const describeForSpan = (
	value: unknown,
	max: number = TOOL_INPUT_SUMMARY_MAX,
): { readonly summary: string; readonly bytes: number } => {
	const json = stringifyOnce(value);
	return { summary: truncate(json, max), bytes: json.length };
};

/**
 * Tool-name-aware structural attributes to set on a `factory.harness.tool`
 * span. Avoids putting full inputs on spans; prefers a few key fields per
 * known tool shape. Unknown tools: just the summary.
 */
export const toolInputAttributes = (
	tool: string,
	input: unknown,
): Readonly<Record<string, string | number | boolean>> => {
	if (!Predicate.isRecord(input)) return {};
	switch (tool) {
		case 'Bash': {
			const cmd = typeof input.command === 'string' ? input.command : '';
			return {
				'tool.cmd.head': cmd.slice(0, TOOL_INPUT_SUMMARY_MAX),
				'tool.cmd.bytes': cmd.length,
			};
		}
		case 'Read':
		case 'Write':
		case 'Edit':
		case 'NotebookEdit': {
			const filePath = typeof input.file_path === 'string' ? input.file_path : '';
			return { 'tool.file_path': filePath };
		}
		case 'Glob':
		case 'Grep': {
			const pattern = typeof input.pattern === 'string' ? input.pattern : '';
			return { 'tool.pattern': pattern };
		}
		default:
			return {};
	}
};
