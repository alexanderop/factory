import { HarnessName } from '@factory/core';
import {
	type HarnessHookAdapter,
	type HookEventType,
	decodeNativeRequest,
	encodeNativeDecision,
	makeJsonAdapter,
} from '@factory/hooks';

const COPILOT_SUPPORTED: ReadonlyArray<HookEventType> = [
	'sessionStart',
	'userPromptSubmit',
	'preToolUse',
	'postToolUse',
	'stop',
	'permissionRequest',
];

const COPILOT_EVENT: Readonly<Record<HookEventType, string>> = {
	sessionStart: 'sessionStart',
	userPromptSubmit: 'userPromptSubmitted',
	preToolUse: 'preToolUse',
	postToolUse: 'postToolUse',
	stop: 'agentStop',
	permissionRequest: 'permissionRequest',
	// Copilot has no native failure hook; `postToolUseFailure` is synthesized
	// client-side from `tool.end ok:false` and never written to the native config.
	postToolUseFailure: 'postToolUseFailure',
};

export const copilotHooksAdapter: HarnessHookAdapter = makeJsonAdapter({
	name: HarnessName.make('copilot'),
	supportedEvents: new Set(COPILOT_SUPPORTED),
	configFilename: 'hooks.json',
	hookEntry: ({ event, socketPath, route }) => ({
		key: COPILOT_EVENT[event],
		value: [{ type: 'http', url: `http://unix:${socketPath}:/hook/${route}` }],
	}),
	result: ({ configPath }) => ({
		extraArgs: ['--additional-mcp-config', `@${configPath}`],
	}),
	decodeRequest: decodeNativeRequest,
	encodeDecision: encodeNativeDecision,
});
