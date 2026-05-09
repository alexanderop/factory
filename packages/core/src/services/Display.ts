import { Context, Effect, Layer, Ref } from 'effect';
import type { PipelineName, RunId, StepId } from '../ids.ts';

export type DisplayEntry =
	| { readonly _tag: 'runStart'; readonly pipeline: PipelineName; readonly runId: RunId }
	| { readonly _tag: 'runEnd'; readonly runId: RunId }
	| { readonly _tag: 'stepStart'; readonly step: StepId }
	| {
			readonly _tag: 'stepIter';
			readonly step: StepId;
			readonly iter: number;
			readonly maxIters: number;
	  }
	| { readonly _tag: 'stepEnd'; readonly step: StepId; readonly ok: boolean }
	| {
			readonly _tag: 'harnessLine';
			readonly step: StepId;
			readonly stream: 'stdout' | 'stderr';
			readonly line: string;
	  }
	| { readonly _tag: 'info'; readonly message: string }
	| { readonly _tag: 'error'; readonly message: string };

export interface DisplayService {
	readonly runStart: (pipeline: PipelineName, runId: RunId) => Effect.Effect<void>;
	readonly runEnd: (runId: RunId) => Effect.Effect<void>;
	readonly stepStart: (step: StepId) => Effect.Effect<void>;
	readonly stepIter: (step: StepId, iter: number, maxIters: number) => Effect.Effect<void>;
	readonly stepEnd: (step: StepId, ok: boolean) => Effect.Effect<void>;
	readonly harnessLine: (
		step: StepId,
		stream: 'stdout' | 'stderr',
		line: string,
	) => Effect.Effect<void>;
	readonly info: (message: string) => Effect.Effect<void>;
	readonly error: (message: string) => Effect.Effect<void>;
}

export class Display extends Context.Tag('@factory/Display')<Display, DisplayService>() {}

export const ConsoleDisplay = {
	layer: Layer.succeed(Display, {
		runStart: (pipeline, runId) => Effect.sync(() => console.log(`▶ ${pipeline} (${runId})`)),
		runEnd: (runId) => Effect.sync(() => console.log(`✔ ${runId}`)),
		stepStart: (step) => Effect.sync(() => console.log(`  → ${step}`)),
		stepIter: (step, iter, maxIters) =>
			Effect.sync(() => console.log(`    [${step}] iter ${iter}/${maxIters}`)),
		stepEnd: (step, ok) => Effect.sync(() => console.log(`  ${ok ? '✔' : '✖'} ${step}`)),
		harnessLine: (step, stream, line) =>
			Effect.sync(() => {
				const out = stream === 'stderr' ? console.error : console.log;
				out(`    [${step}] ${line}`);
			}),
		info: (message) => Effect.sync(() => console.log(message)),
		error: (message) => Effect.sync(() => console.error(message)),
	} satisfies DisplayService),
};

const append =
	(ref: Ref.Ref<ReadonlyArray<DisplayEntry>>) =>
	(entry: DisplayEntry): Effect.Effect<void> =>
		Ref.update(ref, (e) => [...e, entry]);

export const SilentDisplay = {
	layer: (ref: Ref.Ref<ReadonlyArray<DisplayEntry>>): Layer.Layer<Display> => {
		const push = append(ref);
		return Layer.succeed(Display, {
			runStart: (pipeline, runId) => push({ _tag: 'runStart', pipeline, runId }),
			runEnd: (runId) => push({ _tag: 'runEnd', runId }),
			stepStart: (step) => push({ _tag: 'stepStart', step }),
			stepIter: (step, iter, maxIters) => push({ _tag: 'stepIter', step, iter, maxIters }),
			stepEnd: (step, ok) => push({ _tag: 'stepEnd', step, ok }),
			harnessLine: (step, stream, line) => push({ _tag: 'harnessLine', step, stream, line }),
			info: (message) => push({ _tag: 'info', message }),
			error: (message) => push({ _tag: 'error', message }),
		} satisfies DisplayService);
	},
};
