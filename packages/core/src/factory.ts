import { randomUUID } from 'node:crypto';
import { NodeContext } from '@effect/platform-node';
import { Effect, Layer } from 'effect';
import { RunId } from './ids.ts';
import { resumeFactoryEffect, runFactoryEffect } from './orchestrator.ts';
import { NoOtelLayer, OtelLayer } from './otel.ts';
import { ConsoleDisplay } from './services/Display.ts';
import { callbackEventEmitter } from './services/EventEmitter.ts';
import { harnessRegistryLayer } from './services/HarnessRegistry.ts';
import { LiveRunWorkspace } from './services/RunWorkspace.ts';
import { FileStepLoader } from './services/StepLoader.ts';
import { DefaultUntilEvaluator } from './services/UntilEvaluator.ts';
import type {
	Factory,
	FactoryOptions,
	Harness,
	ResumeOptions,
	RunOptions,
	StepEntry,
	StepOptions,
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
}

const buildRuntimeLayer = (opts: FactoryOptions, runOpts: RuntimeOpts, ctx: RuntimeContext) => {
	const otelEnabled = runOpts.otel !== false && process.env.OTEL_SDK_DISABLED !== 'true';

	const workspaceLayer = ctx.resume
		? LiveRunWorkspace.resumed({ runId: ctx.runId, cwd: ctx.cwd })
		: LiveRunWorkspace.layer({ runId: ctx.runId, cwd: ctx.cwd });

	return Layer.mergeAll(
		ConsoleDisplay.layer,
		callbackEventEmitter.layer({
			onStep: runOpts.onStep,
			onError: runOpts.onError,
		}),
		harnessRegistryLayer(opts.harnesses ?? []),
		FileStepLoader.layer,
		DefaultUntilEvaluator.layer,
		workspaceLayer,
		otelEnabled ? OtelLayer : NoOtelLayer,
	).pipe(Layer.provideMerge(NodeContext.layer));
};

export function factory<const Hs extends ReadonlyArray<Harness>>(
	opts: FactoryOptions<Hs[number]['name']> & { readonly harnesses?: Hs },
): Factory<Hs[number]['name']> {
	type Names = Hs[number]['name'];
	const steps: StepEntry[] = [];

	const runEffect = (runOpts: RunOptions) => {
		const runId = RunId.make(randomUUID());
		const cwd = runOpts.cwd ?? process.cwd();
		return runFactoryEffect(opts, steps, runOpts).pipe(
			Effect.provide(buildRuntimeLayer(opts, runOpts, { runId, cwd, resume: false })),
		);
	};

	const resumeEffect = (resumeOpts: ResumeOptions) => {
		const cwd = resumeOpts.cwd ?? process.cwd();
		return resumeFactoryEffect(opts, steps, resumeOpts).pipe(
			Effect.provide(
				buildRuntimeLayer(opts, resumeOpts, { runId: resumeOpts.runId, cwd, resume: true }),
			),
		);
	};

	const make = <StepIds extends string>(): Factory<Names, StepIds> => ({
		name: opts.name,
		harness: opts.harness,
		step<Id extends string>(
			id: Exclude<Id, StepIds>,
			source: string,
			stepOptions?: StepOptions<Names>,
		) {
			steps.push({ id, source, options: stepOptions ?? {} });
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
	});

	return make<never>();
}
