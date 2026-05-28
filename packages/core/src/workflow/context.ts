import { Context, Effect, Layer, Ref } from 'effect';
import type { RunId } from '../ids.ts';
import { BudgetExhaustedError, type RunRecordingError } from '../errors.ts';
import { Display } from '../services/Display.ts';
import { EventEmitter } from '../services/EventEmitter.ts';
import { RunWorkspace } from '../services/RunWorkspace.ts';
import type { PermissionMode } from '../types.ts';

/** Mutable workflow-scoped state shared across `agent()` calls. */
interface WorkflowState {
	readonly phaseTitle: string | undefined;
}

export interface WorkflowContextService {
	/** Working directory all agents run in (from `workflow().run({ cwd })`). */
	readonly cwd: string;
	/** Optional default harness name from `workflow()` options, applied when an
	 *  individual `agent()` call omits `opts.harness`. */
	readonly defaultHarness: string | undefined;
	/** Optional default permission mode, applied when `agent()` omits one. */
	readonly defaultPermissions: PermissionMode | undefined;
	/** Arbitrary args passed to `workflow(...).run({ args })`, surfaced as `ctx.args`. */
	readonly args: Record<string, unknown>;
	/** Total output-token budget; `agent()` refuses to start once `spent >= budget`. */
	readonly budget: number;
	/** Running tally of output tokens spent (fed by the iter `result` event). */
	readonly spentRef: Ref.Ref<number>;
	readonly currentPhase: Effect.Effect<string | undefined>;
	/** Open a new phase: emit `phase.start`, record it, update display + state. */
	readonly phase: (title: string) => Effect.Effect<void, RunRecordingError>;
	/** Free-form progress line routed to the display only. */
	readonly log: (message: string) => Effect.Effect<void>;
	/** Fail with `BudgetExhaustedError` if the budget is already spent. */
	readonly assertBudget: Effect.Effect<void, BudgetExhaustedError>;
	/** Add output tokens to the spent tally (called from the agent iter target). */
	readonly addSpent: (tokens: number) => Effect.Effect<void>;
}

export class WorkflowContext extends Context.Tag('@factory/WorkflowContext')<
	WorkflowContext,
	WorkflowContextService
>() {}

export interface WorkflowContextConfig {
	readonly runId: RunId;
	readonly cwd: string;
	readonly defaultHarness?: string;
	readonly defaultPermissions?: PermissionMode;
	readonly args?: Record<string, unknown>;
	readonly budget?: number;
}

const makeService = (
	config: WorkflowContextConfig,
): Effect.Effect<WorkflowContextService, never, Display | EventEmitter | RunWorkspace> =>
	Effect.gen(function* () {
		const display = yield* Display;
		const emitter = yield* EventEmitter;
		const workspace = yield* RunWorkspace;
		const stateRef = yield* Ref.make<WorkflowState>({ phaseTitle: undefined });
		const spentRef = yield* Ref.make(0);
		const budget = config.budget ?? Number.POSITIVE_INFINITY;
		const runId = config.runId;

		return {
			cwd: config.cwd,
			defaultHarness: config.defaultHarness,
			defaultPermissions: config.defaultPermissions,
			args: config.args ?? {},
			budget,
			spentRef,
			currentPhase: Ref.get(stateRef).pipe(Effect.map((s) => s.phaseTitle)),
			phase: (title) =>
				Effect.gen(function* () {
					yield* Ref.update(stateRef, (s) => ({ ...s, phaseTitle: title }));
					yield* emitter.emit({ type: 'phase.start', runId, title });
					yield* workspace.appendEvent({ type: 'phase.start', runId, title });
					yield* display.phase(title);
				}).pipe(Effect.withSpan(`factory.phase ${title}`)),
			log: (message) => display.log(message),
			assertBudget: Ref.get(spentRef).pipe(
				Effect.flatMap((spent) =>
					spent >= budget
						? Effect.fail(
								new BudgetExhaustedError({
									message: `output-token budget exhausted (${spent}/${budget})`,
									spentTokens: spent,
									budget,
								}),
							)
						: Effect.void,
				),
			),
			addSpent: (tokens) => Ref.update(spentRef, (s) => s + tokens),
		} satisfies WorkflowContextService;
	});

/** Build the WorkflowContext layer. Merged into `buildRuntimeLayer` so both the
 *  declarative and programmatic paths can resolve it (declarative never reads it). */
export const workflowContextLayer = (
	config: WorkflowContextConfig,
): Layer.Layer<WorkflowContext, never, Display | EventEmitter | RunWorkspace> =>
	Layer.effect(WorkflowContext, makeService(config));
