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
	| { readonly type: 'tool'; readonly name: string; readonly input?: unknown }
	| { readonly type: 'exit'; readonly code: number };

export type HarnessExecRequirements = CommandExecutor.CommandExecutor;

export interface Harness {
	readonly name: string;
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

export interface StepOptions {
	readonly harness?: string;
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

export interface FactoryOptions {
	readonly name: string;
	readonly harness?: string;
	readonly harnesses?: ReadonlyArray<Harness>;
}

export interface RunOptions {
	readonly prd: string;
	readonly cwd?: string;
	readonly idleTimeoutMs?: number;
	readonly onStep?: (event: FactoryEvent) => void;
	readonly onError?: (event: Extract<FactoryEvent, { type: 'error' }>) => void;
	readonly otel?: boolean;
}

export interface StepEntry {
	readonly id: string;
	readonly source: string;
	readonly options: StepOptions;
}

export interface Factory {
	readonly name: string;
	readonly step: (id: string, source: string, options?: StepOptions) => Factory;
	readonly run: (options: RunOptions) => Promise<void>;
	readonly runEffect: (options: RunOptions) => Effect.Effect<void, FactoryError>;
}
