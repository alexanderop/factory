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
	supports: copilotSupports,
	defaultPermissions: 'skip',
	buildArgs: copilotBuildArgs,
});
