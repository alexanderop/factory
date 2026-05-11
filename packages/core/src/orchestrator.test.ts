import { describe, it } from '@effect/vitest';
import { assertTrue, deepStrictEqual, strictEqual } from '@effect/vitest/utils';
import { Effect } from 'effect';
import { CapabilityMismatchError } from './capabilities.ts';
import { StepMaxItersError, UnsupportedPermissionError } from './errors.ts';
import { runFactoryEffect } from './orchestrator.ts';
import {
	assertExitFailedWith,
	capturingScripted,
	cycledHarness,
	makeFullCapabilities,
	makeHarnessCapabilities,
	makeTestRig,
} from './testing/index.ts';
import type { FactoryEvent, PermissionMode } from './types.ts';

const fakeHarness = cycledHarness('claude-code', [
	{ stdout: 'iter-1-output\n' },
	{ stdout: 'iter-2-output\n' },
	{ stdout: 'iter-3-output\n' },
	{ stdout: 'iter-4-output\n' },
]);

describe('runFactoryEffect', () => {
	it.effect('runs every step once when no until is set, emitting lifecycle events in order', () =>
		Effect.gen(function* () {
			const steps: ReadonlyArray<readonly [string, string]> = [
				['./steps/plan.md', '---\nname: plan\n---\nWrite a plan.'],
				['./steps/ralph.md', '---\nname: ralph\n---\nIterate.'],
			];

			const { layer, events } = makeTestRig({
				harnesses: [fakeHarness],
				stepFiles: steps,
				verdicts: [true],
			});

			yield* runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code' },
				[
					{ kind: 'step', id: 'plan', source: './steps/plan.md', options: {} },
					{ kind: 'step', id: 'ralph', source: './steps/ralph.md', options: {} },
				],
				{ prd: 'inline PRD text', cwd: process.cwd() },
			).pipe(Effect.provide(layer));

			const captured = yield* events;
			const types = captured.map((e) => e.type);

			strictEqual(types[0], 'run.start');
			assertTrue(types.includes('step.start'));
			assertTrue(types.includes('run.end'));

			const stepEnds = captured.filter(
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
			const { layer, events } = makeTestRig({
				stepFiles: steps,
				verdicts: [false, false, true],
			});

			yield* runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code' },
				[{ kind: 'step', id: 'ralph', source: './steps/ralph.md', options: {} }],
				{ prd: 'inline PRD text', cwd: process.cwd() },
			).pipe(Effect.provide(layer));

			const captured = yield* events;
			const iters = captured.filter(
				(e): e is Extract<FactoryEvent, { type: 'step.iter' }> => e.type === 'step.iter',
			);
			deepStrictEqual(
				iters.map((e) => e.iter),
				[1, 2, 3],
			);

			const ends = captured.filter(
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
			const { harness: recordingHarness, calls } = capturingScripted(
				'claude-code',
				[{ stdout: 'iter-1\n' }],
				{ defaultPermissions: args.harnessDefault },
			);

			const stepBody =
				args.frontmatterPermissions === undefined
					? `---\nname: only\n---\nDo it.`
					: `---\nname: only\npermissions: ${args.frontmatterPermissions}\n---\nDo it.`;

			const { layer } = makeTestRig({
				harnesses: [recordingHarness],
				stepFiles: new Map([['./steps/only.md', stepBody]]),
				verdicts: [true],
			});

			yield* runFactoryEffect(
				{
					name: 'sdd',
					harness: 'claude-code',
					permissions: args.factoryPermissions,
				},
				[
					{
						kind: 'step',
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

			const captured = yield* calls;
			return captured[0]?.permissions;
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
					const narrowHarness = cycledHarness('claude-code', [{ stdout: 'unused\n' }], {
						supports: ['skip', 'read-only'] as const,
						defaultPermissions: 'skip',
					});

					const { layer } = makeTestRig({
						harnesses: [narrowHarness],
						stepFiles: new Map([['./steps/only.md', `---\nname: only\n---\nDo it.`]]),
					});

					const exit = yield* Effect.exit(
						runFactoryEffect(
							{ name: 'sdd', harness: 'claude-code' },
							[{ kind: 'step', id: 'only', source: './steps/only.md', options: {} }],
							{
								prd: 'inline PRD text',
								cwd: process.cwd(),
								permissions: 'accept-edits',
							},
						).pipe(Effect.provide(layer)),
					);

					assertExitFailedWith(exit, UnsupportedPermissionError);
				}),
		);
	});

	describe('capability requirements', () => {
		it.effect(
			'fails with CapabilityMismatchError before spawning when a step requires a capability the harness lacks',
			() =>
				Effect.gen(function* () {
					const { harness: limitedHarness, calls } = capturingScripted(
						'claude-code',
						[{ stdout: 'never\n' }],
						{ capabilities: makeHarnessCapabilities() },
					);

					const { layer } = makeTestRig({
						harnesses: [limitedHarness],
						stepFiles: new Map([
							[
								'./steps/only.md',
								`---\nname: only\nrequires:\n  session:\n    resume: true\n---\nDo it.`,
							],
						]),
					});

					const exit = yield* Effect.exit(
						runFactoryEffect(
							{ name: 'sdd', harness: 'claude-code' },
							[{ kind: 'step', id: 'only', source: './steps/only.md', options: {} }],
							{ prd: 'inline PRD text', cwd: process.cwd() },
						).pipe(Effect.provide(layer)),
					);

					const err = assertExitFailedWith(exit, CapabilityMismatchError);
					deepStrictEqual(err.missing, ['session.resume']);
					deepStrictEqual(yield* calls, []);
				}),
		);

		it.effect('passes when capabilities meet the step requirements', () =>
			Effect.gen(function* () {
				const harness = cycledHarness('claude-code', [{ stdout: 'ok\n' }], {
					capabilities: makeFullCapabilities(),
				});

				const { layer, events } = makeTestRig({
					harnesses: [harness],
					stepFiles: new Map([
						[
							'./steps/only.md',
							`---\nname: only\nrequires:\n  session:\n    resume: true\n  prompt:\n    image: true\n---\nDo it.`,
						],
					]),
				});

				yield* runFactoryEffect(
					{ name: 'sdd', harness: 'claude-code' },
					[{ kind: 'step', id: 'only', source: './steps/only.md', options: {} }],
					{ prd: 'inline PRD text', cwd: process.cwd() },
				).pipe(Effect.provide(layer));

				const ends = (yield* events).filter(
					(e): e is Extract<FactoryEvent, { type: 'step.end' }> => e.type === 'step.end',
				);
				strictEqual(ends.length, 1);
				strictEqual(ends[0]?.ok, true);
			}),
		);
	});

	it.effect('fails with StepMaxItersError when until never holds', () =>
		Effect.gen(function* () {
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

			const { layer, events } = makeTestRig({
				stepFiles: steps,
				verdicts: [false, false],
			});

			const exit = yield* Effect.exit(
				runFactoryEffect(
					{ name: 'sdd', harness: 'claude-code' },
					[{ kind: 'step', id: 'ralph', source: './steps/ralph.md', options: {} }],
					{ prd: 'inline PRD text', cwd: process.cwd() },
				).pipe(Effect.provide(layer)),
			);

			assertExitFailedWith(exit, StepMaxItersError);

			const errorEvent = (yield* events).find((e) => e.type === 'error');
			assertTrue(errorEvent !== undefined);
		}),
	);
});
