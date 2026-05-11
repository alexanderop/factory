import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { Effect, Stream } from 'effect';
import type { HarnessCapabilities } from '../capabilities.ts';
import { HarnessExecError } from '../errors.ts';
import { HarnessName } from '../ids.ts';
import type { ExecOpts, ExecResult, Harness, HarnessEvent, PermissionMode } from '../types.ts';

export interface ScriptedWrite {
	/** Path to write. Relative paths are resolved against `env.FACTORY_RUN_DIR`
	 *  (preferred) or `opts.cwd` if no run dir is set. */
	readonly path: string;
	readonly content: string;
}

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
	/**
	 * Files to materialise on disk before the response's `exit` event. Mirrors
	 * the way real harnesses leave artifacts under `FACTORY_RUN_DIR` (e.g. a
	 * plan step writing `plan.md`, a review role writing `findings.json`).
	 */
	readonly writes?: ReadonlyArray<ScriptedWrite>;
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

export type ScriptedResponder = (opts: ExecOpts) => ScriptedResponse;

/**
 * Test double for `Harness`. Either:
 *  - Cycles through `responses` on each `exec`/`stream` call (positional).
 *  - Or routes each call through a `responder` function that picks a response
 *    based on `ExecOpts` — use this when tests fan out concurrently and the
 *    call order is non-deterministic.
 */
export const scriptedHarness = <Name extends string>(
	name: Name,
	responses: ReadonlyArray<ScriptedResponse> | ScriptedResponder,
	options: ScriptedHarnessOptions = {},
): Harness<Name> => {
	let cursor = 0;
	const next = (opts: ExecOpts): ScriptedResponse => {
		if (typeof responses === 'function') return responses(opts);
		const r = responses[cursor % Math.max(responses.length, 1)] ?? {};
		cursor++;
		return r;
	};

	const capabilities = options.capabilities ?? defaultCapabilities(options.supports ?? ALL_MODES);

	const resolveWritePath = (write: ScriptedWrite, opts: ExecOpts): string => {
		if (isAbsolute(write.path)) return write.path;
		const base = opts.env?.FACTORY_RUN_DIR ?? opts.cwd ?? process.cwd();
		return join(base, write.path);
	};

	const materialiseWrites = (writes: ReadonlyArray<ScriptedWrite>, opts: ExecOpts) =>
		Effect.promise(() =>
			Promise.all(
				writes.map(async (w) => {
					const resolved = resolveWritePath(w, opts);
					await mkdir(dirname(resolved), { recursive: true });
					await writeFile(resolved, w.content);
				}),
			),
		);

	return {
		name,
		capabilities,
		defaultPermissions: options.defaultPermissions,
		exec: (opts: ExecOpts) =>
			Effect.gen(function* () {
				options.onCall?.(opts);
				const r = next(opts);
				if (r.writes && r.writes.length > 0) yield* materialiseWrites(r.writes, opts);
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
			const r = next(opts);
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
			const eventStream = Stream.fromIterable(events);
			return r.writes && r.writes.length > 0
				? Stream.fromEffect(materialiseWrites(r.writes, opts)).pipe(
						Stream.flatMap(() => eventStream),
					)
				: eventStream;
		},
	};
};
