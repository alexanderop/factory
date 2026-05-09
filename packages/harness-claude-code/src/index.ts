import { createSubprocessHarness, registerHarness } from '@factory/core';

export const claudeCode = createSubprocessHarness({
	name: 'claude-code',
	bin: 'claude',
	buildArgs: (prompt) => ['-p', prompt],
});

registerHarness(claudeCode);
