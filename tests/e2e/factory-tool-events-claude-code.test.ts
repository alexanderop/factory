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

const SOURCE_CONTENTS = 'the quick brown fox\n';

const COPY_PROMPT = `---
name: copy
permissions: skip
---

Use your file-reading tool to read the file \`source.txt\` in the current
working directory. Then use your file-writing tool to create a new file named
\`copy.txt\` in the same directory whose contents are exactly the contents of
\`source.txt\` (byte-for-byte; do not add or remove trailing newlines).

Do not create any other files. Do not narrate.
`;

describe('factory e2e: claude-code tool events via onStep', () => {
	it.effect.skipIf(!RUN_GATE)(
		'emits tool.start and tool.end events through the FactoryEvent stream',
		() =>
			Effect.gen(function* () {
				const cwd = mkdtempSync(join(tmpdir(), 'factory-e2e-cc-tool-events-'));
				mkdirSync(join(cwd, 'steps'), { recursive: true });
				writeFileSync(join(cwd, 'steps', 'copy.md'), COPY_PROMPT);
				writeFileSync(join(cwd, 'source.txt'), SOURCE_CONTENTS);

				const seen: Array<FactoryEvent['type']> = [];

				const pipeline = factory({
					name: 'e2e-tool-events',
					harnesses: [claudeCode],
					harness: 'claude-code',
				}).step('copy', 'steps/copy.md');

				const exit = yield* pipeline
					.runEffect({
						prd: '# Tool events test\n\nStep prompt contains the full spec.',
						cwd,
						otel: false,
						onStep: (event) => {
							seen.push(event.type);
						},
					})
					.pipe(Effect.exit);

				strictEqual(Exit.isSuccess(exit), true);

				strictEqual(existsSync(join(cwd, 'copy.txt')), true);
				strictEqual(readFileSync(join(cwd, 'copy.txt'), 'utf8'), SOURCE_CONTENTS);

				const toolStartCount = seen.filter((t) => t === 'tool.start').length;
				const toolEndCount = seen.filter((t) => t === 'tool.end').length;
				strictEqual(toolStartCount >= 1, true);
				strictEqual(toolEndCount >= 1, true);
				strictEqual(toolStartCount, toolEndCount);
			}),
		{ timeout: 240_000 },
	);
});
