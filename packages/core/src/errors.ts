import { Data } from 'effect';
import type { CapabilityMismatchError } from './capabilities.ts';
import type { HarnessName, StepId } from './ids.ts';
import type { PermissionMode } from './permissionMode.ts';

/** Reading or parsing a step markdown file failed. */
export class StepLoadError extends Data.TaggedError('StepLoadError')<{
	readonly message: string;
	readonly path: string;
}> {}

/** A step references a harness name not present in the registry. */
export class HarnessNotFoundError extends Data.TaggedError('HarnessNotFoundError')<{
	readonly message: string;
	readonly harness: HarnessName;
	readonly available: ReadonlyArray<HarnessName>;
}> {}

/** Subprocess exited with non-zero. */
export class HarnessExecError extends Data.TaggedError('HarnessExecError')<{
	readonly message: string;
	readonly harness: HarnessName;
	readonly exitCode: number;
	readonly stderr: string;
}> {}

/** Subprocess failed to spawn (e.g. ENOENT, missing binary on PATH). */
export class HarnessSpawnError extends Data.TaggedError('HarnessSpawnError')<{
	readonly message: string;
	readonly harness: HarnessName;
	readonly bin: string;
}> {}

/** Harness produced no output for `idleTimeoutMs` and was killed. */
export class StepIdleTimeoutError extends Data.TaggedError('StepIdleTimeoutError')<{
	readonly message: string;
	readonly step: StepId;
	readonly timeoutMs: number;
}> {}

/** Ralph loop ran `maxIters` iterations without `until` succeeding. */
export class StepMaxItersError extends Data.TaggedError('StepMaxItersError')<{
	readonly message: string;
	readonly step: StepId;
	readonly maxIters: number;
}> {}

/** Evaluating an `until` predicate threw / a shell predicate command errored unexpectedly. */
export class UntilEvalError extends Data.TaggedError('UntilEvalError')<{
	readonly message: string;
	readonly step: StepId;
	readonly until: string;
}> {}

/** A step has no harness on factory, step option, or frontmatter. */
export class MissingHarnessError extends Data.TaggedError('MissingHarnessError')<{
	readonly message: string;
	readonly step: StepId;
}> {}

/** PRD path was provided but the file could not be read. */
export class PrdLoadError extends Data.TaggedError('PrdLoadError')<{
	readonly message: string;
	readonly path: string;
}> {}

/** `.factory/factory.ts` (or equivalent) was missing or failed to import. */
export class ConfigLoadError extends Data.TaggedError('ConfigLoadError')<{
	readonly message: string;
	readonly cwd: string;
}> {}

/** Writing to the per-run SQLite DB or on-disk artifacts under `.factory/runs/<runId>/` failed. */
export class RunRecordingError extends Data.TaggedError('RunRecordingError')<{
	readonly message: string;
	readonly path?: string;
}> {}

/** Resolved permission mode is not in the chosen harness's `supports` list. */
export class UnsupportedPermissionError extends Data.TaggedError('UnsupportedPermissionError')<{
	readonly message: string;
	readonly harness: HarnessName;
	readonly requested: PermissionMode;
	readonly supported: ReadonlyArray<PermissionMode>;
}> {}

/** Pipeline shape on disk (recorded run) does not match the current factory config. */
export class ResumeMismatchError extends Data.TaggedError('ResumeMismatchError')<{
	readonly message: string;
	readonly stepOrd: number;
	readonly recordedStepId: StepId;
	readonly pipelineStepId: StepId;
}> {}

/** A run cannot be resumed (e.g. already complete, or not found). */
export class ResumeUnavailableError extends Data.TaggedError('ResumeUnavailableError')<{
	readonly message: string;
	readonly reason: 'already-complete' | 'not-found' | 'in-progress';
}> {}

/** Reading or parsing a role markdown file failed. */
export class RoleLoadError extends Data.TaggedError('RoleLoadError')<{
	readonly message: string;
	readonly path: string;
	readonly role: string;
}> {}

export type FactoryError =
	| StepLoadError
	| HarnessNotFoundError
	| HarnessExecError
	| HarnessSpawnError
	| StepIdleTimeoutError
	| StepMaxItersError
	| UntilEvalError
	| MissingHarnessError
	| PrdLoadError
	| ConfigLoadError
	| RunRecordingError
	| UnsupportedPermissionError
	| CapabilityMismatchError
	| ResumeMismatchError
	| ResumeUnavailableError
	| RoleLoadError;
