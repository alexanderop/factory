import type { FileSystem } from '@effect/platform';
import type { Effect } from 'effect';
import { Context } from 'effect';
import type { HookCompileError } from '../errors.ts';
import type { HookSpec } from '../schema.ts';

export interface EmittedConfig {
	readonly files: ReadonlyArray<{ readonly path: string; readonly contents: string }>;
	readonly envForHarness: Record<string, string>;
	readonly argsForHarness: ReadonlyArray<string>;
}

export interface HookEmitterService {
	readonly emit: (
		specs: ReadonlyArray<HookSpec>,
		runDir: string,
	) => Effect.Effect<EmittedConfig, HookCompileError, FileSystem.FileSystem>;
}

export class HookEmitter extends Context.Tag('@factory/hooks/HookEmitter')<
	HookEmitter,
	HookEmitterService
>() {}
