import { NodeContext } from '@effect/platform-node';
import { Cause, Effect, Exit, Layer, Predicate, Ref } from 'effect';
import { CapabilityMismatchError, type HarnessCapabilities } from '../capabilities.ts';
import type { HarnessOtelEnvArgs } from '../harnessOtelEnv.ts';
import {
	ConfigLoadError,
	HarnessExecError,
	HarnessNotFoundError,
	HarnessSpawnError,
	MissingHarnessError,
	PrdLoadError,
	ResumeMismatchError,
	ResumeUnavailableError,
	RoleLoadError,
	RunRecordingError,
	StepIdleTimeoutError,
	StepLoadError,
	StepMaxItersError,
	UnsupportedPermissionError,
	UntilEvalError,
} from '../errors.ts';
import { HarnessName, PipelineName, RunId, StepId } from '../ids.ts';
import type { RoleFinding } from '../review/finding.ts';
import { type DisplayEntry, SilentDisplay } from '../services/Display.ts';
import { noopEventEmitter, recordingEventEmitter } from '../services/EventEmitter.ts';
import { harnessRegistryLayer } from '../services/HarnessRegistry.ts';
import type { IterRecord, RoleRecord, RunRecord, StepRecord } from '../services/runManifest.ts';
import { InMemoryRunWorkspace } from '../services/RunWorkspace.ts';
import { InMemoryStepLoader } from '../services/StepLoader.ts';
import { scriptedUntilEvaluator } from '../services/UntilEvaluator.ts';
import type { ExecOpts, FactoryEvent, Harness, PermissionMode, StepEntry } from '../types.ts';
import {
	type ScriptedHarnessOptions,
	type ScriptedResponder,
	type ScriptedResponse,
	scriptedHarness,
} from './scriptedHarness.ts';

const DEFAULT_RUN_ID = RunId.make('test-run');
const DEFAULT_STEP_ID = StepId.make('plan');
const DEFAULT_HARNESS = HarnessName.make('claude-code');
const DEFAULT_PIPELINE = PipelineName.make('sdd');
const DEFAULT_TIME = 1_700_000_000_000;
const ALL_PERMISSION_MODES: ReadonlyArray<PermissionMode> = [
	'skip',
	'accept-edits',
	'read-only',
	'prompt',
];

// ---------- Branded ID factories ----------

export const makeRunId = (value = 'test-run'): RunId => RunId.make(value);
export const makeStepId = (value = 'plan'): StepId => StepId.make(value);
export const makeHarnessName = (value = 'claude-code'): HarnessName => HarnessName.make(value);
export const makePipelineName = (value = 'sdd'): PipelineName => PipelineName.make(value);

// ---------- Manifest records ----------

export const makeIterRecord = (overrides?: Partial<IterRecord>): IterRecord => ({
	n: 1,
	startedAt: DEFAULT_TIME + 100,
	endedAt: DEFAULT_TIME + 200,
	exitCode: 0,
	untilPassed: true,
	...overrides,
});

export const makeStepRecord = (overrides?: Partial<StepRecord>): StepRecord => ({
	ord: 0,
	stepId: DEFAULT_STEP_ID,
	source: './steps/plan.md',
	harness: DEFAULT_HARNESS,
	maxIters: 1,
	startedAt: DEFAULT_TIME,
	status: 'ok',
	iters: [makeIterRecord()],
	...overrides,
});

export const makeRoleRecord = (overrides?: Partial<RoleRecord>): RoleRecord => ({
	name: 'security',
	harness: DEFAULT_HARNESS,
	startedAt: DEFAULT_TIME,
	status: 'ok',
	findings: 0,
	...overrides,
});

export const makeRunRecord = (overrides?: Partial<RunRecord>): RunRecord => ({
	id: DEFAULT_RUN_ID,
	pipeline: DEFAULT_PIPELINE,
	defaultHarness: DEFAULT_HARNESS,
	cwd: '/tmp/cwd',
	prdSource: 'inline',
	startedAt: DEFAULT_TIME,
	status: 'ok',
	...overrides,
});

// ---------- Inputs the orchestrator and harnesses see ----------

export const makeExecOpts = (overrides?: Partial<ExecOpts>): ExecOpts => ({
	prompt: 'test prompt',
	permissions: 'skip',
	...overrides,
});

export const makeStepEntry = (overrides?: Partial<StepEntry>): StepEntry => ({
	kind: 'step',
	id: 'plan',
	source: './steps/plan.md',
	options: {},
	...overrides,
});

// ---------- Capabilities ----------

export const makeHarnessCapabilities = (
	overrides?: Partial<HarnessCapabilities>,
): HarnessCapabilities => ({
	loadSession: false,
	mcp: { http: false, sse: false },
	prompt: { image: false, audio: false, embeddedContext: false },
	session: { list: false, resume: false, close: false },
	factory: { permissions: ALL_PERMISSION_MODES, toolEvents: false },
	...overrides,
});

/** All capability bits flipped on. Useful when the unit under test is a step
 *  requires-block and capability gaps should not be the reason it fails. */
export const makeFullCapabilities = (): HarnessCapabilities => ({
	loadSession: true,
	mcp: { http: true, sse: true },
	prompt: { image: true, audio: true, embeddedContext: true },
	session: { list: true, resume: true, close: true },
	factory: { permissions: [...ALL_PERMISSION_MODES], toolEvents: true },
});

/** All capability bits off. Useful for negative tests asserting a step is
 *  rejected before the harness is invoked. */
export const makeEmptyCapabilities = (): HarnessCapabilities => ({
	loadSession: false,
	mcp: { http: false, sse: false },
	prompt: { image: false, audio: false, embeddedContext: false },
	session: { list: false, resume: false, close: false },
	factory: { permissions: [], toolEvents: false },
});

// ---------- harnessOtelEnv args ----------

export const makeHarnessOtelEnvArgs = (
	overrides?: Partial<HarnessOtelEnvArgs>,
): HarnessOtelEnvArgs => ({
	harness: 'claude-code',
	runId: makeRunId('r'),
	stepId: makeStepId('s'),
	iter: 1,
	traceId: '0123456789abcdef0123456789abcdef',
	spanId: '0123456789abcdef',
	sampled: true,
	...overrides,
});

// ---------- Tagged errors ----------

export const makeStepLoadError = (
	overrides?: Partial<{ message: string; path: string }>,
): StepLoadError => new StepLoadError({ message: 'cannot read', path: '/x.md', ...overrides });

export const makeHarnessNotFoundError = (
	overrides?: Partial<{
		message: string;
		harness: HarnessName;
		available: ReadonlyArray<HarnessName>;
	}>,
): HarnessNotFoundError =>
	new HarnessNotFoundError({
		message: 'unknown harness',
		harness: makeHarnessName('foo'),
		available: [DEFAULT_HARNESS],
		...overrides,
	});

export const makeHarnessExecError = (
	overrides?: Partial<{
		message: string;
		harness: HarnessName;
		exitCode: number;
		stderr: string;
	}>,
): HarnessExecError =>
	new HarnessExecError({
		message: 'exit 1',
		harness: DEFAULT_HARNESS,
		exitCode: 1,
		stderr: '',
		...overrides,
	});

export const makeHarnessSpawnError = (
	overrides?: Partial<{ message: string; harness: HarnessName; bin: string }>,
): HarnessSpawnError =>
	new HarnessSpawnError({
		message: 'ENOENT',
		harness: DEFAULT_HARNESS,
		bin: 'claude',
		...overrides,
	});

export const makeStepIdleTimeoutError = (
	overrides?: Partial<{ message: string; step: StepId; timeoutMs: number }>,
): StepIdleTimeoutError =>
	new StepIdleTimeoutError({
		message: 'idle 60s',
		step: makeStepId('ralph'),
		timeoutMs: 60_000,
		...overrides,
	});

export const makeStepMaxItersError = (
	overrides?: Partial<{ message: string; step: StepId; maxIters: number }>,
): StepMaxItersError =>
	new StepMaxItersError({
		message: 'gave up',
		step: makeStepId('ralph'),
		maxIters: 10,
		...overrides,
	});

export const makeUntilEvalError = (
	overrides?: Partial<{ message: string; step: StepId; until: string }>,
): UntilEvalError =>
	new UntilEvalError({
		message: 'pnpm test failed',
		step: makeStepId('ralph'),
		until: 'tests pass',
		...overrides,
	});

export const makeMissingHarnessError = (
	overrides?: Partial<{ message: string; step: StepId }>,
): MissingHarnessError =>
	new MissingHarnessError({
		message: 'no harness',
		step: DEFAULT_STEP_ID,
		...overrides,
	});

export const makePrdLoadError = (
	overrides?: Partial<{ message: string; path: string }>,
): PrdLoadError =>
	new PrdLoadError({
		message: 'cannot read PRD',
		path: '/feature.md',
		...overrides,
	});

export const makeConfigLoadError = (
	overrides?: Partial<{ message: string; cwd: string }>,
): ConfigLoadError => new ConfigLoadError({ message: 'no config', cwd: '/repo', ...overrides });

export const makeRunRecordingError = (
	overrides?: Partial<{ message: string; path: string }>,
): RunRecordingError => new RunRecordingError({ message: 'cannot record', ...overrides });

export const makeUnsupportedPermissionError = (
	overrides?: Partial<{
		message: string;
		harness: HarnessName;
		requested: PermissionMode;
		supported: ReadonlyArray<PermissionMode>;
	}>,
): UnsupportedPermissionError =>
	new UnsupportedPermissionError({
		message: 'unsupported permission',
		harness: DEFAULT_HARNESS,
		requested: 'prompt',
		supported: ['skip'],
		...overrides,
	});

export const makeCapabilityMismatchError = (
	overrides?: Partial<{
		message: string;
		harness: HarnessName;
		missing: ReadonlyArray<string>;
	}>,
): CapabilityMismatchError =>
	new CapabilityMismatchError({
		message: 'missing caps',
		harness: DEFAULT_HARNESS,
		missing: ['session.resume'],
		...overrides,
	});

export const makeResumeMismatchError = (
	overrides?: Partial<{
		message: string;
		stepOrd: number;
		recordedStepId: StepId;
		pipelineStepId: StepId;
	}>,
): ResumeMismatchError =>
	new ResumeMismatchError({
		message: 'pipeline drift',
		stepOrd: 1,
		recordedStepId: makeStepId('ralph'),
		pipelineStepId: makeStepId('simplify'),
		...overrides,
	});

export const makeResumeUnavailableError = (
	overrides?: Partial<{
		message: string;
		reason: 'already-complete' | 'not-found' | 'in-progress';
	}>,
): ResumeUnavailableError =>
	new ResumeUnavailableError({
		message: 'already complete',
		reason: 'already-complete',
		...overrides,
	});

export const makeRoleLoadError = (
	overrides?: Partial<{ message: string; path: string; role: string }>,
): RoleLoadError =>
	new RoleLoadError({
		message: 'cannot read role',
		path: '/roles/x.md',
		role: 'x',
		...overrides,
	});

// ---------- Test layer factory ----------

export interface MakeTestLayerOptions {
	readonly displayRef?: Ref.Ref<ReadonlyArray<DisplayEntry>>;
	readonly eventsRef?: Ref.Ref<ReadonlyArray<FactoryEvent>>;
	readonly harnesses?: ReadonlyArray<Harness>;
	readonly stepFiles?: ReadonlyMap<string, string> | Iterable<readonly [string, string]>;
	readonly verdicts?: ReadonlyArray<boolean>;
	readonly runId?: RunId;
	readonly runDir?: string;
}

const defaultHarnessScript = [
	{ stdout: 'iter-1\n' },
	{ stdout: 'iter-2\n' },
	{ stdout: 'iter-3\n' },
	{ stdout: 'iter-4\n' },
	{ stdout: 'iter-5\n' },
];

const toMap = (
	input: ReadonlyMap<string, string> | Iterable<readonly [string, string]> | undefined,
): ReadonlyMap<string, string> => {
	if (!input) return new Map();
	if (input instanceof Map) return input;
	return new Map(input);
};

export const makeTestLayer = (options: MakeTestLayerOptions = {}) => {
	const displayRef = options.displayRef ?? Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
	const harnesses = options.harnesses ?? [scriptedHarness('claude-code', defaultHarnessScript)];
	const eventsLayer = options.eventsRef
		? recordingEventEmitter.layer(options.eventsRef)
		: noopEventEmitter.layer;
	const runId = options.runId ?? DEFAULT_RUN_ID;
	const workspaceLayer = options.runDir
		? InMemoryRunWorkspace.layer({ runId, runDir: options.runDir })
		: InMemoryRunWorkspace.layer({ runId });

	return Layer.mergeAll(
		SilentDisplay.layer(displayRef),
		eventsLayer,
		harnessRegistryLayer(harnesses),
		InMemoryStepLoader.layer(toMap(options.stepFiles)),
		scriptedUntilEvaluator.layer(options.verdicts ?? [true]),
		workspaceLayer,
	).pipe(Layer.provideMerge(NodeContext.layer));
};

// ---------- The canonical test rig ----------
//
// `makeTestRig` is the preferred entry point for new tests. It builds the
// same layer as `makeTestLayer` but also returns the capture refs so the
// test body doesn't have to allocate them. Use the `events` / `display`
// Effects to read out captured state at the end of the test.

export interface TestRig {
	readonly layer: ReturnType<typeof makeTestLayer>;
	readonly events: Effect.Effect<ReadonlyArray<FactoryEvent>>;
	readonly display: Effect.Effect<ReadonlyArray<DisplayEntry>>;
	readonly eventsRef: Ref.Ref<ReadonlyArray<FactoryEvent>>;
	readonly displayRef: Ref.Ref<ReadonlyArray<DisplayEntry>>;
}

export const makeTestRig = (options: MakeTestLayerOptions = {}): TestRig => {
	const displayRef = options.displayRef ?? Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
	const eventsRef = options.eventsRef ?? Ref.unsafeMake<ReadonlyArray<FactoryEvent>>([]);
	const layer = makeTestLayer({ ...options, displayRef, eventsRef });
	return {
		layer,
		events: Ref.get(eventsRef),
		display: Ref.get(displayRef),
		eventsRef,
		displayRef,
	};
};

// ---------- Two-sided scripted harness: capture inbound calls ----------

export interface CapturingScriptedHarness<Name extends string> {
	readonly harness: Harness<Name>;
	/** Read out every `ExecOpts` the orchestrator passed, in call order. */
	readonly calls: Effect.Effect<ReadonlyArray<ExecOpts>>;
}

export const capturingScripted = <Name extends string>(
	name: Name,
	responses: ReadonlyArray<ScriptedResponse> | ScriptedResponder,
	options: ScriptedHarnessOptions = {},
): CapturingScriptedHarness<Name> => {
	const callsRef = Ref.unsafeMake<ReadonlyArray<ExecOpts>>([]);
	const userOnCallEffect = options.onCallEffect;
	const harness = scriptedHarness(name, responses, {
		...options,
		onCallEffect: (opts) =>
			Effect.gen(function* () {
				yield* Ref.update(callsRef, (xs) => [...xs, opts]);
				if (userOnCallEffect) yield* userOnCallEffect(opts);
			}),
	});
	return { harness, calls: Ref.get(callsRef) };
};

// ---------- Exit narrowing helper ----------

/**
 * Asserts that an Effect `Exit` is a typed failure containing an instance of
 * `ErrorClass`, returning the narrowed error for further field assertions.
 * Replaces the four-line `Exit.isFailure` + `Cause.failureOption` + `_tag`
 * + `assertInstanceOf` dance.
 *
 *   const err = assertExitFailedWith(exit, CapabilityMismatchError);
 *   deepStrictEqual(err.missing, ['session.resume']);
 */
export const assertExitFailedWith = <A, E, EClass extends E>(
	exit: Exit.Exit<A, E>,
	ErrorClass: new (...args: never[]) => EClass,
): EClass => {
	if (!Exit.isFailure(exit)) {
		throw new Error(`expected Exit.Failure, got Success: ${JSON.stringify(exit, null, 2)}`);
	}
	const failure = Cause.failureOption(exit.cause);
	if (failure._tag !== 'Some') {
		throw new Error(
			`expected typed failure, got Cause '${exit.cause._tag}': ${String(exit.cause)}`,
		);
	}
	if (!(failure.value instanceof ErrorClass)) {
		const got =
			Predicate.isRecord(failure.value) && typeof failure.value._tag === 'string'
				? failure.value._tag
				: typeof failure.value;
		throw new Error(`expected ${ErrorClass.name}, got ${got}: ${String(failure.value)}`);
	}
	return failure.value;
};

// ---------- Review-step helpers ----------

export interface ReviewRoleFindingsArgs {
	readonly roleId: string;
	readonly findings: ReadonlyArray<RoleFinding>;
	/** Step ord (default `0` — most review tests use a single review step). */
	readonly stepOrd?: number;
	/** Step id (default `'review'`). */
	readonly stepId?: string;
	/** Override the stdout the harness emits. Default: `'<roleId> done\n'`. */
	readonly stdout?: string;
}

/**
 * Build a `ScriptedResponse` that simulates a review role writing its
 * findings to the conventional path. Encapsulates the orchestrator's
 * `<runDir>/steps/<ord>-<stepId>/roles/<roleId>/findings.json` convention,
 * so tests don't hard-code the path.
 *
 *   routedHarness('claude-code', (opts) =>
 *     reviewRoleFindings({
 *       roleId: opts.env?.FACTORY_ROLE_ID ?? 'unknown',
 *       findings: [{ severity: 'P1', file: 'src/auth.ts', message: '…' }],
 *     }),
 *   )
 */
export const reviewRoleFindings = (args: ReviewRoleFindingsArgs): ScriptedResponse => {
	const ord = String(args.stepOrd ?? 0).padStart(2, '0');
	const stepId = args.stepId ?? 'review';
	return {
		stdout: args.stdout ?? `${args.roleId} done\n`,
		writes: [
			{
				path: `steps/${ord}-${stepId}/roles/${args.roleId}/findings.json`,
				content: JSON.stringify({ findings: args.findings }),
			},
		],
	};
};
