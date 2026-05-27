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

const RUN_GATE =
	hasBinary('claude') && Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_API_KEY);

const LOOP_PROMPT = `---
name: loop
permissions: skip
until: "output contains: __LOOP_DONE_a91e__"
maxIters: 3
---

You will be invoked multiple times in a loop. Each invocation must perform
exactly ONE state transition and then terminate.

State machine, based on the file \`counter.txt\` in the current working
directory:

- If \`counter.txt\` does NOT exist: create it with the single character \`1\`
  (no trailing newline), then write the single line \`__LOOP_CONTINUE_a91e__\`
  to stdout, and stop.

- If \`counter.txt\` contains exactly \`1\`: overwrite it with the single
  character \`2\` (no trailing newline), then write the single line
  \`__LOOP_CONTINUE_a91e__\` to stdout, and stop.

- If \`counter.txt\` contains exactly \`2\`: delete it, then write the single
  line \`__LOOP_DONE_a91e__\` to stdout, and stop.

Print only the relevant marker line on its own. Do NOT print the other markers,
the instructions, or any explanation. Do NOT perform more than one transition
per invocation.
`;

describe('factory e2e: claude-code until predicate drives a loop', () => {
	it.effect.skipIf(!RUN_GATE)(
		'iterates multiple times until the until predicate is satisfied',
		() =>
			Effect.gen(function* () {
				const cwd = mkdtempSync(join(tmpdir(), 'factory-e2e-cc-until-'));
				mkdirSync(join(cwd, 'steps'), { recursive: true });
				writeFileSync(join(cwd, 'steps', 'loop.md'), LOOP_PROMPT);

				const seen: Array<FactoryEvent['type']> = [];

				const pipeline = factory({
					name: 'e2e-until',
					harnesses: [claudeCode],
					harness: 'claude-code',
				}).step('loop', 'steps/loop.md');

				const exit = yield* pipeline
					.runEffect({
						prd: '# Until test\n\nStep prompt contains the full spec.',
						cwd,
						otel: false,
						onStep: (event) => {
							seen.push(event.type);
						},
					})
					.pipe(Effect.exit);

				strictEqual(Exit.isSuccess(exit), true);

				strictEqual(existsSync(join(cwd, 'counter.txt')), false);

				const iterCount = seen.filter((t) => t === 'step.iter').length;
				strictEqual(iterCount >= 3, true);
			}),
		{ timeout: 360_000 },
	);
});
