import { FileSystem } from '@effect/platform';
import { NodeContext } from '@effect/platform-node';
import { describe, it } from '@effect/vitest';
import { assertTrue, deepStrictEqual, strictEqual } from '@effect/vitest/utils';
import { Effect } from 'effect';
import { BudgetExhaustedError } from '../errors.ts';
import { makeRunId } from '../testing/factories.ts';
import { assertExitFailedWith, routedHarness } from '../testing/index.ts';
import { makeWorkflowRig } from '../testing/workflowRig.ts';
import { makeAgent } from './agent.ts';
import { parallel } from './combinators.ts';

describe('parallel()', () => {
	it.scoped('a failing agent becomes null; the batch does not fail', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const tmp = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-par-' });
			const runId = makeRunId('par-fail');
			// Route by label embedded in the prompt: the 'bad' agent exits non-zero.
			const harness = routedHarness('claude-code', (opts) =>
				opts.prompt.includes('bad')
					? { exitCode: 1, stderr: 'boom\n' }
					: { events: [{ type: 'assistant.message', text: opts.prompt }] },
			);
			const { layer } = makeWorkflowRig({
				harnesses: [harness],
				runId,
				runDir: `${tmp}/.factory/runs/${runId}`,
				cwd: tmp,
				defaultHarness: 'claude-code',
				defaultPermissions: 'skip',
			});
			const agent = makeAgent({ name: 'wf', harness: 'claude-code' });

			const results = yield* parallel([
				() => agent('good-1', { label: 'a' }),
				() => agent('bad', { label: 'b' }),
				() => agent('good-2', { label: 'c' }),
			]).pipe(Effect.provide(layer));

			strictEqual(results.length, 3);
			// failure → null; the two successes return their prompt text.
			const kept = results.filter((r): r is string => typeof r === 'string');
			deepStrictEqual(kept.toSorted(), ['good-1', 'good-2']);
			assertTrue(results.includes(null));
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('an exhausted budget fails the next agent with BudgetExhaustedError', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const tmp = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-budget-' });
			const runId = makeRunId('budget');
			// First agent reports 100 output tokens via a result event, blowing the
			// budget of 10 so the SECOND agent refuses to start.
			const harness = routedHarness('claude-code', () => ({
				events: [
					{ type: 'assistant.message', text: 'hi' },
					{ type: 'result', ok: true, durationMs: 1, tokens: { input: 0, output: 100 } },
				],
			}));
			const { layer } = makeWorkflowRig({
				harnesses: [harness],
				runId,
				runDir: `${tmp}/.factory/runs/${runId}`,
				cwd: tmp,
				defaultHarness: 'claude-code',
				defaultPermissions: 'skip',
				budget: 10,
			});
			const agent = makeAgent({ name: 'wf', harness: 'claude-code' });

			const exit = yield* Effect.gen(function* () {
				yield* agent('first', { label: 'first' });
				yield* agent('second', { label: 'second' });
			}).pipe(Effect.provide(layer), Effect.exit);

			assertExitFailedWith(exit, BudgetExhaustedError);
		}).pipe(Effect.provide(NodeContext.layer)),
	);
});
