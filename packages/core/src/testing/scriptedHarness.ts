import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { type Duration, Effect, Stream } from 'effect';
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
	 * stream-json. Craft a custom sequence ending with a non-zero `exit` event
	 * to simulate mid-stream crashes.
	 */
	readonly events?: ReadonlyArray<HarnessEvent>;
	/**
	 * Files to materialise on disk before the response's `exit` event. Mirrors
	 * the way real harnesses leave artifacts under `FACTORY_RUN_DIR` (e.g. a
	 * plan step writing `plan.md`, a review role writing `findings.json`).
	 */
	readonly writes?: ReadonlyArray<ScriptedWrite>;
	/**
	 * Sleep before this response is materialised. Useful for testing
	 * interruption, cancellation, and ordering against concurrent fan-out.
	 */
	readonly delay?: Duration.DurationInput;
}

export interface ScriptedHarnessOptions {
	readonly supports?: ReadonlyArray<PermissionMode>;
	readonly capabilities?: HarnessCapabilities;
	readonly defaultPermissions?: PermissionMode;
	/**
	 * Sync callback fired on every `exec`/`stream` invocation. Use for plain
	 * array pushes / counter increments. The return value is ignored.
	 */
	readonly onCall?: (opts: ExecOpts) => void;
	/**
	 * Effect callback fired on every `exec`/`stream` invocation. Preferred
	 * over `onCall` when capturing into Effect-managed state (e.g. `Ref.update`).
	 * Both callbacks fire if both are provided.
	 */
	readonly onCallEffect?: (opts: ExecOpts) => Effect.Effect<void>;
	/**
	 * What to do when an array of `responses` runs out:
	 *  - `'cycle'` (default): wrap around to the start.
	 *  - `'error'`: throw — surfaces "orchestrator made more calls than scripted".
	 */
	readonly exhaust?: 'cycle' | 'error';
}

export type ScriptedResponder = (opts: ExecOpts) => ScriptedResponse;

const ALL_MODES: ReadonlyArray<PermissionMode> = ['skip', 'accept-edits', 'read-only', 'prompt'];

const defaultCapabilities = (permissions: ReadonlyArray<PermissionMode>): HarnessCapabilities => ({
	loadSession: false,
	mcp: { http: false, sse: false },
	prompt: { image: false, audio: false, embeddedContext: false },
	session: { list: false, resume: false, close: false },
	factory: { permissions, toolEvents: false },
});

const buildEvents = (r: ScriptedResponse): ReadonlyArray<HarnessEvent> => {
	if (r.events) return [...r.events, { type: 'exit', code: r.exitCode ?? 0 }];
	const events: HarnessEvent[] = [];
	if (r.stdout) {
		for (const line of r.stdout.split('\n')) if (line) events.push({ type: 'stdout', line });
	}
	if (r.stderr) {
		for (const line of r.stderr.split('\n')) if (line) events.push({ type: 'stderr', line });
	}
	events.push({ type: 'exit', code: r.exitCode ?? 0 });
	return events;
};

/**
 * Test double for `Harness`. Either:
 *  - Cycles through `responses` on each `exec`/`stream` call (positional).
 *  - Or routes each call through a `responder` function that picks a response
 *    based on `ExecOpts` — use this when tests fan out concurrently and the
 *    call order is non-deterministic.
 *
 * Prefer the intent-named factories below (`cycledHarness`, `routedHarness`,
 * `echoHarness`, `silentHarness`, `flakeyHarness`) so test reads document
 * intent rather than mock shape. This factory remains the underlying builder.
 */
export const scriptedHarness = <Name extends string>(
	name: Name,
	responses: ReadonlyArray<ScriptedResponse> | ScriptedResponder,
	options: ScriptedHarnessOptions = {},
): Harness<Name> => {
	let cursor = 0;
	const exhaust = options.exhaust ?? 'cycle';
	const next = (opts: ExecOpts): ScriptedResponse => {
		if (typeof responses === 'function') return responses(opts);
		if (responses.length === 0) return {};
		if (cursor >= responses.length && exhaust === 'error') {
			throw new Error(
				`scripted harness '${name}' exhausted after ${responses.length} call(s); pass exhaust: 'cycle' to repeat`,
			);
		}
		const r = responses[cursor % responses.length] ?? {};
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

	const runOnCall = (opts: ExecOpts): Effect.Effect<void> => {
		if (options.onCall) options.onCall(opts);
		return options.onCallEffect ? options.onCallEffect(opts) : Effect.void;
	};

	return {
		name,
		capabilities,
		defaultPermissions: options.defaultPermissions,
		exec: (opts: ExecOpts) =>
			Effect.gen(function* () {
				yield* runOnCall(opts);
				const r = next(opts);
				if (r.delay !== undefined) yield* Effect.sleep(r.delay);
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
		stream: (opts: ExecOpts) =>
			Stream.unwrap(
				Effect.gen(function* () {
					yield* runOnCall(opts);
					const r = next(opts);
					if (r.delay !== undefined) yield* Effect.sleep(r.delay);
					if (r.writes && r.writes.length > 0) yield* materialiseWrites(r.writes, opts);
					return Stream.fromIterable(buildEvents(r));
				}),
			),
	};
};

// ---------- Intent-named factories ----------

/**
 * Cycle through a fixed list of responses on each call. Use when the test
 * exercises N sequential turns of the orchestrator and the call order is
 * deterministic.
 *
 *   cycledHarness('claude-code', [{ stdout: 'plan\n' }, { stdout: 'iter-1\n' }])
 */
export const cycledHarness = <Name extends string>(
	name: Name,
	responses: ReadonlyArray<ScriptedResponse>,
	options: ScriptedHarnessOptions = {},
): Harness<Name> => scriptedHarness(name, responses, options);

/**
 * Route each call through a responder function. Use when the test fans out
 * concurrently (e.g. review roles) and the call order is non-deterministic.
 *
 *   routedHarness('claude-code', (opts) =>
 *     opts.env?.FACTORY_ROLE_ID === 'security' ? secResp : perfResp,
 *   )
 */
export const routedHarness = <Name extends string>(
	name: Name,
	responder: ScriptedResponder,
	options: ScriptedHarnessOptions = {},
): Harness<Name> => scriptedHarness(name, responder, options);

/**
 * Echoes the inbound `ExecOpts` as JSON on stdout. Use to verify the
 * orchestrator called the harness with the right cwd / env / permissions
 * — assert on the captured stdout in the events stream.
 */
export const echoHarness = <Name extends string>(
	name: Name,
	options: ScriptedHarnessOptions = {},
): Harness<Name> =>
	scriptedHarness(
		name,
		(opts) => ({
			stdout: `${JSON.stringify({
				cwd: opts.cwd,
				env: opts.env,
				prompt: opts.prompt,
				permissions: opts.permissions,
			})}\n`,
		}),
		options,
	);

/**
 * Always returns an empty success. Use to verify the orchestrator reached
 * a step at all (without caring what the step "produced") — useful for
 * pipeline-shape and routing tests.
 */
export const silentHarness = <Name extends string>(
	name: Name,
	options: ScriptedHarnessOptions = {},
): Harness<Name> => scriptedHarness(name, [], options);

export interface FlakeyHarnessOptions extends ScriptedHarnessOptions {
	/** Number of successful calls before flipping to failure. `0` = fail on the first call. */
	readonly failAfter: number;
	/** Override the success response. Default: `{ stdout: 'ok\n' }`. */
	readonly successResponse?: ScriptedResponse;
	/** Override the failure response. Default: `{ exitCode: 1, stderr: 'flakey harness failure\n' }`. */
	readonly failureResponse?: ScriptedResponse;
}

/**
 * Succeeds N times then fails on every subsequent call. Use to exercise
 * resume / retry behaviour without hand-rolling a stateful responder.
 *
 *   flakeyHarness('claude-code', { failAfter: 2 })
 */
export const flakeyHarness = <Name extends string>(
	name: Name,
	options: FlakeyHarnessOptions,
): Harness<Name> => {
	let count = 0;
	const success = options.successResponse ?? { stdout: 'ok\n' };
	const failure = options.failureResponse ?? { exitCode: 1, stderr: 'flakey harness failure\n' };
	return scriptedHarness(
		name,
		() => {
			const isFail = count >= options.failAfter;
			count++;
			return isFail ? failure : success;
		},
		options,
	);
};
