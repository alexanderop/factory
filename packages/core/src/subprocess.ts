import { Command, type CommandExecutor } from '@effect/platform';
import { Duration, Effect, Stream } from 'effect';
import { HarnessExecError, HarnessSpawnError, StepIdleTimeoutError } from './errors.ts';
import { HarnessName, StepId } from './ids.ts';
import type { ExecOpts, ExecResult, Harness, HarnessEvent, PermissionMode } from './types.ts';

export interface SubprocessHarnessConfig<Name extends string, P extends PermissionMode> {
	readonly name: Name;
	readonly bin: string;
	readonly supports: ReadonlyArray<P>;
	readonly buildArgs: (prompt: string, ctx: { readonly permissions: P }) => ReadonlyArray<string>;
	readonly defaultPermissions?: P;
}

export const createSubprocessHarness = <Name extends string, const P extends PermissionMode>(
	config: SubprocessHarnessConfig<Name, P>,
): Harness<Name> => {
	const harnessName = HarnessName.make(config.name);
	const supports: ReadonlyArray<PermissionMode> = config.supports;
	const isSupported = (mode: PermissionMode): mode is P => supports.includes(mode);

	const buildCommand = (opts: ExecOpts): Command.Command => {
		if (!isSupported(opts.permissions)) {
			throw new Error(
				`harness '${config.name}' does not support permission mode '${opts.permissions}' (orchestrator should have rejected this earlier)`,
			);
		}
		const base = Command.make(
			config.bin,
			...config.buildArgs(opts.prompt, { permissions: opts.permissions }),
		);
		const withStdin = Command.stdin(base, Stream.empty);
		const withCwd = opts.cwd ? Command.workingDirectory(withStdin, opts.cwd) : withStdin;
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
		type: 'stdout' | 'stderr',
	): Stream.Stream<HarnessEvent, HarnessSpawnError> =>
		bytes.pipe(
			Stream.decodeText('utf-8'),
			Stream.splitLines,
			Stream.map((line) => ({ type, line }) satisfies HarnessEvent),
			Stream.mapError(toSpawnError),
		);

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
		supports: config.supports,
		defaultPermissions: config.defaultPermissions,
		exec,
		stream,
	};
};
