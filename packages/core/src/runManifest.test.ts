import { FileSystem } from '@effect/platform';
import { NodeContext } from '@effect/platform-node';
import { describe, it } from '@effect/vitest';
import { deepStrictEqual, strictEqual } from '@effect/vitest/utils';
import { Arbitrary, Effect, Exit } from 'effect';
import { ResumeMismatchError, RunRecordingError } from './errors.ts';
import {
	atomicWriteString,
	decodeRun,
	decodeStep,
	encodeRun,
	encodeStep,
	planResume,
	readStep,
	RunRecord,
	StepRecord,
	writeRun,
	writeStep,
} from './services/runManifest.ts';
import {
	assertExitFailedWith,
	makeIterRecord,
	makeRunId,
	makeRunRecord,
	makeStepId,
	makeStepRecord,
} from './testing/index.ts';

const sampleRun = makeRunRecord({
	id: makeRunId('run-codec-1'),
	endedAt: 1_700_000_000_500,
});

const sampleStep = makeStepRecord({
	until: 'tests pass',
	maxIters: 3,
	startedAt: 1_700_000_000_100,
	endedAt: 1_700_000_000_400,
	iters: [makeIterRecord({ startedAt: 1_700_000_000_150, endedAt: 1_700_000_000_200 })],
});

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
			assertExitFailedWith(exit, RunRecordingError);
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
	const stepRecord = (ord: number, stepId: string, status: StepRecord['status']): StepRecord =>
		makeStepRecord({
			ord,
			stepId: makeStepId(stepId),
			source: `./steps/${stepId}.md`,
			startedAt: 0,
			status,
			iters: [],
		});
	const pipelineRef = (ord: number, stepId: string) => ({
		ord,
		stepId: makeStepId(stepId),
	});
	const pipeline = [pipelineRef(0, 'plan'), pipelineRef(1, 'ralph'), pipelineRef(2, 'refactor')];

	it.effect('returns already-done when every step is ok', () =>
		Effect.gen(function* () {
			const recorded = [
				stepRecord(0, 'plan', 'ok'),
				stepRecord(1, 'ralph', 'ok'),
				stepRecord(2, 'refactor', 'ok'),
			];
			const plan = yield* planResume(recorded, pipeline);
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
			const plan = yield* planResume(recorded, pipeline);
			deepStrictEqual(plan, { kind: 'start-at', stepOrd: 1 });
		}),
	);

	it.effect('starts at first running step (zombie)', () =>
		Effect.gen(function* () {
			const recorded = [stepRecord(0, 'plan', 'ok'), stepRecord(1, 'ralph', 'running')];
			const plan = yield* planResume(recorded, pipeline);
			deepStrictEqual(plan, { kind: 'start-at', stepOrd: 1 });
		}),
	);

	it.effect('starts at first missing recorded step', () =>
		Effect.gen(function* () {
			const recorded = [stepRecord(0, 'plan', 'ok')];
			const plan = yield* planResume(recorded, pipeline);
			deepStrictEqual(plan, { kind: 'start-at', stepOrd: 1 });
		}),
	);

	it.effect('starts at ord 0 when nothing was recorded', () =>
		Effect.gen(function* () {
			const plan = yield* planResume([], pipeline);
			deepStrictEqual(plan, { kind: 'start-at', stepOrd: 0 });
		}),
	);

	it.effect('refuses to resume when stepId at an ord changed', () =>
		Effect.gen(function* () {
			const recorded = [stepRecord(0, 'plan', 'ok'), stepRecord(1, 'ralph', 'failed')];
			const drifted = [pipelineRef(0, 'plan'), pipelineRef(1, 'simplify')];
			const exit = yield* Effect.exit(planResume(recorded, drifted));
			assertExitFailedWith(exit, ResumeMismatchError);
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

// `RunRecord` / `StepRecord` use `Schema.Number` for timestamps / counters, but
// JSON can't round-trip NaN / Infinity (`JSON.stringify(NaN) === 'null'`). We
// filter generated values to finite numbers so the test exercises the codec,
// not `JSON`'s lossy treatment of non-finites.
//
// We assert codec involution (encode → decode → encode produces the same JSON)
// instead of `deepStrictEqual(decoded, original)` because `Schema.optional`
// drops keys whose value is `undefined`, while the arbitrary may generate them
// explicitly — that's a difference in representation, not semantics.

const allNumbersFinite = (value: unknown): boolean => {
	if (typeof value === 'number') return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(allNumbersFinite);
	if (value !== null && typeof value === 'object') {
		return Object.values(value).every(allNumbersFinite);
	}
	return true;
};

const runRecordArb = Arbitrary.make(RunRecord).filter(allNumbersFinite);
const stepRecordArb = Arbitrary.make(StepRecord).filter(allNumbersFinite);

describe('runManifest codec properties', () => {
	it.effect.prop(
		'RunRecord codec is involutive (encodeRun → decodeRun → encodeRun is idempotent)',
		{ value: runRecordArb },
		({ value }) =>
			Effect.gen(function* () {
				const json1 = yield* encodeRun(value);
				const decoded = yield* decodeRun(json1);
				const json2 = yield* encodeRun(decoded);
				strictEqual(json2, json1);
			}),
	);

	it.effect.prop(
		'StepRecord codec is involutive (encodeStep → decodeStep → encodeStep is idempotent)',
		{ value: stepRecordArb },
		({ value }) =>
			Effect.gen(function* () {
				const json1 = yield* encodeStep(value);
				const decoded = yield* decodeStep(json1);
				const json2 = yield* encodeStep(decoded);
				strictEqual(json2, json1);
			}),
	);
});
