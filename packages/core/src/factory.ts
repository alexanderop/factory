import { NodeContext } from '@effect/platform-node';
import { Effect, Layer } from 'effect';
import { runFactoryEffect } from './orchestrator.ts';
import { NoOtelLayer, OtelLayer } from './otel.ts';
import { ConsoleDisplay } from './services/Display.ts';
import { callbackEventEmitter } from './services/EventEmitter.ts';
import { harnessRegistryLayer } from './services/HarnessRegistry.ts';
import { FileStepLoader } from './services/StepLoader.ts';
import { DefaultUntilEvaluator } from './services/UntilEvaluator.ts';
import type { Factory, FactoryOptions, RunOptions, StepEntry } from './types.ts';

const buildRuntimeLayer = (opts: FactoryOptions, runOpts: RunOptions) => {
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
		otelEnabled ? OtelLayer : NoOtelLayer,
	).pipe(Layer.provideMerge(NodeContext.layer));
};

export function factory(opts: FactoryOptions): Factory {
	const steps: StepEntry[] = [];

	const self: Factory = {
		name: opts.name,
		step(id, source, stepOptions) {
			steps.push({ id, source, options: stepOptions ?? {} });
			return self;
		},
		runEffect(runOpts) {
			return runFactoryEffect(opts, steps, runOpts).pipe(
				Effect.provide(buildRuntimeLayer(opts, runOpts)),
			);
		},
		async run(runOpts) {
			await Effect.runPromise(self.runEffect(runOpts));
		},
	};

	return self;
}
