import { FileSystem } from '@effect/platform';
import type { Path } from '@effect/platform';
import { Context, Effect, Layer } from 'effect';
import { HookCompileError, HookConfigError } from '../errors.ts';
import { HookEmitter, type EmittedConfig } from './HookEmitter.ts';
import { HookRegistry } from './HookRegistry.ts';

export interface CompileOptions {
	readonly harness: string;
	readonly runDir: string;
	/** When true, verify Codex has codex_hooks = true in its config. */
	readonly checkCodexFlag?: boolean;
}

export interface HookCompilerService {
	readonly compile: (
		opts: CompileOptions,
	) => Effect.Effect<
		EmittedConfig,
		HookCompileError | HookConfigError,
		FileSystem.FileSystem | Path.Path
	>;
}

const checkCodexHooksFlag = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const home = process.env['HOME'] ?? '/root';
	const candidates = [`${home}/.codex/config.toml`, '.codex/config.toml'];
	for (const candidate of candidates) {
		const exists = yield* fs.exists(candidate);
		if (exists) {
			const content = yield* fs
				.readFileString(candidate)
				.pipe(Effect.catchAll(() => Effect.succeed('')));
			if (content.includes('codex_hooks = true')) {
				return;
			}
		}
	}
	yield* Effect.fail(
		new HookConfigError({
			message:
				'Codex hooks require [features] codex_hooks = true in ~/.codex/config.toml or .codex/config.toml. ' +
				'Add it to enable hooks, then retry.',
			harness: 'codex',
		}),
	);
});

export class HookCompiler extends Context.Tag('@factory/hooks/HookCompiler')<
	HookCompiler,
	HookCompilerService
>() {
	static Default: Layer.Layer<HookCompiler, never, HookRegistry | HookEmitter> = Layer.effect(
		HookCompiler,
		Effect.gen(function* () {
			const registry = yield* HookRegistry;
			const emitter = yield* HookEmitter;
			return {
				compile: (opts: CompileOptions) =>
					Effect.gen(function* () {
						if (opts.harness === 'codex' && opts.checkCodexFlag) {
							yield* checkCodexHooksFlag;
						}
						const specs = yield* registry.all;
						return yield* emitter.emit(specs, opts.runDir);
					}).pipe(
						Effect.mapError((e): HookCompileError | HookConfigError => {
							if (e._tag === 'HookConfigError' || e._tag === 'HookCompileError') {
								return e;
							}
							return new HookCompileError({ message: `compiler: ${e.message}` });
						}),
					),
			} satisfies HookCompilerService;
		}),
	);
}
