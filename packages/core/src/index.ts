export {
	ConfigLoadError,
	type FactoryError,
	HarnessExecError,
	HarnessNotFoundError,
	HarnessSpawnError,
	MissingHarnessError,
	PrdLoadError,
	RunRecordingError,
	StepIdleTimeoutError,
	StepLoadError,
	StepMaxItersError,
	UnsupportedPermissionError,
	UntilEvalError,
} from './errors.ts';
export { factory } from './factory.ts';
export { formatErrorMessage, withFriendlyErrors } from './error-handler.ts';
export { runFactoryEffect } from './orchestrator.ts';
export { NoOtelLayer, OtelLayer } from './otel.ts';
export {
	ConsoleDisplay,
	Display,
	type DisplayEntry,
	type DisplayService,
	SilentDisplay,
} from './services/Display.ts';
export {
	callbackEventEmitter,
	EventEmitter,
	type EventEmitterService,
	noopEventEmitter,
	recordingEventEmitter,
} from './services/EventEmitter.ts';
export {
	harnessRegistryLayer,
	HarnessRegistry,
	type HarnessRegistryService,
} from './services/HarnessRegistry.ts';
export {
	InMemoryRunWorkspace,
	type IterEndArgs,
	type IterPaths,
	type IterStartArgs,
	LiveRunWorkspace,
	type RunEndArgs,
	type RunStartArgs,
	RunWorkspace,
	type RunWorkspaceService,
	type StepEndArgs,
	type StepStartArgs,
} from './services/RunWorkspace.ts';
export {
	FileStepLoader,
	InMemoryStepLoader,
	StepLoader,
	type StepLoaderService,
} from './services/StepLoader.ts';
export {
	DefaultUntilEvaluator,
	scriptedUntilEvaluator,
	type UntilEvalCtx,
	UntilEvaluator,
	type UntilEvaluatorService,
} from './services/UntilEvaluator.ts';
export { createSubprocessHarness, type SubprocessHarnessConfig } from './subprocess.ts';
export { PermissionMode } from './types.ts';
export type {
	ExecOpts,
	ExecResult,
	Factory,
	FactoryEvent,
	FactoryOptions,
	Harness,
	HarnessEvent,
	HarnessExecRequirements,
	LoadedStep,
	RunOptions,
	RunState,
	StepEntry,
	StepFrontmatter,
	StepOptions,
} from './types.ts';
