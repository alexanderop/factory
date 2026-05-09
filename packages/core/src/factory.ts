import { randomUUID } from 'node:crypto';
import { NodeContext } from '@effect/platform-node';
import { Effect, Layer } from 'effect';
import { RunId } from './ids.ts';
import { runFactoryEffect } from './orchestrator.ts';
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
	RunOptions,
	StepEntry,
	StepOptions,
} from './types.ts';

interface RuntimeContext {
	readonly runId: RunId;
	readonly cwd: string;
}

const buildRuntimeLayer = (opts: FactoryOptions, runOpts: RunOptions, ctx: RuntimeContext) => {
	const otelEnabled = runOpts.otel !== false && process.env.OTEL_SDK_DISABLED !== 'true';

	return Layer.mergeAll(
		ConsoleDisplay.layer,
		callbackEventEmitter.layer({
			onStep: runOpts.onStep,
			onError: runOpts.onError,
		}),
		harnessRegistryLayer(opts.harnesses ?? []),
		FileStepLoader.layer,
		DefaultUntilEvaluator.layer,
		LiveRunWorkspace.layer({ runId: ctx.runId, cwd: ctx.cwd }),
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
			Effect.provide(buildRuntimeLayer(opts, runOpts, { runId, cwd })),
		);
	};

	const make = <StepIds extends string>(): Factory<Names, StepIds> => ({
		name: opts.name,
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
	});

	return make<never>();
}
