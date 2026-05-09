import { NodeContext } from '@effect/platform-node';
import { describe, it } from '@effect/vitest';
import { assertTrue, deepStrictEqual, strictEqual } from '@effect/vitest/utils';
import { Effect, Layer, Ref } from 'effect';
import { runFactoryEffect } from './orchestrator.ts';
import { RunId } from './ids.ts';
import { InMemoryRunWorkspace } from './services/RunWorkspace.ts';
import {
	type DisplayEntry,
	getFinishedSpans,
	harnessRegistryLayer,
	InMemoryStepLoader,
	OtelTestLayer,
	recordingEventEmitter,
	scriptedHarness,
	scriptedUntilEvaluator,
	SilentDisplay,
} from './testing/index.ts';
import type { FactoryEvent, HarnessEvent } from './types.ts';

const toolScript: ReadonlyArray<HarnessEvent> = [
	{ type: 'assistant.message', text: 'I will read the file then ls.' },
	{ type: 'tool.start', id: 't1', name: 'Read', input: { file_path: '/tmp/x' } },
	{ type: 'tool.end', id: 't1', ok: true, output: 'file body' },
	{ type: 'tool.start', id: 't2', name: 'Bash', input: { command: 'ls' } },
	{ type: 'tool.end', id: 't2', ok: true, output: 'a\nb\n' },
	{ type: 'assistant.message', text: 'done' },
	{
		type: 'result',
		ok: true,
		costUsd: 0.0123,
		durationMs: 456,
		tokens: { input: 100, output: 50 },
		model: 'claude-sonnet-4-6',
	},
];

describe('tool-call telemetry', () => {
	it.effect('emits one factory.harness.tool span per tool call with structural attrs', () =>
		Effect.gen(function* () {
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
			const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);

			const layer = Layer.mergeAll(
				SilentDisplay.layer(displayRef),
				recordingEventEmitter.layer(eventsRef),
				harnessRegistryLayer([scriptedHarness('claude-code', [{ events: toolScript }])]),
				InMemoryStepLoader.layer(new Map([['./steps/only.md', '---\nname: only\n---\nDo it.']])),
				scriptedUntilEvaluator.layer([true]),
				InMemoryRunWorkspace.layer({ runId: RunId.make('test-run') }),
			).pipe(Layer.provideMerge(NodeContext.layer));

			yield* runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code' },
				[{ id: 'only', source: './steps/only.md', options: {} }],
				{ prd: 'inline PRD text', cwd: process.cwd() },
			).pipe(Effect.provide(layer));

			const spans = yield* getFinishedSpans();
			const toolSpans = spans.filter((s) => s.name === 'factory.harness.tool');
			strictEqual(toolSpans.length, 2);

			const readSpan = toolSpans.find((s) => s.attributes['tool.name'] === 'Read');
			assertTrue(readSpan !== undefined);
			deepStrictEqual(readSpan.attributes['tool.id'], 't1');
			deepStrictEqual(readSpan.attributes['tool.file_path'], '/tmp/x');
			deepStrictEqual(readSpan.attributes['tool.ok'], true);

			const bashSpan = toolSpans.find((s) => s.attributes['tool.name'] === 'Bash');
			assertTrue(bashSpan !== undefined);
			deepStrictEqual(bashSpan.attributes['tool.cmd.head'], 'ls');
		}).pipe(Effect.provide(OtelTestLayer)),
	);

	it.effect('emits FactoryEvents for tool.start, tool.end, assistant.message, iter.result', () =>
		Effect.gen(function* () {
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
			const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);

			const layer = Layer.mergeAll(
				SilentDisplay.layer(displayRef),
				recordingEventEmitter.layer(eventsRef),
				harnessRegistryLayer([scriptedHarness('claude-code', [{ events: toolScript }])]),
				InMemoryStepLoader.layer(new Map([['./steps/only.md', '---\nname: only\n---\nDo it.']])),
				scriptedUntilEvaluator.layer([true]),
				InMemoryRunWorkspace.layer({ runId: RunId.make('test-run') }),
			).pipe(Layer.provideMerge(NodeContext.layer));

			yield* runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code' },
				[{ id: 'only', source: './steps/only.md', options: {} }],
				{ prd: 'inline PRD text', cwd: process.cwd() },
			).pipe(Effect.provide(layer));

			const events = yield* Ref.get(eventsRef);

			const toolStarts = events.filter((e) => e.type === 'tool.start');
			strictEqual(toolStarts.length, 2);

			const toolEnds = events.filter((e) => e.type === 'tool.end');
			strictEqual(toolEnds.length, 2);

			const assistantMessages = events.filter((e) => e.type === 'assistant.message');
			strictEqual(assistantMessages.length, 2);

			const iterResults = events.filter(
				(e): e is Extract<FactoryEvent, { type: 'iter.result' }> => e.type === 'iter.result',
			);
			strictEqual(iterResults.length, 1);
			const [result] = iterResults;
			assertTrue(result !== undefined);
			deepStrictEqual(result.costUsd, 0.0123);
			deepStrictEqual(result.tokens?.input, 100);
			deepStrictEqual(result.model, 'claude-sonnet-4-6');
		}).pipe(Effect.provide(OtelTestLayer)),
	);

	it.effect('annotates iter span with cost, tokens, model from result event', () =>
		Effect.gen(function* () {
			const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
			const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);

			const layer = Layer.mergeAll(
				SilentDisplay.layer(displayRef),
				recordingEventEmitter.layer(eventsRef),
				harnessRegistryLayer([scriptedHarness('claude-code', [{ events: toolScript }])]),
				InMemoryStepLoader.layer(new Map([['./steps/only.md', '---\nname: only\n---\nDo it.']])),
				scriptedUntilEvaluator.layer([true]),
				InMemoryRunWorkspace.layer({ runId: RunId.make('test-run') }),
			).pipe(Layer.provideMerge(NodeContext.layer));

			yield* runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code' },
				[{ id: 'only', source: './steps/only.md', options: {} }],
				{ prd: 'inline PRD text', cwd: process.cwd() },
			).pipe(Effect.provide(layer));

			const spans = yield* getFinishedSpans();
			const iter = spans.find((s) => s.name === 'factory.iter');
			assertTrue(iter !== undefined);
			deepStrictEqual(iter.attributes['factory.iter.cost_usd'], 0.0123);
			deepStrictEqual(iter.attributes['factory.iter.tokens.input'], 100);
			deepStrictEqual(iter.attributes['factory.iter.tokens.output'], 50);
			deepStrictEqual(iter.attributes['factory.iter.model'], 'claude-sonnet-4-6');
		}).pipe(Effect.provide(OtelTestLayer)),
	);
});
