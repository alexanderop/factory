import { HarnessName } from '@factory/core';
import {
	type HarnessHookAdapter,
	type HookEventType,
	decodeNativeRequest,
	encodeNativeDecision,
	makeJsonAdapter,
} from '@factory/hooks';

const CLAUDE_SUPPORTED: ReadonlyArray<HookEventType> = [
	'sessionStart',
	'userPromptSubmit',
	'preToolUse',
	'postToolUse',
	'stop',
	'permissionRequest',
];

const CLAUDE_EVENT: Readonly<Record<HookEventType, string>> = {
	sessionStart: 'SessionStart',
	userPromptSubmit: 'UserPromptSubmit',
	preToolUse: 'PreToolUse',
	postToolUse: 'PostToolUse',
	stop: 'Stop',
	permissionRequest: 'PermissionRequest',
	// Claude Code has no native failure hook; `postToolUseFailure` is synthesized
	// client-side from `tool.end ok:false` and never written to the native config.
	postToolUseFailure: 'PostToolUseFailure',
};

export const claudeHooksAdapter: HarnessHookAdapter = makeJsonAdapter({
	name: HarnessName.make('claude-code'),
	supportedEvents: new Set(CLAUDE_SUPPORTED),
	configFilename: 'settings.json',
	hookEntry: ({ event, socketPath, route }) => ({
		key: CLAUDE_EVENT[event],
		value: [
			{
				hooks: [
					{
						type: 'http',
						url: `http://unix:${socketPath}:/hook/${route}`,
						timeout: 30,
					},
				],
			},
		],
	}),
	result: ({ outDir, configPath }) => ({
		env: { CLAUDE_PROJECT_DIR: outDir },
		extraArgs: ['--settings', configPath],
	}),
	decodeRequest: decodeNativeRequest,
	encodeDecision: encodeNativeDecision,
});
