import { createSubprocessHarness } from '@factory/core';

export const codexSupports = ['skip', 'accept-edits', 'read-only'] as const;
type CodexMode = (typeof codexSupports)[number];

const codexPermissionFlags = (mode: CodexMode): readonly string[] => {
	switch (mode) {
		case 'skip':
			return ['--dangerously-bypass-approvals-and-sandbox'];
		case 'accept-edits':
			return ['--full-auto'];
		case 'read-only':
			return ['--sandbox', 'read-only'];
	}
};

export const codexBuildArgs = (
	prompt: string,
	ctx: { readonly permissions: CodexMode },
): readonly string[] => ['exec', ...codexPermissionFlags(ctx.permissions), prompt];

export const codex = createSubprocessHarness({
	name: 'codex',
	bin: 'codex',
	defaultPermissions: 'skip',
	capabilities: {
		loadSession: true,
		mcp: { http: false, sse: false },
		prompt: { image: true, audio: false, embeddedContext: false },
		session: { list: false, resume: true, close: false },
		factory: { permissions: codexSupports, toolEvents: false },
	},
	buildArgs: codexBuildArgs,
});

export { codexHookEmitter } from './hookEmitter.ts';
