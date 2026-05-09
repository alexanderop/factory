import { Args, Command, Options } from '@effect/cli';
import { FileSystem, Path } from '@effect/platform';
import { Effect, Option, Predicate } from 'effect';
import {
	ConfigLoadError,
	type Factory,
	PermissionMode,
	readRun,
	ResumeUnavailableError,
	type RunRecordingError,
} from '@factory/core';

const VERSION = '0.0.0';

const nameArg = Args.text({ name: 'name' }).pipe(
	Args.withDescription(
		'Name of the factory pipeline to run (matches factory({name}) in your config)',
	),
);

const prdOption = Options.text('prd').pipe(
	Options.withDescription('PRD: a markdown file path or inline text'),
);

const cwdOption = Options.directory('cwd').pipe(
	Options.withDescription('Working directory (default: process.cwd())'),
	Options.optional,
);

const noOtelOption = Options.boolean('no-otel').pipe(
	Options.withDescription('Disable OpenTelemetry export'),
);

const idleTimeoutOption = Options.integer('idle-timeout').pipe(
	Options.withDescription('Per-step idle timeout in seconds (default: no timeout)'),
	Options.optional,
);

const permissionsOption = Options.choice('permissions', PermissionMode.literals).pipe(
	Options.withDescription('Override permission mode for this run (top of precedence)'),
	Options.optional,
);

const CANDIDATES = [
	'.factory/factory.ts',
	'.factory/factory.js',
	'factory.config.ts',
	'factory.config.js',
] as const;

const isModuleNotFound = (e: unknown): boolean =>
	Predicate.isRecord(e) && e.code === 'ERR_MODULE_NOT_FOUND';

const isFactory = (v: unknown): v is Factory =>
	Predicate.isRecord(v) &&
	typeof v.name === 'string' &&
	typeof v.step === 'function' &&
	typeof v.run === 'function' &&
	typeof v.runEffect === 'function';

const loadFactoryConfig = (
	cwd: string,
	name: string,
): Effect.Effect<Factory, ConfigLoadError, Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;

		for (const rel of CANDIDATES) {
			const candidate = path.resolve(cwd, rel);
			const result = yield* Effect.tryPromise({
				try: () => import(/* @vite-ignore */ candidate),
				catch: (e) => e,
			}).pipe(Effect.either);

			if (result._tag === 'Left') {
				if (isModuleNotFound(result.left)) continue;
				const e = result.left;
				return yield* Effect.fail(
					new ConfigLoadError({
						message: `failed to import ${candidate}: ${e instanceof Error ? e.message : String(e)}`,
						cwd,
					}),
				);
			}

			const mod: unknown = result.right;
			if (!Predicate.isRecord(mod)) {
				return yield* Effect.fail(
					new ConfigLoadError({
						message: `${candidate} did not export a module object`,
						cwd,
					}),
				);
			}
			const def = mod.default ?? mod[name];
			if (!isFactory(def)) {
				return yield* Effect.fail(
					new ConfigLoadError({
						message: `${candidate} does not export a factory (default or named '${name}')`,
						cwd,
					}),
				);
			}
			if (def.name !== name) {
				return yield* Effect.fail(
					new ConfigLoadError({
						message: `factory in ${candidate} is named '${def.name}', expected '${name}'`,
						cwd,
					}),
				);
			}
			return def;
		}

		return yield* Effect.fail(
			new ConfigLoadError({
				message: `no factory config found in ${cwd}. Expected one of: ${CANDIDATES.join(', ')}`,
				cwd,
			}),
		);
	});

const runCommand = Command.make(
	'run',
	{
		name: nameArg,
		prd: prdOption,
		cwd: cwdOption,
		noOtel: noOtelOption,
		idleTimeout: idleTimeoutOption,
		permissions: permissionsOption,
	},
	({ name, prd, cwd: cwdOpt, noOtel, idleTimeout, permissions }) =>
		Effect.gen(function* () {
			const path = yield* Path.Path;
			const cwd = Option.getOrUndefined(cwdOpt) ?? path.resolve(process.cwd());
			const idleTimeoutMs = Option.getOrUndefined(Option.map(idleTimeout, (s) => s * 1000));
			const permissionsMode = Option.getOrUndefined(permissions);

			const factoryDef = yield* loadFactoryConfig(cwd, name);
			yield* factoryDef.runEffect({
				prd,
				cwd,
				idleTimeoutMs,
				permissions: permissionsMode,
				otel: !noOtel,
			});
		}),
);

const resolveRunId = (runsDir: string, runIdArg: string) =>
	Effect.gen(function* () {
		if (runIdArg !== 'latest') return runIdArg;
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		return yield* fs.readLink(path.join(runsDir, 'latest')).pipe(
			Effect.mapError(
				(e) =>
					new ResumeUnavailableError({
						message: `failed to resolve 'latest' symlink in ${runsDir}: ${e.message}`,
						reason: 'not-found',
					}),
			),
		);
	});

const resumeCommand = Command.make(
	'resume',
	{
		runId: Args.text({ name: 'run-id' }).pipe(
			Args.withDescription('Run id to resume, or "latest" for the most recent run'),
		),
		cwd: cwdOption,
		noOtel: noOtelOption,
		idleTimeout: idleTimeoutOption,
		permissions: permissionsOption,
	},
	({ runId: runIdArg, cwd: cwdOpt, noOtel, idleTimeout, permissions }) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const cwd = Option.getOrUndefined(cwdOpt) ?? path.resolve(process.cwd());
			const idleTimeoutMs = Option.getOrUndefined(Option.map(idleTimeout, (s) => s * 1000));
			const permissionsMode = Option.getOrUndefined(permissions);

			const runsDir = path.join(cwd, '.factory', 'runs');
			const resolvedRunId = yield* resolveRunId(runsDir, runIdArg);
			const runDir = path.join(runsDir, resolvedRunId);
			const runJsonExists = yield* fs.exists(runDir).pipe(
				Effect.mapError(
					(e) =>
						new ResumeUnavailableError({
							message: `failed to stat ${runDir}: ${e.message}`,
							reason: 'not-found',
						}),
				),
			);
			if (!runJsonExists) {
				return yield* Effect.fail(
					new ResumeUnavailableError({
						message: `run dir not found: ${runDir}`,
						reason: 'not-found',
					}),
				);
			}
			const runRecord = yield* readRun(path.join(runDir, 'run.json')).pipe(
				Effect.mapError(
					(e: RunRecordingError) =>
						new ResumeUnavailableError({
							message: `failed to read run.json for '${resolvedRunId}': ${e.message}`,
							reason: 'not-found',
						}),
				),
			);

			const factoryDef = yield* loadFactoryConfig(cwd, runRecord.pipeline);
			yield* factoryDef.resumeEffect({
				runId: runRecord.id,
				cwd,
				idleTimeoutMs,
				permissions: permissionsMode,
				otel: !noOtel,
			});
		}),
);

const rootCommand = Command.make('factory', {}, () =>
	Effect.sync(() => {
		console.log(`factory v${VERSION} — software factory pipelines`);
		console.log('Use --help to see available commands.');
	}),
);

export const factoryCli = rootCommand.pipe(Command.withSubcommands([runCommand, resumeCommand]));

export const cli = Command.run(factoryCli, {
	name: 'factory',
	version: VERSION,
});
