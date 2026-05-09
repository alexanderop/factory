import { Effect, Stream } from 'effect';
import { HarnessExecError } from '../errors.ts';
import { HarnessName } from '../ids.ts';
import type { ExecOpts, ExecResult, Harness, HarnessEvent } from '../types.ts';

export interface ScriptedResponse {
	readonly stdout?: string;
	readonly stderr?: string;
	readonly exitCode?: number;
	readonly events?: ReadonlyArray<HarnessEvent>;
}

/**
 * Test double for `Harness`. Cycles through `responses` on each `exec`/`stream`
 * call. Use via `harnessRegistryLayer([scriptedHarness('claude-code', [...])])`.
 *
 * Supports synthetic `tool_use`/`tool_result` events via the `events` field —
 * these are emitted after stdout/stderr lines (before the exit event).
 */
export const scriptedHarness = <Name extends string>(
	name: Name,
	responses: ReadonlyArray<ScriptedResponse>,
): Harness<Name> => {
	let cursor = 0;
	const next = (): ScriptedResponse => {
		const r = responses[cursor % Math.max(responses.length, 1)] ?? {};
		cursor++;
		return r;
	};

	return {
		name,
		exec: (_opts: ExecOpts) =>
			Effect.gen(function* () {
				const r = next();
				const result: ExecResult = {
					exitCode: r.exitCode ?? 0,
					stdout: r.stdout ?? '',
					stderr: r.stderr ?? '',
				};
				if (result.exitCode !== 0) {
					return yield* Effect.fail(
						new HarnessExecError({
							message: `scripted harness '${name}' returned exit code ${result.exitCode}`,
							harness: HarnessName.make(name),
							exitCode: result.exitCode,
							stderr: result.stderr,
						}),
					);
				}
				return result;
			}),
		stream: (_opts: ExecOpts) => {
			const r = next();
			const events: HarnessEvent[] = [];
			if (r.stdout) {
				for (const line of r.stdout.split('\n')) {
					if (line) events.push({ type: 'stdout', line });
				}
			}
			if (r.stderr) {
				for (const line of r.stderr.split('\n')) {
					if (line) events.push({ type: 'stderr', line });
				}
			}
			if (r.events) {
				for (const event of r.events) {
					events.push(event);
				}
			}
			events.push({ type: 'exit', code: r.exitCode ?? 0 });
			return Stream.fromIterable(events);
		},
	};
};
