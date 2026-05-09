import { createSubprocessHarness, registerHarness } from '@factory/core';

export const codex = createSubprocessHarness({
	name: 'codex',
	bin: 'codex',
	buildArgs: (prompt) => ['exec', prompt],
});

registerHarness(codex);
