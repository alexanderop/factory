import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { factory } from '@factory/core';
import { claudeCode } from '@factory/harness-claude-code';

const here = dirname(fileURLToPath(import.meta.url));
const step = (name: string): string => resolve(here, 'steps', `${name}.md`);

export default factory({
	name: 'effect-review',
	harness: 'claude-code',
	harnesses: [claudeCode],
})
	.step('plan', step('plan'))
	.step('branch', step('branch'))
	.step('ralph', step('ralph'))
	.step('pr', step('pr'));
