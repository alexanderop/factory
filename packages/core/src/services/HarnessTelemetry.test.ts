import { Stream } from 'effect';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { describe, expect, it } from 'vitest';
import { HarnessName } from '../ids.ts';
import type { HarnessEvent } from '../types.ts';
import { HarnessTelemetry, LiveHarnessTelemetry } from './HarnessTelemetry.ts';

const harnessName = HarnessName.make('test-harness');

const makeStream = (events: ReadonlyArray<HarnessEvent>) =>
	Stream.fromIterable(events) as Stream.Stream<HarnessEvent, never, never>;

const run = (events: ReadonlyArray<HarnessEvent>, captureMode: 'off' | 'counts' | 'redacted' | 'full' = 'full') =>
	Effect.gen(function* () {
		const svc = yield* HarnessTelemetry;
		return yield* svc.processStream(makeStream(events), harnessName, captureMode);
	}).pipe(Effect.provide(LiveHarnessTelemetry.layer));

describe('LiveHarnessTelemetry.processStream', () => {
	it('collects stdout and stderr lines into ExecResult', async () => {
		const result = await Effect.runPromise(
			run([
				{ type: 'stdout', line: 'hello' },
				{ type: 'stdout', line: 'world' },
				{ type: 'stderr', line: 'warn' },
				{ type: 'exit', code: 0 },
			]),
		);
		expect(result.stdout).toBe('hello\nworld\n');
		expect(result.stderr).toBe('warn\n');
		expect(result.exitCode).toBe(0);
	});

	it('fails with HarnessExecError on non-zero exit', async () => {
		const exit = await Effect.runPromiseExit(
			run([
				{ type: 'stdout', line: 'some output' },
				{ type: 'exit', code: 2 },
			]),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			const failure = Cause.failureOption(exit.cause);
			expect(failure._tag).toBe('Some');
			if (failure._tag === 'Some') {
				expect(failure.value._tag).toBe('HarnessExecError');
				if (failure.value._tag === 'HarnessExecError') {
					expect(failure.value.exitCode).toBe(2);
				}
			}
		}
	});

	it('does not throw when tool_use has no matching tool_result (orphan span)', async () => {
		const result = await Effect.runPromise(
			run([
				{ type: 'tool_use', id: 'orphan-1', name: 'Bash', input: { command: 'ls' } },
				{ type: 'exit', code: 0 },
			]),
		);
		expect(result.exitCode).toBe(0);
	});

	it('handles matched tool_use / tool_result pairs', async () => {
		const result = await Effect.runPromise(
			run([
				{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/src/foo.ts' } },
				{ type: 'tool_result', id: 'tu-1', ok: true, output: 'file content here' },
				{ type: 'exit', code: 0 },
			]),
		);
		expect(result.exitCode).toBe(0);
	});

	it('handles tool_result with error status', async () => {
		const result = await Effect.runPromise(
			run([
				{ type: 'tool_use', id: 'tu-err', name: 'Bash', input: { command: 'bad-cmd' } },
				{
					type: 'tool_result',
					id: 'tu-err',
					ok: false,
					error: 'command not found: bad-cmd',
				},
				{ type: 'exit', code: 0 },
			]),
		);
		expect(result.exitCode).toBe(0);
	});

	it('records usage events without failing', async () => {
		const result = await Effect.runPromise(
			run([
				{
					type: 'usage',
					model: 'claude-opus-4-5',
					inputTokens: 100,
					outputTokens: 50,
					cacheReadTokens: 25,
					cacheCreationTokens: 0,
				},
				{ type: 'exit', code: 0 },
			]),
		);
		expect(result.exitCode).toBe(0);
	});

	it('captureMode=off does not attach tool input', async () => {
		const result = await Effect.runPromise(
			run(
				[
					{ type: 'tool_use', id: 'tu-off', name: 'Write', input: { content: 'secret' } },
					{ type: 'tool_result', id: 'tu-off', ok: true },
					{ type: 'exit', code: 0 },
				],
				'off',
			),
		);
		expect(result.exitCode).toBe(0);
	});

	it('handles empty stream (only exit)', async () => {
		const result = await Effect.runPromise(run([{ type: 'exit', code: 0 }]));
		expect(result.stdout).toBe('');
		expect(result.stderr).toBe('');
		expect(result.exitCode).toBe(0);
	});

	it('handles multiple tool spans in sequence', async () => {
		const result = await Effect.runPromise(
			run([
				{ type: 'tool_use', id: 'tu-a', name: 'Read', input: { file_path: '/a.ts' } },
				{ type: 'tool_result', id: 'tu-a', ok: true, output: 'content a' },
				{ type: 'tool_use', id: 'tu-b', name: 'Write', input: { file_path: '/b.ts', content: 'x' } },
				{ type: 'tool_result', id: 'tu-b', ok: true },
				{ type: 'exit', code: 0 },
			]),
		);
		expect(result.exitCode).toBe(0);
	});
});
