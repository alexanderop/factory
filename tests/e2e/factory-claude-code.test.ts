import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

const RUN_GATE = hasBinary('claude');

const STEP_PROMPT = `---
name: touch
permissions: skip
---

Create a file named \`DONE.txt\` in the current working directory.
Its contents must be exactly the single line:

ok

Do not create any other files. Do not write anything else to DONE.txt.
When the file exists with the correct contents, stop.
`;

describe('factory e2e: claude-code', () => {
	it.effect.skipIf(!RUN_GATE)(
		'runs a one-step pipeline through the real claude CLI and writes the expected artifact',
		() =>
			Effect.gen(function* () {
				const cwd = mkdtempSync(join(tmpdir(), 'factory-e2e-cc-'));
				mkdirSync(join(cwd, 'steps'), { recursive: true });
				writeFileSync(join(cwd, 'steps', 'touch.md'), STEP_PROMPT);

				const seen: Array<FactoryEvent['type']> = [];

				const pipeline = factory({
					name: 'e2e-touch',
					harnesses: [claudeCode],
					harness: 'claude-code',
				}).step('touch', 'steps/touch.md');

				const exit = yield* pipeline
					.runEffect({
						prd: '# Touch a file\n\nThe step prompt has the full spec.',
						cwd,
						otel: false,
						onStep: (event) => {
							seen.push(event.type);
						},
					})
					.pipe(Effect.exit);

				strictEqual(Exit.isSuccess(exit), true);
				strictEqual(existsSync(join(cwd, 'DONE.txt')), true);

				strictEqual(seen.includes('run.start'), true);
				strictEqual(seen.includes('step.start'), true);
				strictEqual(seen.includes('step.iter'), true);
				strictEqual(seen.includes('step.end'), true);
				strictEqual(seen.includes('run.end'), true);
			}),
		{ timeout: 180_000 },
	);
});
