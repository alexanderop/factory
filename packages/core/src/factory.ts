import { randomUUID } from 'node:crypto';
import { NodeContext } from '@effect/platform-node';
import { Effect, Layer } from 'effect';
import { RunId } from './ids.ts';
import { resumeFactoryEffect, runFactoryEffect } from './orchestrator.ts';
import { NoOtelLayer, OtelLayer } from './otel.ts';
import * as AgentSequence from './services/AgentSequence.ts';
import { ConsoleDisplay } from './services/Display.ts';
import { callbackEventEmitter } from './services/EventEmitter.ts';
import { harnessRegistryLayer } from './services/HarnessRegistry.ts';
import { noopHookRunner, noopHookTransport } from './services/HookRunner.ts';
import { LiveRunWorkspace } from './services/RunWorkspace.ts';
import { StepLoader } from './services/StepLoader.ts';
import { DefaultUntilEvaluator } from './services/UntilEvaluator.ts';
import { readRecordedAgents, maxRecordedSeq } from './workflow/agentManifest.ts';
import { workflowContextLayer } from './workflow/context.ts';
import { runWorkflowEffect } from './workflow/runWorkflowEffect.ts';
import type {
	Factory,
	FactoryOptions,
	Harness,
	PipelineEntry,
	ResumeOptions,
	ReviewSpec,
	RoleEntry,
	RoleSpec,
	RunOptions,
	StepOptions,
	WorkflowBodyFn,
	WorkflowHandle,
	WorkflowResumeOptions,
	WorkflowRunOptions,
} from './types.ts';

interface RuntimeContext {
	readonly runId: RunId;
	readonly cwd: string;
	readonly resume: boolean;
}

interface RuntimeOpts {
	readonly otel?: boolean;
	readonly onStep?: RunOptions['onStep'];
	readonly onError?: RunOptions['onError'];
	/** Workflow-only: budget / args / agent-sequence seed for `.workflow()`. */
	readonly budget?: number;
	readonly args?: Record<string, unknown>;
	readonly agentSeqStart?: number;
}

const buildRuntimeLayer = (opts: FactoryOptions, runOpts: RuntimeOpts, ctx: RuntimeContext) => {
	const otelEnabled = runOpts.otel !== false && process.env.OTEL_SDK_DISABLED !== 'true';

	const workspaceLayer = ctx.resume
		? LiveRunWorkspace.resumed({ runId: ctx.runId, cwd: ctx.cwd })
		: LiveRunWorkspace.layer({ runId: ctx.runId, cwd: ctx.cwd });

	// Live hooks are injected from outside core (`@factory/hooks`) to keep the
	// dependency direction correct; absent → no-op runner (transport resolved
	// via `Effect.serviceOption`, so its absence is fine). Merged inside the
	// `provideMerge(NodeContext)` so a live layer can use FileSystem/Path/exec.
	const hookLayer = opts.hooks ?? Layer.merge(noopHookRunner.layer, noopHookTransport.layer);

	// AgentSequence: fresh for new runs, seeded past the highest recorded seq on
	// resume so a re-run never reuses an existing agents/<seq>-<label>/ dir.
	const agentSeqLayer = ctx.resume
		? AgentSequence.resumedLayer(runOpts.agentSeqStart ?? 0)
		: AgentSequence.layer;

	const base = Layer.mergeAll(
		ConsoleDisplay.layer,
		callbackEventEmitter.layer({
			onStep: runOpts.onStep,
			onError: runOpts.onError,
		}),
		harnessRegistryLayer(opts.harnesses ?? []),
		StepLoader.Default,
		DefaultUntilEvaluator.layer,
		workspaceLayer,
		hookLayer,
		agentSeqLayer,
		otelEnabled ? OtelLayer : NoOtelLayer,
	).pipe(Layer.provideMerge(NodeContext.layer));

	// WorkflowContext reads Display / EventEmitter / RunWorkspace, so it sits on
	// top of `base`. Merged into both paths; the declarative path never reads it.
	const wfLayer = workflowContextLayer({
		runId: ctx.runId,
		cwd: ctx.cwd,
		defaultHarness: opts.harness,
		defaultPermissions: opts.permissions,
		...(runOpts.args === undefined ? {} : { args: runOpts.args }),
		...(runOpts.budget === undefined ? {} : { budget: runOpts.budget }),
	});

	// `base` provides WorkflowContext's requirements; the result exposes both
	// `base`'s services and WorkflowContext.
	return Layer.provideMerge(wfLayer, base);
};

const normaliseRole = <Names extends string>(spec: RoleSpec<Names>): RoleEntry => {
	const { id, source, ...rest } = spec;
	return { id, source, options: rest };
};

export function factory<const Hs extends ReadonlyArray<Harness>>(
	opts: FactoryOptions<Hs[number]['name']> & { readonly harnesses?: Hs },
): Factory<Hs[number]['name']> {
	type Names = Hs[number]['name'];
	const entries: PipelineEntry[] = [];

	const runEffect = (runOpts: RunOptions) => {
		const runId = RunId.make(randomUUID());
		const cwd = runOpts.cwd ?? process.cwd();
		return runFactoryEffect(opts, entries, runOpts).pipe(
			Effect.provide(buildRuntimeLayer(opts, runOpts, { runId, cwd, resume: false })),
		);
	};

	const resumeEffect = (resumeOpts: ResumeOptions) => {
		const cwd = resumeOpts.cwd ?? process.cwd();
		return resumeFactoryEffect(opts, entries, resumeOpts).pipe(
			Effect.provide(
				buildRuntimeLayer(opts, resumeOpts, { runId: resumeOpts.runId, cwd, resume: true }),
			),
		);
	};

	const workflow = (name: string, body: WorkflowBodyFn): WorkflowHandle => {
		const workflowRunEffect = (runOpts: WorkflowRunOptions = {}) => {
			const runId = RunId.make(randomUUID());
			const cwd = runOpts.cwd ?? process.cwd();
			return runWorkflowEffect(opts, name, body, { cwd, resumed: false }).pipe(
				Effect.provide(
					buildRuntimeLayer(
						opts,
						{
							otel: runOpts.otel,
							onStep: runOpts.onStep,
							onError: runOpts.onError,
							...(runOpts.budget === undefined ? {} : { budget: runOpts.budget }),
							...(runOpts.args === undefined ? {} : { args: runOpts.args }),
						},
						{ runId, cwd, resume: false },
					),
				),
			);
		};

		const workflowResumeEffect = (resumeOpts: WorkflowResumeOptions) => {
			const cwd = resumeOpts.cwd ?? process.cwd();
			return Effect.gen(function* () {
				// Seed AgentSequence past the highest recorded seq so resume never
				// reuses a directory. Read from the resumed run dir.
				const runDir = `${cwd}/.factory/runs/${resumeOpts.runId}`;
				const recorded = yield* readRecordedAgents(runDir).pipe(
					Effect.catchAll(() => Effect.succeed([])),
				);
				const agentSeqStart = maxRecordedSeq(recorded) + 1;
				return yield* runWorkflowEffect(opts, name, body, { cwd, resumed: true }).pipe(
					Effect.provide(
						buildRuntimeLayer(
							opts,
							{
								otel: resumeOpts.otel,
								agentSeqStart,
								...(resumeOpts.budget === undefined ? {} : { budget: resumeOpts.budget }),
								...(resumeOpts.args === undefined ? {} : { args: resumeOpts.args }),
							},
							{ runId: resumeOpts.runId, cwd, resume: true },
						),
					),
				);
			}).pipe(Effect.provide(NodeContext.layer));
		};

		return {
			runEffect: workflowRunEffect,
			run: async (runOpts) => {
				await Effect.runPromise(workflowRunEffect(runOpts));
			},
			resumeEffect: workflowResumeEffect,
			resume: async (resumeOpts) => {
				await Effect.runPromise(workflowResumeEffect(resumeOpts));
			},
		};
	};

	const make = <StepIds extends string>(): Factory<Names, StepIds> => ({
		name: opts.name,
		step<Id extends string>(
			id: Exclude<Id, StepIds>,
			source: string,
			stepOptions?: StepOptions<Names>,
		) {
			entries.push({ kind: 'step', id, source, options: stepOptions ?? {} });
			return make<StepIds | Id>();
		},
		review<Id extends string>(id: Exclude<Id, StepIds>, spec: ReviewSpec<Names>) {
			entries.push({
				kind: 'review',
				id,
				roles: spec.roles.map((r) => normaliseRole(r)),
				aggregate: spec.aggregate ? normaliseRole(spec.aggregate) : undefined,
				concurrency: spec.concurrency,
				options: {
					...(spec.harness === undefined ? {} : { harness: spec.harness }),
					...(spec.permissions === undefined ? {} : { permissions: spec.permissions }),
				},
			});
			return make<StepIds | Id>();
		},
		runEffect,
		run: async (runOpts) => {
			await Effect.runPromise(runEffect(runOpts));
		},
		resumeEffect,
		resume: async (resumeOpts) => {
			await Effect.runPromise(resumeEffect(resumeOpts));
		},
		workflow,
	});

	return make<never>();
}
