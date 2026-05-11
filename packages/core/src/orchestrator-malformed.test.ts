import { FileSystem } from '@effect/platform';
import { NodeContext } from '@effect/platform-node';
import { describe, it } from '@effect/vitest';
import { assertInclude, assertTrue, deepStrictEqual, strictEqual } from '@effect/vitest/utils';
import { Effect, Exit, Ref } from 'effect';
import { HarnessExecError } from './errors.ts';
import { runFactoryEffect } from './orchestrator.ts';
import { decodeFindings } from './review/finding.ts';
import { decodeStep } from './services/runManifest.ts';
import {
	assertExitFailedWith,
	cycledHarness,
	makeTestLayer,
	routedHarness,
	type ScriptedResponder,
} from './testing/index.ts';
import type { FactoryEvent, PipelineEntry } from './types.ts';

// `runReview` catches per-role failures (missing findings.json, malformed JSON,
// schema mismatch) and converts them into a synthetic P3 finding via
// `mergeFindings`. The orchestrator therefore SUCCEEDS for cases 1, 2, 3, 6 —
// the user-visible artefact is a `'failed'` role record in `step.json` plus
// the synthetic P3 in the merged `findings.json`. We assert on those instead
// of on a propagated typed error. (Task description suggested expecting a
// typed failure; the production code's contract is graceful capture, so the
// tests assert the actual contract.)

const REVIEW_PIPELINE: ReadonlyArray<PipelineEntry> = [
	{
		kind: 'review',
		id: 'review',
		roles: [{ id: 'security', source: './roles/security.md', options: {} }],
		aggregate: undefined,
		concurrency: undefined,
		options: {},
	},
];

const REVIEW_ROLE_FILES = new Map([
	['./roles/security.md', '---\nname: security\n---\nReview for security issues.'],
]);

const runReviewWithRoleResponse = (runDir: string, response: ScriptedResponder) =>
	Effect.gen(function* () {
		const harness = routedHarness('claude-code', response);
		const layer = makeTestLayer({
			harnesses: [harness],
			stepFiles: REVIEW_ROLE_FILES,
			runDir,
		});
		return yield* Effect.exit(
			runFactoryEffect(
				{ name: 'rev', harness: 'claude-code', harnesses: [harness] },
				REVIEW_PIPELINE,
				{ prd: 'inline PRD', cwd: process.cwd() },
			).pipe(Effect.provide(layer)),
		);
	});

const readRoleRecord = (runDir: string, roleId: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const stepJsonPath = `${runDir}/steps/00-review/step.json`;
		const stepJson = yield* fs.readFileString(stepJsonPath);
		const decoded = yield* decodeStep(stepJson, stepJsonPath);
		const role = decoded.roles?.find((r) => r.name === roleId);
		assertTrue(role !== undefined);
		return role;
	});

const readMergedFindings = (runDir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const merged = yield* fs.readFileString(`${runDir}/findings.json`);
		return yield* decodeFindings(merged);
	});

describe('orchestrator — malformed harness responses', () => {
	it.scoped('review role with empty stdout and no findings.json is captured as SystemError', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const runDir = yield* fs.makeTempDirectoryScoped({ prefix: 'malformed-empty-' });

			const exit = yield* runReviewWithRoleResponse(runDir, () => ({
				stdout: '',
				exitCode: 0,
			}));

			assertTrue(Exit.isSuccess(exit));

			const role = yield* readRoleRecord(runDir, 'security');
			strictEqual(role.status, 'failed');
			strictEqual(role.errorTag, 'SystemError');

			const findings = yield* readMergedFindings(runDir);
			strictEqual(findings.findings.length, 1);
			strictEqual(findings.findings[0]?.severity, 'P3');
			strictEqual(findings.findings[0]?.role, 'security');
			assertInclude(findings.findings[0]?.message, 'security');
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('review role with malformed JSON in findings.json is captured as ParseError', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const runDir = yield* fs.makeTempDirectoryScoped({ prefix: 'malformed-json-' });

			const exit = yield* runReviewWithRoleResponse(runDir, () => ({
				stdout: 'wrote garbage\n',
				writes: [
					{
						path: 'steps/00-review/roles/security/findings.json',
						content: 'not json {{{',
					},
				],
			}));

			assertTrue(Exit.isSuccess(exit));

			const role = yield* readRoleRecord(runDir, 'security');
			strictEqual(role.status, 'failed');
			strictEqual(role.errorTag, 'ParseError');

			const findings = yield* readMergedFindings(runDir);
			strictEqual(findings.findings.length, 1);
			strictEqual(findings.findings[0]?.severity, 'P3');
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('review role with wrong-shape JSON is captured as ParseError', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const runDir = yield* fs.makeTempDirectoryScoped({ prefix: 'malformed-shape-' });

			const exit = yield* runReviewWithRoleResponse(runDir, () => ({
				stdout: 'wrong shape\n',
				writes: [
					{
						path: 'steps/00-review/roles/security/findings.json',
						// valid JSON, but missing the required `findings` array
						content: JSON.stringify({ wrong: 'shape', items: [] }),
					},
				],
			}));

			assertTrue(Exit.isSuccess(exit));

			const role = yield* readRoleRecord(runDir, 'security');
			strictEqual(role.status, 'failed');
			strictEqual(role.errorTag, 'ParseError');
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('orchestrator step with stderr-only output and exit 0 still succeeds', () =>
		Effect.gen(function* () {
			const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);
			const harness = cycledHarness('claude-code', [{ stderr: 'noisy warning\n', exitCode: 0 }]);
			const layer = makeTestLayer({
				eventsRef,
				harnesses: [harness],
				stepFiles: new Map([['./steps/only.md', '---\nname: only\n---\nDo it.']]),
				verdicts: [true],
			});

			yield* runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code', harnesses: [harness] },
				[{ kind: 'step', id: 'only', source: './steps/only.md', options: {} }],
				{ prd: 'inline PRD', cwd: process.cwd() },
			).pipe(Effect.provide(layer));

			const events = yield* Ref.get(eventsRef);
			const ends = events.filter(
				(e): e is Extract<FactoryEvent, { type: 'step.end' }> => e.type === 'step.end',
			);
			strictEqual(ends.length, 1);
			strictEqual(ends[0]?.ok, true);
			deepStrictEqual(
				events.map((e) => e.type).filter((t) => t === 'error'),
				[],
			);
		}),
	);

	it.effect('mid-stream crash via events array surfaces as HarnessExecError', () =>
		Effect.gen(function* () {
			const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);
			// `scriptedHarness` appends a trailing `{ type: 'exit', code: r.exitCode ?? 0 }`
			// after `events`, so the inner crash exit must be matched on `exitCode`
			// to survive that trailing event.
			const harness = cycledHarness('claude-code', [
				{
					exitCode: 137,
					events: [
						{ type: 'stdout', line: 'starting up' },
						{ type: 'exit', code: 137 },
					],
				},
			]);
			const layer = makeTestLayer({
				eventsRef,
				harnesses: [harness],
				stepFiles: new Map([['./steps/only.md', '---\nname: only\n---\nDo it.']]),
				verdicts: [true],
			});

			const exit = yield* Effect.exit(
				runFactoryEffect(
					{ name: 'sdd', harness: 'claude-code', harnesses: [harness] },
					[{ kind: 'step', id: 'only', source: './steps/only.md', options: {} }],
					{ prd: 'inline PRD', cwd: process.cwd() },
				).pipe(Effect.provide(layer)),
			);

			const err = assertExitFailedWith(exit, HarnessExecError);
			strictEqual(err.exitCode, 137);
			strictEqual(err.harness, 'claude-code');

			const events = yield* Ref.get(eventsRef);
			const errorEvents = events.filter((e) => e.type === 'error');
			strictEqual(errorEvents.length, 1);
		}),
	);

	it.scoped('review role with truncated findings.json is captured as ParseError', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const runDir = yield* fs.makeTempDirectoryScoped({ prefix: 'malformed-trunc-' });

			// Simulates a partial-write: process killed mid-flush, file exists
			// but ends abruptly. JSON.parse will fail.
			const exit = yield* runReviewWithRoleResponse(runDir, () => ({
				stdout: 'wrote half\n',
				writes: [
					{
						path: 'steps/00-review/roles/security/findings.json',
						content: '{"findings": [',
					},
				],
			}));

			assertTrue(Exit.isSuccess(exit));

			const role = yield* readRoleRecord(runDir, 'security');
			strictEqual(role.status, 'failed');
			strictEqual(role.errorTag, 'ParseError');

			const findings = yield* readMergedFindings(runDir);
			strictEqual(findings.findings.length, 1);
			strictEqual(findings.findings[0]?.severity, 'P3');
		}).pipe(Effect.provide(NodeContext.layer)),
	);
});
