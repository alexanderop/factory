import { FileSystem } from '@effect/platform';
import { NodeContext } from '@effect/platform-node';
import { describe, it } from '@effect/vitest';
import { strictEqual, assertTrue } from '@effect/vitest/utils';
import { Effect } from 'effect';
import { Hook } from '@factory/hooks';
import { copilotHookEmitter } from './hookEmitter.ts';

describe('copilotHookEmitter', () => {
	it.scoped('writes config.json at the correct path', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const runDir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-copilot-emitter-' });

			const result = yield* copilotHookEmitter.emit([Hook.denyPaths(['**/.env*'])], runDir);

			const expectedPath = `${runDir}/.hooks/copilot/config.json`;
			const exists = yield* fs.exists(expectedPath);
			assertTrue(exists);
			strictEqual(result.envForHarness['GH_COPILOT_HOOKS_CONFIG'], expectedPath);
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('returns FACTORY_HOOK_HARNESS=copilot in envForHarness', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const runDir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-copilot-emitter-' });

			const result = yield* copilotHookEmitter.emit([], runDir);
			strictEqual(result.envForHarness['FACTORY_HOOK_HARNESS'], 'copilot');
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('ask spec on copilot logs warning and emits deny', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const runDir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-copilot-emitter-' });

			const askSpec = Hook.rule({ on: 'preToolUse', decide: 'ask' });
			yield* copilotHookEmitter.emit([askSpec], runDir);

			const content = yield* fs.readFileString(`${runDir}/.hooks/copilot/config.json`);
			assertTrue(content.includes('deny'));
			assertTrue(!content.includes('ask'));
		}).pipe(Effect.provide(NodeContext.layer)),
	);
});
