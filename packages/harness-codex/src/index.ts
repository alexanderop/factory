import { createSubprocessHarness } from '@factory/core';

export const codex = createSubprocessHarness({
	name: 'codex',
	bin: 'codex',
	buildArgs: (prompt) => ['exec', prompt],
});
