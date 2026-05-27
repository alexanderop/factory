import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from '@effect/vitest';
import { strictEqual } from '@effect/vitest/utils';
import { Effect, Exit } from 'effect';
import { factory, type FactoryEvent } from '@factory/core';
import { claudeCode } from '@factory/harness-claude-code';

const hasBinary = (name: string): boolean => {
	try {
		execSync(`command -v ${name}`, { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
};

const RUN_GATE =
	hasBinary('claude') && Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_API_KEY);

const WRITE_PROMPT = `---
name: write
permissions: skip
---

Create a file named \`step1.out\` in the current working directory.
Its contents must be exactly the five characters \`alpha\` with no trailing newline.
Do not create any other files. Do not narrate.
`;

const MIRROR_PROMPT = `---
name: mirror
permissions: skip
---

Read the file \`step1.out\` in the current working directory.
Create a new file named \`step2.out\` in the same directory whose contents are
exactly the contents of \`step1.out\` (no trailing newline added, no transformation).
Do not create any other files. Do not narrate.
`;

describe('factory e2e: claude-code multi-step output flow', () => {
	it.effect.skipIf(!RUN_GATE)(
		'pipes one step output to the next via the shared workspace',
		() =>
			Effect.gen(function* () {
				const cwd = mkdtempSync(join(tmpdir(), 'factory-e2e-cc-multi-step-'));
				mkdirSync(join(cwd, 'steps'), { recursive: true });
				writeFileSync(join(cwd, 'steps', 'write.md'), WRITE_PROMPT);
				writeFileSync(join(cwd, 'steps', 'mirror.md'), MIRROR_PROMPT);

				const seen: Array<FactoryEvent['type']> = [];

				const pipeline = factory({
					name: 'e2e-multi-step',
					harnesses: [claudeCode],
					harness: 'claude-code',
				})
					.step('write', 'steps/write.md')
					.step('mirror', 'steps/mirror.md');

				const exit = yield* pipeline
					.runEffect({
						prd: '# Multi-step\n\nStep prompts contain the full spec.',
						cwd,
						otel: false,
						onStep: (event) => {
							seen.push(event.type);
						},
					})
					.pipe(Effect.exit);

				strictEqual(Exit.isSuccess(exit), true);

				strictEqual(existsSync(join(cwd, 'step1.out')), true);
				strictEqual(readFileSync(join(cwd, 'step1.out'), 'utf8'), 'alpha');

				strictEqual(existsSync(join(cwd, 'step2.out')), true);
				strictEqual(readFileSync(join(cwd, 'step2.out'), 'utf8'), 'alpha');

				const stepStarts = seen.filter((t) => t === 'step.start').length;
				const stepEnds = seen.filter((t) => t === 'step.end').length;
				strictEqual(stepStarts >= 2, true);
				strictEqual(stepEnds >= 2, true);
			}),
		{ timeout: 240_000 },
	);
});
