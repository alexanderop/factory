import { FileSystem } from '@effect/platform';
import { NodeContext } from '@effect/platform-node';
import { describe, it } from 'vitest';
import { claudeCodeHookEmitter } from '@factory/harness-claude-code';
import { codexHookEmitter } from '@factory/harness-codex';
import { copilotHookEmitter } from '@factory/harness-copilot';
import { Effect, Layer } from 'effect';
import type { HookEmitterService } from './services/HookEmitter.ts';
import { exampleSpecs } from '../test/fixtures/hooks.example.ts';
import { HookCompiler } from './services/HookCompiler.ts';
import { HookEmitter } from './services/HookEmitter.ts';
import { HookRegistry } from './services/HookRegistry.ts';

const runCompile = (harness: string, emitter: HookEmitterService) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const runDir = yield* fs.makeTempDirectoryScoped({ prefix: `factory-golden-${harness}-` });
		const compiler = yield* HookCompiler;
		const result = yield* compiler.compile({ harness, runDir });
		const contents: Record<string, string> = {};
		for (const file of result.files) {
			contents[file.path.replace(runDir, '<runDir>')] = file.contents;
		}
		return contents;
	}).pipe(
		Effect.scoped,
		Effect.provide(
			HookCompiler.Default.pipe(
				Layer.provide(HookRegistry.layer(exampleSpecs)),
				Layer.provide(Layer.succeed(HookEmitter, emitter)),
			),
		),
		Effect.provide(NodeContext.layer),
	);

describe('golden compile snapshots', () => {
	it('claude-code emits expected settings.json', async ({ expect }) => {
		const contents = await Effect.runPromise(runCompile('claude-code', claudeCodeHookEmitter));
		expect(contents).toMatchSnapshot();
	});

	it('codex emits expected config.toml', async ({ expect }) => {
		const contents = await Effect.runPromise(runCompile('codex', codexHookEmitter));
		expect(contents).toMatchSnapshot();
	});

	it('copilot emits expected config.json', async ({ expect }) => {
		const contents = await Effect.runPromise(runCompile('copilot', copilotHookEmitter));
		expect(contents).toMatchSnapshot();
	});
});
