import { createSubprocessHarness } from '@factory/core';
import { parseClaudeStreamJsonLine } from './streamJson.ts';

export const claudeSupports = ['skip', 'accept-edits', 'read-only', 'prompt'] as const;
type ClaudeMode = (typeof claudeSupports)[number];

const claudePermissionFlags = (mode: ClaudeMode): readonly string[] => {
	switch (mode) {
		case 'skip':
			return ['--dangerously-skip-permissions'];
		case 'accept-edits':
			return ['--permission-mode', 'acceptEdits'];
		case 'read-only':
			return ['--permission-mode', 'plan'];
		case 'prompt':
			return [];
	}
};

export const claudeBuildArgs = (
	prompt: string,
	ctx: { readonly permissions: ClaudeMode },
): readonly string[] => [
	...claudePermissionFlags(ctx.permissions),
	'--output-format',
	'stream-json',
	'--verbose',
	'-p',
	prompt,
];

export const claudeCode = createSubprocessHarness({
	name: 'claude-code',
	bin: 'claude',
	defaultPermissions: 'skip',
	capabilities: {
		loadSession: true,
		mcp: { http: true, sse: true },
		prompt: { image: true, audio: false, embeddedContext: true },
		session: { list: true, resume: true, close: false },
		factory: { permissions: claudeSupports, toolEvents: true },
	},
	buildArgs: claudeBuildArgs,
	parseStdoutLine: parseClaudeStreamJsonLine,
	telemetryEnv: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
});

export { parseClaudeStreamJsonLine } from './streamJson.ts';
export { claudeHooksAdapter } from './hooksAdapter.ts';
