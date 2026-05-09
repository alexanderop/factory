import type { CommandExecutor } from '@effect/platform';
import { Schema, type Effect, type Stream } from 'effect';
import type {
	FactoryError,
	HarnessExecError,
	HarnessSpawnError,
	StepIdleTimeoutError,
} from './errors.ts';
import { HarnessName, StepId } from './ids.ts';
import type { PipelineName, RunId } from './ids.ts';

export interface ExecOpts {
	readonly prompt: string;
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly idleTimeoutMs?: number;
}

export interface ExecResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export type HarnessEvent =
	| { readonly type: 'stdout'; readonly line: string }
	| { readonly type: 'stderr'; readonly line: string }
	| { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
	| {
			readonly type: 'tool_result';
			readonly id: string;
			readonly ok: boolean;
			readonly output?: unknown;
			readonly error?: string;
	  }
	| {
			readonly type: 'usage';
			readonly model?: string;
			readonly inputTokens?: number;
			readonly outputTokens?: number;
			readonly cacheReadTokens?: number;
			readonly cacheCreationTokens?: number;
	  }
	| { readonly type: 'message'; readonly role: 'assistant' | 'user' | 'system'; readonly text: string }
	| { readonly type: 'exit'; readonly code: number };

export type HarnessExecRequirements = CommandExecutor.CommandExecutor;

export interface Harness<Name extends string = string> {
	readonly name: Name;
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
});
export type StepFrontmatter = typeof StepFrontmatter.Type;

export interface LoadedStep {
	readonly id: StepId;
	readonly path: string;
	readonly frontmatter: StepFrontmatter;
	readonly prompt: string;
}

export interface StepOptions<Names extends string = string> {
	readonly harness?: Names;
	readonly until?: string;
	readonly maxIters?: number;
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
			readonly type: 'error';
			readonly runId: RunId;
			readonly step?: StepId;
			readonly error: unknown;
	  };

export interface FactoryOptions<Names extends string = string> {
	readonly name: string;
	readonly harness?: Names;
	readonly harnesses?: ReadonlyArray<Harness<Names>>;
}

/** Controls how much of tool input/output is recorded on spans and logs. */
export type CaptureMode = 'off' | 'counts' | 'redacted' | 'full';

export interface RunOptions {
	readonly prd: string;
	readonly cwd?: string;
	readonly idleTimeoutMs?: number;
	readonly onStep?: (event: FactoryEvent) => void;
	readonly onError?: (event: Extract<FactoryEvent, { type: 'error' }>) => void;
	readonly otel?: boolean;
	readonly captureMode?: CaptureMode;
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
