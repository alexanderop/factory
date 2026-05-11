import { describe, it } from '@effect/vitest';
import { deepStrictEqual, assertTrue } from '@effect/vitest/utils';
import { Effect, Stream } from 'effect';
import { Hook } from '../builders.ts';
import type { HookDecision } from '../schema.ts';
import { PreToolUseEvent } from '../schema.ts';
import { InMemoryHookRegistry } from '../testing/InMemoryHookRegistry.ts';
import { runShim } from './shim.ts';

const makeStdin = (event: PreToolUseEvent): Stream.Stream<Uint8Array> => {
	const json = JSON.stringify({
		_tag: event._tag,
		toolName: event.toolName,
		command: event.command,
	});
	return Stream.fromIterable([new TextEncoder().encode(json)]);
};

const preToolUseEvent = new PreToolUseEvent({ toolName: 'Bash', command: 'echo hello' });

const denySpec = Hook.rule({ on: 'preToolUse', decide: 'deny', reason: 'blocked' });
const allowSpec = Hook.rule({ on: 'preToolUse', decide: 'allow' });
const effectSpec = Hook.effect({
	on: 'preToolUse',
	handler: () => Effect.succeed(Hook.deny('custom deny')),
});

describe('runShim', () => {
	it.effect('deny-all handler returns Deny decision for PreToolUse', () =>
		Effect.gen(function* () {
			const stdin = makeStdin(preToolUseEvent);

			const decision: HookDecision = yield* runShim({
				hookId: denySpec.id,
				stdinStream: stdin,
			});

			deepStrictEqual(decision._tag, 'Deny');
		}).pipe(Effect.provide(InMemoryHookRegistry.withSpec(denySpec))),
	);

	it.effect('allow handler returns Allow decision', () =>
		Effect.gen(function* () {
			const stdin = makeStdin(preToolUseEvent);

			const decision: HookDecision = yield* runShim({
				hookId: allowSpec.id,
				stdinStream: stdin,
			});

			deepStrictEqual(decision._tag, 'Allow');
		}).pipe(Effect.provide(InMemoryHookRegistry.withSpec(allowSpec))),
	);

	it.effect('effect handler with custom logic runs and returns its decision', () =>
		Effect.gen(function* () {
			const stdin = makeStdin(preToolUseEvent);

			const decision: HookDecision = yield* runShim({
				hookId: effectSpec.id,
				stdinStream: stdin,
			});

			deepStrictEqual(decision._tag, 'Deny');
			if (decision._tag === 'Deny') {
				assertTrue(decision.reason === 'custom deny');
			}
		}).pipe(Effect.provide(InMemoryHookRegistry.withSpec(effectSpec))),
	);
});
