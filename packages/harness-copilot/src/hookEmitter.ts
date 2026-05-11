import { FileSystem } from '@effect/platform';
import { Effect } from 'effect';
import type { EmittedConfig, HookEmitterService } from '@factory/hooks';
import { HookCompileError } from '@factory/hooks';

type CopilotHookEntry = {
	readonly id: string;
	readonly event: string;
	readonly command: string;
	readonly decide: string;
};

export const copilotHookEmitter: HookEmitterService = {
	emit: (specs, runDir) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const hooksDir = `${runDir}/.hooks/copilot`;
			yield* fs.makeDirectory(hooksDir, { recursive: true });

			const hooks: CopilotHookEntry[] = [];
			for (const spec of specs) {
				let decide = spec._tag === 'RuleSpec' ? spec.decide : 'allow';
				if (decide === 'ask') {
					yield* Effect.logWarning(
						`[hooks] spec ${spec.id} uses 'ask' decide — copilot does not support prompts, downgrading to deny`,
					);
					decide = 'deny';
				}
				hooks.push({
					id: spec.id,
					event: spec.on,
					command: `factory-hook ${spec.on} --hook ${spec.id}`,
					decide,
				});
			}

			const config = { hooks };
			const configPath = `${hooksDir}/config.json`;
			const contents = JSON.stringify(config, null, 2);
			yield* fs.writeFileString(configPath, contents);

			return {
				files: [{ path: configPath, contents }],
				envForHarness: {
					FACTORY_HOOK_HARNESS: 'copilot',
					GH_COPILOT_HOOKS_CONFIG: configPath,
				},
				argsForHarness: [],
			} satisfies EmittedConfig;
		}).pipe(
			Effect.mapError(
				(e) =>
					new HookCompileError({
						message: `copilot emitter: ${e.message}`,
					}),
			),
		),
};
