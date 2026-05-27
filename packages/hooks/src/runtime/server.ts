import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	FileSystem,
	HttpRouter,
	HttpServer,
	HttpServerRequest,
	HttpServerResponse,
} from '@effect/platform';
import { NodeHttpServer } from '@effect/platform-node';
import {
	HarnessName,
	type HookStepPrep,
	HookRunner,
	HookTransport,
	type HookTransportService,
	RunId,
	StepId,
} from '@factory/core';
import { Effect, Layer } from 'effect';
import { type HarnessHookAdapter, buildHookEvent } from '../adapter.ts';
import type { HookConfig } from '../config.ts';
import { HOOK_EVENT_TYPES, type HookEventType } from '../events.ts';
import { liveHookRunner } from './HookRunner.ts';

const EVENT_TYPES = new Set<string>(HOOK_EVENT_TYPES);
const isHookEventType = (s: string): s is HookEventType => EVENT_TYPES.has(s);

const EMPTY_PREP: HookStepPrep = { nativeEvents: new Set<string>() };

/** `POST /hook/:harness/:runId/:stepId/:iter/:event` — the harness fires its
 *  native hook; we recover the run context from the URL, decode the native body
 *  via that harness's adapter, dispatch through the user's handlers, and reply
 *  with the harness-native decision. Any failure replies allow (fail-open) so a
 *  transport hiccup never wedges the harness. */
const hookRoute = (adapters: ReadonlyMap<string, HarnessHookAdapter>) =>
	Effect.gen(function* () {
		const runner = yield* HookRunner;
		const request = yield* HttpServerRequest.HttpServerRequest;
		const params = yield* HttpRouter.params;
		const harness = params.harness ?? '';
		const eventParam = params.event ?? '';
		const adapter = adapters.get(harness);
		if (adapter === undefined || !isHookEventType(eventParam)) {
			return yield* HttpServerResponse.json({ action: 'allow' });
		}
		const body = yield* request.json;
		const event = buildHookEvent(
			eventParam,
			{
				runId: RunId.make(params.runId ?? ''),
				stepId: StepId.make(params.stepId ?? ''),
				iter: Number(params.iter ?? '0'),
				harness: HarnessName.make(harness),
			},
			adapter.decodeRequest({ event: eventParam, body }),
		);
		const decision = yield* runner.dispatch(event);
		return yield* HttpServerResponse.json(adapter.encodeDecision({ event: eventParam, decision }));
	}).pipe(Effect.catchAll(() => HttpServerResponse.json({ action: 'allow' })));

const router = (adapters: ReadonlyMap<string, HarnessHookAdapter>) =>
	HttpRouter.empty.pipe(
		HttpRouter.post('/hook/:harness/:runId/:stepId/:iter/:event', hookRoute(adapters)),
	);

const makeTransport = (
	socketPath: string,
	baseDir: string,
	adapters: ReadonlyMap<string, HarnessHookAdapter>,
	config: HookConfig,
): HookTransportService => {
	// Each prepareStep writes into its own numbered subdir of the run-scoped
	// `baseDir` (cleaned up when the layer's scope closes), so configs never
	// collide across concurrent steps yet leave no per-iter temp dirs behind.
	let seq = 0;
	return {
		prepareStep: ({ runId, stepId, harnessName, iter }) => {
			const adapter = adapters.get(harnessName);
			if (adapter === undefined) return Effect.succeed(EMPTY_PREP);
			const events = [...adapter.supportedEvents].filter((e) => (config[e]?.length ?? 0) > 0);
			if (events.length === 0) return Effect.succeed(EMPTY_PREP);
			const outDir = `${baseDir}/${seq++}`;
			return adapter.writeConfig({ socketPath, events, outDir, runId, stepId, iter }).pipe(
				Effect.map(
					(result) =>
						({
							env: result.env,
							extraArgs: result.extraArgs,
							nativeEvents: new Set<string>(events),
						}) satisfies HookStepPrep,
				),
				Effect.catchAll((cause) =>
					Effect.logError('hook transport prepareStep failed', cause).pipe(Effect.as(EMPTY_PREP)),
				),
			);
		},
	};
};

/** Live hooks layer: the user's in-process `HookRunner` plus the run-scoped
 *  unix-socket server + per-step `HookTransport`. Injected via
 *  `FactoryOptions.hooks` so core never imports `@factory/hooks`. */
export const hooksLayer = (options: {
	readonly config: HookConfig;
	readonly adapters: ReadonlyArray<HarnessHookAdapter>;
}): Layer.Layer<HookRunner | HookTransport, never, FileSystem.FileSystem> =>
	Layer.unwrapScoped(
		Effect.gen(function* () {
			// One run-scoped base dir for all per-step configs; removed when the
			// layer's scope closes so a long multi-step/iter run leaves nothing behind.
			const fs = yield* FileSystem.FileSystem;
			const baseDir = yield* fs
				.makeTempDirectoryScoped({ prefix: 'factory-hookcfg-' })
				.pipe(Effect.orDie);
			// Keep the path well under the macOS `sun_path` limit (104 bytes incl.
			// NUL): a full UUID under a default `/var/folders/...` tmpdir lands at
			// exactly 104 → `bind()` fails. 8 hex chars is plenty for one socket/run.
			const socketPath = join(tmpdir(), `factory-hooks-${randomUUID().slice(0, 8)}.sock`);
			const adapterByName = new Map<string, HarnessHookAdapter>(
				options.adapters.map((a) => [a.name, a]),
			);
			const runnerLayer = liveHookRunner.layer(options.config);
			const serveLayer = router(adapterByName).pipe(
				HttpServer.serve(),
				Layer.provide(NodeHttpServer.layer(() => createServer(), { path: socketPath })),
				Layer.provide(runnerLayer),
				Layer.orDie,
			);
			const transportLayer = Layer.succeed(
				HookTransport,
				makeTransport(socketPath, baseDir, adapterByName, options.config),
			);
			return Layer.mergeAll(runnerLayer, transportLayer, serveLayer);
		}),
	);
