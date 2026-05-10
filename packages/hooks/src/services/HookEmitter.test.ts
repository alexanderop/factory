import { FileSystem } from '@effect/platform';
import { NodeContext } from '@effect/platform-node';
import { describe, it } from '@effect/vitest';
import { assertTrue } from '@effect/vitest/utils';
import { Effect, Layer } from 'effect';
import { Hook } from '../builders.ts';
import { HookCompileError } from '../errors.ts';
import type { EmittedConfig } from './HookEmitter.ts';
import { HookEmitter } from './HookEmitter.ts';

const testEmitterLayer = Layer.succeed(HookEmitter, {
	emit: (specs, runDir) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const dir = `${runDir}/.hooks/test`;
			yield* fs.makeDirectory(dir, { recursive: true });
			const path = `${dir}/config.json`;
			const contents = JSON.stringify({ specs: specs.map((s) => s._tag) });
			yield* fs.writeFileString(path, contents);
			return {
				files: [{ path, contents }],
				envForHarness: { TEST_HOOK_DIR: dir, FACTORY_HOOK_HARNESS: 'test' },
				argsForHarness: ['--test-config', path],
			} satisfies EmittedConfig;
		}).pipe(
			Effect.mapError((e) => new HookCompileError({ message: `test emitter: ${e.message}` })),
		),
} satisfies HookEmitter['Type']);

const AppLayer = Layer.mergeAll(testEmitterLayer, NodeContext.layer);

describe('HookEmitter interface', () => {
	it.scoped('emit writes a config file and returns env/args', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-emitter-' });

			const emitter = yield* HookEmitter;
			const result = yield* emitter.emit([Hook.denyPaths(['**/.env*'])], dir);

			assertTrue(result.files.length > 0);
			assertTrue(Object.keys(result.envForHarness).length > 0);
		}).pipe(Effect.provide(AppLayer)),
	);
});
