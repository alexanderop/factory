import { FileSystem, Path } from '@effect/platform';
import { NodeContext } from '@effect/platform-node';
import { describe, it } from '@effect/vitest';
import { assertTrue, strictEqual } from '@effect/vitest/utils';
import { Effect } from 'effect';
import { ConfigLoadError, ResumeUnavailableError } from '@factory/core';
import { assertExitFailedWith } from '@factory/core/testing';
import { cli } from './cli.ts';

// Walk up from the test's cwd until we find a `node_modules` directory (the
// workspace root). The temp dir we hand to the CLI is symlinked against it so
// the dynamically-imported `factory.config.js` can resolve `@factory/core` and
// `@factory/core/testing` via Node's bare-module resolver.
const findWorkspaceNodeModules = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	let dir = path.resolve(process.cwd());
	for (;;) {
		const candidate = path.join(dir, 'node_modules');
		if (yield* fs.exists(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) {
			throw new Error(`could not locate node_modules walking up from ${process.cwd()}`);
		}
		dir = parent;
	}
});

const makeImportableTempDir = (prefix: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const dir = yield* fs.makeTempDirectoryScoped({ prefix });
		const nodeModules = yield* findWorkspaceNodeModules;
		yield* fs.symlink(nodeModules, path.join(dir, 'node_modules'));
		return dir;
	});

const happyPathConfig = `
import { factory } from '@factory/core';
import { scriptedHarness } from '@factory/core/testing';

const harness = scriptedHarness('claude-code', [{ stdout: 'iter-1\\n' }]);

export default factory({
  name: 'demo',
  harness: 'claude-code',
  harnesses: [harness],
}).step('plan', new URL('./steps/plan.md', import.meta.url).pathname);
`;

const planStepMd = `---
name: plan
maxIters: 1
---
Plan the work.
`;

const runCli = (argv: ReadonlyArray<string>) =>
	cli(['node', 'factory', ...argv]).pipe(Effect.provide(NodeContext.layer), Effect.exit);

const onlyRunIdEntry = (entries: ReadonlyArray<string>) => {
	const ids = entries.filter((e) => e !== 'latest');
	strictEqual(ids.length, 1);
	const [id] = ids;
	if (id === undefined) throw new Error('unreachable: length asserted above');
	return id;
};

describe('factoryCli', () => {
	describe('run', () => {
		it.scoped('fails with ConfigLoadError when no config file is present', () =>
			Effect.gen(function* () {
				const cwd = yield* makeImportableTempDir('factory-cli-no-config-');
				const exit = yield* runCli(['run', 'demo', '--prd', 'hi', '--cwd', cwd]);
				const err = assertExitFailedWith(exit, ConfigLoadError);
				assertTrue(err.message.includes('no factory config found'));
			}).pipe(Effect.provide(NodeContext.layer)),
		);

		it.scoped('fails with ConfigLoadError when config does not export a factory', () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const cwd = yield* makeImportableTempDir('factory-cli-bad-export-');
				yield* fs.writeFileString(
					path.join(cwd, 'factory.config.js'),
					"export default { not: 'a factory' };\n",
				);
				const exit = yield* runCli(['run', 'demo', '--prd', 'hi', '--cwd', cwd]);
				assertExitFailedWith(exit, ConfigLoadError);
			}).pipe(Effect.provide(NodeContext.layer)),
		);

		it.scoped('fails with ConfigLoadError when factory name differs from argv', () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const cwd = yield* makeImportableTempDir('factory-cli-name-mismatch-');
				yield* fs.writeFileString(
					path.join(cwd, 'factory.config.js'),
					`
import { factory } from '@factory/core';
import { scriptedHarness } from '@factory/core/testing';
export default factory({
  name: 'actual',
  harness: 'claude-code',
  harnesses: [scriptedHarness('claude-code', [{ stdout: 'x\\n' }])],
});
`,
				);
				const exit = yield* runCli(['run', 'expected', '--prd', 'hi', '--cwd', cwd]);
				const err = assertExitFailedWith(exit, ConfigLoadError);
				// Phrasing-order-agnostic: assert both names appear, not their order.
				assertTrue(err.message.includes("'actual'"));
				assertTrue(err.message.includes("'expected'"));
			}).pipe(Effect.provide(NodeContext.layer)),
		);

		it.scoped('happy path: writes run.json under <cwd>/.factory/runs/<runId>/', () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const cwd = yield* makeImportableTempDir('factory-cli-run-');
				yield* fs.makeDirectory(path.join(cwd, 'steps'), { recursive: true });
				yield* fs.writeFileString(path.join(cwd, 'steps', 'plan.md'), planStepMd);
				yield* fs.writeFileString(path.join(cwd, 'factory.config.js'), happyPathConfig);

				const exit = yield* runCli([
					'run',
					'demo',
					'--prd',
					'inline PRD text',
					'--cwd',
					cwd,
					'--no-otel',
				]);
				assertTrue(exit._tag === 'Success', `expected Success, got ${JSON.stringify(exit)}`);

				const runsDir = path.join(cwd, '.factory', 'runs');
				const runId = onlyRunIdEntry(yield* fs.readDirectory(runsDir));
				const runJsonExists = yield* fs.exists(path.join(runsDir, runId, 'run.json'));
				assertTrue(runJsonExists);
			}).pipe(Effect.provide(NodeContext.layer)),
		);
	});

	describe('resume', () => {
		it.scoped('fails with ResumeUnavailableError (not-found) when run dir is missing', () =>
			Effect.gen(function* () {
				const cwd = yield* makeImportableTempDir('factory-cli-resume-missing-');
				const exit = yield* runCli(['resume', 'nope', '--cwd', cwd]);
				const err = assertExitFailedWith(exit, ResumeUnavailableError);
				strictEqual(err.reason, 'not-found');
			}).pipe(Effect.provide(NodeContext.layer)),
		);

		it.scoped("fails with ResumeUnavailableError when 'latest' symlink is absent", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const cwd = yield* makeImportableTempDir('factory-cli-resume-no-latest-');
				// Runs dir exists, but no `latest` symlink — the CLI must surface a
				// ResumeUnavailableError rather than a generic fs error.
				yield* fs.makeDirectory(path.join(cwd, '.factory', 'runs'), { recursive: true });
				const exit = yield* runCli(['resume', 'latest', '--cwd', cwd]);
				const err = assertExitFailedWith(exit, ResumeUnavailableError);
				strictEqual(err.reason, 'not-found');
			}).pipe(Effect.provide(NodeContext.layer)),
		);

		it.scoped('resumes an existing run by id (piggy-backs on happy-path setup)', () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const cwd = yield* makeImportableTempDir('factory-cli-resume-ok-');
				yield* fs.makeDirectory(path.join(cwd, 'steps'), { recursive: true });
				yield* fs.writeFileString(path.join(cwd, 'steps', 'plan.md'), planStepMd);
				yield* fs.writeFileString(path.join(cwd, 'factory.config.js'), happyPathConfig);

				const runExit = yield* runCli([
					'run',
					'demo',
					'--prd',
					'inline PRD',
					'--cwd',
					cwd,
					'--no-otel',
				]);
				assertTrue(runExit._tag === 'Success');

				const runsDir = path.join(cwd, '.factory', 'runs');
				const runId = onlyRunIdEntry(yield* fs.readDirectory(runsDir));

				// Asserting the CLI drove `factoryDef.resumeEffect` (config loaded +
				// run.json read + dispatched). The orchestrator then hits
				// ResumeUnavailableError('already-complete') because the prior run
				// finished — that's the expected end state, not a test of resume
				// itself.
				const resumeExit = yield* runCli(['resume', runId, '--cwd', cwd, '--no-otel']);
				const err = assertExitFailedWith(resumeExit, ResumeUnavailableError);
				strictEqual(err.reason, 'already-complete');
			}).pipe(Effect.provide(NodeContext.layer)),
		);
	});
});
