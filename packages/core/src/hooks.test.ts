import { describe, it } from '@effect/vitest';
import { deepStrictEqual } from '@effect/vitest/utils';
import { Effect, Ref } from 'effect';
import { runFactoryEffect } from './orchestrator.ts';
import type { HookEvent } from './services/HookRunner.ts';
import { capturingScripted, makeTestRig } from './testing/index.ts';

const stepFiles: ReadonlyArray<readonly [string, string]> = [
	['./steps/plan.md', '---\nname: plan\n---\nWrite a plan.'],
];

const stepPipeline = [
	{ kind: 'step' as const, id: 'plan', source: './steps/plan.md', options: {} },
];

describe('runFactoryEffect — hooks integration (smoke)', () => {
	it.effect(
		'dispatches sessionStart, preToolUse, postToolUse, stop in order for a single-tool iter',
		() =>
			Effect.gen(function* () {
				const hookEventsRef = yield* Ref.make<ReadonlyArray<HookEvent>>([]);

				const { harness } = capturingScripted('claude-code', [
					{
						events: [
							{
								type: 'tool.start',
								id: 'tc_1',
								name: 'Bash',
								input: { command: 'ls' },
							},
							{
								type: 'tool.end',
								id: 'tc_1',
								ok: true,
								output: { stdout: 'file.txt\n' },
							},
							{ type: 'assistant.message', text: 'done' },
							{ type: 'result', ok: true, durationMs: 5 },
							{ type: 'exit', code: 0 },
						],
					},
				]);

				const { layer } = makeTestRig({
					harnesses: [harness],
					stepFiles,
					verdicts: [true],
					hookEventsRef,
				});

				yield* runFactoryEffect({ name: 'sdd', harness: 'claude-code' }, stepPipeline, {
					prd: 'inline PRD',
					cwd: process.cwd(),
				}).pipe(Effect.provide(layer));

				const tags = (yield* Ref.get(hookEventsRef)).map((e) => e._tag);
				deepStrictEqual(tags, ['sessionStart', 'preToolUse', 'postToolUse', 'stop']);
			}),
	);

	it.effect('postToolUseFailure dispatches when the tool errors (tool.end ok:false)', () =>
		Effect.gen(function* () {
			const hookEventsRef = yield* Ref.make<ReadonlyArray<HookEvent>>([]);

			const { harness } = capturingScripted('claude-code', [
				{
					events: [
						{ type: 'tool.start', id: 'tc_1', name: 'Bash', input: { command: 'oops' } },
						{
							type: 'tool.end',
							id: 'tc_1',
							ok: false,
							output: { stderr: 'command not found' },
						},
						{ type: 'result', ok: true, durationMs: 3 },
						{ type: 'exit', code: 0 },
					],
				},
			]);

			const { layer } = makeTestRig({
				harnesses: [harness],
				stepFiles,
				verdicts: [true],
				hookEventsRef,
			});

			yield* runFactoryEffect({ name: 'sdd', harness: 'claude-code' }, stepPipeline, {
				prd: 'inline PRD',
				cwd: process.cwd(),
			}).pipe(Effect.provide(layer));

			const tags = (yield* Ref.get(hookEventsRef)).map((e) => e._tag);
			deepStrictEqual(tags, ['sessionStart', 'preToolUse', 'postToolUseFailure', 'stop']);
		}),
	);

	it.effect('preToolUse fires once per tool call across multiple tools in one iter', () =>
		Effect.gen(function* () {
			const hookEventsRef = yield* Ref.make<ReadonlyArray<HookEvent>>([]);

			const { harness } = capturingScripted('claude-code', [
				{
					events: [
						{ type: 'tool.start', id: 't1', name: 'Bash', input: { command: 'ls' } },
						{ type: 'tool.end', id: 't1', ok: true, output: { stdout: '' } },
						{ type: 'tool.start', id: 't2', name: 'Write', input: { path: 'x' } },
						{ type: 'tool.end', id: 't2', ok: true, output: {} },
						{ type: 'result', ok: true, durationMs: 5 },
						{ type: 'exit', code: 0 },
					],
				},
			]);

			const { layer } = makeTestRig({
				harnesses: [harness],
				stepFiles,
				verdicts: [true],
				hookEventsRef,
			});

			yield* runFactoryEffect({ name: 'sdd', harness: 'claude-code' }, stepPipeline, {
				prd: 'inline PRD',
				cwd: process.cwd(),
			}).pipe(Effect.provide(layer));

			const tags = (yield* Ref.get(hookEventsRef)).map((e) => e._tag);
			deepStrictEqual(tags, [
				'sessionStart',
				'preToolUse',
				'postToolUse',
				'preToolUse',
				'postToolUse',
				'stop',
			]);
		}),
	);
});
