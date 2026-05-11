import { describe, it } from '@effect/vitest';
import { assertTrue, deepStrictEqual, strictEqual } from '@effect/vitest/utils';
import { Effect, Ref } from 'effect';
import { runFactoryEffect } from './orchestrator.ts';
import {
	type DisplayEntry,
	getFinishedSpans,
	makeTestLayer,
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

	it.effect('Phase A: enriches iter span with stream counters and exit reason', () =>
		Effect.gen(function* () {
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
			const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);

			const script: ReadonlyArray<HarnessEvent> = [
				{ type: 'assistant.message', text: 'hello' },
				{ type: 'assistant.message', text: 'world' },
				{ type: 'tool.start', id: 't1', name: 'Read', input: { file_path: '/tmp/a' } },
				{ type: 'tool.end', id: 't1', ok: true, output: 'ok' },
				{ type: 'tool.start', id: 't2', name: 'Bash', input: { command: 'ls' } },
				{ type: 'tool.end', id: 't2', ok: false, output: 'bad' },
				{
					type: 'result',
					ok: true,
					durationMs: 1,
					tokens: { input: 1, output: 1 },
					model: 'm',
				},
			];

			const layer = makeTestLayer({
				displayRef,
				eventsRef,
				harnesses: [scriptedHarness('claude-code', [{ events: script }])],
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
			assertTrue(typeof iter.attributes['factory.iter.bytes.stdout'] === 'number');
		}).pipe(Effect.provide(OtelTestLayer)),
	);

	it.effect('Phase B: iter span carries both factory.iter.* and gen_ai.* keys', () =>
		Effect.gen(function* () {
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
			const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);

			const script: ReadonlyArray<HarnessEvent> = [
				{ type: 'assistant.message', text: 'hi' },
				{
					type: 'result',
					ok: true,
					costUsd: 0.05,
					durationMs: 100,
					tokens: { input: 10, output: 20, cacheRead: 5, cacheCreate: 1 },
					model: 'claude-sonnet-4-6',
				},
			];

			const layer = makeTestLayer({
				displayRef,
				eventsRef,
				harnesses: [scriptedHarness('claude-code', [{ events: script }])],
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
			deepStrictEqual(iter.attributes['factory.iter.tokens.input'], 10);
			deepStrictEqual(iter.attributes['factory.iter.tokens.output'], 20);
			deepStrictEqual(iter.attributes['gen_ai.system'], 'claude-code');
			deepStrictEqual(iter.attributes['gen_ai.request.model'], 'claude-sonnet-4-6');
			deepStrictEqual(iter.attributes['gen_ai.usage.input_tokens'], 10);
			deepStrictEqual(iter.attributes['gen_ai.usage.output_tokens'], 20);
			deepStrictEqual(iter.attributes['gen_ai.usage.cache_read_input_tokens'], 5);
			deepStrictEqual(iter.attributes['gen_ai.usage.cache_creation_input_tokens'], 1);
			assertTrue(
				typeof iter.attributes['gen_ai.response.finish_reasons'] === 'string' &&
					iter.attributes['gen_ai.response.finish_reasons'].includes('stop'),
			);
		}).pipe(Effect.provide(OtelTestLayer)),
	);

	it.effect('Phase C: tool spans carry per-tool output attributes', () =>
		Effect.gen(function* () {
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
			const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);

			const script: ReadonlyArray<HarnessEvent> = [
				{ type: 'tool.start', id: 'b1', name: 'Bash', input: { command: 'ls' } },
				{
					type: 'tool.end',
					id: 'b1',
					ok: true,
					output: { stdout: 'a\nb\n', stderr: '', exit_code: 0 },
				},
				{ type: 'tool.start', id: 'r1', name: 'Read', input: { file_path: '/tmp/x' } },
				{ type: 'tool.end', id: 'r1', ok: true, output: 'line1\nline2\nline3' },
				{
					type: 'result',
					ok: true,
					durationMs: 1,
					tokens: { input: 1, output: 1 },
					model: 'm',
				},
			];

			const layer = makeTestLayer({
				displayRef,
				eventsRef,
				harnesses: [scriptedHarness('claude-code', [{ events: script }])],
				stepFiles: new Map([['./steps/only.md', '---\nname: only\n---\nDo it.']]),
			});

			yield* runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code' },
				[{ kind: 'step', id: 'only', source: './steps/only.md', options: {} }],
				{ prd: 'inline PRD text', cwd: process.cwd() },
			).pipe(Effect.provide(layer));

			const spans = yield* getFinishedSpans();
			const bash = spans.find((s) => s.attributes['tool.name'] === 'Bash');
			assertTrue(bash !== undefined);
			deepStrictEqual(bash.attributes['tool.exit_code'], 0);
			strictEqual(typeof bash.attributes['tool.stdout.bytes'], 'number');
			strictEqual(typeof bash.attributes['tool.stderr.bytes'], 'number');

			const read = spans.find((s) => s.attributes['tool.name'] === 'Read');
			assertTrue(read !== undefined);
			deepStrictEqual(read.attributes['tool.file.lines'], 3);
			strictEqual(typeof read.attributes['tool.file.bytes'], 'number');
		}).pipe(Effect.provide(OtelTestLayer)),
	);

	it.effect('Phase E: iter span Status=Error when a non-cancelled tool fails', () =>
		Effect.gen(function* () {
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
			const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);

			const script: ReadonlyArray<HarnessEvent> = [
				{ type: 'tool.start', id: 't1', name: 'Bash', input: { command: 'false' } },
				{ type: 'tool.end', id: 't1', ok: false, output: 'boom' },
				{
					type: 'result',
					ok: true,
					durationMs: 1,
					tokens: { input: 1, output: 1 },
					model: 'm',
				},
			];

			const layer = makeTestLayer({
				displayRef,
				eventsRef,
				harnesses: [scriptedHarness('claude-code', [{ events: script }])],
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
			strictEqual(iter.status.code, 2);
			deepStrictEqual(iter.attributes['factory.iter.tool.calls_failed'], 1);
		}).pipe(Effect.provide(OtelTestLayer)),
	);

	it.effect('Phase F: iter span carries assistant.message and tool.* events', () =>
		Effect.gen(function* () {
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
			const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);

			const script: ReadonlyArray<HarnessEvent> = [
				{ type: 'assistant.message', text: 'one' },
				{ type: 'tool.start', id: 't1', name: 'Read', input: { file_path: '/x' } },
				{ type: 'tool.end', id: 't1', ok: true, output: 'ok' },
				{
					type: 'result',
					ok: true,
					durationMs: 1,
					tokens: { input: 1, output: 1 },
					model: 'm',
				},
			];

			const layer = makeTestLayer({
				displayRef,
				eventsRef,
				harnesses: [scriptedHarness('claude-code', [{ events: script }])],
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
			const eventNames = new Set(iter.events.map((e) => e.name));
			assertTrue(eventNames.has('assistant.message'));
			assertTrue(eventNames.has('tool.start'));
			assertTrue(eventNames.has('tool.end'));
		}).pipe(Effect.provide(OtelTestLayer)),
	);
});
