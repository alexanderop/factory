import { createSubprocessHarness } from '@factory/core';
import { parseLine } from './parser.ts';

export const claudeCode = createSubprocessHarness({
	name: 'claude-code',
	bin: 'claude',
	buildArgs: (prompt) => ['--output-format', 'stream-json', '--verbose', '-p', prompt],
	parseLine,
});
