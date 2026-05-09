import { Command, type CommandExecutor } from '@effect/platform';
import { Duration, Effect, Stream } from 'effect';
import { HarnessExecError, HarnessSpawnError, StepIdleTimeoutError } from './errors.ts';
import { HarnessName, StepId } from './ids.ts';
import type { ExecOpts, ExecResult, Harness, HarnessEvent } from './types.ts';

/** State threaded through per-harness line parsers across calls. */
export type ParserState = Record<string, unknown>;

/** Per-harness structured-output parser. Returns new events and updated state. */
export type ParseLine = (
	line: string,
	state: ParserState,
) => { events: ReadonlyArray<HarnessEvent>; state: ParserState };

/** Default parser: every line is emitted as a raw stdout/stderr event. */
const identityParser: ParseLine = (line, state) => ({
	events: [],
	state,
});

export interface SubprocessHarnessConfig<Name extends string = string> {
	readonly name: Name;
	readonly bin: string;
	readonly buildArgs: (prompt: string) => ReadonlyArray<string>;
	/**
	 * Optional per-harness parser. Receives each raw stdout line and the current
	 * parser state. Returns derived `HarnessEvent`s (e.g. `tool_use`, `tool_result`,
	 * `usage`) and the updated state.
	 *
	 * Raw `stdout`/`stderr` events are always emitted regardless of this parser;
	 * the parser only *adds* structured events on top of them.
	 * Omit (or return `[]`) to keep raw-text-only behaviour.
	 */
	readonly parseLine?: ParseLine;
}

export const createSubprocessHarness = <Name extends string>(
	config: SubprocessHarnessConfig<Name>,
): Harness<Name> => {
	const harnessName = HarnessName.make(config.name);
	const parse = config.parseLine ?? identityParser;

	const buildCommand = (opts: ExecOpts): Command.Command => {
		const base = Command.make(config.bin, ...config.buildArgs(opts.prompt));
		const withCwd = opts.cwd ? Command.workingDirectory(base, opts.cwd) : base;
		return opts.env ? Command.env(withCwd, opts.env) : withCwd;
	};

	const toSpawnError = (e: unknown): HarnessSpawnError =>
		new HarnessSpawnError({
			message: `failed to spawn '${config.bin}': ${e instanceof Error ? e.message : String(e)}`,
			harness: harnessName,
			bin: config.bin,
		});

	const lineEvents = (
		bytes: Stream.Stream<Uint8Array, unknown>,
		streamType: 'stdout' | 'stderr',
	): Stream.Stream<HarnessEvent, HarnessSpawnError> => {
		let parserState: ParserState = {};
		return bytes.pipe(
			Stream.decodeText('utf-8'),
			Stream.splitLines,
			Stream.flatMap((line) => {
				const rawEvent: HarnessEvent = { type: streamType, line };
				if (streamType === 'stdout') {
					const result = parse(line, parserState);
					parserState = result.state;
					return Stream.fromIterable([rawEvent, ...result.events]);
				}
				return Stream.make(rawEvent);
			}),
			Stream.mapError(toSpawnError),
		);
	};

	const stream = (
		opts: ExecOpts,
	): Stream.Stream<
		HarnessEvent,
		HarnessSpawnError | StepIdleTimeoutError,
		CommandExecutor.CommandExecutor
	> => {
		const events: Stream.Stream<HarnessEvent, HarnessSpawnError, CommandExecutor.CommandExecutor> =
			Stream.unwrapScoped(
				Effect.gen(function* () {
					const proc = yield* Command.start(buildCommand(opts)).pipe(Effect.mapError(toSpawnError));
					const exit: Stream.Stream<HarnessEvent, HarnessSpawnError> = Stream.fromEffect(
						proc.exitCode.pipe(
							Effect.map((code) => ({ type: 'exit', code }) satisfies HarnessEvent),
							Effect.mapError(toSpawnError),
						),
					);
					return Stream.concat(
						Stream.merge(lineEvents(proc.stdout, 'stdout'), lineEvents(proc.stderr, 'stderr')),
						exit,
					);
				}),
			);

		if (opts.idleTimeoutMs && opts.idleTimeoutMs > 0) {
			const ms = opts.idleTimeoutMs;
			return events.pipe(
				Stream.timeoutFail(
					() =>
						new StepIdleTimeoutError({
							message: `harness '${config.name}' produced no output for ${ms}ms`,
							step: StepId.make(''),
							timeoutMs: ms,
						}),
					Duration.millis(ms),
				),
			);
		}
		return events;
	};

	const exec = (
		opts: ExecOpts,
	): Effect.Effect<
		ExecResult,
		HarnessExecError | HarnessSpawnError | StepIdleTimeoutError,
		CommandExecutor.CommandExecutor
	> =>
		Effect.gen(function* () {
			const stdoutLines: string[] = [];
			const stderrLines: string[] = [];
			let exitCode = 0;

			yield* Stream.runForEach(stream(opts), (event) =>
				Effect.sync(() => {
					if (event.type === 'stdout') stdoutLines.push(event.line);
					else if (event.type === 'stderr') stderrLines.push(event.line);
					else if (event.type === 'exit') exitCode = event.code;
				}),
			);

			const stdout = stdoutLines.length === 0 ? '' : `${stdoutLines.join('\n')}\n`;
			const stderr = stderrLines.length === 0 ? '' : `${stderrLines.join('\n')}\n`;

			if (exitCode !== 0) {
				return yield* Effect.fail(
					new HarnessExecError({
						message: `harness '${config.name}' exited with code ${exitCode}`,
						harness: harnessName,
						exitCode,
						stderr: stderr.trim(),
					}),
				);
			}

			return { exitCode, stdout, stderr } satisfies ExecResult;
		});

	return {
		name: config.name,
		exec,
		stream,
	};
};
