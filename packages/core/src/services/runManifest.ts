import { FileSystem } from '@effect/platform';
import { Effect, Schema } from 'effect';
import { ResumeMismatchError, ResumeUnavailableError, RunRecordingError } from '../errors.ts';
import { HarnessName, PipelineName, RunId, StepId } from '../ids.ts';

export const RunStatus = Schema.Literal('running', 'ok', 'error', 'interrupted');
export type RunStatus = typeof RunStatus.Type;

export const StepStatus = Schema.Literal('running', 'ok', 'failed');
export type StepStatus = typeof StepStatus.Type;

export const IterRecord = Schema.Struct({
	n: Schema.Number,
	startedAt: Schema.Number,
	endedAt: Schema.optional(Schema.Number),
	exitCode: Schema.optional(Schema.Number),
	untilPassed: Schema.optional(Schema.Boolean),
	untilOutput: Schema.optional(Schema.String),
	filesChanged: Schema.optional(Schema.Number),
});
export type IterRecord = typeof IterRecord.Type;

export const StepRecord = Schema.Struct({
	ord: Schema.Number,
	stepId: StepId,
	source: Schema.String,
	harness: HarnessName,
	until: Schema.optional(Schema.String),
	maxIters: Schema.Number,
	startedAt: Schema.Number,
	endedAt: Schema.optional(Schema.Number),
	status: StepStatus,
	iters: Schema.Array(IterRecord),
});
export type StepRecord = typeof StepRecord.Type;

export const RunRecord = Schema.Struct({
	id: RunId,
	pipeline: PipelineName,
	defaultHarness: Schema.optional(HarnessName),
	cwd: Schema.String,
	prdSource: Schema.String,
	factoryFile: Schema.optional(Schema.String),
	startedAt: Schema.Number,
	endedAt: Schema.optional(Schema.Number),
	status: RunStatus,
	errorTag: Schema.optional(Schema.String),
	errorMessage: Schema.optional(Schema.String),
});
export type RunRecord = typeof RunRecord.Type;

export const RunRecordJson = Schema.parseJson(RunRecord);
export const StepRecordJson = Schema.parseJson(StepRecord);
export const IterRecordJson = Schema.parseJson(IterRecord);

const decodeRunInternal = Schema.decodeUnknown(RunRecordJson);
const encodeRunInternal = Schema.encode(RunRecordJson);
const decodeStepInternal = Schema.decodeUnknown(StepRecordJson);
const encodeStepInternal = Schema.encode(StepRecordJson);
const decodeIterInternal = Schema.decodeUnknown(IterRecordJson);
const encodeIterInternal = Schema.encode(IterRecordJson);

const toRecordingError =
	(message: string, path?: string) =>
	(cause: unknown): RunRecordingError =>
		new RunRecordingError({
			message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
			path,
		});

export const decodeRun = (json: string, path?: string) =>
	decodeRunInternal(json).pipe(Effect.mapError(toRecordingError('failed to decode run', path)));

export const encodeRun = (value: RunRecord) =>
	encodeRunInternal(value).pipe(Effect.mapError(toRecordingError('failed to encode run')));

export const decodeStep = (json: string, path?: string) =>
	decodeStepInternal(json).pipe(Effect.mapError(toRecordingError('failed to decode step', path)));

export const encodeStep = (value: StepRecord) =>
	encodeStepInternal(value).pipe(Effect.mapError(toRecordingError('failed to encode step')));

export const decodeIter = (json: string, path?: string) =>
	decodeIterInternal(json).pipe(Effect.mapError(toRecordingError('failed to decode iter', path)));

export const encodeIter = (value: IterRecord) =>
	encodeIterInternal(value).pipe(Effect.mapError(toRecordingError('failed to encode iter')));

export interface AtomicWriteDeps {
	readonly rename?: (oldPath: string, newPath: string) => Effect.Effect<void, RunRecordingError>;
}

export const atomicWriteString = (path: string, data: string, deps: AtomicWriteDeps = {}) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const tmp = `${path}.tmp.${process.pid}`;
		yield* fs
			.writeFileString(tmp, data)
			.pipe(Effect.mapError(toRecordingError(`failed to write ${tmp}`, tmp)));
		const rename =
			deps.rename ??
			((from: string, to: string) =>
				fs
					.rename(from, to)
					.pipe(Effect.mapError(toRecordingError(`failed to rename ${from} -> ${to}`, to))));
		yield* rename(tmp, path);
	});

export const writeRun = (path: string, value: RunRecord) =>
	encodeRun(value).pipe(Effect.flatMap((json) => atomicWriteString(path, json)));

export const writeStep = (path: string, value: StepRecord) =>
	encodeStep(value).pipe(Effect.flatMap((json) => atomicWriteString(path, json)));

export const writeIter = (path: string, value: IterRecord) =>
	encodeIter(value).pipe(Effect.flatMap((json) => atomicWriteString(path, json)));

export const readRun = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const text = yield* fs
			.readFileString(path)
			.pipe(Effect.mapError(toRecordingError(`failed to read ${path}`, path)));
		return yield* decodeRun(text, path);
	});

export const readStep = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const text = yield* fs
			.readFileString(path)
			.pipe(Effect.mapError(toRecordingError(`failed to read ${path}`, path)));
		return yield* decodeStep(text, path);
	});

export const readIter = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const text = yield* fs
			.readFileString(path)
			.pipe(Effect.mapError(toRecordingError(`failed to read ${path}`, path)));
		return yield* decodeIter(text, path);
	});

export type ResumePlan =
	| { readonly kind: 'already-done' }
	| { readonly kind: 'start-at'; readonly stepOrd: number };

export interface PipelineStepRef {
	readonly ord: number;
	readonly stepId: StepId;
}

/**
 * Decide where to resume a run by walking the pipeline in declared order.
 *
 * - If the recorded run's status is `'interrupted'`, refuse with
 *   `ResumeUnavailableError` (`reason: 'in-progress'`). Resume of
 *   interrupted runs is not yet supported.
 * - If `pipelineSteps[ord]` has a matching `recordedSteps[ord]` and its
 *   `stepId` differs, we refuse with `ResumeMismatchError` — the pipeline
 *   shape changed since the run started.
 * - Otherwise, the first ord without a recorded `'ok'` status is the
 *   resume point. A missing record at a given ord (e.g. ralph started, was
 *   ^C'd before refactor's `step.json` was written) is also a resume point.
 * - All `'ok'` → `already-done` (caller should refuse to resume).
 */
export const planResume = (
	recordedSteps: ReadonlyArray<StepRecord>,
	pipelineSteps: ReadonlyArray<PipelineStepRef>,
	runStatus: RunStatus,
): Effect.Effect<ResumePlan, ResumeMismatchError | ResumeUnavailableError> =>
	Effect.gen(function* () {
		if (runStatus === 'interrupted') {
			return yield* Effect.fail(
				new ResumeUnavailableError({
					message: 'run was interrupted; resume of interrupted runs is not yet supported',
					reason: 'in-progress',
				}),
			);
		}
		const byOrd = new Map(recordedSteps.map((s) => [s.ord, s] as const));
		for (const pipelineStep of pipelineSteps) {
			const recorded = byOrd.get(pipelineStep.ord);
			if (recorded === undefined) {
				return { kind: 'start-at', stepOrd: pipelineStep.ord } satisfies ResumePlan;
			}
			if (recorded.stepId !== pipelineStep.stepId) {
				return yield* Effect.fail(
					new ResumeMismatchError({
						message: `pipeline step at ord ${pipelineStep.ord} is '${pipelineStep.stepId}' but recorded run has '${recorded.stepId}'`,
						stepOrd: pipelineStep.ord,
						recordedStepId: recorded.stepId,
						pipelineStepId: pipelineStep.stepId,
					}),
				);
			}
			if (recorded.status !== 'ok') {
				return { kind: 'start-at', stepOrd: pipelineStep.ord } satisfies ResumePlan;
			}
		}
		return { kind: 'already-done' } satisfies ResumePlan;
	});
