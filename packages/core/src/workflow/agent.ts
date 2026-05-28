import type { CommandExecutor, FileSystem, Path } from '@effect/platform';
import { Effect, Schema } from 'effect';
import { type FactoryError, MissingHarnessError, UnsupportedPermissionError } from '../errors.ts';
import { AgentLabel, type AgentSeq, type HarnessName, type RunId, StepId } from '../ids.ts';
import { type IterTarget, streamHarnessIter } from '../orchestrator.ts';
import {
	factoryHarnessEnv,
	resolveAgentPermissions,
	resolveHarnessName,
} from '../pipelineHelpers.ts';
import { AgentSequence } from '../services/AgentSequence.ts';
import { Display, type DisplayService } from '../services/Display.ts';
import { EventEmitter, type EventEmitterService } from '../services/EventEmitter.ts';
import { HarnessRegistry } from '../services/HarnessRegistry.ts';
import type { HookRunner, HookTransport } from '../services/HookRunner.ts';
import { readOutput } from '../services/runManifest.ts';
import { RunWorkspace, type RunWorkspaceService } from '../services/RunWorkspace.ts';
import type { FactoryOptions, PermissionMode } from '../types.ts';
import { hashAgentInput } from './agentManifest.ts';
import { WorkflowContext, type WorkflowContextService } from './context.ts';

export interface AgentOptions<A = string> {
	readonly harness?: string;
	readonly schema?: Schema.Schema<A>;
	readonly permissions?: PermissionMode;
	readonly label?: string;
	readonly phase?: string;
}

/** Services a single `agent()` call needs in scope. */
export type AgentRequirements =
	| Display
	| EventEmitter
	| RunWorkspace
	| HarnessRegistry
	| AgentSequence
	| HookRunner
	| HookTransport
	| WorkflowContext
	| CommandExecutor.CommandExecutor
	| FileSystem.FileSystem
	| Path.Path;

/** The shape of the `agent` function exposed on the workflow context. With a
 *  `schema` the call returns the decoded `A`; without one, the last assistant
 *  message string. */
export interface AgentFn {
	<A>(
		prompt: string,
		opts: AgentOptions<A> & { readonly schema: Schema.Schema<A> },
	): Effect.Effect<A, FactoryError, AgentRequirements>;
	(prompt: string, opts?: AgentOptions): Effect.Effect<string, FactoryError, AgentRequirements>;
}

/** Build an `IterTarget` for the programmatic agent layout (agents/<seq>/),
 *  forwarding to the agent-keyed workspace methods and feeding output tokens
 *  into the workflow budget. */
const agentIterTarget = (
	workspace: RunWorkspaceService,
	ctx: WorkflowContextService,
	label: StepId,
	seq: AgentSeq,
	n: number,
): IterTarget => ({
	label,
	n,
	recordEvent: (event) => workspace.appendAgentIterEvent(seq, n, event),
	recordStdout: (text) => workspace.appendAgentStdout(seq, n, text),
	recordStderr: (text) => workspace.appendAgentStderr(seq, n, text),
	onResultTokens: (output) => ctx.addSpent(output),
});

interface AgentStartArgs {
	readonly runId: RunId;
	readonly seq: AgentSeq;
	readonly label: AgentLabel;
	readonly harness: HarnessName;
	readonly phase: string | undefined;
}

const emitAgentStart = (
	emitter: EventEmitterService,
	workspace: RunWorkspaceService,
	display: DisplayService,
	args: AgentStartArgs,
) => {
	const event = {
		type: 'agent.start' as const,
		runId: args.runId,
		seq: args.seq,
		label: args.label,
		harness: args.harness,
		...(args.phase === undefined ? {} : { phase: args.phase }),
	};
	return emitter
		.emit(event)
		.pipe(
			Effect.zipRight(workspace.appendEvent(event)),
			Effect.zipRight(display.agentStart(args.label)),
		);
};

const emitAgentEnd = (
	emitter: EventEmitterService,
	workspace: RunWorkspaceService,
	display: DisplayService,
	args: {
		readonly runId: RunId;
		readonly seq: AgentSeq;
		readonly label: AgentLabel;
		readonly ok: boolean;
	},
) => {
	const event = {
		type: 'agent.end' as const,
		runId: args.runId,
		seq: args.seq,
		label: args.label,
		ok: args.ok,
	};
	return emitter
		.emit(event)
		.pipe(
			Effect.zipRight(workspace.appendEvent(event)),
			Effect.zipRight(display.agentEnd(args.label, args.ok)),
		);
};

/**
 * Programmatic agent primitive implementation. Runs one harness iteration on
 * top of the extracted `streamHarnessIter` kernel and records it under
 * `agents/<seq>-<label>/`.
 *
 * - No `schema` → returns the last assistant message text (`''` if none).
 * - With `schema` → points `$FACTORY_STEP_OUTPUT` at the iter output file and
 *   decodes it through `readOutput`, returning a typed `A`.
 *
 * The return is typed `string | A`; `AgentFn` overloads narrow it at call sites.
 */
const runAgent = <A>(
	factoryOpts: FactoryOptions,
	prompt: string,
	opts: AgentOptions<A>,
): Effect.Effect<string | A, FactoryError, AgentRequirements> =>
	Effect.gen(function* () {
		const ctx = yield* WorkflowContext;
		const workspace = yield* RunWorkspace;
		const emitter = yield* EventEmitter;
		const display = yield* Display;
		const registry = yield* HarnessRegistry;

		// (1) budget gate before doing any work.
		yield* ctx.assertBudget;

		// (2) identity.
		const agentSeq = yield* AgentSequence;
		const seq = yield* agentSeq.next;
		const label = AgentLabel.make(opts.label ?? `agent-${seq}`);
		const stepLabel = StepId.make(label);
		const runId = workspace.runId;
		const cwd = ctx.cwd;

		// (3) resolve harness (frontmatter-free).
		const harnessName = resolveHarnessName(
			opts.harness ?? ctx.defaultHarness ?? factoryOpts.harness,
		);
		if (!harnessName) {
			return yield* Effect.fail(
				new MissingHarnessError({
					message: `agent '${label}' has no harness (opts.harness, workflow default, or factory({harness}) required)`,
					step: stepLabel,
				}),
			);
		}
		const harness = yield* registry.resolve(harnessName);

		// (4) resolve permissions.
		const permissions = resolveAgentPermissions(
			opts.permissions,
			ctx.defaultPermissions,
			factoryOpts,
			harness,
		);
		const supported = harness.capabilities.factory.permissions;
		if (!supported.includes(permissions)) {
			return yield* Effect.fail(
				new UnsupportedPermissionError({
					message: `harness '${harnessName}' does not support permission mode '${permissions}' (supported: ${supported.join(', ') || '(none)'})`,
					harness: harnessName,
					requested: permissions,
					supported,
				}),
			);
		}

		// (5) hashes + resume short-circuit.
		const phaseTitle = opts.phase ?? (yield* ctx.currentPhase);
		const { promptHash, optsHash } = hashAgentInput(prompt, {
			harness: harnessName,
			permissions,
			label,
			phase: phaseTitle,
			schema: opts.schema ? JSON.stringify(opts.schema.ast) : undefined,
		});

		const resumable = yield* workspace.findResumableAgent(seq, promptHash, optsHash);
		if (resumable) {
			yield* emitAgentStart(emitter, workspace, display, {
				runId,
				seq,
				label,
				harness: harnessName,
				phase: phaseTitle,
			});
			yield* emitAgentEnd(emitter, workspace, display, { runId, seq, label, ok: true });
			if (opts.schema) {
				return yield* Schema.decodeUnknown(opts.schema)(resumable.record.output).pipe(
					Effect.mapError(
						() =>
							new MissingHarnessError({
								message: `agent '${label}': recorded output failed to decode on resume`,
								step: stepLabel,
							}),
					),
				);
			}
			return typeof resumable.record.output === 'string' ? resumable.record.output : '';
		}

		// (6) run for real.
		return yield* Effect.gen(function* () {
			yield* workspace.recordAgentStart({ seq, label, promptHash, optsHash, harness: harnessName });
			yield* emitAgentStart(emitter, workspace, display, {
				runId,
				seq,
				label,
				harness: harnessName,
				phase: phaseTitle,
			});

			const paths = yield* workspace.recordAgentIterStart({ seq, n: 1, prompt });
			const outputEnv: Record<string, string> = opts.schema
				? { FACTORY_STEP_OUTPUT: paths.outputPath }
				: {};

			const result = yield* streamHarnessIter({
				runId,
				harness,
				harnessName,
				opts: {
					prompt,
					cwd,
					permissions,
					env: { ...factoryHarnessEnv(workspace.runDir, cwd, runId), ...outputEnv },
				},
				target: agentIterTarget(workspace, ctx, stepLabel, seq, 1),
				workspace,
				emitter,
				display,
			});

			yield* workspace.recordAgentIterEnd({ seq, n: 1, exitCode: result.result.exitCode });

			if (opts.schema) {
				const decoded = yield* readOutput(paths.outputPath, opts.schema, label);
				yield* workspace.recordAgentEnd({ seq, status: 'ok', output: decoded });
				yield* emitAgentEnd(emitter, workspace, display, { runId, seq, label, ok: true });
				return decoded;
			}

			const text = result.lastAssistantMessage;
			yield* workspace.recordAgentEnd({ seq, status: 'ok', output: text });
			yield* emitAgentEnd(emitter, workspace, display, { runId, seq, label, ok: true });
			return text;
		}).pipe(
			// On failure, mark the agent failed + emit `agent.end(ok:false)`. This
			// cleanup is best-effort: a recording error here must not mask the
			// original failure, so we swallow it with an explicit log.
			Effect.tapError(() =>
				workspace.recordAgentEnd({ seq, status: 'failed' }).pipe(
					Effect.zipRight(
						emitAgentEnd(emitter, workspace, display, { runId, seq, label, ok: false }),
					),
					Effect.catchAll((cleanupError) =>
						Effect.logWarning(`agent '${label}': failed to record failure`, cleanupError),
					),
				),
			),
		);
	}).pipe(Effect.withSpan(`factory.agent ${opts.label ?? 'agent'}`));

/** Build the `agent` function bound to a factory's options. The overload
 *  signatures live on `AgentFn`; the implementation delegates to `runAgent`. */
export const makeAgent = (factoryOpts: FactoryOptions): AgentFn => {
	function agent<A>(
		prompt: string,
		opts: AgentOptions<A> & { readonly schema: Schema.Schema<A> },
	): Effect.Effect<A, FactoryError, AgentRequirements>;
	function agent(
		prompt: string,
		opts?: AgentOptions,
	): Effect.Effect<string, FactoryError, AgentRequirements>;
	function agent<A>(
		prompt: string,
		opts: AgentOptions<A> = {},
	): Effect.Effect<string | A, FactoryError, AgentRequirements> {
		return runAgent(factoryOpts, prompt, opts);
	}
	return agent;
};
