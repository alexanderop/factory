import { createSubprocessHarness, registerHarness } from '@factory/core';

export const copilot = createSubprocessHarness({
	name: 'copilot',
	bin: 'copilot',
	buildArgs: (prompt) => ['suggest', '--prompt', prompt],
});

registerHarness(copilot);
