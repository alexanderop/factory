import { describe, it } from '@effect/vitest';
import { assertTrue, deepStrictEqual, strictEqual } from '@effect/vitest/utils';
import { Effect } from 'effect';
import { runFactoryEffect } from './orchestrator.ts';
import { cycledHarness, getFinishedSpans, makeTestRig, OtelTestLayer } from './testing/index.ts';
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
	it.effect('forwards rich tool events into spans + factory events', () =>
		Effect.gen(function* () {
			const { layer, events } = makeTestRig({
				harnesses: [cycledHarness('claude-code', [{ events: toolScript }])],
				stepFiles: new Map([['./steps/only.md', '---\nname: only\n---\nDo it.']]),
			});

			yield* runFactoryEffect(
				{ name: 'sdd', harness: 'claude-code' },
				[{ kind: 'step', id: 'only', source: './steps/only.md', options: {} }],
				{ prd: 'inline PRD text', cwd: process.cwd() },
			).pipe(Effect.provide(layer));

			const spans = yield* getFinishedSpans();

			const toolSpans = spans.filter((s) => s.name.startsWith('factory.harness.tool '));
			strictEqual(toolSpans.length, 2);

			const readSpan = toolSpans.find((s) => s.attributes['tool.name'] === 'Read');
			assertTrue(readSpan !== undefined);
			strictEqual(readSpan.name, 'factory.harness.tool Read');
			deepStrictEqual(readSpan.attributes['tool.id'], 't1');
			deepStrictEqual(readSpan.attributes['tool.file_path'], '/tmp/x');
			deepStrictEqual(readSpan.attributes['tool.ok'], true);

			const bashSpan = toolSpans.find((s) => s.attributes['tool.name'] === 'Bash');
			assertTrue(bashSpan !== undefined);
			strictEqual(bashSpan.name, 'factory.harness.tool Bash');
			deepStrictEqual(bashSpan.attributes['tool.cmd.head'], 'ls');

			const iter = spans.find((s) => s.name === 'factory.iter only#1');
			assertTrue(iter !== undefined);
			deepStrictEqual(iter.attributes['factory.iter.cost_usd'], 0.0123);
			deepStrictEqual(iter.attributes['factory.iter.tokens.input'], 100);
			deepStrictEqual(iter.attributes['factory.iter.tokens.output'], 50);
			deepStrictEqual(iter.attributes['factory.iter.model'], 'claude-sonnet-4-6');

			const captured = yield* events;

			const toolStarts = captured.filter((e) => e.type === 'tool.start');
			strictEqual(toolStarts.length, 2);

			const toolEnds = captured.filter((e) => e.type === 'tool.end');
			strictEqual(toolEnds.length, 2);

			const assistantMessages = captured.filter((e) => e.type === 'assistant.message');
			strictEqual(assistantMessages.length, 2);

			const iterResults = captured.filter(
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
});
