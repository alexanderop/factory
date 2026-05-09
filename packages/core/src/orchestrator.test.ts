import { NodeContext } from '@effect/platform-node';
import { Cause, Effect, Exit, Layer, Ref } from 'effect';
import { describe, expect, it } from 'vitest';
import { runFactoryEffect } from './orchestrator.ts';
import {
	type DisplayEntry,
	harnessRegistryLayer,
	InMemoryStepLoader,
	recordingEventEmitter,
	scriptedHarness,
	scriptedUntilEvaluator,
	SilentDisplay,
} from './testing/index.ts';
import type { FactoryEvent } from './types.ts';

const fakeHarness = scriptedHarness('claude-code', [
	{ stdout: 'iter-1-output\n' },
	{ stdout: 'iter-2-output\n' },
	{ stdout: 'iter-3-output\n' },
	{ stdout: 'iter-4-output\n' },
]);

const buildLayer = (
	displayRef: Ref.Ref<ReadonlyArray<DisplayEntry>>,
	eventsRef: Ref.Ref<ReadonlyArray<FactoryEvent>>,
	steps: Iterable<readonly [string, string]>,
	verdicts: ReadonlyArray<boolean>,
) =>
	Layer.mergeAll(
		SilentDisplay.layer(displayRef),
		recordingEventEmitter.layer(eventsRef),
		harnessRegistryLayer([
			scriptedHarness('claude-code', [
				{ stdout: 'iter-1\n' },
				{ stdout: 'iter-2\n' },
				{ stdout: 'iter-3\n' },
				{ stdout: 'iter-4\n' },
				{ stdout: 'iter-5\n' },
			]),
		]),
		InMemoryStepLoader.layer(new Map(steps)),
		scriptedUntilEvaluator.layer(verdicts),
	).pipe(Layer.provideMerge(NodeContext.layer));

describe('runFactoryEffect', () => {
	it('runs every step once when no until is set, emitting lifecycle events in order', async () => {
		const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
		const eventsRef = Ref.unsafeMake<ReadonlyArray<FactoryEvent>>([]);

		const steps: ReadonlyArray<readonly [string, string]> = [
			['./steps/plan.md', '---\nname: plan\n---\nWrite a plan.'],
			['./steps/ralph.md', '---\nname: ralph\n---\nIterate.'],
		];

		const layer = buildLayer(displayRef, eventsRef, steps, [true]);

		await Effect.runPromise(
			runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code', harnesses: [fakeHarness] },
				[
					{ id: 'plan', source: './steps/plan.md', options: {} },
					{ id: 'ralph', source: './steps/ralph.md', options: {} },
				],
				{ prd: 'inline PRD text', cwd: process.cwd() },
			).pipe(Effect.provide(layer)),
		);

		const events = await Effect.runPromise(Ref.get(eventsRef));
		const types = events.map((e) => e.type);

		expect(types[0]).toBe('run.start');
		expect(types).toContain('step.start');
		expect(types).toContain('run.end');

		const stepEnds = events.filter(
			(e): e is Extract<FactoryEvent, { type: 'step.end' }> => e.type === 'step.end',
		);
		expect(stepEnds).toHaveLength(2);
		expect(stepEnds.every((e) => e.ok)).toBe(true);
		expect(stepEnds.map((e) => e.step)).toEqual(['plan', 'ralph']);
	});

	it('iterates the ralph loop until the until-predicate succeeds', async () => {
		const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
		const eventsRef = Ref.unsafeMake<ReadonlyArray<FactoryEvent>>([]);

		const steps: ReadonlyArray<readonly [string, string]> = [
			[
				'./steps/ralph.md',
				`---
name: ralph
until: "output contains: DONE"
maxIters: 5
---
Iterate until done.`,
			],
		];

		// false, false, true → success on iter 3
		const layer = buildLayer(displayRef, eventsRef, steps, [false, false, true]);

		await Effect.runPromise(
			runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code' },
				[{ id: 'ralph', source: './steps/ralph.md', options: {} }],
				{ prd: 'inline PRD text', cwd: process.cwd() },
			).pipe(Effect.provide(layer)),
		);

		const events = await Effect.runPromise(Ref.get(eventsRef));
		const iters = events.filter(
			(e): e is Extract<FactoryEvent, { type: 'step.iter' }> => e.type === 'step.iter',
		);
		expect(iters.map((e) => e.iter)).toEqual([1, 2, 3]);

		const ends = events.filter(
			(e): e is Extract<FactoryEvent, { type: 'step.end' }> => e.type === 'step.end',
		);
		expect(ends).toHaveLength(1);
		expect(ends[0]?.ok).toBe(true);
	});

	it('fails with StepMaxItersError when until never holds', async () => {
		const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
		const eventsRef = Ref.unsafeMake<ReadonlyArray<FactoryEvent>>([]);

		const steps: ReadonlyArray<readonly [string, string]> = [
			[
				'./steps/ralph.md',
				`---
name: ralph
until: "output contains: DONE"
maxIters: 2
---
Iterate.`,
			],
		];

		const layer = buildLayer(displayRef, eventsRef, steps, [false, false]);

		const exit = await Effect.runPromiseExit(
			runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code' },
				[{ id: 'ralph', source: './steps/ralph.md', options: {} }],
				{ prd: 'inline PRD text', cwd: process.cwd() },
			).pipe(Effect.provide(layer)),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			const failure = Cause.failureOption(exit.cause);
			expect(failure._tag).toBe('Some');
			if (failure._tag === 'Some') {
				expect((failure.value as { _tag: string })._tag).toBe('StepMaxItersError');
			}
		}

		const events = await Effect.runPromise(Ref.get(eventsRef));
		const errorEvent = events.find((e) => e.type === 'error');
		expect(errorEvent).toBeDefined();
	});
});
