import { Args, Command, Options } from '@effect/cli';
import { FileSystem, Path } from '@effect/platform';
import { Effect, Layer, Option, Predicate, Schema, Stream } from 'effect';
import {
	ConfigLoadError,
	type Factory,
	PermissionMode,
	readRun,
	ResumeUnavailableError,
	type RunRecordingError,
} from '@factory/core';
import { claudeCodeHookEmitter } from '@factory/harness-claude-code';
import { codexHookEmitter } from '@factory/harness-codex';
import { copilotHookEmitter } from '@factory/harness-copilot';
import {
	handlerRegistry,
	HookCompiler,
	HookEmitter,
	HookEvent,
	HookRegistry,
	runShim,
} from '@factory/hooks';

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

			const harness = factoryDef.harness;
			const compiled = yield* harness
				? Effect.gen(function* () {
						const compiler = yield* HookCompiler;
						const runDir = path.join(cwd, '.factory');
						return yield* compiler.compile({ harness, runDir }).pipe(
							Effect.option,
						);
					}).pipe(
						Effect.provide(
							HookCompiler.Default.pipe(
								Layer.provide(handlerRegistry()),
								Layer.provide(harnessEmitterLayer(harness)),
							),
						),
					)
				: Effect.succeed(Option.none());

			const compiledConfig = Option.getOrUndefined(compiled);

			yield* factoryDef.runEffect({
				prd,
				cwd,
				idleTimeoutMs,
				permissions: permissionsMode,
				otel: !noOtel,
				harnessEnv: compiledConfig?.envForHarness,
				harnessArgs: compiledConfig?.argsForHarness,
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

const harnessEmitterLayer = (harness: string): Layer.Layer<HookEmitter> => {
	const emitter =
		harness === 'codex'
			? codexHookEmitter
			: harness === 'copilot'
				? copilotHookEmitter
				: claudeCodeHookEmitter;
	return Layer.succeed(HookEmitter, emitter);
};

const hooksListCommand = Command.make('list', {}, () =>
	Effect.gen(function* () {
		const registry = yield* HookRegistry;
		const specs = yield* registry.all;
		if (specs.length === 0) {
			console.log('No hooks found in .factory/hooks.ts');
			return;
		}
		for (const spec of specs) {
			const detail = spec._tag === 'RuleSpec' ? `decide=${spec.decide}` : 'effect handler';
			console.log(`  ${spec.id.slice(0, 8)}  on=${spec.on}  ${detail}`);
		}
	}).pipe(Effect.provide(handlerRegistry())),
);

const hooksCompileCommand = Command.make(
	'compile',
	{
		harness: Options.choice('harness', ['claude-code', 'codex', 'copilot'] as const).pipe(
			Options.withDescription('Target harness to compile hooks for'),
			Options.withDefault('claude-code' as const),
		),
		runDir: Options.directory('run-dir').pipe(
			Options.withDescription('Output directory for compiled hook configs'),
			Options.optional,
		),
	},
	({ harness, runDir: runDirOpt }) =>
		Effect.gen(function* () {
			const path = yield* Path.Path;
			const cwd = path.resolve(process.cwd());
			const runDir = Option.getOrElse(runDirOpt, () => path.join(cwd, '.factory'));
			const compiler = yield* HookCompiler;
			const compiled = yield* compiler.compile({ harness, runDir });
			console.log(`Compiled hooks for ${harness}:`);
			for (const file of compiled.files) {
				console.log(`  wrote: ${file.path}`);
			}
		}).pipe(
			Effect.provide(
				HookCompiler.Default.pipe(
					Layer.provide(handlerRegistry()),
					Layer.provide(harnessEmitterLayer('claude-code')),
				),
			),
		),
);

const decodeHookEvent = Schema.decodeUnknown(Schema.parseJson(HookEvent));

const hooksCheckCommand = Command.make(
	'check',
	{
		eventJson: Args.text({ name: 'event-json' }).pipe(
			Args.withDescription('Hook event JSON to check against loaded specs'),
		),
	},
	({ eventJson }) =>
		Effect.gen(function* () {
			const registry = yield* HookRegistry;
			const event = yield* decodeHookEvent(eventJson).pipe(
				Effect.mapError(
					(e) => new Error(`invalid event JSON: ${e.message}`),
				),
			);
			const specs = yield* registry.byEvent(event._tag);
			if (specs.length === 0) {
				console.log(`No hooks registered for event '${event._tag}'`);
				return;
			}
			for (const spec of specs) {
				const decision = yield* runShim({
					hookId: spec.id,
					stdinStream: Stream.fromIterable([new TextEncoder().encode(eventJson)]),
				});
				console.log(`  ${spec.id.slice(0, 8)}  → ${decision._tag}`);
			}
		}).pipe(Effect.provide(handlerRegistry())),
);

const hooksCommand = Command.make('hooks', {}, () =>
	Effect.sync(() => {
		console.log('factory hooks — manage and inspect hook specs');
		console.log('Use --help to see available subcommands.');
	}),
).pipe(Command.withSubcommands([hooksListCommand, hooksCompileCommand, hooksCheckCommand]));

const rootCommand = Command.make('factory', {}, () =>
	Effect.sync(() => {
		console.log(`factory v${VERSION} — software factory pipelines`);
		console.log('Use --help to see available commands.');
	}),
);

export const factoryCli = rootCommand.pipe(
	Command.withSubcommands([runCommand, resumeCommand, hooksCommand]),
);

export const cli = Command.run(factoryCli, {
	name: 'factory',
	version: VERSION,
});
