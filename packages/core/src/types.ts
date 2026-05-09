import type { CommandExecutor } from '@effect/platform';
import { Schema, type Effect, type Stream } from 'effect';
import type { HarnessCapabilities } from './capabilities.ts';
import { StepRequirements } from './capabilities.ts';
import type {
	FactoryError,
	HarnessExecError,
	HarnessSpawnError,
	StepIdleTimeoutError,
} from './errors.ts';
import { HarnessName, StepId } from './ids.ts';
import type { PipelineName, RunId } from './ids.ts';
import { PermissionMode } from './permissionMode.ts';

export { PermissionMode };

export interface ExecOpts {
	readonly prompt: string;
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly idleTimeoutMs?: number;
	readonly permissions: PermissionMode;
}

export interface ExecResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface HarnessTokenUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead?: number;
	readonly cacheCreate?: number;
}

export type HarnessEvent =
	| { readonly type: 'stdout'; readonly line: string }
	| { readonly type: 'stderr'; readonly line: string }
	| { readonly type: 'exit'; readonly code: number }
	| {
			readonly type: 'tool.start';
			readonly id: string;
			readonly name: string;
			readonly input: unknown;
	  }
	| {
			readonly type: 'tool.end';
			readonly id: string;
			readonly ok: boolean;
			readonly output: unknown;
	  }
	| { readonly type: 'assistant.message'; readonly text: string }
	| {
			readonly type: 'result';
			readonly ok: boolean;
			readonly costUsd?: number;
			readonly tokens?: HarnessTokenUsage;
			readonly model?: string;
			readonly durationMs: number;
	  };

export type HarnessExecRequirements = CommandExecutor.CommandExecutor;

export interface Harness<Name extends string = string> {
	readonly name: Name;
	readonly capabilities: HarnessCapabilities;
	readonly defaultPermissions?: PermissionMode;
	/** Extra env injected during OTel passthrough (e.g. `CLAUDE_CODE_ENABLE_TELEMETRY=1`). */
	readonly telemetryEnv?: Readonly<Record<string, string>>;
	readonly exec: (
		opts: ExecOpts,
	) => Effect.Effect<
		ExecResult,
		HarnessExecError | HarnessSpawnError | StepIdleTimeoutError,
		HarnessExecRequirements
	>;
	readonly stream: (
		opts: ExecOpts,
	) => Stream.Stream<
		HarnessEvent,
		HarnessSpawnError | StepIdleTimeoutError,
		HarnessExecRequirements
	>;
}

export const StepFrontmatter = Schema.Struct({
	name: Schema.optional(StepId),
	harness: Schema.optional(HarnessName),
	until: Schema.optional(Schema.String),
	maxIters: Schema.optional(Schema.Number),
	permissions: Schema.optional(PermissionMode),
	requires: Schema.optional(StepRequirements),
});
export type StepFrontmatter = typeof StepFrontmatter.Type;

export interface LoadedStep {
	readonly id: StepId;
	readonly path: string;
	readonly raw: string;
	readonly frontmatter: StepFrontmatter;
	readonly prompt: string;
}

export interface StepOptions<Names extends string = string> {
	readonly harness?: Names;
	readonly until?: string;
	readonly maxIters?: number;
	readonly permissions?: PermissionMode;
	readonly requires?: StepRequirements;
}

export type RunState = Record<string, unknown>;

export type FactoryEvent =
	| { readonly type: 'run.start'; readonly runId: RunId; readonly pipeline: PipelineName }
	| { readonly type: 'run.end'; readonly runId: RunId }
	| { readonly type: 'step.start'; readonly runId: RunId; readonly step: StepId }
	| {
			readonly type: 'step.iter';
			readonly runId: RunId;
			readonly step: StepId;
			readonly iter: number;
	  }
	| {
			readonly type: 'step.end';
			readonly runId: RunId;
			readonly step: StepId;
			readonly ok: boolean;
	  }
	| {
			readonly type: 'step.output';
			readonly runId: RunId;
			readonly step: StepId;
			readonly output: unknown;
	  }
	| {
			readonly type: 'tool.start';
			readonly runId: RunId;
			readonly step: StepId;
			readonly iter: number;
			readonly toolCallId: string;
			readonly tool: string;
			readonly inputSummary: string;
			readonly inputBytes: number;
	  }
	| {
			readonly type: 'tool.end';
			readonly runId: RunId;
			readonly step: StepId;
			readonly iter: number;
			readonly toolCallId: string;
			readonly tool: string;
			readonly ok: boolean;
			readonly outputSummary: string;
			readonly outputBytes: number;
			readonly durationMs: number;
	  }
	| {
			readonly type: 'assistant.message';
			readonly runId: RunId;
			readonly step: StepId;
			readonly iter: number;
			readonly text: string;
	  }
	| {
			readonly type: 'iter.result';
			readonly runId: RunId;
			readonly step: StepId;
			readonly iter: number;
			readonly ok: boolean;
			readonly costUsd?: number;
			readonly tokens?: HarnessTokenUsage;
			readonly model?: string;
			readonly durationMs: number;
	  }
	| {
			readonly type: 'error';
			readonly runId: RunId;
			readonly step?: StepId;
			readonly error: unknown;
	  };

export interface FactoryOptions<Names extends string = string> {
	readonly name: string;
	readonly harness?: Names;
	readonly harnesses?: ReadonlyArray<Harness<Names>>;
	readonly permissions?: PermissionMode;
}

export interface RunOptions {
	readonly prd: string;
	readonly cwd?: string;
	readonly idleTimeoutMs?: number;
	readonly permissions?: PermissionMode;
	readonly onStep?: (event: FactoryEvent) => void;
	readonly onError?: (event: Extract<FactoryEvent, { type: 'error' }>) => void;
	readonly otel?: boolean;
}

export interface StepEntry {
	readonly id: string;
	readonly source: string;
	readonly options: StepOptions;
}

export interface Factory<Names extends string = string, StepIds extends string = never> {
	readonly name: string;
	readonly step: <Id extends string>(
		id: Exclude<Id, StepIds>,
		source: string,
		options?: StepOptions<Names>,
	) => Factory<Names, StepIds | Id>;
	readonly run: (options: RunOptions) => Promise<void>;
	readonly runEffect: (options: RunOptions) => Effect.Effect<void, FactoryError>;
}
