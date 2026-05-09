import { Args, Command, Options } from '@effect/cli';
import { Path } from '@effect/platform';
import { Effect, Option, Predicate } from 'effect';
import { ConfigLoadError, type CaptureMode, type Factory } from '@factory/core';

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

const otelCaptureOption = Options.choice('otel-capture', ['off', 'counts', 'redacted', 'full'] as const).pipe(
	Options.withDescription(
		'How much of tool input/output to record on spans (default: redacted). ' +
		'Env: FACTORY_OTEL_CAPTURE',
	),
	Options.optional,
);

const idleTimeoutOption = Options.integer('idle-timeout').pipe(
	Options.withDescription('Per-step idle timeout in seconds (default: no timeout)'),
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

const resolveCaptureMode = (flag: Option.Option<CaptureMode>): CaptureMode => {
	if (Option.isSome(flag)) return flag.value;
	const env = process.env.FACTORY_OTEL_CAPTURE;
	if (env === 'off' || env === 'counts' || env === 'redacted' || env === 'full') return env;
	return 'redacted';
};

const runCommand = Command.make(
	'run',
	{
		name: nameArg,
		prd: prdOption,
		cwd: cwdOption,
		noOtel: noOtelOption,
		otelCapture: otelCaptureOption,
		idleTimeout: idleTimeoutOption,
	},
	({ name, prd, cwd: cwdOpt, noOtel, otelCapture, idleTimeout }) =>
		Effect.gen(function* () {
			const path = yield* Path.Path;
			const cwd = cwdOpt._tag === 'Some' ? cwdOpt.value : path.resolve(process.cwd());
			const idleTimeoutMs = idleTimeout._tag === 'Some' ? idleTimeout.value * 1000 : undefined;

			const factoryDef = yield* loadFactoryConfig(cwd, name);
			yield* factoryDef.runEffect({
				prd,
				cwd,
				idleTimeoutMs,
				otel: !noOtel,
				captureMode: resolveCaptureMode(otelCapture),
			});
		}),
);

const rootCommand = Command.make('factory', {}, () =>
	Effect.sync(() => {
		console.log(`factory v${VERSION} — software factory pipelines`);
		console.log('Use --help to see available commands.');
	}),
);

export const factoryCli = rootCommand.pipe(Command.withSubcommands([runCommand]));

export const cli = Command.run(factoryCli, {
	name: 'factory',
	version: VERSION,
});
