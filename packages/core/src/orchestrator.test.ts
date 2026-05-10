import { NodeContext } from '@effect/platform-node';
import { describe, it } from '@effect/vitest';
import { assertInstanceOf, assertTrue, deepStrictEqual, strictEqual } from '@effect/vitest/utils';
import { Cause, Effect, Exit, Layer, Ref, Stream } from 'effect';
import { CapabilityMismatchError, type HarnessCapabilities } from './capabilities.ts';
import {
	HarnessIdleTimeoutError,
	StepIdleTimeoutError,
	StepMaxItersError,
	UnsupportedPermissionError,
} from './errors.ts';
import { HarnessName, RunId } from './ids.ts';
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
import type { ExecOpts, FactoryEvent, Harness, PermissionMode } from './types.ts';

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
	it.effect('runs every step once when no until is set, emitting lifecycle events in order', () =>
		Effect.gen(function* () {
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
			const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);

			const steps: ReadonlyArray<readonly [string, string]> = [
				['./steps/plan.md', '---\nname: plan\n---\nWrite a plan.'],
				['./steps/ralph.md', '---\nname: ralph\n---\nIterate.'],
			];

			const layer = buildLayer(displayRef, eventsRef, steps, [true]);

			yield* runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code', harnesses: [fakeHarness] },
				[
					{ id: 'plan', source: './steps/plan.md', options: {} },
					{ id: 'ralph', source: './steps/ralph.md', options: {} },
				],
				{ prd: 'inline PRD text', cwd: process.cwd() },
			).pipe(Effect.provide(layer));

			const events = yield* Ref.get(eventsRef);
			const types = events.map((e) => e.type);

			strictEqual(types[0], 'run.start');
			assertTrue(types.includes('step.start'));
			assertTrue(types.includes('run.end'));

			const stepEnds = events.filter(
				(e): e is Extract<FactoryEvent, { type: 'step.end' }> => e.type === 'step.end',
			);
			strictEqual(stepEnds.length, 2);
			assertTrue(stepEnds.every((e) => e.ok));
			deepStrictEqual(
				stepEnds.map((e) => e.step),
				['plan', 'ralph'],
			);
		}),
	);

	it.effect('iterates the ralph loop until the until-predicate succeeds', () =>
		Effect.gen(function* () {
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
			const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);

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

			yield* runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code' },
				[{ id: 'ralph', source: './steps/ralph.md', options: {} }],
				{ prd: 'inline PRD text', cwd: process.cwd() },
			).pipe(Effect.provide(layer));

			const events = yield* Ref.get(eventsRef);
			const iters = events.filter(
				(e): e is Extract<FactoryEvent, { type: 'step.iter' }> => e.type === 'step.iter',
			);
			deepStrictEqual(
				iters.map((e) => e.iter),
				[1, 2, 3],
			);

			const ends = events.filter(
				(e): e is Extract<FactoryEvent, { type: 'step.end' }> => e.type === 'step.end',
			);
			strictEqual(ends.length, 1);
			strictEqual(ends[0]?.ok, true);
		}),
	);

	const runWithPermissions = (args: {
		readonly factoryPermissions?: PermissionMode;
		readonly stepPermissions?: PermissionMode;
		readonly frontmatterPermissions?: PermissionMode;
		readonly cliPermissions?: PermissionMode;
		readonly harnessDefault?: PermissionMode;
	}) =>
		Effect.gen(function* () {
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
			const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);

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

			yield* runFactoryEffect(
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
			).pipe(Effect.provide(layer));

			return calls[0]?.permissions;
		});

	describe('permission resolution', () => {
		it.effect('falls back to "prompt" when nothing is configured', () =>
			Effect.gen(function* () {
				const mode = yield* runWithPermissions({});
				strictEqual(mode, 'prompt');
			}),
		);

		it.effect('uses harness defaultPermissions when no override is set', () =>
			Effect.gen(function* () {
				const mode = yield* runWithPermissions({ harnessDefault: 'skip' });
				strictEqual(mode, 'skip');
			}),
		);

		it.effect('pipeline permissions override harness defaultPermissions', () =>
			Effect.gen(function* () {
				const mode = yield* runWithPermissions({
					harnessDefault: 'skip',
					factoryPermissions: 'read-only',
				});
				strictEqual(mode, 'read-only');
			}),
		);

		it.effect('frontmatter overrides pipeline permissions', () =>
			Effect.gen(function* () {
				const mode = yield* runWithPermissions({
					factoryPermissions: 'read-only',
					frontmatterPermissions: 'accept-edits',
				});
				strictEqual(mode, 'accept-edits');
			}),
		);

		it.effect('step option overrides frontmatter permissions', () =>
			Effect.gen(function* () {
				const mode = yield* runWithPermissions({
					frontmatterPermissions: 'accept-edits',
					stepPermissions: 'read-only',
				});
				strictEqual(mode, 'read-only');
			}),
		);

		it.effect('CLI permissions take top precedence', () =>
			Effect.gen(function* () {
				const mode = yield* runWithPermissions({
					harnessDefault: 'skip',
					factoryPermissions: 'read-only',
					frontmatterPermissions: 'accept-edits',
					stepPermissions: 'read-only',
					cliPermissions: 'prompt',
				});
				strictEqual(mode, 'prompt');
			}),
		);

		it.effect(
			'fails with UnsupportedPermissionError when resolved mode is not in harness.supports',
			() =>
				Effect.gen(function* () {
					const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
					const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);

					const narrowHarness = scriptedHarness('claude-code', [{ stdout: 'unused\n' }], {
						supports: ['skip', 'read-only'] as const,
						defaultPermissions: 'skip',
					});

					const layer = Layer.mergeAll(
						SilentDisplay.layer(displayRef),
						recordingEventEmitter.layer(eventsRef),
						harnessRegistryLayer([narrowHarness]),
						InMemoryStepLoader.layer(
							new Map([['./steps/only.md', `---\nname: only\n---\nDo it.`]]),
						),
						scriptedUntilEvaluator.layer([true]),
						InMemoryRunWorkspace.layer({ runId: RunId.make('test-run') }),
					).pipe(Layer.provideMerge(NodeContext.layer));

					const exit = yield* Effect.exit(
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

					assertTrue(Exit.isFailure(exit));
					const failure = Cause.failureOption(exit.cause);
					assertTrue(failure._tag === 'Some');
					assertInstanceOf(failure.value, UnsupportedPermissionError);
				}),
		);
	});

	describe('capability requirements', () => {
		it.effect(
			'fails with CapabilityMismatchError before spawning when a step requires a capability the harness lacks',
			() =>
				Effect.gen(function* () {
					const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
					const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);

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

					const exit = yield* Effect.exit(
						runFactoryEffect(
							{ name: 'sdd', harness: 'claude-code' },
							[{ id: 'only', source: './steps/only.md', options: {} }],
							{ prd: 'inline PRD text', cwd: process.cwd() },
						).pipe(Effect.provide(layer)),
					);

					assertTrue(Exit.isFailure(exit));
					const failure = Cause.failureOption(exit.cause);
					assertTrue(failure._tag === 'Some');
					assertInstanceOf(failure.value, CapabilityMismatchError);
					deepStrictEqual(failure.value.missing, ['session.resume']);
					deepStrictEqual(calls, []);
				}),
		);

		it.effect('passes when capabilities meet the step requirements', () =>
			Effect.gen(function* () {
				const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
				const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);

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

				yield* runFactoryEffect(
					{ name: 'sdd', harness: 'claude-code' },
					[{ id: 'only', source: './steps/only.md', options: {} }],
					{ prd: 'inline PRD text', cwd: process.cwd() },
				).pipe(Effect.provide(layer));

				const events = yield* Ref.get(eventsRef);
				const ends = events.filter(
					(e): e is Extract<FactoryEvent, { type: 'step.end' }> => e.type === 'step.end',
				);
				strictEqual(ends.length, 1);
				strictEqual(ends[0]?.ok, true);
			}),
		);
	});

	it.effect(
		'maps HarnessIdleTimeoutError to StepIdleTimeoutError carrying the running step brand',
		() =>
			Effect.gen(function* () {
				const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
				const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);

				const fullCaps: HarnessCapabilities = {
					loadSession: false,
					mcp: { http: false, sse: false },
					prompt: { image: false, audio: false, embeddedContext: false },
					session: { list: false, resume: false, close: false },
					factory: {
						permissions: ['skip', 'accept-edits', 'read-only', 'prompt'],
						toolEvents: false,
					},
				};
				const idleHarness: Harness<'claude-code'> = {
					name: 'claude-code',
					capabilities: fullCaps,
					exec: () =>
						Effect.fail(
							new HarnessIdleTimeoutError({
								message: "harness 'claude-code' produced no output for 5000ms",
								harness: HarnessName.make('claude-code'),
								idleMs: 5000,
							}),
						),
					stream: () =>
						Stream.fail(
							new HarnessIdleTimeoutError({
								message: "harness 'claude-code' produced no output for 5000ms",
								harness: HarnessName.make('claude-code'),
								idleMs: 5000,
							}),
						),
				};

				const layer = Layer.mergeAll(
					SilentDisplay.layer(displayRef),
					recordingEventEmitter.layer(eventsRef),
					harnessRegistryLayer([idleHarness]),
					InMemoryStepLoader.layer(new Map([['./steps/only.md', `---\nname: only\n---\nDo it.`]])),
					scriptedUntilEvaluator.layer([true]),
					InMemoryRunWorkspace.layer({ runId: RunId.make('test-run') }),
				).pipe(Layer.provideMerge(NodeContext.layer));

				const exit = yield* Effect.exit(
					runFactoryEffect(
						{ name: 'sdd', harness: 'claude-code' },
						[{ id: 'only', source: './steps/only.md', options: {} }],
						{ prd: 'inline PRD', cwd: process.cwd() },
					).pipe(Effect.provide(layer)),
				);

				assertTrue(Exit.isFailure(exit));
				const failure = Cause.failureOption(exit.cause);
				assertTrue(failure._tag === 'Some');
				assertInstanceOf(failure.value, StepIdleTimeoutError);
				strictEqual(failure.value.step, 'only');
				strictEqual(failure.value.timeoutMs, 5000);
			}),
	);

	it.effect('fails with StepMaxItersError when until never holds', () =>
		Effect.gen(function* () {
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
			const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);

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

			const exit = yield* Effect.exit(
				runFactoryEffect(
					{ name: 'sdd', harness: 'claude-code' },
					[{ id: 'ralph', source: './steps/ralph.md', options: {} }],
					{ prd: 'inline PRD text', cwd: process.cwd() },
				).pipe(Effect.provide(layer)),
			);

			assertTrue(Exit.isFailure(exit));
			const failure = Cause.failureOption(exit.cause);
			assertTrue(failure._tag === 'Some');
			assertInstanceOf(failure.value, StepMaxItersError);

			const events = yield* Ref.get(eventsRef);
			const errorEvent = events.find((e) => e.type === 'error');
			assertTrue(errorEvent !== undefined);
		}),
	);
});
