import { factory } from '@factory/core';
import { claudeCode } from '@factory/harness-claude-code';
import { codex } from '@factory/harness-codex';
import { copilot } from '@factory/harness-copilot';

export default factory({
	name: 'sdd',
	harness: 'claude-code',
	harnesses: [claudeCode, codex, copilot],
})
	.step('plan', './.factory/steps/plan.md', { harness: 'claude-code' })
	.step('ralph', './.factory/steps/ralph.md', { harness: 'codex' })
	.step('verify', './.factory/steps/verify.md', { harness: 'claude-code' })
	.step('qa', './.factory/steps/qa.md', { harness: 'copilot' })
	.step('simplify', './.factory/steps/simplify.md', { harness: 'codex' });
