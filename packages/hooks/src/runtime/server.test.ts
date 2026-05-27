import { request as httpRequest } from 'node:http';
import { FileSystem } from '@effect/platform';
import { NodeContext } from '@effect/platform-node';
import { describe, it } from '@effect/vitest';
import { assertTrue, strictEqual } from '@effect/vitest/utils';
import { HarnessName, HookTransport, RunId, StepId } from '@factory/core';
import { Effect, Layer, Ref } from 'effect';
import { makeJsonAdapter } from '../adapterHelpers.ts';
import { ALLOW } from '../decision.ts';
import { HOOK_EVENT_TYPES } from '../events.ts';
import { decodeNativeRequest, encodeNativeDecision } from '../native.ts';
import { hooksLayer } from './server.ts';

const testAdapter = makeJsonAdapter({
	name: HarnessName.make('claude-code'),
	supportedEvents: new Set(HOOK_EVENT_TYPES),
	configFilename: 'settings.json',
	hookEntry: ({ socketPath, route }) => ({
		key: route,
		value: { url: `http://unix:${socketPath}:/hook/${route}` },
	}),
	result: ({ configPath }) => ({ extraArgs: ['--settings', configPath] }),
	decodeRequest: decodeNativeRequest,
	encodeDecision: encodeNativeDecision,
});

const postUnix = (
	socketPath: string,
	path: string,
	body: unknown,
): Promise<{ readonly status: number; readonly text: string }> =>
	new Promise((resolve, reject) => {
		const req = httpRequest(
			{ socketPath, path, method: 'POST', headers: { 'content-type': 'application/json' } },
			(res) => {
				let data = '';
				res.on('data', (chunk) => {
					data += chunk;
				});
				res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }));
			},
		);
		req.on('error', reject);
		req.write(JSON.stringify(body));
		req.end();
	});

describe('hooks transport server', () => {
	it.scoped('round-trips a native callback over the unix socket to the user handler', () => {
		const fired = Ref.unsafeMake<ReadonlyArray<string>>([]);
		const layer = hooksLayer({
			config: {
				sessionStart: [
					{
						handler: (event) =>
							Ref.update(fired, (xs) => [...xs, event.source]).pipe(Effect.as(ALLOW)),
					},
				],
			},
			adapters: [testAdapter],
		});

		return Effect.gen(function* () {
			const transport = yield* HookTransport;
			const prep = yield* transport.prepareStep({
				runId: RunId.make('run-1'),
				stepId: StepId.make('plan'),
				harnessName: HarnessName.make('claude-code'),
				iter: 1,
			});

			// sessionStart has a configured handler → transport delivers it natively.
			assertTrue(prep.nativeEvents.has('sessionStart'));

			// Recover the socket + callback path from the config the transport wrote.
			const configPath = (prep.extraArgs ?? [])[1] ?? '';
			const fs = yield* FileSystem.FileSystem;
			const content = yield* fs.readFileString(configPath);
			const match = content.match(/http:\/\/unix:([^:]+):(\/hook\/[^"]+)/);
			const socketPath = match?.[1];
			const callbackPath = match?.[2];
			if (socketPath === undefined || callbackPath === undefined) {
				return yield* Effect.die(new Error('config did not contain a hook callback URL'));
			}

			const response = yield* Effect.promise(() =>
				postUnix(socketPath, callbackPath, { source: 'startup' }),
			);

			strictEqual(response.status, 200);
			strictEqual((yield* Ref.get(fired)).length, 1);
			strictEqual((yield* Ref.get(fired))[0], 'startup');
		}).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeContext.layer))));
	});
});
