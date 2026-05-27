import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from '@effect/vitest';
import { strictEqual } from '@effect/vitest/utils';
import { Effect, Exit, Schema } from 'effect';
import { factory, type FactoryEvent, type RunId } from '@factory/core';
import { claudeCode } from '@factory/harness-claude-code';

const decodeStatus = Schema.decodeUnknownSync(Schema.Struct({ status: Schema.String }));

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

const STEP1_PROMPT = `---
name: step1
permissions: skip
---

Create a file named \`step1.out\` in the current working directory containing
exactly the three characters \`one\` with no trailing newline.
Do not create any other files. Do not narrate.
`;

const STEP2_PROMPT = `---
name: step2
permissions: skip
until: "output contains: __STEP2_DONE_b6f1__"
maxIters: 1
---

Check whether the file \`gate.ready\` exists in the current working directory.

If \`gate.ready\` exists: create a file named \`step2.out\` containing exactly
the two characters \`ok\` with no trailing newline. Then write the single line
\`__STEP2_DONE_b6f1__\` to stdout and stop.

If \`gate.ready\` does NOT exist: do not modify any files. Write the single
line \`__STEP2_PENDING_b6f1__\` to stdout and stop.

Output ONLY the marker line on its own. Do not narrate. Do not mention the
markers anywhere except as the literal output line.
`;

describe('factory e2e: claude-code resume after mid-run failure', () => {
	it.effect.skipIf(!RUN_GATE)(
		'fails when the gate is missing, then resumes and completes once the gate is in place',
		() =>
			Effect.gen(function* () {
				const cwd = mkdtempSync(join(tmpdir(), 'factory-e2e-cc-resume-'));
				mkdirSync(join(cwd, 'steps'), { recursive: true });
				writeFileSync(join(cwd, 'steps', 'step1.md'), STEP1_PROMPT);
				writeFileSync(join(cwd, 'steps', 'step2.md'), STEP2_PROMPT);

				const pipeline = factory({
					name: 'e2e-resume',
					harnesses: [claudeCode],
					harness: 'claude-code',
				})
					.step('step1', 'steps/step1.md')
					.step('step2', 'steps/step2.md');

				let capturedRunId: RunId | undefined;
				const firstRunSeen: Array<FactoryEvent['type']> = [];

				const firstExit = yield* pipeline
					.runEffect({
						prd: '# Resume test\n\nStep prompts contain the full spec.',
						cwd,
						otel: false,
						onStep: (event) => {
							firstRunSeen.push(event.type);
							if (event.type === 'run.start') {
								capturedRunId = event.runId;
							}
						},
					})
					.pipe(Effect.exit);

				strictEqual(Exit.isFailure(firstExit), true);
				if (capturedRunId === undefined) {
					throw new Error('run.start did not provide a runId');
				}
				const runId: RunId = capturedRunId;
				const runDir = join(cwd, '.factory', 'runs', runId);
				const step1JsonPath = join(runDir, 'steps', '00-step1', 'step.json');
				const step2JsonPath = join(runDir, 'steps', '01-step2', 'step.json');
				const runJsonPath = join(runDir, 'run.json');

				strictEqual(existsSync(join(cwd, 'step1.out')), true);
				strictEqual(readFileSync(join(cwd, 'step1.out'), 'utf8'), 'one');

				const step1AfterRun1 = decodeStatus(JSON.parse(readFileSync(step1JsonPath, 'utf8')));
				strictEqual(step1AfterRun1.status, 'ok');

				const step2AfterRun1 = decodeStatus(JSON.parse(readFileSync(step2JsonPath, 'utf8')));
				strictEqual(step2AfterRun1.status, 'failed');

				const runAfterRun1 = decodeStatus(JSON.parse(readFileSync(runJsonPath, 'utf8')));
				strictEqual(runAfterRun1.status, 'error');

				strictEqual(existsSync(join(cwd, 'step2.out')), false);

				writeFileSync(join(cwd, 'gate.ready'), '');

				const resumeSeen: Array<FactoryEvent['type']> = [];
				const resumeStepStarts: string[] = [];

				const resumeExit = yield* pipeline
					.resumeEffect({
						runId,
						cwd,
						otel: false,
						onStep: (event) => {
							resumeSeen.push(event.type);
							if (event.type === 'step.start') {
								resumeStepStarts.push(event.step);
							}
						},
					})
					.pipe(Effect.exit);

				strictEqual(Exit.isSuccess(resumeExit), true);

				strictEqual(existsSync(join(cwd, 'step2.out')), true);
				strictEqual(readFileSync(join(cwd, 'step2.out'), 'utf8'), 'ok');

				strictEqual(readFileSync(join(cwd, 'step1.out'), 'utf8'), 'one');

				const step2AfterResume = decodeStatus(JSON.parse(readFileSync(step2JsonPath, 'utf8')));
				strictEqual(step2AfterResume.status, 'ok');

				const runAfterResume = decodeStatus(JSON.parse(readFileSync(runJsonPath, 'utf8')));
				strictEqual(runAfterResume.status, 'ok');

				strictEqual(resumeStepStarts.includes('step1'), false);
				strictEqual(resumeStepStarts.includes('step2'), true);
			}),
		{ timeout: 360_000 },
	);
});
