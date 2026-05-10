import { FileSystem } from '@effect/platform';
import { NodeContext } from '@effect/platform-node';
import { describe, it } from '@effect/vitest';
import { assertInstanceOf, deepStrictEqual, strictEqual } from '@effect/vitest/utils';
import { Cause, Effect, Exit } from 'effect';
import { ResumeMismatchError, ResumeUnavailableError, RunRecordingError } from './errors.ts';
import { HarnessName, PipelineName, RunId, StepId } from './ids.ts';
import {
	atomicWriteString,
	decodeRun,
	encodeRun,
	planResume,
	readStep,
	type RunRecord,
	type StepRecord,
	writeRun,
	writeStep,
} from './services/runManifest.ts';

const sampleRun: RunRecord = {
	id: RunId.make('run-codec-1'),
	pipeline: PipelineName.make('sdd'),
	defaultHarness: HarnessName.make('claude-code'),
	cwd: '/tmp/cwd',
	prdSource: 'inline',
	startedAt: 1_700_000_000_000,
	endedAt: 1_700_000_000_500,
	status: 'ok',
};

const sampleStep: StepRecord = {
	ord: 0,
	stepId: StepId.make('plan'),
	source: './steps/plan.md',
	harness: HarnessName.make('claude-code'),
	until: 'tests pass',
	maxIters: 3,
	startedAt: 1_700_000_000_100,
	endedAt: 1_700_000_000_400,
	status: 'ok',
	iters: [
		{
			n: 1,
			startedAt: 1_700_000_000_150,
			endedAt: 1_700_000_000_200,
			exitCode: 0,
			untilPassed: true,
		},
	],
};

describe('runManifest codec', () => {
	it.effect('RunRecord roundtrips through parseJson', () =>
		Effect.gen(function* () {
			const json = yield* encodeRun(sampleRun);
			const decoded = yield* decodeRun(json);
			deepStrictEqual(decoded, sampleRun);
		}),
	);

	it.effect('decodeRun maps malformed JSON to RunRecordingError', () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(decodeRun('{not json'));
			const failure = Cause.failureOption(Exit.isFailure(exit) ? exit.cause : Cause.empty);
			assertInstanceOf(failure._tag === 'Some' ? failure.value : null, RunRecordingError);
		}),
	);
});

describe('atomicWriteString', () => {
	it.scoped('writes file atomically and removes the tmp suffix', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-atomic-' });
			const target = `${dir}/run.json`;
			yield* atomicWriteString(target, '{"hello":"world"}');
			const content = yield* fs.readFileString(target);
			strictEqual(content, '{"hello":"world"}');
			const tmpExists = yield* fs.exists(`${target}.tmp.${process.pid}`);
			strictEqual(tmpExists, false);
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('preserves existing file when rename step fails', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-atomic-fail-' });
			const target = `${dir}/run.json`;
			yield* fs.writeFileString(target, 'original');
			const exit = yield* Effect.exit(
				atomicWriteString(target, 'updated', {
					rename: () => Effect.fail(new RunRecordingError({ message: 'simulated rename failure' })),
				}),
			);
			strictEqual(Exit.isFailure(exit), true);
			const content = yield* fs.readFileString(target);
			strictEqual(content, 'original');
		}).pipe(Effect.provide(NodeContext.layer)),
	);
});

describe('planResume', () => {
	const stepRecord = (ord: number, stepId: string, status: StepRecord['status']): StepRecord => ({
		ord,
		stepId: StepId.make(stepId),
		source: `./steps/${stepId}.md`,
		harness: HarnessName.make('claude-code'),
		maxIters: 1,
		startedAt: 0,
		status,
		iters: [],
	});
	const pipelineRef = (ord: number, stepId: string) => ({
		ord,
		stepId: StepId.make(stepId),
	});
	const pipeline = [pipelineRef(0, 'plan'), pipelineRef(1, 'ralph'), pipelineRef(2, 'refactor')];

	it.effect('returns already-done when every step is ok', () =>
		Effect.gen(function* () {
			const recorded = [
				stepRecord(0, 'plan', 'ok'),
				stepRecord(1, 'ralph', 'ok'),
				stepRecord(2, 'refactor', 'ok'),
			];
			const plan = yield* planResume(recorded, pipeline, 'error');
			deepStrictEqual(plan, { kind: 'already-done' });
		}),
	);

	it.effect('starts at first failed step', () =>
		Effect.gen(function* () {
			const recorded = [
				stepRecord(0, 'plan', 'ok'),
				stepRecord(1, 'ralph', 'failed'),
				stepRecord(2, 'refactor', 'ok'),
			];
			const plan = yield* planResume(recorded, pipeline, 'error');
			deepStrictEqual(plan, { kind: 'start-at', stepOrd: 1 });
		}),
	);

	it.effect('starts at first running step (zombie)', () =>
		Effect.gen(function* () {
			const recorded = [stepRecord(0, 'plan', 'ok'), stepRecord(1, 'ralph', 'running')];
			const plan = yield* planResume(recorded, pipeline, 'error');
			deepStrictEqual(plan, { kind: 'start-at', stepOrd: 1 });
		}),
	);

	it.effect('starts at first missing recorded step', () =>
		Effect.gen(function* () {
			const recorded = [stepRecord(0, 'plan', 'ok')];
			const plan = yield* planResume(recorded, pipeline, 'error');
			deepStrictEqual(plan, { kind: 'start-at', stepOrd: 1 });
		}),
	);

	it.effect('starts at ord 0 when nothing was recorded', () =>
		Effect.gen(function* () {
			const plan = yield* planResume([], pipeline, 'error');
			deepStrictEqual(plan, { kind: 'start-at', stepOrd: 0 });
		}),
	);

	it.effect('refuses to resume when stepId at an ord changed', () =>
		Effect.gen(function* () {
			const recorded = [stepRecord(0, 'plan', 'ok'), stepRecord(1, 'ralph', 'failed')];
			const drifted = [pipelineRef(0, 'plan'), pipelineRef(1, 'simplify')];
			const exit = yield* Effect.exit(planResume(recorded, drifted, 'error'));
			const failure = Cause.failureOption(Exit.isFailure(exit) ? exit.cause : Cause.empty);
			assertInstanceOf(failure._tag === 'Some' ? failure.value : null, ResumeMismatchError);
		}),
	);

	it.effect('refuses to resume when run status is interrupted', () =>
		Effect.gen(function* () {
			const recorded = [stepRecord(0, 'plan', 'ok'), stepRecord(1, 'ralph', 'failed')];
			const exit = yield* Effect.exit(planResume(recorded, pipeline, 'interrupted'));
			const failure = Cause.failureOption(Exit.isFailure(exit) ? exit.cause : Cause.empty);
			assertInstanceOf(failure._tag === 'Some' ? failure.value : null, ResumeUnavailableError);
		}),
	);
});

describe('writeRun + writeStep + readStep', () => {
	it.scoped('writes and reads back a step record', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-step-rw-' });
			const stepPath = `${dir}/step.json`;
			yield* writeStep(stepPath, sampleStep);
			const decoded = yield* readStep(stepPath);
			deepStrictEqual(decoded, sampleStep);
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('writeRun produces a parseable file', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-run-rw-' });
			const runPath = `${dir}/run.json`;
			yield* writeRun(runPath, sampleRun);
			const text = yield* fs.readFileString(runPath);
			const decoded = yield* decodeRun(text);
			strictEqual(decoded.id, sampleRun.id);
			strictEqual(decoded.status, 'ok');
		}).pipe(Effect.provide(NodeContext.layer)),
	);
});
