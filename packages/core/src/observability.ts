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
 * Tool-name-aware structural attributes to set on a `factory.harness.tool <name>`
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

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');
const lineCount = (s: string): number => (s === '' ? 0 : s.split('\n').length);

const extractBashOutput = (
	output: unknown,
): { stdout?: string; stderr?: string; exitCode?: number; timedOut?: boolean } => {
	if (typeof output === 'string') {
		return { stdout: output };
	}
	if (!Predicate.isRecord(output)) return {};
	const stdout = typeof output.stdout === 'string' ? output.stdout : undefined;
	const stderr = typeof output.stderr === 'string' ? output.stderr : undefined;
	const exitCode =
		typeof output.exit_code === 'number'
			? output.exit_code
			: typeof output.exitCode === 'number'
				? output.exitCode
				: undefined;
	const timedOut =
		typeof output.timed_out === 'boolean'
			? output.timed_out
			: typeof output.timedOut === 'boolean'
				? output.timedOut
				: undefined;
	return { stdout, stderr, exitCode, timedOut };
};

const extractStringContent = (output: unknown): string | undefined => {
	if (typeof output === 'string') return output;
	if (Array.isArray(output)) {
		const parts: string[] = [];
		for (const block of output) {
			if (typeof block === 'string') parts.push(block);
			else if (Predicate.isRecord(block) && typeof block.text === 'string') parts.push(block.text);
		}
		return parts.length > 0 ? parts.join('') : undefined;
	}
	if (Predicate.isRecord(output) && typeof output.text === 'string') return output.text;
	return undefined;
};

/**
 * Tool-name-aware output attributes to add to a `factory.harness.tool <name>`
 * span at end. Returns undefined-free attributes; absent fields are simply
 * omitted (a `0` would imply the tool ran and produced nothing).
 */
export const toolOutputAttributes = (
	tool: string,
	output: unknown,
	_ok: boolean,
): Readonly<Record<string, string | number | boolean>> => {
	switch (tool) {
		case 'Bash': {
			const out = extractBashOutput(output);
			const attrs: Record<string, string | number | boolean> = {};
			if (out.exitCode !== undefined) attrs['tool.exit_code'] = out.exitCode;
			if (out.stdout !== undefined) attrs['tool.stdout.bytes'] = byteLength(out.stdout);
			if (out.stderr !== undefined) attrs['tool.stderr.bytes'] = byteLength(out.stderr);
			if (out.timedOut !== undefined) attrs['tool.timed_out'] = out.timedOut;
			return attrs;
		}
		case 'Read': {
			const text = extractStringContent(output);
			if (text === undefined) return {};
			return {
				'tool.file.bytes': byteLength(text),
				'tool.file.lines': lineCount(text),
			};
		}
		case 'Write':
		case 'Edit':
		case 'NotebookEdit': {
			if (!Predicate.isRecord(output)) return {};
			const attrs: Record<string, string | number | boolean> = {};
			if (typeof output.bytes_before === 'number')
				attrs['tool.file.bytes_before'] = output.bytes_before;
			if (typeof output.bytes_after === 'number')
				attrs['tool.file.bytes_after'] = output.bytes_after;
			if (typeof output.lines_added === 'number') attrs['tool.lines_added'] = output.lines_added;
			if (typeof output.lines_removed === 'number')
				attrs['tool.lines_removed'] = output.lines_removed;
			return attrs;
		}
		case 'Glob':
		case 'Grep': {
			const text = extractStringContent(output);
			if (text === undefined) {
				if (Predicate.isRecord(output) && typeof output.matches === 'number') {
					return { 'tool.matches.count': output.matches };
				}
				return {};
			}
			const trimmed = text.trim();
			if (trimmed === '') return { 'tool.matches.count': 0 };
			return { 'tool.matches.count': trimmed.split('\n').length };
		}
		default:
			return {};
	}
};
