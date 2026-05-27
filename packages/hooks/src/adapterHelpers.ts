import { FileSystem, Path } from '@effect/platform';
import { ConfigLoadError, type HarnessName } from '@factory/core';
import { Effect } from 'effect';
import {
	assertSupports,
	type HarnessHookAdapter,
	type HarnessHookAdapterArgs,
	type HarnessHookAdapterResult,
	type HarnessNativeConfig,
} from './adapter.ts';
import type { HookEventType } from './events.ts';

/** URL path the harness POSTs back to, carrying the run context the native
 *  payload lacks. Matched by the server's `/hook/:harness/:runId/:stepId/:iter/:event`. */
const routeFor = (
	name: HarnessName,
	args: Pick<HarnessHookAdapterArgs, 'runId' | 'stepId' | 'iter'>,
	event: HookEventType,
): string =>
	// Encode the free-form segments: a runId/stepId containing `/`, `?`, `#`, …
	// would otherwise add or shift path segments and break route matching (the
	// router decodes params back, so the server still sees the original values).
	`${name}/${encodeURIComponent(args.runId)}/${encodeURIComponent(args.stepId)}/${args.iter}/${event}`;

export interface JsonAdapterSpec {
	readonly name: HarnessName;
	readonly supportedEvents: ReadonlySet<HookEventType>;
	readonly configFilename: string;
	/** Convert each requested event into the harness-native hook entry. `route`
	 *  is the context-carrying callback path (see `routeFor`). */
	readonly hookEntry: (args: {
		readonly event: HookEventType;
		readonly socketPath: string;
		readonly route: string;
	}) => { readonly key: string; readonly value: unknown };
	readonly result: (
		args: HarnessHookAdapterArgs & { readonly configPath: string },
	) => HarnessHookAdapterResult;
	readonly decodeRequest: HarnessHookAdapter['decodeRequest'];
	readonly encodeDecision: HarnessHookAdapter['encodeDecision'];
}

/** Factory for the JSON-flavoured adapters (claude, codex, copilot). Each
 *  adapter assembles a `{ hooks: { ... } }` document and writes it as JSON.
 *  Only the event-name mapping, the filename, the env/args needed to make the
 *  harness pick the file up, and the native request/decision codecs vary. */
export const makeJsonAdapter = (spec: JsonAdapterSpec): HarnessHookAdapter => {
	const probe = { name: spec.name, supportedEvents: spec.supportedEvents };

	const buildConfig = (args: HarnessHookAdapterArgs): HarnessNativeConfig => {
		assertSupports(probe, args.events);
		const hooks: Record<string, unknown> = {};
		for (const event of args.events) {
			const { key, value } = spec.hookEntry({
				event,
				socketPath: args.socketPath,
				route: routeFor(spec.name, args, event),
			});
			hooks[key] = value;
		}
		return {
			path: `${args.outDir}/${spec.configFilename}`,
			content: JSON.stringify({ hooks }, null, 2),
			format: 'json',
		};
	};

	const writeConfig = (
		args: HarnessHookAdapterArgs,
	): Effect.Effect<HarnessHookAdapterResult, ConfigLoadError, FileSystem.FileSystem | Path.Path> =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const config = buildConfig(args);
			yield* fs.makeDirectory(path.dirname(config.path), { recursive: true });
			yield* fs.writeFileString(config.path, config.content);
			return spec.result({ ...args, configPath: config.path });
		}).pipe(
			Effect.catchTags({
				BadArgument: (e) =>
					Effect.fail(new ConfigLoadError({ message: e.message, cwd: args.outDir })),
				SystemError: (e) =>
					Effect.fail(new ConfigLoadError({ message: e.message, cwd: args.outDir })),
			}),
		);

	return {
		name: spec.name,
		supportedEvents: spec.supportedEvents,
		buildConfig,
		writeConfig,
		decodeRequest: spec.decodeRequest,
		encodeDecision: spec.encodeDecision,
	};
};
