import { createSubprocessHarness } from '@factory/core';

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
): readonly string[] => [...claudePermissionFlags(ctx.permissions), '-p', prompt];

export const claudeCode = createSubprocessHarness({
	name: 'claude-code',
	bin: 'claude',
	supports: claudeSupports,
	defaultPermissions: 'skip',
	buildArgs: claudeBuildArgs,
});
