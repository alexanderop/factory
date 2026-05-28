import type { CommandExecutor, FileSystem, Path } from '@effect/platform';
import { Clock, Effect, Metric } from 'effect';
import type { FactoryError, RunRecordingError } from '../errors.ts';
import { PipelineName, type RunId } from '../ids.ts';
import { runDurationMs, runsTotal } from '../metrics.ts';
import { emitAndRecord } from '../pipelineHelpers.ts';
import { Display } from '../services/Display.ts';
import { EventEmitter } from '../services/EventEmitter.ts';
import type { HarnessRegistry } from '../services/HarnessRegistry.ts';
import type { HookRunner, HookTransport } from '../services/HookRunner.ts';
import { RunWorkspace } from '../services/RunWorkspace.ts';
import type { AgentSequence } from '../services/AgentSequence.ts';
import type { FactoryOptions } from '../types.ts';
import { type AgentFn, type AgentRequirements, makeAgent } from './agent.ts';
import { type ConcurrencyOptions, parallel, pipeline } from './combinators.ts';
import { WorkflowContext } from './context.ts';

/** The surface a programmatic workflow body receives. */
export interface WorkflowCtx {
	readonly agent: AgentFn;
	readonly parallel: <A, E, R>(
		thunks: ReadonlyArray<() => Effect.Effect<A, E, R>>,
		options?: ConcurrencyOptions,
	) => Effect.Effect<ReadonlyArray<A | null>, never, R>;
	readonly pipeline: <T, E, R>(
		items: ReadonlyArray<T>,
		stages: ReadonlyArray<(input: T) => Effect.Effect<T, E, R>>,
		options?: ConcurrencyOptions,
	) => Effect.Effect<ReadonlyArray<T>, E, R>;
	readonly phase: (title: string) => Effect.Effect<void, RunRecordingError>;
	readonly log: (message: string) => Effect.Effect<void>;
	readonly args: Record<string, unknown>;
	readonly budget: number;
}

export type WorkflowBody = (
	ctx: WorkflowCtx,
) => Effect.Effect<void, FactoryError, AgentRequirements>;

export interface WorkflowRunContext {
	readonly cwd: string;
	readonly resumed: boolean;
}

/** Services the workflow runner needs in scope (provided by buildRuntimeLayer). */
export type WorkflowRunRequirements =
	| Display
	| EventEmitter
	| HarnessRegistry
	| RunWorkspace
	| AgentSequence
	| WorkflowContext
	| HookRunner
	| HookTransport
	| FileSystem.FileSystem
	| Path.Path
	| CommandExecutor.CommandExecutor;

/**
 * Run a programmatic workflow body. Mirrors `runFactoryEffect` scaffolding:
 * recordRunStart / run.start / run body under a span / recordRunEnd with the
 * same tapError chain and run metrics. The body is invoked with a fully-wired
 * `WorkflowCtx`. Resume re-runs the body; completed agents short-circuit from
 * the manifest inside `agent()` (see `findResumableAgent`).
 */
export const runWorkflowEffect = (
	factoryOpts: FactoryOptions,
	name: string,
	body: WorkflowBody,
	runCtx: WorkflowRunContext,
): Effect.Effect<void, FactoryError, WorkflowRunRequirements> =>
	Effect.gen(function* () {
		const display = yield* Display;
		const emitter = yield* EventEmitter;
		const workspace = yield* RunWorkspace;
		const ctxService = yield* WorkflowContext;

		const runId: RunId = workspace.runId;
		const pipelineName = PipelineName.make(name);

		yield* Effect.annotateCurrentSpan({
			'factory.run.id': runId,
			'factory.pipeline': pipelineName,
			'factory.cwd': runCtx.cwd,
			...(runCtx.resumed ? { 'factory.resumed': 'true' } : {}),
		});

		yield* display.runStart(pipelineName, runId);

		const runStartedAt = yield* Clock.currentTimeMillis;

		if (runCtx.resumed) {
			yield* workspace.recordRunResume({ fromStepOrd: 0 });
		} else {
			yield* workspace.recordRunStart({
				pipeline: pipelineName,
				defaultHarness: undefined,
				cwd: runCtx.cwd,
				prdSource: 'workflow',
				prdContent: '',
			});
		}
		yield* emitAndRecord(emitter, workspace, { type: 'run.start', runId, pipeline: pipelineName });

		const ctx: WorkflowCtx = {
			agent: makeAgent(factoryOpts),
			parallel,
			pipeline,
			phase: ctxService.phase,
			log: ctxService.log,
			args: ctxService.args,
			budget: ctxService.budget,
		};

		const recordRunMetrics = (outcome: 'ok' | 'error') =>
			Effect.gen(function* () {
				const endedAt = yield* Clock.currentTimeMillis;
				yield* Metric.increment(runsTotal).pipe(
					Effect.tagMetrics('outcome', outcome),
					Effect.tagMetrics('pipeline', pipelineName),
				);
				yield* Metric.update(runDurationMs, endedAt - runStartedAt).pipe(
					Effect.tagMetrics('outcome', outcome),
					Effect.tagMetrics('pipeline', pipelineName),
				);
			});

		yield* body(ctx).pipe(
			Effect.withSpan(`factory.workflow ${name}`),
			Effect.tapError((error) =>
				emitAndRecord(emitter, workspace, { type: 'error', runId, error }),
			),
			Effect.tapError((error) =>
				workspace.recordRunEnd({
					status: 'error',
					errorTag: error._tag,
					errorMessage: error.message,
				}),
			),
			Effect.tapError(() => recordRunMetrics('error')),
		);

		yield* workspace.recordRunEnd({ status: 'ok' });
		yield* recordRunMetrics('ok');
		yield* emitAndRecord(emitter, workspace, { type: 'run.end', runId });
		yield* display.runEnd(runId);
	}).pipe(
		Effect.withSpan(`factory.workflow.run ${name}`, {
			attributes: { 'factory.pipeline': name },
		}),
	);
