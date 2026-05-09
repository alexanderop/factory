import { Effect, Stream } from 'effect';
import type { HarnessCapabilities } from '../capabilities.ts';
import { HarnessExecError } from '../errors.ts';
import { HarnessName } from '../ids.ts';
import type { ExecOpts, ExecResult, Harness, HarnessEvent, PermissionMode } from '../types.ts';

export interface ScriptedResponse {
	readonly stdout?: string;
	readonly stderr?: string;
	readonly exitCode?: number;
	/**
	 * When provided, the harness emits these events in order (followed by an
	 * implicit `exit`). Used for testing tool-call telemetry without parsing
	 * stream-json.
	 */
	readonly events?: ReadonlyArray<HarnessEvent>;
}

export interface ScriptedHarnessOptions {
	readonly supports?: ReadonlyArray<PermissionMode>;
	readonly capabilities?: HarnessCapabilities;
	readonly defaultPermissions?: PermissionMode;
	readonly onCall?: (opts: ExecOpts) => void;
}

const ALL_MODES: ReadonlyArray<PermissionMode> = ['skip', 'accept-edits', 'read-only', 'prompt'];

const defaultCapabilities = (permissions: ReadonlyArray<PermissionMode>): HarnessCapabilities => ({
	loadSession: false,
	mcp: { http: false, sse: false },
	prompt: { image: false, audio: false, embeddedContext: false },
	session: { list: false, resume: false, close: false },
	factory: { permissions, toolEvents: false },
});

/**
 * Test double for `Harness`. Cycles through `responses` on each `exec`/`stream`
 * call. Use via `harnessRegistryLayer([scriptedHarness('claude-code', [...])])`.
 */
export const scriptedHarness = <Name extends string>(
	name: Name,
	responses: ReadonlyArray<ScriptedResponse>,
	options: ScriptedHarnessOptions = {},
): Harness<Name> => {
	let cursor = 0;
	const next = (): ScriptedResponse => {
		const r = responses[cursor % Math.max(responses.length, 1)] ?? {};
		cursor++;
		return r;
	};

	const capabilities = options.capabilities ?? defaultCapabilities(options.supports ?? ALL_MODES);

	return {
		name,
		capabilities,
		defaultPermissions: options.defaultPermissions,
		exec: (opts: ExecOpts) =>
			Effect.gen(function* () {
				options.onCall?.(opts);
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
		stream: (opts: ExecOpts) => {
			options.onCall?.(opts);
			const r = next();
			const events: HarnessEvent[] = [];
			if (r.events) {
				events.push(...r.events);
			} else {
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
			}
			events.push({ type: 'exit', code: r.exitCode ?? 0 });
			return Stream.fromIterable(events);
		},
	};
};
