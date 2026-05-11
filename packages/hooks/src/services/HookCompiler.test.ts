import { FileSystem } from '@effect/platform';
import { NodeContext } from '@effect/platform-node';
import { describe, it } from '@effect/vitest';
import { assertInstanceOf, assertTrue } from '@effect/vitest/utils';
import { Cause, Effect, Exit, Layer } from 'effect';
import { Hook } from '../builders.ts';
import { HookCompileError, HookConfigError } from '../errors.ts';
import type { HookSpec } from '../schema.ts';
import { HookEmitter, type EmittedConfig, type HookEmitterService } from './HookEmitter.ts';
import { HookCompiler } from './HookCompiler.ts';
import { HookRegistry } from './HookRegistry.ts';

const specs = [Hook.denyPaths(['**/.env*'])];

function makeTestEmitter(harnessKey: string): HookEmitterService {
	return {
		emit: (emitSpecs: ReadonlyArray<HookSpec>, runDir: string) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const dir = `${runDir}/.hooks/${harnessKey}`;
				yield* fs.makeDirectory(dir, { recursive: true });
				const path = `${dir}/config.json`;
				yield* fs.writeFileString(path, JSON.stringify({ specs: emitSpecs.length }));
				return {
					files: [{ path, contents: '{}' }],
					envForHarness: { FACTORY_HOOK_HARNESS: harnessKey },
					argsForHarness: [],
				} satisfies EmittedConfig;
			}).pipe(
				Effect.mapError(
					(e): HookCompileError => new HookCompileError({ message: `test emitter: ${e.message}` }),
				),
			),
	};
}

const AppLayer = (harness: string) => {
	const deps = Layer.mergeAll(
		HookRegistry.layer(specs),
		Layer.succeed(HookEmitter, makeTestEmitter(harness)),
	);
	return Layer.mergeAll(HookCompiler.Default.pipe(Layer.provide(deps)), NodeContext.layer);
};

describe('HookCompiler', () => {
	it.scoped('compile delegates to HookEmitter and writes files', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const runDir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-compiler-' });

			const compiler = yield* HookCompiler;
			const result = yield* compiler.compile({ harness: 'claude-code', runDir });

			const exists = yield* fs.exists(`${runDir}/.hooks/claude-code/config.json`);
			assertTrue(exists);
			assertTrue(Object.keys(result.envForHarness).length > 0);
		}).pipe(Effect.provide(AppLayer('claude-code'))),
	);

	it.scoped('compile passes all registry specs to the emitter', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const runDir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-compiler-' });

			const compiler = yield* HookCompiler;
			yield* compiler.compile({ harness: 'codex', runDir });

			const content = yield* fs.readFileString(`${runDir}/.hooks/codex/config.json`);
			assertTrue(content.includes('1'));
		}).pipe(Effect.provide(AppLayer('codex'))),
	);

	it.scoped('compile for codex with checkCodexFlag fails when hooks flag is missing', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const runDir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-compiler-' });

			const compiler = yield* HookCompiler;
			const exit = yield* Effect.exit(
				compiler.compile({ harness: 'codex', runDir, checkCodexFlag: true }),
			);

			assertTrue(Exit.isFailure(exit));
			const failure = Cause.failureOption(Exit.isFailure(exit) ? exit.cause : Cause.empty);
			if (failure._tag === 'Some') {
				assertInstanceOf(failure.value, HookConfigError);
			}
		}).pipe(Effect.provide(AppLayer('codex'))),
	);
});
