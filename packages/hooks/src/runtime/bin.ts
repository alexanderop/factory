#!/usr/bin/env -S node --experimental-strip-types
import { NodeRuntime } from '@effect/platform-node';
import { Effect, Stream } from 'effect';
import { HookId } from '../ids.ts';
import { handlerRegistry } from './handlerRegistry.ts';
import { encodeDecision, runShim } from './shim.ts';

const hookId = HookId.make(process.env['FACTORY_HOOK_ID'] ?? '');
const harness = process.env['FACTORY_HOOK_HARNESS'] ?? 'unknown';

const chunks: Uint8Array[] = [];
for await (const chunk of process.stdin) {
	if (chunk instanceof Uint8Array) {
		chunks.push(chunk);
	}
}
const stdinStream = Stream.fromIterable(chunks);

const program = Effect.gen(function* () {
	const decision = yield* runShim({ hookId, stdinStream });
	const { json, exitCode } = encodeDecision(decision, harness);
	process.stdout.write(json + '\n');
	process.exitCode = exitCode;
}).pipe(
	Effect.catchAll((e) => {
		process.stderr.write(`factory-hook error: ${e.message}\n`);
		process.exitCode = 1;
		return Effect.void;
	}),
	Effect.provide(handlerRegistry()),
);

NodeRuntime.runMain(program);
