import { factory } from '@factory/core';
// importing the harness package registers it
import '@factory/harness-claude-code';

export default factory({ name: 'sdd', harness: 'claude-code' })
	.step('plan', './steps/plan.md')
	.step('ralph', './steps/ralph.md')
	.step('verify', './steps/verify.md')
	.step('qa', './steps/qa.md')
	.step('simplify', './steps/simplify.md');
