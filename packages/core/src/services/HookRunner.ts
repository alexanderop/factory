import type { FileSystem, Path } from '@effect/platform';
import { Context, Effect, Layer, Ref } from 'effect';
import type { HarnessName, RunId, StepId } from '../ids.ts';

/** Tag-shaped hook event payload. The full payload schema lives in
 *  `@factory/hooks/events`; we keep the structural shape here so that the
 *  orchestrator can depend on this seam without pulling in the hooks
 *  runtime. */
export interface HookEvent {
	readonly _tag: string;
	readonly [key: string]: unknown;
}

export type HookDecisionAction = 'allow' | 'deny' | 'ask' | 'block';

export interface HookDecision {
	readonly action: HookDecisionAction;
	readonly reason?: string;
	readonly updatedInput?: Record<string, unknown>;
	readonly additionalContext?: string;
}

export const HOOK_DECISION_ALLOW: HookDecision = { action: 'allow' };

export interface HookRunnerService {
	readonly dispatch: (event: HookEvent) => Effect.Effect<HookDecision>;
}

export class HookRunner extends Context.Tag('@factory/HookRunner')<
	HookRunner,
	HookRunnerService
>() {}

export const noopHookRunner = {
	layer: Layer.succeed(HookRunner, {
		dispatch: () => Effect.succeed(HOOK_DECISION_ALLOW),
	} satisfies HookRunnerService),
};

export const recordingHookRunner = {
	layer: (ref: Ref.Ref<ReadonlyArray<HookEvent>>): Layer.Layer<HookRunner> =>
		Layer.succeed(HookRunner, {
			dispatch: (event) =>
				Ref.update(ref, (xs) => [...xs, event]).pipe(Effect.as(HOOK_DECISION_ALLOW)),
		}),
};

/** Run-scoped transport seam. The live implementation (in `@factory/hooks`)
 *  owns the per-run unix-socket server and, per step, writes the harness's
 *  native hook config and returns the env/args the harness needs plus the set
 *  of events that harness delivers natively (so the orchestrator only
 *  dispatches the complement from the event stream — see D1 in the plan). Kept
 *  here as a structural seam so the orchestrator can depend on it without
 *  pulling in the hooks runtime. */
export interface HookStepPrep {
	readonly env?: Record<string, string>;
	readonly extraArgs?: ReadonlyArray<string>;
	readonly nativeEvents: ReadonlySet<string>;
}

export interface HookTransportPrepareArgs {
	readonly runId: RunId;
	readonly stepId: StepId;
	readonly harnessName: HarnessName;
	readonly iter: number;
}

export interface HookTransportService {
	readonly prepareStep: (
		args: HookTransportPrepareArgs,
	) => Effect.Effect<HookStepPrep, never, FileSystem.FileSystem | Path.Path>;
}

export class HookTransport extends Context.Tag('@factory/HookTransport')<
	HookTransport,
	HookTransportService
>() {}

const EMPTY_PREP: HookStepPrep = { nativeEvents: new Set<string>() };

export const noopHookTransport = {
	layer: Layer.succeed(HookTransport, {
		prepareStep: () => Effect.succeed(EMPTY_PREP),
	} satisfies HookTransportService),
};
