import { Command, type CommandExecutor } from '@effect/platform';
import { Duration, Effect, Metric, Redacted, Stream } from 'effect';
import { harnessSpawnsTotal } from './metrics.ts';
import type { HarnessCapabilities } from './capabilities.ts';
import { HarnessAuthError, HarnessExecError, HarnessSpawnError, StepIdleTimeoutError } from './errors.ts';
import { HarnessName, StepId } from './ids.ts';
import type {
	ExecOpts,
	ExecResult,
	Harness,
	HarnessAuth,
	HarnessAuthSpec,
	HarnessEvent,
	PermissionMode,
} from './types.ts';

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
	readonly auth?: HarnessAuthSpec;
}

export const createSubprocessHarness = <Name extends string, const P extends PermissionMode>(
	config: SubprocessHarnessConfig<Name, P>,
): Harness<Name> => {
	const harnessName = HarnessName.make(config.name);
	const supports: ReadonlyArray<PermissionMode> = config.capabilities.factory.permissions;
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
		HarnessSpawnError | StepIdleTimeoutError,
		CommandExecutor.CommandExecutor
	> => {
		const events: Stream.Stream<HarnessEvent, HarnessSpawnError, CommandExecutor.CommandExecutor> =
			Stream.unwrapScoped(
				Effect.gen(function* () {
					const proc = yield* Command.start(buildCommand(opts)).pipe(
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
								new StepIdleTimeoutError({
									message: `harness '${config.name}' produced no output for ${opts.idleTimeoutMs}ms`,
									step: StepId.make(''),
									timeoutMs: opts.idleTimeoutMs ?? 0,
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

	const harness: Harness<Name> = {
		name: config.name,
		capabilities: config.capabilities,
		defaultPermissions: config.defaultPermissions,
		telemetryEnv: config.telemetryEnv,
		auth: config.auth,
		withAuth: (auth) => withAuth(harness, auth),
		exec,
		stream,
	};
	return harness;
};

/** Build the env record for a given `HarnessAuth` variant. */
const buildResolveAuthEnv = <Name extends string>(
	harness: Harness<Name>,
	auth: HarnessAuth,
): Effect.Effect<Record<string, string>, HarnessAuthError> => {
	// Lazily-cached effect for Helper variant, created once per withAuth call.
	// Stored outside the returned Effect so it persists across exec/stream calls.
	let cachedFetch: Effect.Effect<Readonly<Record<string, string>>, HarnessAuthError> | null =
		null;

	switch (auth._tag) {
		case 'Inherit':
			return Effect.succeed({});

		case 'ApiKey': {
			const spec = harness.auth;
			if (!spec || spec.envVars.length === 0) {
				return Effect.fail(
					new HarnessAuthError({
						message: `harness '${harness.name}' has no auth spec; ApiKey requires at least one envVar entry`,
						harness: HarnessName.make(harness.name),
					}),
				);
			}
			const firstVar = spec.envVars[0];
			if (firstVar === undefined) {
				return Effect.fail(
					new HarnessAuthError({
						message: `harness '${harness.name}' auth spec has no envVar entries`,
						harness: HarnessName.make(harness.name),
					}),
				);
			}
			return Effect.succeed({ [firstVar.name]: Redacted.value(auth.value) });
		}

		case 'Env': {
			const resolved: Record<string, string> = {};
			for (const [k, v] of Object.entries(auth.env)) {
				resolved[k] = typeof v === 'string' ? v : Redacted.value(v);
			}
			return Effect.succeed(resolved);
		}

		case 'Helper': {
			const ttl = auth.ttl ?? Duration.minutes(5);
			// Each call to resolveAuthEnv re-enters this Effect.gen; the mutable
			// `cachedFetch` ensures Effect.cachedWithTTL is only created once.
			return Effect.gen(function* () {
				if (cachedFetch === null) {
					cachedFetch = yield* Effect.cachedWithTTL(auth.fetch, ttl);
				}
				return yield* cachedFetch;
			});
		}
	}
};

const mergedOpts = (authEnv: Record<string, string>, opts: ExecOpts): ExecOpts => ({
	...opts,
	env: { ...authEnv, ...opts.env },
});

const authKindStr = (auth: HarnessAuth): string => {
	switch (auth._tag) {
		case 'ApiKey':
			return 'api-key';
		case 'Env':
			return 'env';
		case 'Helper':
			return 'helper';
		case 'Inherit':
			return 'inherit';
	}
};

/**
 * Wraps a harness with credential resolution. Auth env is merged before
 * step-level `opts.env` so step-level values always take precedence.
 * Span attributes `factory.harness.auth.kind` and `factory.harness.auth.envKeys`
 * are annotated on the current span during auth resolution.
 */
export const withAuth = <Name extends string>(
	harness: Harness<Name>,
	auth: HarnessAuth,
): Harness<Name> => {
	const resolveAuthEnv = buildResolveAuthEnv(harness, auth);
	const kind = authKindStr(auth);

	const annotateAndResolve = resolveAuthEnv.pipe(
		Effect.tap((authEnv) =>
			Effect.annotateCurrentSpan({
				'factory.harness.auth.kind': kind,
				'factory.harness.auth.envKeys': Object.keys(authEnv).toSorted().join(','),
			}),
		),
	);

	const wrappedHarness: Harness<Name> = {
		...harness,
		withAuth: (newAuth) => withAuth(harness, newAuth),
		exec: (opts) =>
			Effect.flatMap(annotateAndResolve, (authEnv) => harness.exec(mergedOpts(authEnv, opts))),
		stream: (opts) =>
			Stream.flatMap(Stream.fromEffect(annotateAndResolve), (authEnv) =>
				harness.stream(mergedOpts(authEnv, opts)),
			),
	};
	return wrappedHarness;
};
