export interface ExecOpts {
	prompt: string;
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type HarnessEvent =
	| { type: 'stdout'; line: string }
	| { type: 'stderr'; line: string }
	| { type: 'tool'; name: string; input?: unknown }
	| { type: 'exit'; code: number };

export interface Harness {
	readonly name: string;
	exec(opts: ExecOpts): Promise<ExecResult>;
	stream(opts: ExecOpts): AsyncIterable<HarnessEvent>;
}

export interface StepFrontmatter {
	name?: string;
	harness?: string;
	until?: string;
	maxIters?: number;
}

export interface LoadedStep {
	id: string;
	path: string;
	frontmatter: StepFrontmatter;
	prompt: string;
}

export interface StepOptions {
	harness?: string;
	until?: string;
	maxIters?: number;
}

// biome-ignore lint/suspicious/noExplicitAny: state bag is intentionally loose in v0
export type RunState = Record<string, any>;

export interface RunCtx {
	runId: string;
	pipeline: string;
	state: RunState;
	harness: Harness;
	cwd: string;
	prd: string;
	emit: (event: FactoryEvent) => void;
}

export type FactoryEvent =
	| { type: 'run.start'; runId: string; pipeline: string }
	| { type: 'run.end'; runId: string }
	| { type: 'step.start'; runId: string; step: string }
	| { type: 'step.end'; runId: string; step: string; ok: boolean }
	| { type: 'step.output'; runId: string; step: string; output: unknown }
	| { type: 'error'; runId: string; step?: string; error: unknown };

export interface FactoryOptions {
	name: string;
	harness?: string;
}

export interface RunOptions {
	prd: string;
	cwd?: string;
	onStep?: (event: FactoryEvent) => void;
	onError?: (event: Extract<FactoryEvent, { type: 'error' }>) => void;
	otel?: boolean;
}

export interface Factory {
	readonly name: string;
	step(id: string, source: string, options?: StepOptions): Factory;
	run(options: RunOptions): Promise<void>;
}
