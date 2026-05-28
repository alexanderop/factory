import { FileSystem, Path } from '@effect/platform';
import { NodeContext } from '@effect/platform-node';
import { describe, it } from '@effect/vitest';
import { assertTrue, strictEqual } from '@effect/vitest/utils';
import { Effect } from 'effect';
import { factory } from '../factory.ts';
import { readRun } from '../services/runManifest.ts';
import { routedHarness } from '../testing/index.ts';
import type { FactoryEvent } from '../types.ts';

describe('factory().workflow()', () => {
	it.scoped('runs a phase with two parallel agents end-to-end', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const tmp = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-wf-' });
			const captured: FactoryEvent[] = [];

			const harness = routedHarness('claude-code', (opts) => ({
				events: [{ type: 'assistant.message', text: opts.prompt }],
			}));

			const wf = factory({ name: 'demo', harness: 'claude-code', harnesses: [harness] }).workflow(
				'demo',
				({ agent, parallel, phase }) =>
					Effect.gen(function* () {
						yield* phase('classify');
						yield* parallel([
							() => agent('review a', { label: 'review-a', permissions: 'skip' }),
							() => agent('review b', { label: 'review-b', permissions: 'skip' }),
						]);
					}),
			);

			yield* wf
				.runEffect({
					cwd: tmp,
					otel: false,
					onStep: (e) => {
						captured.push(e);
					},
				})
				.pipe(Effect.provide(NodeContext.layer));

			const types = captured.map((e) => e.type);
			strictEqual(types[0], 'run.start');
			assertTrue(types.includes('phase.start'));
			strictEqual(types.filter((t) => t === 'agent.start').length, 2);
			strictEqual(types.filter((t) => t === 'agent.end').length, 2);
			assertTrue(types.includes('run.end'));

			// Two agents/<seq>-<label>/ dirs on disk, run.json status ok.
			const runsDir = path.join(tmp, '.factory', 'runs');
			const runIds = yield* fs.readDirectory(runsDir);
			const runId = runIds.find((n) => n !== 'latest') ?? runIds[0];
			if (runId === undefined) throw new Error('no run directory written');
			const runDir = path.join(runsDir, runId);
			const run = yield* readRun(path.join(runDir, 'run.json'));
			strictEqual(run.status, 'ok');
			const agentDirs = yield* fs.readDirectory(path.join(runDir, 'agents'));
			strictEqual(agentDirs.length, 2);
		}).pipe(Effect.provide(NodeContext.layer)),
	);
});
