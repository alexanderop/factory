import { HarnessName } from '@factory/core';
import {
	type HarnessHookAdapter,
	type HookEventType,
	decodeNativeRequest,
	encodeNativeDecision,
	makeJsonAdapter,
} from '@factory/hooks';

const CODEX_SUPPORTED: ReadonlyArray<HookEventType> = [
	'sessionStart',
	'userPromptSubmit',
	'preToolUse',
	'postToolUse',
	'stop',
	'permissionRequest',
];

const CODEX_EVENT: Readonly<Record<HookEventType, string>> = {
	sessionStart: 'SessionStart',
	userPromptSubmit: 'UserPromptSubmit',
	preToolUse: 'PreToolUse',
	postToolUse: 'PostToolUse',
	stop: 'Stop',
	permissionRequest: 'PermissionRequest',
	// `postToolUseFailure` is synthesized client-side; never emitted to Codex.
	postToolUseFailure: 'PostToolUseFailure',
};

/** Codex emits the common 6 hook events natively. `postToolUseFailure` has no
 *  native counterpart — factory synthesizes it from `tool.end ok:false` in
 *  the harness event stream and runs handlers client-side. */
export const codexHooksAdapter: HarnessHookAdapter = makeJsonAdapter({
	name: HarnessName.make('codex'),
	supportedEvents: new Set(CODEX_SUPPORTED),
	configFilename: 'hooks.json',
	hookEntry: ({ event, socketPath, route }) => ({
		key: CODEX_EVENT[event],
		// The shim binary resolves the socket path and POSTs stdin to `route`,
		// turning Codex's `command` handler into the same HTTP request shape
		// the other harnesses use natively.
		value: [{ type: 'command', command: 'factory-hook', args: [socketPath, route] }],
	}),
	result: ({ configPath }) => ({
		extraArgs: ['-c', `hooks_path="${configPath}"`],
	}),
	decodeRequest: decodeNativeRequest,
	encodeDecision: encodeNativeDecision,
});
