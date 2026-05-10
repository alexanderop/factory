import { Command, type CommandExecutor } from '@effect/platform';
import { Duration, Effect, Metric, Stream } from 'effect';
import { harnessSpawnsTotal } from './metrics.ts';
import type { HarnessCapabilities } from './capabilities.ts';
import {
	HarnessExecError,
	HarnessIdleTimeoutError,
	HarnessSpawnError,
	UnsupportedPermissionError,
} from './errors.ts';
import { HarnessName } from './ids.ts';
import type { ExecOpts, ExecResult, Harness, HarnessEvent, PermissionMode } from './types.ts';

export interface SubprocessHarnessConfig<Name extends string, P extends PermissionMode> {
	readonly name: Name;
	readonly bin: string;
	readonly capabilities: HarnessCapabilities & {
		readonly factory: { readonly permissions: ReadonlyArray<P>; readonly toolEvents: boolean };
	};
	readonly buildArgs: (prompt: string, ctx: { readonly permissions: P }) => ReadonlyArray<string>;
	readonly defaultPermissions?: P;
	/**
	 * Optional parser converting a single stdout line into one or more
	 * `HarnessEvent`s. When present, stdout is parsed instead of emitted as
	 * raw `{ type: 'stdout', line }`. Stderr is always emitted as raw lines.
	 */
	readonly parseStdoutLine?: (line: string) => ReadonlyArray<HarnessEvent>;
	/**
	 * Extra env injected into the subprocess only when OTel passthrough is
	 * active. Use for harness-specific opt-in flags (e.g.
	 * `CLAUDE_CODE_ENABLE_TELEMETRY=1`).
	 */
	readonly telemetryEnv?: Readonly<Record<string, string>>;
}

export const createSubprocessHarness = <Name extends string, const P extends PermissionMode>(
	config: SubprocessHarnessConfig<Name, P>,
): Harness<Name> => {
	const harnessName = HarnessName.make(config.name);
	const supports: ReadonlyArray<PermissionMode> = config.capabilities.factory.permissions;
	const isSupported = (mode: PermissionMode): mode is P => supports.includes(mode);

	const buildCommand = (
		opts: ExecOpts,
	): Effect.Effect<Command.Command, UnsupportedPermissionError> =>
		Effect.gen(function* () {
			if (!isSupported(opts.permissions)) {
				return yield* Effect.fail(
					new UnsupportedPermissionError({
						message: `harness '${config.name}' does not support permission mode '${opts.permissions}' (supported: ${supports.join(', ') || '(none)'})`,
						harness: harnessName,
						requested: opts.permissions,
						supported: supports,
					}),
				);
			}
			const base = Command.make(
				config.bin,
				...config.buildArgs(opts.prompt, { permissions: opts.permissions }),
			);
			const withStdin = Command.stdin(base, Stream.empty);
			const withCwd = opts.cwd ? Command.workingDirectory(withStdin, opts.cwd) : withStdin;
			return opts.env ? Command.env(withCwd, opts.env) : withCwd;
		});

	const toSpawnError = (e: unknown): HarnessSpawnError =>
		new HarnessSpawnError({
			message: `failed to spawn '${config.bin}': ${e instanceof Error ? e.message : String(e)}`,
			harness: harnessName,
			bin: config.bin,
		});

	const stdoutEvents = (
		bytes: Stream.Stream<Uint8Array, unknown>,
	): Stream.Stream<HarnessEvent, HarnessSpawnError> => {
		const lines = bytes.pipe(Stream.decodeText('utf-8'), Stream.splitLines);
		const parser = config.parseStdoutLine;
		const events = parser
			? lines.pipe(Stream.flatMap((line) => Stream.fromIterable(parser(line))))
			: lines.pipe(Stream.map((line) => ({ type: 'stdout', line }) satisfies HarnessEvent));
		return events.pipe(Stream.mapError(toSpawnError));
	};

	const stderrEvents = (
		bytes: Stream.Stream<Uint8Array, unknown>,
	): Stream.Stream<HarnessEvent, HarnessSpawnError> =>
		bytes.pipe(
			Stream.decodeText('utf-8'),
			Stream.splitLines,
			Stream.map((line) => ({ type: 'stderr', line }) satisfies HarnessEvent),
			Stream.mapError(toSpawnError),
		);

	const stream = (
		opts: ExecOpts,
	): Stream.Stream<
		HarnessEvent,
		HarnessSpawnError | HarnessIdleTimeoutError | UnsupportedPermissionError,
		CommandExecutor.CommandExecutor
	> => {
		const events: Stream.Stream<
			HarnessEvent,
			HarnessSpawnError | UnsupportedPermissionError,
			CommandExecutor.CommandExecutor
		> = Stream.unwrapScoped(
			Effect.gen(function* () {
				const command = yield* buildCommand(opts);
				const proc = yield* Command.start(command).pipe(
					Effect.mapError(toSpawnError),
					Effect.tap(() =>
						Metric.increment(harnessSpawnsTotal).pipe(
							Effect.tagMetrics('harness', config.name),
							Effect.tagMetrics('outcome', 'ok'),
						),
					),
					Effect.tapError(() =>
						Metric.increment(harnessSpawnsTotal).pipe(
							Effect.tagMetrics('harness', config.name),
							Effect.tagMetrics('outcome', 'error'),
						),
					),
					Effect.withSpan(`factory.harness.spawn ${config.name}`, {
						kind: 'producer',
						attributes: {
							'factory.harness': config.name,
							'factory.harness.bin': config.bin,
							'factory.permission.mode': opts.permissions,
							'factory.cwd': opts.cwd ?? '',
						},
					}),
				);
				const exit: Stream.Stream<HarnessEvent, HarnessSpawnError> = Stream.fromEffect(
					proc.exitCode.pipe(
						Effect.map((code) => ({ type: 'exit', code }) satisfies HarnessEvent),
						Effect.mapError(toSpawnError),
					),
				);
				return Stream.concat(
					Stream.merge(stdoutEvents(proc.stdout), stderrEvents(proc.stderr)),
					exit,
				);
			}),
		);

		const withTimeout =
			opts.idleTimeoutMs && opts.idleTimeoutMs > 0
				? events.pipe(
						Stream.timeoutFail(
							() =>
								new HarnessIdleTimeoutError({
									message: `harness '${config.name}' produced no output for ${opts.idleTimeoutMs}ms`,
									harness: harnessName,
									idleMs: opts.idleTimeoutMs ?? 0,
								}),
							Duration.millis(opts.idleTimeoutMs),
						),
					)
				: events;

		return withTimeout.pipe(
			Stream.withSpan(`factory.harness.stream ${config.name}`, {
				attributes: {
					'factory.harness': config.name,
					'factory.permission.mode': opts.permissions,
				},
			}),
		);
	};

	const exec = (
		opts: ExecOpts,
	): Effect.Effect<
		ExecResult,
		HarnessExecError | HarnessSpawnError | HarnessIdleTimeoutError | UnsupportedPermissionError,
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
		capabilities: config.capabilities,
		defaultPermissions: config.defaultPermissions,
		telemetryEnv: config.telemetryEnv,
		exec,
		stream,
	};
};
