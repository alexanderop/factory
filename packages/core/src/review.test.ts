import { FileSystem } from '@effect/platform';
import { NodeContext } from '@effect/platform-node';
import { describe, it } from '@effect/vitest';
import { assertInclude, assertTrue, deepStrictEqual, strictEqual } from '@effect/vitest/utils';
import { Effect, Exit } from 'effect';
import { runFactoryEffect } from './orchestrator.ts';
import { decodeFindings } from './review/finding.ts';
import { decodeStep } from './services/runManifest.ts';
import {
	cycledHarness,
	makeRunId,
	makeTestRig,
	reviewRoleFindings,
	routedHarness,
} from './testing/index.ts';
import type { ExecOpts, FactoryEvent, PipelineEntry } from './types.ts';

describe('runFactoryEffect — review step', () => {
	it.scoped('runs a single role and writes a merged findings.json', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const runDir = yield* fs.makeTempDirectoryScoped({ prefix: 'review-test-' });

			const scripted = cycledHarness('claude-code', [
				reviewRoleFindings({
					roleId: 'security',
					findings: [{ severity: 'P1', file: 'src/db.ts', line: 12, message: 'sql injection' }],
					stdout: 'wrote findings\n',
				}),
			]);

			const { layer, events } = makeTestRig({
				harnesses: [scripted],
				stepFiles: new Map([
					['./roles/security.md', '---\nname: security\n---\nReview for security issues.'],
				]),
				runId: makeRunId('test-run'),
				runDir,
			});

			const pipeline: ReadonlyArray<PipelineEntry> = [
				{
					kind: 'review',
					id: 'review',
					roles: [{ id: 'security', source: './roles/security.md', options: {} }],
					aggregate: undefined,
					concurrency: undefined,
					options: {},
				},
			];

			yield* runFactoryEffect(
				{ name: 'rev', harness: 'claude-code', harnesses: [scripted] },
				pipeline,
				{ prd: 'inline PRD', cwd: process.cwd() },
			).pipe(Effect.provide(layer));

			const merged = yield* fs.readFileString(`${runDir}/findings.json`);
			const decoded = yield* decodeFindings(merged);
			strictEqual(decoded.findings.length, 1);
			strictEqual(decoded.findings[0]?.role, 'security');
			strictEqual(decoded.findings[0]?.severity, 'P1');
			strictEqual(decoded.findings[0]?.file, 'src/db.ts');

			const ends = (yield* events).filter(
				(e): e is Extract<FactoryEvent, { type: 'step.end' }> => e.type === 'step.end',
			);
			strictEqual(ends.length, 1);
			strictEqual(ends[0]?.ok, true);
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('fans out two roles concurrently and merges both findings', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const runDir = yield* fs.makeTempDirectoryScoped({ prefix: 'review-test-' });

			const calls: ExecOpts[] = [];
			const scripted = routedHarness(
				'claude-code',
				(opts) => {
					const roleId = opts.env?.FACTORY_ROLE_ID;
					if (roleId === 'security') {
						return reviewRoleFindings({
							roleId: 'security',
							findings: [{ severity: 'P1', file: 'src/auth.ts', line: 7, message: 'missing auth' }],
						});
					}
					if (roleId === 'perf') {
						return reviewRoleFindings({
							roleId: 'perf',
							findings: [{ severity: 'P2', file: 'src/list.ts', line: 33, message: 'n+1 query' }],
						});
					}
					return {};
				},
				{ onCall: (opts) => calls.push(opts) },
			);

			const { layer } = makeTestRig({
				harnesses: [scripted],
				stepFiles: new Map([
					['./roles/security.md', '---\nname: security\n---\nSecurity.'],
					['./roles/perf.md', '---\nname: perf\n---\nPerformance.'],
				]),
				runId: makeRunId('test-run-2'),
				runDir,
			});

			const pipeline: ReadonlyArray<PipelineEntry> = [
				{
					kind: 'review',
					id: 'review',
					roles: [
						{ id: 'security', source: './roles/security.md', options: {} },
						{ id: 'perf', source: './roles/perf.md', options: {} },
					],
					aggregate: undefined,
					concurrency: undefined,
					options: {},
				},
			];

			yield* runFactoryEffect(
				{ name: 'rev', harness: 'claude-code', harnesses: [scripted] },
				pipeline,
				{ prd: 'inline PRD', cwd: process.cwd() },
			).pipe(Effect.provide(layer));

			const merged = yield* fs.readFileString(`${runDir}/findings.json`);
			const decoded = yield* decodeFindings(merged);
			strictEqual(decoded.findings.length, 2);

			const byRole = new Map(decoded.findings.map((f) => [f.role, f]));
			deepStrictEqual([...byRole.keys()].toSorted(), ['perf', 'security']);
			strictEqual(byRole.get('security')?.severity, 'P1');
			strictEqual(byRole.get('perf')?.severity, 'P2');

			strictEqual(calls.length, 2);
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('routes each role to its own harness when role.harness overrides the default', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const runDir = yield* fs.makeTempDirectoryScoped({ prefix: 'review-test-' });

			const claudeRoles: string[] = [];
			const codexRoles: string[] = [];

			const claude = routedHarness(
				'claude-code',
				(opts) =>
					reviewRoleFindings({
						roleId: opts.env?.FACTORY_ROLE_ID ?? 'unknown',
						findings: [{ severity: 'P1', file: 'src/x.ts', message: 'from claude' }],
						stdout: 'claude done\n',
					}),
				{ onCall: (o) => claudeRoles.push(o.env?.FACTORY_ROLE_ID ?? '') },
			);

			const codex = routedHarness(
				'codex',
				(opts) =>
					reviewRoleFindings({
						roleId: opts.env?.FACTORY_ROLE_ID ?? 'unknown',
						findings: [{ severity: 'P2', file: 'src/y.ts', message: 'from codex' }],
						stdout: 'codex done\n',
					}),
				{ onCall: (o) => codexRoles.push(o.env?.FACTORY_ROLE_ID ?? '') },
			);

			const { layer } = makeTestRig({
				harnesses: [claude, codex],
				stepFiles: new Map([
					['./roles/security.md', '---\nname: security\n---\nSecurity.'],
					['./roles/style.md', '---\nname: style\n---\nStyle.'],
				]),
				runId: makeRunId('test-run-4'),
				runDir,
			});

			const pipeline: ReadonlyArray<PipelineEntry> = [
				{
					kind: 'review',
					id: 'review',
					roles: [
						{ id: 'security', source: './roles/security.md', options: {} },
						{ id: 'style', source: './roles/style.md', options: { harness: 'codex' } },
					],
					aggregate: undefined,
					concurrency: undefined,
					options: {},
				},
			];

			yield* runFactoryEffect(
				{ name: 'rev', harness: 'claude-code', harnesses: [claude, codex] },
				pipeline,
				{ prd: 'inline PRD', cwd: process.cwd() },
			).pipe(Effect.provide(layer));

			deepStrictEqual(claudeRoles, ['security']);
			deepStrictEqual(codexRoles, ['style']);

			const merged = yield* fs.readFileString(`${runDir}/findings.json`);
			const decoded = yield* decodeFindings(merged);
			const byRole = new Map(decoded.findings.map((f) => [f.role, f]));
			strictEqual(byRole.get('security')?.message, 'from claude');
			strictEqual(byRole.get('style')?.message, 'from codex');
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('persists per-role status, harness, and finding count to step.json', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const runDir = yield* fs.makeTempDirectoryScoped({ prefix: 'review-test-' });

			const scripted = routedHarness('claude-code', (opts) => {
				const roleId = opts.env?.FACTORY_ROLE_ID;
				if (roleId === 'good') {
					return reviewRoleFindings({
						roleId: 'good',
						findings: [
							{ severity: 'P1', file: 'src/a.ts', message: 'a' },
							{ severity: 'P3', file: 'src/b.ts', message: 'b' },
						],
					});
				}
				if (roleId === 'bad') {
					return { stdout: 'kaboom\n', exitCode: 7 };
				}
				return {};
			});

			const { layer } = makeTestRig({
				harnesses: [scripted],
				stepFiles: new Map([
					['./roles/good.md', '---\nname: good\n---\nGood.'],
					['./roles/bad.md', '---\nname: bad\n---\nBad.'],
				]),
				runId: makeRunId('test-run-roles'),
				runDir,
			});

			const pipeline: ReadonlyArray<PipelineEntry> = [
				{
					kind: 'review',
					id: 'review',
					roles: [
						{ id: 'good', source: './roles/good.md', options: {} },
						{ id: 'bad', source: './roles/bad.md', options: {} },
					],
					aggregate: undefined,
					concurrency: undefined,
					options: {},
				},
			];

			yield* runFactoryEffect(
				{ name: 'rev', harness: 'claude-code', harnesses: [scripted] },
				pipeline,
				{ prd: 'inline PRD', cwd: process.cwd() },
			).pipe(Effect.provide(layer));

			const stepJsonPath = `${runDir}/steps/00-review/step.json`;
			const stepJson = yield* fs.readFileString(stepJsonPath);
			const decoded = yield* decodeStep(stepJson, stepJsonPath);

			strictEqual(decoded.status, 'ok');
			const roles = decoded.roles ?? [];
			strictEqual(roles.length, 2);

			const byName = new Map(roles.map((r) => [r.name, r]));
			const good = byName.get('good');
			const bad = byName.get('bad');

			strictEqual(good?.status, 'ok');
			strictEqual(good?.findings, 2);
			strictEqual(good?.harness, 'claude-code');
			strictEqual(good?.errorTag, undefined);

			strictEqual(bad?.status, 'failed');
			strictEqual(bad?.findings, 1);
			strictEqual(bad?.harness, 'claude-code');
			strictEqual(bad?.errorTag, 'HarnessExecError');
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('captures a failing role as a synthetic P3 finding without halting', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const runDir = yield* fs.makeTempDirectoryScoped({ prefix: 'review-test-' });

			const scripted = routedHarness('claude-code', (opts) => {
				const roleId = opts.env?.FACTORY_ROLE_ID;
				if (roleId === 'flaky') {
					return { stdout: 'oops\n', exitCode: 17 };
				}
				if (roleId === 'quality') {
					return reviewRoleFindings({
						roleId: 'quality',
						findings: [{ severity: 'P2', file: 'src/x.ts', message: 'magic number' }],
					});
				}
				return {};
			});

			const { layer } = makeTestRig({
				harnesses: [scripted],
				stepFiles: new Map([
					['./roles/flaky.md', '---\nname: flaky\n---\nFlaky.'],
					['./roles/quality.md', '---\nname: quality\n---\nQuality.'],
				]),
				runId: makeRunId('test-run-3'),
				runDir,
			});

			const pipeline: ReadonlyArray<PipelineEntry> = [
				{
					kind: 'review',
					id: 'review',
					roles: [
						{ id: 'flaky', source: './roles/flaky.md', options: {} },
						{ id: 'quality', source: './roles/quality.md', options: {} },
					],
					aggregate: undefined,
					concurrency: undefined,
					options: {},
				},
			];

			const exit = yield* Effect.exit(
				runFactoryEffect({ name: 'rev', harness: 'claude-code', harnesses: [scripted] }, pipeline, {
					prd: 'inline PRD',
					cwd: process.cwd(),
				}).pipe(Effect.provide(layer)),
			);

			assertTrue(Exit.isSuccess(exit));

			const merged = yield* fs.readFileString(`${runDir}/findings.json`);
			const decoded = yield* decodeFindings(merged);
			strictEqual(decoded.findings.length, 2);

			const byRole = new Map(decoded.findings.map((f) => [f.role, f]));
			strictEqual(byRole.get('quality')?.severity, 'P2');
			const flakyFinding = byRole.get('flaky');
			strictEqual(flakyFinding?.severity, 'P3');
			assertInclude(flakyFinding?.message, 'flaky');
		}).pipe(Effect.provide(NodeContext.layer)),
	);
});
