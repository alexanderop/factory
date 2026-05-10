import { FileSystem } from '@effect/platform';
import { Effect } from 'effect';
import { HookCompileError, type HookEmitterService } from '@factory/hooks';

type ClaudeHookEntry = {
	readonly hooks: ReadonlyArray<{ readonly type: 'command'; readonly command: string }>;
};


function specToEvent(on: string): string {
	const map: Record<string, string> = {
		preToolUse: 'PreToolUse',
		postToolUse: 'PostToolUse',
		sessionStart: 'SessionStart',
		stop: 'Stop',
		permissionRequest: 'PermissionRequest',
	};
	return map[on] ?? on;
}

export const claudeCodeHookEmitter: HookEmitterService = {
	emit: (specs, runDir) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const hooksDir = `${runDir}/.hooks/claude-code`;
			yield* fs.makeDirectory(hooksDir, { recursive: true });

			const grouped: Record<string, ClaudeHookEntry[]> = {};
			for (const spec of specs) {
				const eventKey = specToEvent(spec.on);
				const entries: ClaudeHookEntry[] = grouped[eventKey] ?? [];
				grouped[eventKey] = entries;
				if (spec._tag === 'RuleSpec' && spec.decide === 'ask') {
					yield* Effect.logWarning(
						`[hooks] spec ${spec.id} uses 'ask' decide — claude-code supports prompt, emitting ask`,
					);
				}
				const command = `factory-hook ${eventKey} --hook ${spec.id}`;
				entries.push({ hooks: [{ type: 'command', command }] });
			}

			const settings = { hooks: grouped };
			const settingsPath = `${hooksDir}/settings.json`;
			const contents = JSON.stringify(settings, null, 2);
			yield* fs.writeFileString(settingsPath, contents);

			return {
				files: [{ path: settingsPath, contents }],
				envForHarness: { FACTORY_HOOK_HARNESS: 'claude-code' },
				argsForHarness: ['--settings', settingsPath],
			};
		}).pipe(
			Effect.mapError(
				(e): HookCompileError =>
					new HookCompileError({
						message: `claude-code emitter: ${e.message}`,
					}),
			),
		),
};
