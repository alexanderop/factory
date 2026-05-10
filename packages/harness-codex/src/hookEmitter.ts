import { FileSystem } from '@effect/platform';
import { Effect } from 'effect';
import type { EmittedConfig, HookEmitterService } from '@factory/hooks';
import { HookCompileError } from '@factory/hooks';

export const codexHookEmitter: HookEmitterService = {
	emit: (specs, runDir) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const hooksDir = `${runDir}/.hooks/codex`;
			yield* fs.makeDirectory(hooksDir, { recursive: true });

			const lines: string[] = ['[hooks]'];
			for (const spec of specs) {
				if (spec.on !== 'preToolUse') {
					yield* Effect.logWarning(
						`[hooks] spec ${spec.id} targets event '${spec.on}' — codex only supports preToolUse, skipping`,
					);
					continue;
				}
				let decide = spec._tag === 'RuleSpec' ? spec.decide : 'allow';
				if (decide === 'ask') {
					yield* Effect.logWarning(
						`[hooks] spec ${spec.id} uses 'ask' decide — codex does not support prompts, downgrading to deny`,
					);
					decide = 'deny';
				}
				lines.push(
					`[[hooks.pre_tool_call]]`,
					`id = "${spec.id}"`,
					`command = "factory-hook preToolUse --hook ${spec.id}"`,
					`decide = "${decide}"`,
				);
			}

			const contents = lines.join('\n') + '\n';
			const configPath = `${hooksDir}/config.toml`;
			yield* fs.writeFileString(configPath, contents);

			return {
				files: [{ path: configPath, contents }],
				envForHarness: {
					FACTORY_HOOK_HARNESS: 'codex',
					CODEX_HOME: hooksDir,
				},
				argsForHarness: [],
			} satisfies EmittedConfig;
		}).pipe(
			Effect.mapError(
				(e) =>
					new HookCompileError({
						message: `codex emitter: ${e.message}`,
					}),
			),
		),
};
