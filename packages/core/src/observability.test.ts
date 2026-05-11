import { describe, it } from '@effect/vitest';
import { assertTrue, deepStrictEqual, strictEqual } from '@effect/vitest/utils';
import { Effect, Ref } from 'effect';
import { runFactoryEffect } from './orchestrator.ts';
import {
	cycledHarness,
	type DisplayEntry,
	getFinishedSpans,
	makeTestLayer,
	makeTestRig,
	OtelTestLayer,
	scriptedHarness,
} from './testing/index.ts';
import type { FactoryEvent, HarnessEvent } from './types.ts';

describe('observability', () => {
	it.effect('emits the expected span tree for a single-iter run', () =>
		Effect.gen(function* () {
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
			const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);

			const layer = makeTestLayer({
				displayRef,
				eventsRef,
				harnesses: [scriptedHarness('claude-code', [{ stdout: 'iter-1\n' }])],
				stepFiles: new Map([['./steps/only.md', '---\nname: only\n---\nDo it.']]),
			});

			yield* runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code' },
				[{ kind: 'step', id: 'only', source: './steps/only.md', options: {} }],
				{ prd: 'inline PRD text', cwd: process.cwd(), permissions: 'skip' },
			).pipe(Effect.provide(layer));

			const spans = yield* getFinishedSpans();
			const names = new Set(spans.map((s) => s.name));

			assertTrue(names.has('factory.run sdd'));
			assertTrue(names.has('factory.step only'));
			assertTrue(names.has('factory.step.run only'));
			assertTrue(names.has('factory.iter only#1'));
			assertTrue(names.has('factory.step.load only'));

			const run = spans.find((s) => s.name === 'factory.run sdd');
			assertTrue(run !== undefined);
			deepStrictEqual(run.attributes['factory.pipeline'], 'sdd');
			deepStrictEqual(run.attributes['factory.run.id'], 'test-run');
			deepStrictEqual(run.attributes['factory.harness'], 'claude-code');
			deepStrictEqual(run.attributes['factory.permission.mode'], 'skip');

			const step = spans.find((s) => s.name === 'factory.step only');
			assertTrue(step !== undefined);
			deepStrictEqual(step.attributes['factory.step'], 'only');
			deepStrictEqual(step.attributes['factory.harness'], 'claude-code');
			deepStrictEqual(step.attributes['factory.permission.mode'], 'skip');

			const iter = spans.find((s) => s.name === 'factory.iter only#1');
			assertTrue(iter !== undefined);
			deepStrictEqual(iter.attributes['factory.iter'], 1);
			deepStrictEqual(iter.attributes['factory.iter.max'], 1);
			deepStrictEqual(iter.attributes['factory.harness'], 'claude-code');
			deepStrictEqual(iter.attributes['factory.permission.mode'], 'skip');
		}).pipe(Effect.provide(OtelTestLayer)),
	);

	it.effect('annotates the step span with factory.error._tag on failure', () =>
		Effect.gen(function* () {
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
			const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);

			const layer = makeTestLayer({
				displayRef,
				eventsRef,
				harnesses: [scriptedHarness('claude-code', [{ stdout: 'nope\n' }])],
				stepFiles: new Map([
					[
						'./steps/ralph.md',
						`---\nname: ralph\nuntil: "output contains: DONE"\nmaxIters: 1\n---\nIterate.`,
					],
				]),
				verdicts: [false],
			});

			yield* Effect.exit(
				runFactoryEffect(
					{ name: 'sdd', harness: 'claude-code' },
					[{ kind: 'step', id: 'ralph', source: './steps/ralph.md', options: {} }],
					{ prd: 'inline PRD text', cwd: process.cwd() },
				).pipe(Effect.provide(layer)),
			);

			const spans = yield* getFinishedSpans();
			const step = spans.find((s) => s.name === 'factory.step ralph');
			assertTrue(step !== undefined);
			deepStrictEqual(step.attributes['factory.error._tag'], 'StepMaxItersError');
		}).pipe(Effect.provide(OtelTestLayer)),
	);

	it.effect('emits a fully-annotated iter span and tool spans for a rich step', () =>
		Effect.gen(function* () {
			const script: ReadonlyArray<HarnessEvent> = [
				{ type: 'assistant.message', text: 'hello' },
				{ type: 'assistant.message', text: 'world' },
				{ type: 'tool.start', id: 'r1', name: 'Read', input: { file_path: '/tmp/x' } },
				{ type: 'tool.end', id: 'r1', ok: true, output: 'line1\nline2\nline3' },
				{ type: 'tool.start', id: 'b1', name: 'Bash', input: { command: 'ls' } },
				{
					type: 'tool.end',
					id: 'b1',
					ok: false,
					output: { stdout: 'a\nb\n', stderr: '', exit_code: 0 },
				},
				{
					type: 'result',
					ok: true,
					costUsd: 0.05,
					durationMs: 100,
					tokens: { input: 10, output: 20, cacheRead: 5, cacheCreate: 1 },
					model: 'claude-sonnet-4-6',
				},
			];

			const { layer } = makeTestRig({
				harnesses: [cycledHarness('claude-code', [{ events: script }])],
				stepFiles: new Map([['./steps/only.md', '---\nname: only\n---\nDo it.']]),
			});

			yield* runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code' },
				[{ kind: 'step', id: 'only', source: './steps/only.md', options: {} }],
				{ prd: 'inline PRD text', cwd: process.cwd() },
			).pipe(Effect.provide(layer));

			const spans = yield* getFinishedSpans();
			const iter = spans.find((s) => s.name === 'factory.iter only#1');
			assertTrue(iter !== undefined);

			deepStrictEqual(iter.attributes['factory.iter.assistant.message.count'], 2);
			deepStrictEqual(iter.attributes['factory.iter.tool.calls'], 2);
			deepStrictEqual(iter.attributes['factory.iter.tool.calls_failed'], 1);
			deepStrictEqual(iter.attributes['factory.iter.tool.calls_cancelled'], 0);
			deepStrictEqual(iter.attributes['factory.iter.exit.reason'], 'assistant_end');
			strictEqual(typeof iter.attributes['factory.iter.bytes.stdout'], 'number');

			deepStrictEqual(iter.attributes['factory.iter.tokens.input'], 10);
			deepStrictEqual(iter.attributes['factory.iter.tokens.output'], 20);
			deepStrictEqual(iter.attributes['gen_ai.system'], 'claude-code');
			deepStrictEqual(iter.attributes['gen_ai.request.model'], 'claude-sonnet-4-6');
			deepStrictEqual(iter.attributes['gen_ai.usage.input_tokens'], 10);
			deepStrictEqual(iter.attributes['gen_ai.usage.output_tokens'], 20);
			deepStrictEqual(iter.attributes['gen_ai.usage.cache_read_input_tokens'], 5);
			deepStrictEqual(iter.attributes['gen_ai.usage.cache_creation_input_tokens'], 1);
			const finishReasons = iter.attributes['gen_ai.response.finish_reasons'];
			assertTrue(typeof finishReasons === 'string' && finishReasons.includes('stop'));

			// Failed tool call drives the iter span to Status=Error even though
			// the harness `result` is `ok: true` and exit code is 0.
			strictEqual(iter.status.code, 2);

			const bash = spans.find((s) => s.attributes['tool.name'] === 'Bash');
			assertTrue(bash !== undefined);
			deepStrictEqual(bash.attributes['tool.exit_code'], 0);
			strictEqual(typeof bash.attributes['tool.stdout.bytes'], 'number');
			strictEqual(typeof bash.attributes['tool.stderr.bytes'], 'number');

			const read = spans.find((s) => s.attributes['tool.name'] === 'Read');
			assertTrue(read !== undefined);
			deepStrictEqual(read.attributes['tool.file.lines'], 3);
			strictEqual(typeof read.attributes['tool.file.bytes'], 'number');

			const eventNames = new Set(iter.events.map((e) => e.name));
			assertTrue(eventNames.has('assistant.message'));
			assertTrue(eventNames.has('tool.start'));
			assertTrue(eventNames.has('tool.end'));
		}).pipe(Effect.provide(OtelTestLayer)),
	);
});
