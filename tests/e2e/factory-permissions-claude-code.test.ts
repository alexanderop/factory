import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from '@effect/vitest';
import { strictEqual } from '@effect/vitest/utils';
import { Effect, Exit } from 'effect';
import { factory } from '@factory/core';
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
---

Create a file named \`wrote.txt\` in the current working directory containing
exactly the two characters \`ok\` with no trailing newline.
Do not create any other files. Do not narrate.
`;

const buildPipeline = (mode: 'skip' | 'read-only') =>
	factory({
		name: 'e2e-permissions',
		harnesses: [claudeCode],
		harness: 'claude-code',
	}).step('write', 'steps/write.md', { permissions: mode });

describe('factory e2e: claude-code permission modes', () => {
	it.effect.skipIf(!RUN_GATE)(
		'permissions: skip allows the write tool and the file is created',
		() =>
			Effect.gen(function* () {
				const cwd = mkdtempSync(join(tmpdir(), 'factory-e2e-cc-perm-skip-'));
				mkdirSync(join(cwd, 'steps'), { recursive: true });
				writeFileSync(join(cwd, 'steps', 'write.md'), WRITE_PROMPT);

				const pipeline = buildPipeline('skip');

				const exit = yield* pipeline
					.runEffect({
						prd: '# Permissions skip\n\nStep prompt contains the full spec.',
						cwd,
						otel: false,
					})
					.pipe(Effect.exit);

				strictEqual(Exit.isSuccess(exit), true);
				strictEqual(existsSync(join(cwd, 'wrote.txt')), true);
				strictEqual(readFileSync(join(cwd, 'wrote.txt'), 'utf8'), 'ok');
			}),
		{ timeout: 240_000 },
	);

	it.effect.skipIf(!RUN_GATE)(
		'permissions: read-only blocks the write tool and the file is NOT created',
		() =>
			Effect.gen(function* () {
				const cwd = mkdtempSync(join(tmpdir(), 'factory-e2e-cc-perm-ro-'));
				mkdirSync(join(cwd, 'steps'), { recursive: true });
				writeFileSync(join(cwd, 'steps', 'write.md'), WRITE_PROMPT);

				const pipeline = buildPipeline('read-only');

				yield* pipeline
					.runEffect({
						prd: '# Permissions read-only\n\nStep prompt contains the full spec.',
						cwd,
						otel: false,
					})
					.pipe(Effect.exit);

				strictEqual(existsSync(join(cwd, 'wrote.txt')), false);
			}),
		{ timeout: 240_000 },
	);
});
