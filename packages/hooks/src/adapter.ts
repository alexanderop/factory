import type { FileSystem, Path } from '@effect/platform';
import type {
	ConfigLoadError,
	HarnessName,
	HookDecision,
	HookEvent,
	RunId,
	StepId,
} from '@factory/core';
import { Data } from 'effect';
import type { Effect } from 'effect';
import type { HookEventType } from './events.ts';

/** Run context the server parsed out of the callback URL — the native CLI
 *  payload carries the tool/input but never factory's run/step/iter, so the
 *  adapter writes these into the URL and the server threads them back here. */
export interface HookCallContext {
	readonly runId: RunId;
	readonly stepId: StepId;
	readonly iter: number;
	readonly harness: HarnessName;
}

export interface HarnessHookAdapterArgs {
	readonly socketPath: string;
	readonly events: ReadonlyArray<HookEventType>;
	readonly outDir: string;
	readonly runId: RunId;
	readonly stepId: StepId;
	readonly iter: number;
}

export interface HarnessHookAdapterResult {
	readonly env?: Readonly<Record<string, string>>;
	readonly extraArgs?: ReadonlyArray<string>;
}

export interface HarnessNativeConfig {
	readonly path: string;
	readonly content: string;
	readonly format: 'json' | 'toml';
}

export interface HarnessHookAdapter {
	readonly name: HarnessName;
	readonly supportedEvents: ReadonlySet<HookEventType>;
	readonly buildConfig: (args: HarnessHookAdapterArgs) => HarnessNativeConfig;
	readonly writeConfig: (
		args: HarnessHookAdapterArgs,
	) => Effect.Effect<HarnessHookAdapterResult, ConfigLoadError, FileSystem.FileSystem | Path.Path>;
	/** Extract this harness's native callback body (for `event`) into the
	 *  event-specific fields (tool, input, output, source, …). The server merges
	 *  these with the run context to form the structural `HookEvent`. */
	readonly decodeRequest: (args: {
		readonly event: HookEventType;
		readonly body: unknown;
	}) => Record<string, unknown>;
	/** Encode a dispatched decision into this harness's native hook response. */
	readonly encodeDecision: (args: {
		readonly event: HookEventType;
		readonly decision: HookDecision;
	}) => unknown;
}

export class HookCapabilityError extends Data.TaggedError('HookCapabilityError')<{
	readonly message: string;
	readonly harness: HarnessName;
	readonly event: string;
}> {}

export interface HookCapabilityProbe {
	readonly name: HarnessName;
	readonly supportedEvents: ReadonlySet<HookEventType>;
}

export const assertSupports = (
	probe: HookCapabilityProbe,
	events: ReadonlyArray<HookEventType>,
): void => {
	for (const event of events) {
		if (!probe.supportedEvents.has(event)) {
			throw new HookCapabilityError({
				message: `harness '${probe.name}' does not support hook event '${event}'`,
				harness: probe.name,
				event,
			});
		}
	}
};

/** Assemble the structural hook event the runner dispatches, merging the run
 *  context (from the URL) with the harness-decoded native fields. */
export const buildHookEvent = (
	event: HookEventType,
	context: HookCallContext,
	fields: Record<string, unknown>,
): HookEvent => ({ _tag: event, ...context, ...fields });
