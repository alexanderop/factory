import { FileSystem } from '@effect/platform';
import { NodeContext } from '@effect/platform-node';
import { describe, it } from '@effect/vitest';
import { assertTrue, deepStrictEqual, strictEqual } from '@effect/vitest/utils';
import { Effect, Schema } from 'effect';
import { HarnessExecError, MissingHarnessError } from '../errors.ts';
import { readAgent } from '../services/runManifest.ts';
import { makeRunId } from '../testing/factories.ts';
import {
	assertExitFailedWith,
	capturingScripted,
	cycledHarness,
	silentHarness,
} from '../testing/index.ts';
import { makeWorkflowRig } from '../testing/workflowRig.ts';
import type { FactoryEvent } from '../types.ts';
import { makeAgent } from './agent.ts';

const PlanSchema = Schema.Struct({ title: Schema.String, steps: Schema.Array(Schema.String) });

describe('agent()', () => {
	it.scoped('no-schema agent returns the LAST assistant message text', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const tmp = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-agent-' });
			const runId = makeRunId('agent-text');
			const harness = cycledHarness('claude-code', [
				{
					events: [
						{ type: 'assistant.message', text: 'first' },
						{ type: 'assistant.message', text: 'last' },
					],
				},
			]);
			const { layer, events } = makeWorkflowRig({
				harnesses: [harness],
				runId,
				runDir: `${tmp}/.factory/runs/${runId}`,
				cwd: tmp,
				defaultHarness: 'claude-code',
				defaultPermissions: 'skip',
			});
			const agent = makeAgent({ name: 'wf', harness: 'claude-code' });

			const result = yield* agent('do the thing', { label: 'writer' }).pipe(Effect.provide(layer));
			strictEqual(result, 'last');

			const captured = yield* events;
			const types = captured.map((e) => e.type);
			assertTrue(types.includes('agent.start'));
			const end = captured.find(
				(e): e is Extract<FactoryEvent, { type: 'agent.end' }> => e.type === 'agent.end',
			);
			assertTrue(end?.ok === true);

			const parsed = yield* readAgent(`${tmp}/.factory/runs/${runId}/agents/000-writer/agent.json`);
			strictEqual(parsed.status, 'ok');
			strictEqual(parsed.label, 'writer');
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('no-schema agent returns empty string when the harness emits no message', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const tmp = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-agent-' });
			const runId = makeRunId('agent-empty');
			const { layer } = makeWorkflowRig({
				harnesses: [silentHarness('claude-code')],
				runId,
				runDir: `${tmp}/.factory/runs/${runId}`,
				cwd: tmp,
				defaultHarness: 'claude-code',
				defaultPermissions: 'skip',
			});
			const agent = makeAgent({ name: 'wf', harness: 'claude-code' });
			const result = yield* agent('nothing').pipe(Effect.provide(layer));
			strictEqual(result, '');
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('schema agent decodes $FACTORY_STEP_OUTPUT into a typed value', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const tmp = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-agent-' });
			const runId = makeRunId('agent-schema');
			const value = { title: 'Plan', steps: ['a', 'b'] };
			const { harness, calls } = capturingScripted('claude-code', [
				{
					stdout: 'done\n',
					writes: [
						{ path: `agents/000-planner/iters/001/output.json`, content: JSON.stringify(value) },
					],
				},
			]);
			const { layer } = makeWorkflowRig({
				harnesses: [harness],
				runId,
				runDir: `${tmp}/.factory/runs/${runId}`,
				cwd: tmp,
				defaultHarness: 'claude-code',
				defaultPermissions: 'skip',
			});
			const agent = makeAgent({ name: 'wf', harness: 'claude-code' });

			const result = yield* agent('make a plan', { schema: PlanSchema, label: 'planner' }).pipe(
				Effect.provide(layer),
			);
			deepStrictEqual(result, value);

			const captured = yield* calls;
			const call = captured[0];
			if (call === undefined) throw new Error('harness was not called');
			// FACTORY_STEP_OUTPUT only present in the schema case.
			assertTrue(call.env?.FACTORY_STEP_OUTPUT !== undefined);
			strictEqual(call.permissions, 'skip');
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('no-schema call does NOT set FACTORY_STEP_OUTPUT', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const tmp = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-agent-' });
			const runId = makeRunId('agent-no-output');
			const { harness, calls } = capturingScripted('claude-code', [{ stdout: 'ok\n' }]);
			const { layer } = makeWorkflowRig({
				harnesses: [harness],
				runId,
				runDir: `${tmp}/.factory/runs/${runId}`,
				cwd: tmp,
				defaultHarness: 'claude-code',
				defaultPermissions: 'skip',
			});
			const agent = makeAgent({ name: 'wf', harness: 'claude-code' });
			yield* agent('plain').pipe(Effect.provide(layer));
			const captured = yield* calls;
			strictEqual(captured[0]?.env?.FACTORY_STEP_OUTPUT, undefined);
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('missing harness surfaces as a typed MissingHarnessError', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const tmp = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-agent-' });
			const runId = makeRunId('agent-no-harness');
			const { layer } = makeWorkflowRig({
				harnesses: [silentHarness('claude-code')],
				runId,
				runDir: `${tmp}/.factory/runs/${runId}`,
				cwd: tmp,
			});
			// no defaultHarness on factory or ctx → MissingHarnessError
			const agent = makeAgent({ name: 'wf' });
			const exit = yield* agent('x').pipe(Effect.provide(layer), Effect.exit);
			assertExitFailedWith(exit, MissingHarnessError);
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('a non-zero harness exit surfaces as HarnessExecError and records status failed', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const tmp = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-agent-' });
			const runId = makeRunId('agent-fail');
			const harness = cycledHarness('claude-code', [{ exitCode: 1, stderr: 'boom\n' }]);
			const { layer } = makeWorkflowRig({
				harnesses: [harness],
				runId,
				runDir: `${tmp}/.factory/runs/${runId}`,
				cwd: tmp,
				defaultHarness: 'claude-code',
				defaultPermissions: 'skip',
			});
			const agent = makeAgent({ name: 'wf', harness: 'claude-code' });
			const exit = yield* agent('fail', { label: 'breaker' }).pipe(
				Effect.provide(layer),
				Effect.exit,
			);
			assertExitFailedWith(exit, HarnessExecError);

			const parsed = yield* readAgent(
				`${tmp}/.factory/runs/${runId}/agents/000-breaker/agent.json`,
			);
			strictEqual(parsed.status, 'failed');
		}).pipe(Effect.provide(NodeContext.layer)),
	);
});
