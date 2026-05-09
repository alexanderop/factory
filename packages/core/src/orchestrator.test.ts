import { NodeContext } from '@effect/platform-node';
import { Cause, Effect, Exit, Layer, Ref } from 'effect';
import { describe, expect, it } from 'vitest';
import type { HarnessCapabilities } from './capabilities.ts';
import { RunId } from './ids.ts';
import { runFactoryEffect } from './orchestrator.ts';
import { InMemoryRunWorkspace } from './services/RunWorkspace.ts';
import {
	type DisplayEntry,
	harnessRegistryLayer,
	InMemoryStepLoader,
	recordingEventEmitter,
	scriptedHarness,
	scriptedUntilEvaluator,
	SilentDisplay,
} from './testing/index.ts';
import type { ExecOpts, FactoryEvent, PermissionMode } from './types.ts';

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
		InMemoryRunWorkspace.layer({ runId: RunId.make('test-run') }),
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

	const runWithPermissions = async (args: {
		readonly factoryPermissions?: PermissionMode;
		readonly stepPermissions?: PermissionMode;
		readonly frontmatterPermissions?: PermissionMode;
		readonly cliPermissions?: PermissionMode;
		readonly harnessDefault?: PermissionMode;
	}): Promise<PermissionMode | undefined> => {
		const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
		const eventsRef = Ref.unsafeMake<ReadonlyArray<FactoryEvent>>([]);

		const calls: ExecOpts[] = [];
		const recordingHarness = scriptedHarness('claude-code', [{ stdout: 'iter-1\n' }], {
			defaultPermissions: args.harnessDefault,
			onCall: (opts) => calls.push(opts),
		});

		const stepBody =
			args.frontmatterPermissions === undefined
				? `---\nname: only\n---\nDo it.`
				: `---\nname: only\npermissions: ${args.frontmatterPermissions}\n---\nDo it.`;

		const layer = Layer.mergeAll(
			SilentDisplay.layer(displayRef),
			recordingEventEmitter.layer(eventsRef),
			harnessRegistryLayer([recordingHarness]),
			InMemoryStepLoader.layer(new Map([['./steps/only.md', stepBody]])),
			scriptedUntilEvaluator.layer([true]),
			InMemoryRunWorkspace.layer({ runId: RunId.make('test-run') }),
		).pipe(Layer.provideMerge(NodeContext.layer));

		await Effect.runPromise(
			runFactoryEffect(
				{
					name: 'sdd',
					harness: 'claude-code',
					permissions: args.factoryPermissions,
				},
				[
					{
						id: 'only',
						source: './steps/only.md',
						options:
							args.stepPermissions === undefined ? {} : { permissions: args.stepPermissions },
					},
				],
				{
					prd: 'inline PRD text',
					cwd: process.cwd(),
					permissions: args.cliPermissions,
				},
			).pipe(Effect.provide(layer)),
		);

		return calls[0]?.permissions;
	};

	describe('permission resolution', () => {
		it('falls back to "prompt" when nothing is configured', async () => {
			const mode = await runWithPermissions({});
			expect(mode).toBe('prompt');
		});

		it('uses harness defaultPermissions when no override is set', async () => {
			const mode = await runWithPermissions({ harnessDefault: 'skip' });
			expect(mode).toBe('skip');
		});

		it('pipeline permissions override harness defaultPermissions', async () => {
			const mode = await runWithPermissions({
				harnessDefault: 'skip',
				factoryPermissions: 'read-only',
			});
			expect(mode).toBe('read-only');
		});

		it('frontmatter overrides pipeline permissions', async () => {
			const mode = await runWithPermissions({
				factoryPermissions: 'read-only',
				frontmatterPermissions: 'accept-edits',
			});
			expect(mode).toBe('accept-edits');
		});

		it('step option overrides frontmatter permissions', async () => {
			const mode = await runWithPermissions({
				frontmatterPermissions: 'accept-edits',
				stepPermissions: 'read-only',
			});
			expect(mode).toBe('read-only');
		});

		it('CLI permissions take top precedence', async () => {
			const mode = await runWithPermissions({
				harnessDefault: 'skip',
				factoryPermissions: 'read-only',
				frontmatterPermissions: 'accept-edits',
				stepPermissions: 'read-only',
				cliPermissions: 'prompt',
			});
			expect(mode).toBe('prompt');
		});

		it('fails with UnsupportedPermissionError when resolved mode is not in harness.supports', async () => {
			const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
			const eventsRef = Ref.unsafeMake<ReadonlyArray<FactoryEvent>>([]);

			const narrowHarness = scriptedHarness('claude-code', [{ stdout: 'unused\n' }], {
				supports: ['skip', 'read-only'] as const,
				defaultPermissions: 'skip',
			});

			const layer = Layer.mergeAll(
				SilentDisplay.layer(displayRef),
				recordingEventEmitter.layer(eventsRef),
				harnessRegistryLayer([narrowHarness]),
				InMemoryStepLoader.layer(new Map([['./steps/only.md', `---\nname: only\n---\nDo it.`]])),
				scriptedUntilEvaluator.layer([true]),
				InMemoryRunWorkspace.layer({ runId: RunId.make('test-run') }),
			).pipe(Layer.provideMerge(NodeContext.layer));

			const exit = await Effect.runPromiseExit(
				runFactoryEffect(
					{ name: 'sdd', harness: 'claude-code' },
					[{ id: 'only', source: './steps/only.md', options: {} }],
					{
						prd: 'inline PRD text',
						cwd: process.cwd(),
						permissions: 'accept-edits',
					},
				).pipe(Effect.provide(layer)),
			);

			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				const failure = Cause.failureOption(exit.cause);
				expect(failure._tag === 'Some' && failure.value._tag === 'UnsupportedPermissionError').toBe(
					true,
				);
			}
		});
	});

	describe('capability requirements', () => {
		it('fails with CapabilityMismatchError before spawning when a step requires a capability the harness lacks', async () => {
			const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
			const eventsRef = Ref.unsafeMake<ReadonlyArray<FactoryEvent>>([]);

			const calls: ExecOpts[] = [];
			const limitedCaps: HarnessCapabilities = {
				loadSession: false,
				mcp: { http: false, sse: false },
				prompt: { image: false, audio: false, embeddedContext: false },
				session: { list: false, resume: false, close: false },
				factory: {
					permissions: ['skip', 'accept-edits', 'read-only', 'prompt'],
					toolEvents: false,
				},
			};
			const limitedHarness = scriptedHarness('claude-code', [{ stdout: 'never\n' }], {
				capabilities: limitedCaps,
				onCall: (opts) => calls.push(opts),
			});

			const layer = Layer.mergeAll(
				SilentDisplay.layer(displayRef),
				recordingEventEmitter.layer(eventsRef),
				harnessRegistryLayer([limitedHarness]),
				InMemoryStepLoader.layer(
					new Map([
						[
							'./steps/only.md',
							`---\nname: only\nrequires:\n  session:\n    resume: true\n---\nDo it.`,
						],
					]),
				),
				scriptedUntilEvaluator.layer([true]),
				InMemoryRunWorkspace.layer({ runId: RunId.make('test-run') }),
			).pipe(Layer.provideMerge(NodeContext.layer));

			const exit = await Effect.runPromiseExit(
				runFactoryEffect(
					{ name: 'sdd', harness: 'claude-code' },
					[{ id: 'only', source: './steps/only.md', options: {} }],
					{ prd: 'inline PRD text', cwd: process.cwd() },
				).pipe(Effect.provide(layer)),
			);

			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				const failure = Cause.failureOption(exit.cause);
				expect(failure._tag === 'Some' && failure.value._tag === 'CapabilityMismatchError').toBe(
					true,
				);
				if (failure._tag === 'Some' && failure.value._tag === 'CapabilityMismatchError') {
					expect(failure.value.missing).toEqual(['session.resume']);
				}
			}
			expect(calls).toEqual([]);
		});

		it('passes when capabilities meet the step requirements', async () => {
			const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
			const eventsRef = Ref.unsafeMake<ReadonlyArray<FactoryEvent>>([]);

			const fullCaps: HarnessCapabilities = {
				loadSession: true,
				mcp: { http: true, sse: true },
				prompt: { image: true, audio: false, embeddedContext: true },
				session: { list: true, resume: true, close: false },
				factory: {
					permissions: ['skip', 'accept-edits', 'read-only', 'prompt'],
					toolEvents: true,
				},
			};
			const harness = scriptedHarness('claude-code', [{ stdout: 'ok\n' }], {
				capabilities: fullCaps,
			});

			const layer = Layer.mergeAll(
				SilentDisplay.layer(displayRef),
				recordingEventEmitter.layer(eventsRef),
				harnessRegistryLayer([harness]),
				InMemoryStepLoader.layer(
					new Map([
						[
							'./steps/only.md',
							`---\nname: only\nrequires:\n  session:\n    resume: true\n  prompt:\n    image: true\n---\nDo it.`,
						],
					]),
				),
				scriptedUntilEvaluator.layer([true]),
				InMemoryRunWorkspace.layer({ runId: RunId.make('test-run') }),
			).pipe(Layer.provideMerge(NodeContext.layer));

			await Effect.runPromise(
				runFactoryEffect(
					{ name: 'sdd', harness: 'claude-code' },
					[{ id: 'only', source: './steps/only.md', options: {} }],
					{ prd: 'inline PRD text', cwd: process.cwd() },
				).pipe(Effect.provide(layer)),
			);

			const events = await Effect.runPromise(Ref.get(eventsRef));
			const ends = events.filter(
				(e): e is Extract<FactoryEvent, { type: 'step.end' }> => e.type === 'step.end',
			);
			expect(ends).toHaveLength(1);
			expect(ends[0]?.ok).toBe(true);
		});
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
				expect(failure.value._tag).toBe('StepMaxItersError');
			}
		}

		const events = await Effect.runPromise(Ref.get(eventsRef));
		const errorEvent = events.find((e) => e.type === 'error');
		expect(errorEvent).toBeDefined();
	});
});
