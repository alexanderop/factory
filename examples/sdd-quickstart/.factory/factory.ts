import { factory } from '@factory/core';
import { claudeCode } from '@factory/harness-claude-code';

export default factory({
	name: 'sdd',
	harness: 'claude-code',
	harnesses: [claudeCode],
})
	.step('plan', './.factory/steps/plan.md')
	.step('ralph', './.factory/steps/ralph.md')
	.step('verify', './.factory/steps/verify.md')
	.step('qa', './.factory/steps/qa.md')
	.step('simplify', './.factory/steps/simplify.md');
