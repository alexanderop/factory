import { FileSystem } from '@effect/platform';
import { NodeContext } from '@effect/platform-node';
import { describe, it } from '@effect/vitest';
import { deepStrictEqual, strictEqual, assertTrue } from '@effect/vitest/utils';
import { Effect } from 'effect';
import { Hook } from '@factory/hooks';
import { claudeCodeHookEmitter } from './hookEmitter.ts';

describe('claudeCodeHookEmitter', () => {
	it.scoped('writes settings.json at the correct path', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const runDir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-claude-emitter-' });

			const result = yield* claudeCodeHookEmitter.emit([Hook.denyPaths(['**/.env*'])], runDir);

			const expectedPath = `${runDir}/.hooks/claude-code/settings.json`;
			const exists = yield* fs.exists(expectedPath);
			assertTrue(exists);
			deepStrictEqual(result.argsForHarness, ['--settings', expectedPath]);
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('returns FACTORY_HOOK_HARNESS=claude-code in envForHarness', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const runDir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-claude-emitter-' });

			const result = yield* claudeCodeHookEmitter.emit([], runDir);
			strictEqual(result.envForHarness['FACTORY_HOOK_HARNESS'], 'claude-code');
		}).pipe(Effect.provide(NodeContext.layer)),
	);
});
