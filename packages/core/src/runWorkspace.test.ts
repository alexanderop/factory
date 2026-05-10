import { FileSystem, Path } from '@effect/platform';
import { NodeContext } from '@effect/platform-node';
import { describe, it } from '@effect/vitest';
import { assertTrue, deepStrictEqual, strictEqual } from '@effect/vitest/utils';
import {
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Predicate,
	Ref,
	Schema,
	Stream,
} from 'effect';
import { ResumeUnavailableError, StepMaxItersError } from './errors.ts';
import { HarnessName, PipelineName, RunId, StepId } from './ids.ts';
import { resumeFactoryEffect, runFactoryEffect } from './orchestrator.ts';
import type { Harness, HarnessEvent } from './types.ts';
import {
	decodeRun,
	decodeStep,
	IterRecord,
	type RunRecord,
	type StepRecord,
	writeRun,
	writeStep,
} from './services/runManifest.ts';
import { LiveRunWorkspace, RunWorkspace } from './services/RunWorkspace.ts';
import {
	type DisplayEntry,
	harnessRegistryLayer,
	InMemoryStepLoader,
	noopEventEmitter,
	scriptedHarness,
	scriptedUntilEvaluator,
	SilentDisplay,
} from './testing/index.ts';

const decodeIterRecord = Schema.decodeUnknown(IterRecord);

const listTreeRelative = (
	root: string,
): Effect.Effect<ReadonlyArray<string>, unknown, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const out: string[] = [];
		const walk = (dir: string): Effect.Effect<void, unknown> =>
			Effect.gen(function* () {
				const entries = yield* fs.readDirectory(dir);
				for (const name of entries) {
					const full = path.join(dir, name);
					const stat = yield* fs.stat(full);
					if (stat.type === 'Directory') {
						yield* walk(full);
					} else {
						out.push(path.relative(root, full));
					}
				}
			});
		yield* walk(root);
		return out.toSorted();
	});

describe('runWorkspace integration (file-only manifests)', () => {
	it.scoped('writes the canonical run directory layout', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const tmp = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-run-' });
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);

			const planMd = '---\nname: plan\n---\nWrite a plan.';
			const ralphMd = '---\nname: ralph\n---\nIterate.';
			const stepsMap = new Map([
				['./steps/plan.md', planMd],
				['./steps/ralph.md', ralphMd],
			]);

			const runId = RunId.make('integration-test-run');

			const fakeHarness = scriptedHarness('claude-code', [
				{ stdout: 'iter-1\n' },
				{ stdout: 'iter-2\n' },
			]);

			const layer = Layer.mergeAll(
				SilentDisplay.layer(displayRef),
				noopEventEmitter.layer,
				harnessRegistryLayer([fakeHarness]),
				InMemoryStepLoader.layer(stepsMap),
				scriptedUntilEvaluator.layer([true]),
				LiveRunWorkspace.layer({ runId, cwd: tmp }),
			).pipe(Layer.provideMerge(NodeContext.layer));

			yield* runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code', harnesses: [fakeHarness] },
				[
					{ id: 'plan', source: './steps/plan.md', options: {} },
					{ id: 'ralph', source: './steps/ralph.md', options: {} },
				],
				{ prd: 'inline PRD text', cwd: tmp },
			).pipe(Effect.provide(layer));

			const runDir = `${tmp}/.factory/runs/${runId}`;

			const prd = yield* fs.readFileString(`${runDir}/prd.md`);
			strictEqual(prd, 'inline PRD text');

			const planStepMd = yield* fs.readFileString(`${runDir}/steps/00-plan/step.md`);
			strictEqual(planStepMd, planMd);

			const ralphStepMd = yield* fs.readFileString(`${runDir}/steps/01-ralph/step.md`);
			strictEqual(ralphStepMd, ralphMd);

			const tree = yield* listTreeRelative(runDir);
			// The scripted harness emits only stdout/stderr/exit, so per-iter
			// events.jsonl is never created. It would appear once the harness
			// streams a tool.* / assistant.message / result event.
			deepStrictEqual(tree, [
				'events.jsonl',
				'prd.md',
				'run.json',
				'steps/00-plan/iters/001/prompt.md',
				'steps/00-plan/iters/001/stdout.log',
				'steps/00-plan/iters/001/summary.json',
				'steps/00-plan/step.json',
				'steps/00-plan/step.md',
				'steps/01-ralph/iters/001/prompt.md',
				'steps/01-ralph/iters/001/stdout.log',
				'steps/01-ralph/iters/001/summary.json',
				'steps/01-ralph/step.json',
				'steps/01-ralph/step.md',
			]);

			const run = yield* decodeRun(yield* fs.readFileString(`${runDir}/run.json`));
			strictEqual(run.id, runId);
			strictEqual(run.pipeline, 'sdd');
			strictEqual(run.status, 'ok');
			strictEqual(run.defaultHarness, 'claude-code');
			strictEqual(run.cwd, tmp);
			strictEqual(run.prdSource, 'inline PRD text');
			assertTrue((run.endedAt ?? 0) >= run.startedAt);

			const planStep = yield* decodeStep(
				yield* fs.readFileString(`${runDir}/steps/00-plan/step.json`),
			);
			strictEqual(planStep.ord, 0);
			strictEqual(planStep.stepId, 'plan');
			strictEqual(planStep.status, 'ok');
			strictEqual(planStep.harness, 'claude-code');
			strictEqual(planStep.maxIters, 1);
			strictEqual(planStep.iters.length, 1);
			strictEqual(planStep.iters[0]?.exitCode, 0);

			const ralphStep = yield* decodeStep(
				yield* fs.readFileString(`${runDir}/steps/01-ralph/step.json`),
			);
			strictEqual(ralphStep.ord, 1);
			strictEqual(ralphStep.status, 'ok');

			const eventLines = (yield* fs.readFileString(`${runDir}/events.jsonl`))
				.split('\n')
				.filter((l) => l.length > 0);
			const eventTypes = eventLines.map((line) => {
				const parsed: unknown = JSON.parse(line);
				if (Predicate.isRecord(parsed) && typeof parsed.type === 'string') {
					return parsed.type;
				}
				return '';
			});
			strictEqual(eventTypes[0], 'run.start');
			assertTrue(eventTypes.includes('step.start'));
			assertTrue(eventTypes.includes('step.end'));
			strictEqual(eventTypes[eventTypes.length - 1], 'run.end');
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('streams stdout/stderr to per-iter log files and forwards to display', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const tmp = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-stream-' });
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);

			const stepsMap = new Map([
				[
					'./steps/ralph.md',
					'---\nname: ralph\nuntil: "output contains: DONE"\nmaxIters: 2\n---\nIterate.',
				],
			]);

			const runId = RunId.make('stream-test-run');

			const fiveLines = 'a\nb\nc\nd\ne\n';
			const harness = scriptedHarness('claude-code', [
				{ stdout: fiveLines, stderr: 'oops\n' },
				{ stdout: 'DONE\n' },
			]);

			const layer = Layer.mergeAll(
				SilentDisplay.layer(displayRef),
				noopEventEmitter.layer,
				harnessRegistryLayer([harness]),
				InMemoryStepLoader.layer(stepsMap),
				scriptedUntilEvaluator.layer([false, true]),
				LiveRunWorkspace.layer({ runId, cwd: tmp }),
			).pipe(Layer.provideMerge(NodeContext.layer));

			yield* runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code', harnesses: [harness] },
				[{ id: 'ralph', source: './steps/ralph.md', options: {} }],
				{ prd: 'inline PRD', cwd: tmp },
			).pipe(Effect.provide(layer));

			const runDir = `${tmp}/.factory/runs/${runId}`;

			const stdout1 = yield* fs.readFileString(`${runDir}/steps/00-ralph/iters/001/stdout.log`);
			strictEqual(stdout1, fiveLines);
			const stderr1 = yield* fs.readFileString(`${runDir}/steps/00-ralph/iters/001/stderr.log`);
			strictEqual(stderr1, 'oops\n');

			const prompt1 = yield* fs.readFileString(`${runDir}/steps/00-ralph/iters/001/prompt.md`);
			assertTrue(prompt1.includes('# PRD'));
			assertTrue(prompt1.includes('# Step'));

			const stdout2 = yield* fs.readFileString(`${runDir}/steps/00-ralph/iters/002/stdout.log`);
			strictEqual(stdout2, 'DONE\n');

			const display = yield* Ref.get(displayRef);
			const harnessLines = display.filter(
				(d): d is Extract<DisplayEntry, { _tag: 'harnessLine' }> => d._tag === 'harnessLine',
			);
			strictEqual(harnessLines.length, 7);
			const stdoutLines = harnessLines.filter((d) => d.stream === 'stdout');
			deepStrictEqual(
				stdoutLines.map((d) => d.line),
				['a', 'b', 'c', 'd', 'e', 'DONE'],
			);

			const step = yield* decodeStep(
				yield* fs.readFileString(`${runDir}/steps/00-ralph/step.json`),
			);
			strictEqual(step.iters.length, 2);
			strictEqual(step.iters[0]?.n, 1);
			assertTrue((step.iters[0]?.endedAt ?? 0) >= (step.iters[0]?.startedAt ?? 0));
			strictEqual(step.iters[1]?.n, 2);
			strictEqual(step.iters[1]?.exitCode, 0);

			const summaryRaw: unknown = JSON.parse(
				yield* fs.readFileString(`${runDir}/steps/00-ralph/iters/002/summary.json`),
			);
			const summary = yield* decodeIterRecord(summaryRaw);
			strictEqual(summary.n, 2);
			strictEqual(summary.untilPassed, true);
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('records run as interrupted when fiber is interrupted mid-step', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const tmp = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-interrupt-' });
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
			const runId = RunId.make('interrupt-test-run');

			const stepStarted = yield* Deferred.make<void>();

			const hangingHarness: Harness<'claude-code'> = {
				name: 'claude-code',
				capabilities: {
					loadSession: false,
					mcp: { http: false, sse: false },
					prompt: { image: false, audio: false, embeddedContext: false },
					session: { list: false, resume: false, close: false },
					factory: {
						permissions: ['skip', 'accept-edits', 'read-only', 'prompt'],
						toolEvents: false,
					},
				},
				exec: () => Effect.never,
				stream: (): Stream.Stream<HarnessEvent> => {
					const signal = Deferred.succeed(stepStarted);
					const never: Stream.Stream<HarnessEvent> = Stream.never;
					return Stream.fromEffect(signal).pipe(Stream.flatMap(() => never));
				},
			};

			const layer = Layer.mergeAll(
				SilentDisplay.layer(displayRef),
				noopEventEmitter.layer,
				harnessRegistryLayer([hangingHarness]),
				InMemoryStepLoader.layer(new Map([['./steps/only.md', '---\nname: only\n---\nDo it.']])),
				scriptedUntilEvaluator.layer([true]),
				LiveRunWorkspace.layer({ runId, cwd: tmp }),
			).pipe(Layer.provideMerge(NodeContext.layer));

			const fiber = yield* runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code', harnesses: [hangingHarness] },
				[{ id: 'only', source: './steps/only.md', options: {} }],
				{ prd: 'inline PRD', cwd: tmp },
			).pipe(Effect.provide(layer), Effect.fork);

			yield* Deferred.await(stepStarted);
			yield* Fiber.interrupt(fiber);

			const runDir = `${tmp}/.factory/runs/${runId}`;
			const run = yield* decodeRun(yield* fs.readFileString(`${runDir}/run.json`));
			strictEqual(run.status, 'interrupted');
			assertTrue(run.endedAt !== undefined);
		}).pipe(Effect.provide(NodeContext.layer)),
	);
});

describe('LiveRunWorkspace.resumed', () => {
	const seedRunDir = (
		runDir: string,
		runId: RunId,
		recordedSteps: ReadonlyArray<StepRecord>,
	): Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path> =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			yield* fs.makeDirectory(runDir, { recursive: true });
			yield* fs.writeFileString(`${runDir}/prd.md`, 'inline PRD');
			const runRecord: RunRecord = {
				id: runId,
				pipeline: PipelineName.make('sdd'),
				defaultHarness: HarnessName.make('claude-code'),
				cwd: '/tmp/seeded',
				prdSource: 'inline PRD',
				startedAt: 1_700_000_000_000,
				status: 'running',
			};
			yield* writeRun(`${runDir}/run.json`, runRecord);
			for (const step of recordedSteps) {
				const dir = `${runDir}/steps/${step.ord.toString().padStart(2, '0')}-${step.stepId}`;
				yield* fs.makeDirectory(dir, { recursive: true });
				yield* writeStep(`${dir}/step.json`, step);
			}
			yield* fs.writeFileString(`${runDir}/events.jsonl`, '');
		});

	const completedStep = (ord: number, stepId: string): StepRecord => ({
		ord,
		stepId: StepId.make(stepId),
		source: `./steps/${stepId}.md`,
		harness: HarnessName.make('claude-code'),
		maxIters: 1,
		startedAt: 1_700_000_000_100,
		endedAt: 1_700_000_000_200,
		status: 'ok',
		iters: [
			{
				n: 1,
				startedAt: 1_700_000_000_110,
				endedAt: 1_700_000_000_190,
				exitCode: 0,
				untilPassed: true,
			},
		],
	});

	it.scoped('hydrates run + step records from disk', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const tmp = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-resume-' });
			const runId = RunId.make('resumed-run');
			const runDir = `${tmp}/.factory/runs/${runId}`;
			yield* seedRunDir(runDir, runId, [completedStep(0, 'plan'), completedStep(1, 'ralph')]);

			const layer = LiveRunWorkspace.resumed({ runId, cwd: tmp });
			yield* Effect.gen(function* () {
				const ws = yield* RunWorkspace;
				strictEqual(ws.runId, runId);
				strictEqual(ws.runDir, runDir);
				const resumed = yield* ws.recordRunResume({ fromStepOrd: 1 });
				strictEqual(resumed.status, 'running');
				strictEqual(resumed.startedAt, 1_700_000_000_000);
				strictEqual(resumed.endedAt, undefined);
				yield* ws.recordRunEnd({ status: 'ok' });
			}).pipe(Effect.provide(layer));

			const finalRun = yield* decodeRun(yield* fs.readFileString(`${runDir}/run.json`));
			strictEqual(finalRun.status, 'ok');
			strictEqual(finalRun.startedAt, 1_700_000_000_000);
			assertTrue(finalRun.endedAt !== undefined);
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('end-to-end: failed run resumes from first non-ok step', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const tmp = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-resume-e2e-' });
			const runId = RunId.make('e2e-run');

			const planMd = '---\nname: plan\nuntil: "output contains: PLAN"\nmaxIters: 1\n---\nPlan.';
			const ralphMd = '---\nname: ralph\nuntil: "output contains: DONE"\nmaxIters: 2\n---\nIter.';
			const stepsMap = new Map([
				['./steps/plan.md', planMd],
				['./steps/ralph.md', ralphMd],
			]);

			const callsRef = yield* Ref.make<ReadonlyArray<string>>([]);
			const recordCall = (label: string) =>
				Effect.runSync(Ref.update(callsRef, (xs) => [...xs, label]));

			// Phase 1: ralph's until never passes → StepMaxItersError on step 1.
			const phase1Harness = scriptedHarness(
				'claude-code',
				[{ stdout: 'plan ok\n' }, { stdout: 'iter 1\n' }, { stdout: 'iter 2\n' }],
				{
					onCall: (opts) => {
						if (opts.prompt.includes('Plan.')) recordCall('phase1:plan');
						else recordCall('phase1:ralph');
					},
				},
			);

			const phase1Layer = Layer.mergeAll(
				SilentDisplay.layer(yield* Ref.make<ReadonlyArray<DisplayEntry>>([])),
				noopEventEmitter.layer,
				harnessRegistryLayer([phase1Harness]),
				InMemoryStepLoader.layer(stepsMap),
				scriptedUntilEvaluator.layer([true, false, false]),
				LiveRunWorkspace.layer({ runId, cwd: tmp }),
			).pipe(Layer.provideMerge(NodeContext.layer));

			const phase1Steps = [
				{ id: 'plan', source: './steps/plan.md', options: {} },
				{ id: 'ralph', source: './steps/ralph.md', options: {} },
			];

			const phase1Exit = yield* Effect.exit(
				runFactoryEffect(
					{ name: 'sdd', harness: 'claude-code', harnesses: [phase1Harness] },
					phase1Steps,
					{ prd: 'inline PRD', cwd: tmp },
				).pipe(Effect.provide(phase1Layer)),
			);
			const phase1Failure = Cause.failureOption(
				Exit.isFailure(phase1Exit) ? phase1Exit.cause : Cause.empty,
			);
			assertTrue(phase1Failure._tag === 'Some');
			assertTrue(phase1Failure.value instanceof StepMaxItersError);

			const runDir = `${tmp}/.factory/runs/${runId}`;
			const runAfterPhase1 = yield* decodeRun(yield* fs.readFileString(`${runDir}/run.json`));
			strictEqual(runAfterPhase1.status, 'error');
			const planStep = yield* decodeStep(
				yield* fs.readFileString(`${runDir}/steps/00-plan/step.json`),
			);
			strictEqual(planStep.status, 'ok');
			const ralphStep = yield* decodeStep(
				yield* fs.readFileString(`${runDir}/steps/01-ralph/step.json`),
			);
			strictEqual(ralphStep.status, 'failed');

			// Phase 2: resume. ralph's until now passes immediately. Plan must NOT be re-run.
			const phase2Harness = scriptedHarness('claude-code', [{ stdout: 'DONE\n' }], {
				onCall: (opts) => {
					if (opts.prompt.includes('Plan.')) recordCall('phase2:plan');
					else recordCall('phase2:ralph');
				},
			});

			const phase2Layer = Layer.mergeAll(
				SilentDisplay.layer(yield* Ref.make<ReadonlyArray<DisplayEntry>>([])),
				noopEventEmitter.layer,
				harnessRegistryLayer([phase2Harness]),
				InMemoryStepLoader.layer(stepsMap),
				scriptedUntilEvaluator.layer([true]),
				LiveRunWorkspace.resumed({ runId, cwd: tmp }),
			).pipe(Layer.provideMerge(NodeContext.layer));

			yield* resumeFactoryEffect(
				{ name: 'sdd', harness: 'claude-code', harnesses: [phase2Harness] },
				phase1Steps,
				{ runId, cwd: tmp },
			).pipe(Effect.provide(phase2Layer));

			const finalRun = yield* decodeRun(yield* fs.readFileString(`${runDir}/run.json`));
			strictEqual(finalRun.status, 'ok');
			const finalRalph = yield* decodeStep(
				yield* fs.readFileString(`${runDir}/steps/01-ralph/step.json`),
			);
			strictEqual(finalRalph.status, 'ok');

			const calls = yield* Ref.get(callsRef);
			deepStrictEqual(calls, ['phase1:plan', 'phase1:ralph', 'phase1:ralph', 'phase2:ralph']);
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('refuses to resume an already-complete run', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const tmp = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-resume-done-' });
			const runId = RunId.make('done-run');
			const runDir = `${tmp}/.factory/runs/${runId}`;
			yield* seedRunDir(runDir, runId, [completedStep(0, 'plan'), completedStep(1, 'ralph')]);

			const planMd = '---\nname: plan\n---\nPlan.';
			const ralphMd = '---\nname: ralph\n---\nIter.';
			const stepsMap = new Map([
				['./steps/plan.md', planMd],
				['./steps/ralph.md', ralphMd],
			]);
			const harness = scriptedHarness('claude-code', [{ stdout: 'x\n' }]);
			const layer = Layer.mergeAll(
				SilentDisplay.layer(yield* Ref.make<ReadonlyArray<DisplayEntry>>([])),
				noopEventEmitter.layer,
				harnessRegistryLayer([harness]),
				InMemoryStepLoader.layer(stepsMap),
				scriptedUntilEvaluator.layer([true]),
				LiveRunWorkspace.resumed({ runId, cwd: tmp }),
			).pipe(Layer.provideMerge(NodeContext.layer));

			const exit = yield* Effect.exit(
				resumeFactoryEffect(
					{ name: 'sdd', harness: 'claude-code', harnesses: [harness] },
					[
						{ id: 'plan', source: './steps/plan.md', options: {} },
						{ id: 'ralph', source: './steps/ralph.md', options: {} },
					],
					{ runId, cwd: tmp },
				).pipe(Effect.provide(layer)),
			);
			const failure = Cause.failureOption(Exit.isFailure(exit) ? exit.cause : Cause.empty);
			assertTrue(failure._tag === 'Some');
			assertTrue(failure.value instanceof ResumeUnavailableError);
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('does not overwrite the latest symlink', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const tmp = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-resume-symlink-' });
			const runsDir = `${tmp}/.factory/runs`;

			const otherRunId = RunId.make('other-run');
			yield* fs.makeDirectory(`${runsDir}/${otherRunId}`, { recursive: true });
			if (process.platform !== 'win32') {
				yield* fs.symlink(otherRunId, `${runsDir}/latest`);
			}

			const runId = RunId.make('resumed-run');
			const runDir = `${runsDir}/${runId}`;
			yield* seedRunDir(runDir, runId, [completedStep(0, 'plan')]);

			const layer = LiveRunWorkspace.resumed({ runId, cwd: tmp });
			yield* Effect.gen(function* () {
				const ws = yield* RunWorkspace;
				yield* ws.recordRunResume({ fromStepOrd: 0 });
			}).pipe(Effect.provide(layer));

			if (process.platform !== 'win32') {
				const link = yield* fs.readLink(`${runsDir}/latest`);
				strictEqual(link, otherRunId);
			}
		}).pipe(Effect.provide(NodeContext.layer)),
	);
});
