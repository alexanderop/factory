import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from '@effect/vitest';
import { strictEqual } from '@effect/vitest/utils';
import { Effect, Exit, Schema } from 'effect';
import { factory, type FactoryEvent, RoleFinding, type RunId } from '@factory/core';
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

const SEED_PROMPT = `---
name: seed
permissions: skip
---

Create a file named \`subject.txt\` in the current working directory with these
exact three lines (each terminated with a newline):

line1
line2
line3

Do not create any other files. Do not narrate.
`;

const ROLE_SECURITY_PROMPT = `---
name: security
permissions: skip
---

The environment variable FACTORY_ROLE_DIR holds the absolute path of your role
directory. Run this shell command verbatim (it uses the env var to write to the
correct location):

mkdir -p "$FACTORY_ROLE_DIR" && printf '%s' '{"findings":[{"severity":"P3","file":"subject.txt","line":1,"message":"security review noted line 1"}]}' > "$FACTORY_ROLE_DIR/findings.json"

Do not write any other files. Do not edit subject.txt. Do not narrate.
`;

const ROLE_STYLE_PROMPT = `---
name: style
permissions: skip
---

The environment variable FACTORY_ROLE_DIR holds the absolute path of your role
directory. Run this shell command verbatim (it uses the env var to write to the
correct location):

mkdir -p "$FACTORY_ROLE_DIR" && printf '%s' '{"findings":[{"severity":"P3","file":"subject.txt","line":2,"message":"style review noted line 2"}]}' > "$FACTORY_ROLE_DIR/findings.json"

Do not write any other files. Do not edit subject.txt. Do not narrate.
`;

const decodeRoleFinding = Schema.decodeUnknownSync(
	Schema.Struct({ findings: Schema.Array(RoleFinding) }),
);

describe('factory e2e: claude-code review step with multiple roles', () => {
	it.effect.skipIf(!RUN_GATE)(
		'fans out to two roles which each write a structurally valid findings.json',
		() =>
			Effect.gen(function* () {
				const cwd = mkdtempSync(join(tmpdir(), 'factory-e2e-cc-review-'));
				mkdirSync(join(cwd, 'steps'), { recursive: true });
				writeFileSync(join(cwd, 'steps', 'seed.md'), SEED_PROMPT);
				writeFileSync(join(cwd, 'steps', 'role-security.md'), ROLE_SECURITY_PROMPT);
				writeFileSync(join(cwd, 'steps', 'role-style.md'), ROLE_STYLE_PROMPT);

				let capturedRunId: RunId | undefined;
				const seen: Array<FactoryEvent['type']> = [];
				const stepStarts: string[] = [];
				const stepEnds: string[] = [];

				const pipeline = factory({
					name: 'e2e-review',
					harnesses: [claudeCode],
					harness: 'claude-code',
				})
					.step('seed', 'steps/seed.md')
					.review('audit', {
						roles: [
							{ id: 'security', source: 'steps/role-security.md' },
							{ id: 'style', source: 'steps/role-style.md' },
						],
					});

				const exit = yield* pipeline
					.runEffect({
						prd: '# Review test\n\nStep and role prompts contain the full spec.',
						cwd,
						otel: false,
						onStep: (event) => {
							seen.push(event.type);
							if (event.type === 'run.start') {
								capturedRunId = event.runId;
							}
							if (event.type === 'step.start') {
								stepStarts.push(event.step);
							}
							if (event.type === 'step.end') {
								stepEnds.push(event.step);
							}
						},
					})
					.pipe(Effect.exit);

				strictEqual(Exit.isSuccess(exit), true);
				if (capturedRunId === undefined) {
					throw new Error('run.start did not provide a runId');
				}
				const runId: RunId = capturedRunId;
				const auditDir = join(cwd, '.factory', 'runs', runId, 'steps', '01-audit');
				const securityFindings = join(auditDir, 'roles', 'security', 'findings.json');
				const styleFindings = join(auditDir, 'roles', 'style', 'findings.json');

				strictEqual(existsSync(securityFindings), true);
				strictEqual(existsSync(styleFindings), true);

				const securityDecoded = decodeRoleFinding(
					JSON.parse(readFileSync(securityFindings, 'utf8')),
				);
				const styleDecoded = decodeRoleFinding(JSON.parse(readFileSync(styleFindings, 'utf8')));

				strictEqual(securityDecoded.findings.length >= 1, true);
				strictEqual(styleDecoded.findings.length >= 1, true);

				strictEqual(stepStarts.includes('seed'), true);
				strictEqual(stepStarts.includes('audit'), true);
				strictEqual(stepEnds.includes('seed'), true);
				strictEqual(stepEnds.includes('audit'), true);
			}),
		{ timeout: 360_000 },
	);
});
