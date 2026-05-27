import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from '@effect/vitest';
import { strictEqual } from '@effect/vitest/utils';
import { factory } from '@factory/core';
import { codex, codexHooksAdapter } from '@factory/harness-codex';
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

const CODEX_AVAILABLE = hasBinary('codex');
const API_KEY_AVAILABLE = Boolean(process.env.OPENAI_API_KEY);
// Codex hooks are `command` handlers that shell out to `factory-hook`, so the
// shim must be installed on PATH (`pnpm --dir packages/harness-codex link --global`).
const SHIM_AVAILABLE = hasBinary('factory-hook');
const RUN_GATE = CODEX_AVAILABLE && API_KEY_AVAILABLE && SHIM_AVAILABLE;

const STEP_PROMPT = `---
name: noop
permissions: skip
---

Reply with the single word: done. Do not use any tools.
`;

describe('hooks e2e: codex', () => {
	it.effect.skipIf(!RUN_GATE)(
		'sessionStart handler writes a sentinel file via the real CLI round-trip',
		() =>
			Effect.gen(function* () {
				const cwd = mkdtempSync(join(tmpdir(), 'factory-hooks-e2e-codex-'));
				mkdirSync(join(cwd, 'steps'), { recursive: true });
				writeFileSync(join(cwd, 'steps', 'noop.md'), STEP_PROMPT);
				const sentinelPath = join(cwd, 'sentinel.txt');

				const pipeline = factory({
					name: 'hooks-e2e-codex',
					harnesses: [codex],
					harness: 'codex',
					hooks: hooksLayer({
						config: {
							sessionStart: [
								{
									handler: () =>
										Effect.sync(() => writeFileSync(sentinelPath, 'sessionStart fired')),
								},
							],
						},
						adapters: [codexHooksAdapter],
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
