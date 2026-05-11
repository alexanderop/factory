import { FileSystem } from '@effect/platform';
import { NodeContext } from '@effect/platform-node';
import { describe, it } from '@effect/vitest';
import { strictEqual, assertTrue } from '@effect/vitest/utils';
import { Effect } from 'effect';
import { Hook } from '@factory/hooks';
import { codexHookEmitter } from './hookEmitter.ts';

describe('codexHookEmitter', () => {
	it.scoped('writes config.toml at the correct path', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const runDir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-codex-emitter-' });

			const result = yield* codexHookEmitter.emit([Hook.denyPaths(['**/.env*'])], runDir);

			const expectedDir = `${runDir}/.hooks/codex`;
			assertTrue(result.envForHarness['CODEX_HOME'] === expectedDir);
			const exists = yield* fs.exists(`${expectedDir}/config.toml`);
			assertTrue(exists);
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('returns FACTORY_HOOK_HARNESS=codex in envForHarness', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const runDir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-codex-emitter-' });

			const result = yield* codexHookEmitter.emit([], runDir);
			strictEqual(result.envForHarness['FACTORY_HOOK_HARNESS'], 'codex');
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('ask spec on codex logs warning and emits deny', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const runDir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-codex-emitter-' });

			const askSpec = Hook.rule({ on: 'preToolUse', decide: 'ask' });
			yield* codexHookEmitter.emit([askSpec], runDir);

			const content = yield* fs.readFileString(`${runDir}/.hooks/codex/config.toml`);
			assertTrue(content.includes('deny'));
			assertTrue(!content.includes('ask'));
		}).pipe(Effect.provide(NodeContext.layer)),
	);
});
