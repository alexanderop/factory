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
	auth: {
		envVars: [
			{ name: 'ANTHROPIC_AUTH_TOKEN', kind: 'bearer', description: 'Anthropic bearer token' },
			{ name: 'ANTHROPIC_API_KEY', kind: 'api-key', description: 'Anthropic API key' },
			{
				name: 'CLAUDE_CODE_OAUTH_TOKEN',
				kind: 'oauth-token',
				description: 'Claude Code OAuth token',
			},
		],
		extraEnv: [{ name: 'ANTHROPIC_BASE_URL', description: 'Anthropic API base URL override' }],
	},
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
