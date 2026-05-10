import { createSubprocessHarness } from '@factory/core';

export const copilotSupports = ['skip', 'accept-edits'] as const;
type CopilotMode = (typeof copilotSupports)[number];

const copilotPermissionFlags = (mode: CopilotMode): readonly string[] => {
	switch (mode) {
		case 'skip':
			return ['--allow-all'];
		case 'accept-edits':
			return ['--allow-all-tools'];
	}
};

export const copilotBuildArgs = (
	prompt: string,
	ctx: { readonly permissions: CopilotMode },
): readonly string[] => [...copilotPermissionFlags(ctx.permissions), '-p', prompt];

export const copilot = createSubprocessHarness({
	name: 'copilot',
	bin: 'copilot',
	defaultPermissions: 'skip',
	auth: {
		envVars: [
			{ name: 'GH_TOKEN', kind: 'pat', description: 'GitHub personal access token' },
			{ name: 'GITHUB_TOKEN', kind: 'pat', description: 'GitHub token (fallback)' },
		],
	},
	capabilities: {
		loadSession: false,
		mcp: { http: false, sse: false },
		prompt: { image: false, audio: false, embeddedContext: false },
		session: { list: false, resume: false, close: false },
		factory: { permissions: copilotSupports, toolEvents: false },
	},
	buildArgs: copilotBuildArgs,
});
