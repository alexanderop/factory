import { NodeContext } from '@effect/platform-node';
import { describe, it } from '@effect/vitest';
import { assertTrue, deepStrictEqual, strictEqual } from '@effect/vitest/utils';
import { Effect, Layer, Ref } from 'effect';
import { StepMaxItersError } from './errors.ts';
import { RunId } from './ids.ts';
import { runFactoryEffect } from './orchestrator.ts';
import { SilentDisplay } from './services/Display.ts';
import { callbackEventEmitter } from './services/EventEmitter.ts';
import { harnessRegistryLayer } from './services/HarnessRegistry.ts';
import { InMemoryRunWorkspace } from './services/RunWorkspace.ts';
import { InMemoryStepLoader } from './services/StepLoader.ts';
import { scriptedUntilEvaluator } from './services/UntilEvaluator.ts';
import { assertExitFailedWith, cycledHarness, type DisplayEntry } from './testing/index.ts';
import type { FactoryEvent } from './types.ts';

interface BuildLayerOptions {
	readonly onStep?: (event: FactoryEvent) => void;
	readonly onError?: (event: Extract<FactoryEvent, { type: 'error' }>) => void;
	readonly stepFiles: ReadonlyMap<string, string>;
	readonly verdicts: ReadonlyArray<boolean>;
}

// Mirrors `makeTestLayer` but wires `callbackEventEmitter` in place of the
// default `noopEventEmitter` / `recordingEventEmitter` — overlaying via
// `Layer.merge` would publish the same `EventEmitter` tag twice.
const buildLayer = (options: BuildLayerOptions) =>
	Layer.mergeAll(
		SilentDisplay.layer(Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([])),
		callbackEventEmitter.layer({ onStep: options.onStep, onError: options.onError }),
		harnessRegistryLayer([cycledHarness('claude-code', [{ stdout: 'iter-1\n' }])]),
		InMemoryStepLoader.layer(options.stepFiles),
		scriptedUntilEvaluator.layer(options.verdicts),
		InMemoryRunWorkspace.layer({ runId: RunId.make('test-run') }),
	).pipe(Layer.provideMerge(NodeContext.layer));

describe('callbackEventEmitter', () => {
	it.effect('invokes onStep for every event on the happy path and never invokes onError', () =>
		Effect.gen(function* () {
			// Callbacks are user-facing JS closures, not Effect-aware — plain
			// mutable arrays mirror the production seam.
			const stepEvents: FactoryEvent[] = [];
			const errorEvents: Array<Extract<FactoryEvent, { type: 'error' }>> = [];

			const layer = buildLayer({
				stepFiles: new Map([['./steps/only.md', '---\nname: only\n---\nDo it.']]),
				verdicts: [true],
				onStep: (event) => {
					stepEvents.push(event);
				},
				onError: (event) => {
					errorEvents.push(event);
				},
			});

			yield* runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code' },
				[{ kind: 'step', id: 'only', source: './steps/only.md', options: {} }],
				{ prd: 'inline PRD text', cwd: process.cwd() },
			).pipe(Effect.provide(layer));

			const types = stepEvents.map((e) => e.type);
			strictEqual(types[0], 'run.start');
			assertTrue(types.includes('step.start'));
			strictEqual(types[types.length - 1], 'run.end');

			deepStrictEqual(errorEvents, []);
		}),
	);

	it.effect('invokes onError exactly once and onStep for every event on the error path', () =>
		Effect.gen(function* () {
			const stepEvents: FactoryEvent[] = [];
			const errorEvents: Array<Extract<FactoryEvent, { type: 'error' }>> = [];

			const layer = buildLayer({
				stepFiles: new Map([
					[
						'./steps/ralph.md',
						`---\nname: ralph\nuntil: "output contains: DONE"\nmaxIters: 1\n---\nIterate.`,
					],
				]),
				verdicts: [false],
				onStep: (event) => {
					stepEvents.push(event);
				},
				onError: (event) => {
					errorEvents.push(event);
				},
			});

			const exit = yield* Effect.exit(
				runFactoryEffect(
					{ name: 'sdd', harness: 'claude-code' },
					[{ kind: 'step', id: 'ralph', source: './steps/ralph.md', options: {} }],
					{ prd: 'inline PRD text', cwd: process.cwd() },
				).pipe(Effect.provide(layer)),
			);

			assertExitFailedWith(exit, StepMaxItersError);

			strictEqual(errorEvents.length, 1);
			strictEqual(errorEvents[0]?.type, 'error');
			assertTrue(stepEvents.some((e) => e.type === 'error'));
		}),
	);
});
