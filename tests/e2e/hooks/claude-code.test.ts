import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from '@effect/vitest';
import { strictEqual } from '@effect/vitest/utils';
import { factory } from '@factory/core';
import { claudeCode, claudeHooksAdapter } from '@factory/harness-claude-code';
import { hooksLayer } from '@factory/hooks';
import { Effect } from 'effect';

const hasBinary = (name: string): boolean => {
	try {
		execSync(`command -v ${name}`, { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
};

const CLAUDE_AVAILABLE = hasBinary('claude');
const API_KEY_AVAILABLE = Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_API_KEY);
const RUN_GATE = CLAUDE_AVAILABLE && API_KEY_AVAILABLE;

const STEP_PROMPT = `---
name: noop
permissions: skip
---

Reply with the single word: done. Do not use any tools.
`;

describe('hooks e2e: claude-code', () => {
	it.effect.skipIf(!RUN_GATE)(
		'sessionStart handler writes a sentinel file via the real CLI round-trip',
		() =>
			Effect.gen(function* () {
				const cwd = mkdtempSync(join(tmpdir(), 'factory-hooks-e2e-claude-'));
				mkdirSync(join(cwd, 'steps'), { recursive: true });
				writeFileSync(join(cwd, 'steps', 'noop.md'), STEP_PROMPT);
				const sentinelPath = join(cwd, 'sentinel.txt');

				const pipeline = factory({
					name: 'hooks-e2e-cc',
					harnesses: [claudeCode],
					harness: 'claude-code',
					hooks: hooksLayer({
						config: {
							sessionStart: [
								{
									handler: () =>
										Effect.sync(() => writeFileSync(sentinelPath, 'sessionStart fired')),
								},
							],
						},
						adapters: [claudeHooksAdapter],
					}),
				}).step('noop', 'steps/noop.md');

				yield* pipeline.runEffect({
					prd: '# Hooks smoke\n\nThe step prompt has the full spec.',
					cwd,
					otel: false,
				});

				strictEqual(existsSync(sentinelPath), true);
				strictEqual(readFileSync(sentinelPath, 'utf8'), 'sessionStart fired');
			}),
		{ timeout: 180_000 },
	);
});
