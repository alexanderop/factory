import { createSubprocessHarness } from '@factory/core';
import { parseLine } from './parser.ts';

export const codex = createSubprocessHarness({
	name: 'codex',
	bin: 'codex',
	buildArgs: (prompt) => ['exec', '--json', prompt],
	parseLine,
});
