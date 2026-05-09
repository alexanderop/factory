import { FileSystem, Path, type CommandExecutor } from '@effect/platform';
import { Effect, Stream } from 'effect';
import { CapabilityMismatchError, matchRequirements } from './capabilities.ts';
import {
	HarnessExecError,
	MissingHarnessError,
	PrdLoadError,
	StepIdleTimeoutError,
	StepMaxItersError,
	UnsupportedPermissionError,
	type FactoryError,
	type HarnessSpawnError,
	type RunRecordingError,
} from './errors.ts';
import { HarnessName, PipelineName, StepId, type RunId } from './ids.ts';
import { Display, type DisplayService } from './services/Display.ts';
import { EventEmitter, type EventEmitterService } from './services/EventEmitter.ts';
import { HarnessRegistry } from './services/HarnessRegistry.ts';
import { RunWorkspace, type RunWorkspaceService } from './services/RunWorkspace.ts';
import { StepLoader } from './services/StepLoader.ts';
import { UntilEvaluator } from './services/UntilEvaluator.ts';
import type {
	ExecOpts,
	ExecResult,
	FactoryEvent,
	FactoryOptions,
	Harness,
	LoadedStep,
	PermissionMode,
	RunOptions,
	StepEntry,
	StepOptions,
} from './types.ts';

interface RunStepArgs {
	readonly runId: RunId;
	readonly stepOrd: number;
	readonly stepId: StepId;
	readonly loaded: LoadedStep;
	readonly harness: Harness;
	readonly harnessName: HarnessName;
	readonly options: StepOptions;
	readonly cwd: string;
	readonly prd: string;
	readonly idleTimeoutMs?: number;
	readonly permissions: PermissionMode;
}

const resolvePermissions = (
	cliMode: PermissionMode | undefined,
	step: LoadedStep,
	stepOpts: StepOptions,
	pipeline: FactoryOptions,
	harness: Harness,
): PermissionMode =>
	cliMode ??
	stepOpts.permissions ??
	step.frontmatter.permissions ??
	pipeline.permissions ??
	harness.defaultPermissions ??
	'prompt';

const resolvePrdContent = (prd: string, cwd: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const resolved = path.isAbsolute(prd) ? prd : path.resolve(cwd, prd);
		return yield* fs.readFileString(resolved).pipe(
			Effect.catchTag('SystemError', (e) =>
				e.reason === 'NotFound'
					? Effect.succeed(prd)
					: Effect.fail(
							new PrdLoadError({
								message: `failed to read PRD '${resolved}': ${e.message}`,
								path: resolved,
							}),
						),
			),
			Effect.catchTag('BadArgument', (e) =>
				Effect.fail(
					new PrdLoadError({
						message: `invalid PRD path '${resolved}': ${e.message}`,
						path: resolved,
					}),
				),
			),
		);
	});

const emitAndRecord = (
	emitter: EventEmitterService,
	workspace: RunWorkspaceService,
	event: FactoryEvent,
) => Effect.zipRight(emitter.emit(event), workspace.appendEvent(event));

interface StreamHarnessArgs {
	readonly harness: Harness;
	readonly opts: ExecOpts;
	readonly stepId: StepId;
	readonly harnessName: HarnessName;
	readonly stepOrd: number;
	readonly n: number;
	readonly workspace: RunWorkspaceService;
	readonly display: DisplayService;
}

const streamHarnessIter = ({
	harness,
	opts,
	stepId,
	harnessName,
	stepOrd,
	n,
	workspace,
	display,
}: StreamHarnessArgs): Effect.Effect<
	ExecResult,
	HarnessExecError | HarnessSpawnError | StepIdleTimeoutError | RunRecordingError,
	CommandExecutor.CommandExecutor
> =>
	Effect.gen(function* () {
		const stdoutLines: string[] = [];
		const stderrLines: string[] = [];
		let exitCode = 0;

		yield* Stream.runForEach(harness.stream(opts), (event) => {
			if (event.type === 'stdout') {
				stdoutLines.push(event.line);
				return Effect.zipRight(
					workspace.appendStdout(stepOrd, n, `${event.line}\n`),
					display.harnessLine(stepId, 'stdout', event.line),
				);
			}
			if (event.type === 'stderr') {
				stderrLines.push(event.line);
				return Effect.zipRight(
					workspace.appendStderr(stepOrd, n, `${event.line}\n`),
					display.harnessLine(stepId, 'stderr', event.line),
				);
			}
			if (event.type === 'exit') {
				exitCode = event.code;
			}
			return Effect.void;
		}).pipe(
			Effect.mapError((e) =>
				e._tag === 'StepIdleTimeoutError'
					? new StepIdleTimeoutError({
							message: e.message,
							step: stepId,
							timeoutMs: e.timeoutMs,
						})
					: e,
			),
		);

		const stdout = stdoutLines.length === 0 ? '' : `${stdoutLines.join('\n')}\n`;
		const stderr = stderrLines.length === 0 ? '' : `${stderrLines.join('\n')}\n`;

		if (exitCode !== 0) {
			return yield* Effect.fail(
				new HarnessExecError({
					message: `harness '${harnessName}' exited with code ${exitCode}`,
					harness: harnessName,
					exitCode,
					stderr: stderr.trim(),
				}),
			);
		}

		return { exitCode, stdout, stderr } satisfies ExecResult;
	});

const runStep = (
	args: RunStepArgs,
): Effect.Effect<
	void,
	FactoryError,
	Display | EventEmitter | UntilEvaluator | RunWorkspace | CommandExecutor.CommandExecutor
> =>
	Effect.gen(function* () {
		const display = yield* Display;
		const emitter = yield* EventEmitter;
		const evaluator = yield* UntilEvaluator;
		const workspace = yield* RunWorkspace;
		const {
			runId,
			stepOrd,
			stepId,
			loaded,
			harness,
			harnessName,
			options,
			cwd,
			prd,
			idleTimeoutMs,
			permissions,
		} = args;

		const maxIters = options.maxIters ?? loaded.frontmatter.maxIters ?? 1;
		const until = options.until ?? loaded.frontmatter.until;

		yield* workspace.recordStepStart({
			ord: stepOrd,
			stepId,
			source: loaded.path,
			harness: harnessName,
			until,
			maxIters,
			stepFileContent: loaded.raw,
		});
		yield* emitAndRecord(emitter, workspace, { type: 'step.start', runId, step: stepId });
		yield* display.stepStart(stepId);

		const fullPrompt = prd ? `# PRD\n\n${prd}\n\n# Step\n\n${loaded.prompt}` : loaded.prompt;

		let success = false;
		for (let i = 1; i <= maxIters; i++) {
			yield* workspace.recordIterStart({ stepOrd, n: i, prompt: fullPrompt });
			yield* emitAndRecord(emitter, workspace, { type: 'step.iter', runId, step: stepId, iter: i });
			yield* display.stepIter(stepId, i, maxIters);

			const lastResult = yield* streamHarnessIter({
				harness,
				harnessName,
				opts: { prompt: fullPrompt, cwd, idleTimeoutMs, permissions },
				stepId,
				stepOrd,
				n: i,
				workspace,
				display,
			});

			if (until === undefined) {
				yield* workspace.recordIterEnd({ stepOrd, n: i, exitCode: lastResult.exitCode });
				success = true;
				break;
			}
			const passed = yield* evaluator.evaluate(until, { step: stepId, cwd, lastResult });
			yield* workspace.recordIterEnd({
				stepOrd,
				n: i,
				exitCode: lastResult.exitCode,
				untilPassed: passed,
			});
			if (passed) {
				success = true;
				break;
			}
		}

		yield* workspace.recordStepEnd({ ord: stepOrd, status: success ? 'ok' : 'failed' });
		yield* emitAndRecord(emitter, workspace, {
			type: 'step.end',
			runId,
			step: stepId,
			ok: success,
		});
		yield* display.stepEnd(stepId, success);

		if (!success) {
			return yield* Effect.fail(
				new StepMaxItersError({
					message: `step '${stepId}' did not satisfy until '${until}' after ${maxIters} iterations`,
					step: stepId,
					maxIters,
				}),
			);
		}
	}).pipe(
		Effect.withSpan('factory.step', {
			attributes: {
				'factory.step': args.stepId,
				'factory.harness': args.harness.name,
				'factory.run.id': args.runId,
			},
		}),
	);

export const runFactoryEffect = (
	factoryOpts: FactoryOptions,
	steps: ReadonlyArray<StepEntry>,
	runOpts: RunOptions,
): Effect.Effect<
	void,
	FactoryError,
	| Display
	| EventEmitter
	| HarnessRegistry
	| StepLoader
	| UntilEvaluator
	| RunWorkspace
	| FileSystem.FileSystem
	| Path.Path
	| CommandExecutor.CommandExecutor
> =>
	Effect.gen(function* () {
		const display = yield* Display;
		const emitter = yield* EventEmitter;
		const loader = yield* StepLoader;
		const registry = yield* HarnessRegistry;
		const workspace = yield* RunWorkspace;

		const runId = workspace.runId;
		const pipeline = PipelineName.make(factoryOpts.name);
		const cwd = runOpts.cwd ?? process.cwd();

		yield* display.runStart(pipeline, runId);

		const prd = yield* resolvePrdContent(runOpts.prd, cwd);

		const defaultHarness = factoryOpts.harness ? HarnessName.make(factoryOpts.harness) : undefined;

		yield* workspace.recordRunStart({
			pipeline,
			defaultHarness,
			cwd,
			prdSource: runOpts.prd,
			prdContent: prd,
		});
		yield* emitAndRecord(emitter, workspace, { type: 'run.start', runId, pipeline });

		const stepBody = Effect.gen(function* () {
			for (const [ord, entry] of steps.entries()) {
				const stepId = StepId.make(entry.id);
				const loaded = yield* loader.load(entry.source, cwd);
				const harnessName =
					(entry.options.harness ? HarnessName.make(entry.options.harness) : undefined) ??
					loaded.frontmatter.harness ??
					defaultHarness;
				if (!harnessName) {
					return yield* Effect.fail(
						new MissingHarnessError({
							message: `step '${stepId}' has no harness (factory({harness}), step option, or frontmatter required)`,
							step: stepId,
						}),
					);
				}
				const harness = yield* registry.resolve(harnessName);
				const supportedPermissions = harness.capabilities.factory.permissions;
				const permissions = resolvePermissions(
					runOpts.permissions,
					loaded,
					entry.options,
					factoryOpts,
					harness,
				);
				if (!supportedPermissions.includes(permissions)) {
					return yield* Effect.fail(
						new UnsupportedPermissionError({
							message: `harness '${harnessName}' does not support permission mode '${permissions}' (supported: ${supportedPermissions.join(', ') || '(none)'})`,
							harness: harnessName,
							requested: permissions,
							supported: supportedPermissions,
						}),
					);
				}
				const missing = matchRequirements(
					harness.capabilities,
					entry.options.requires ?? loaded.frontmatter.requires,
				);
				if (missing.length > 0) {
					return yield* Effect.fail(
						new CapabilityMismatchError({
							message: `harness '${harnessName}' is missing required capabilities: ${missing.join(', ')}`,
							harness: harnessName,
							missing,
						}),
					);
				}
				yield* runStep({
					runId,
					stepOrd: ord,
					stepId,
					loaded,
					harness,
					harnessName,
					options: entry.options,
					cwd,
					prd,
					idleTimeoutMs: runOpts.idleTimeoutMs,
					permissions,
				});
			}
		});

		yield* stepBody.pipe(
			Effect.tapError((error) =>
				emitAndRecord(emitter, workspace, { type: 'error', runId, error }),
			),
			Effect.tapError((error) =>
				workspace.recordRunEnd({
					status: 'error',
					errorTag: error._tag,
					errorMessage: error.message,
				}),
			),
		);

		yield* workspace.recordRunEnd({ status: 'ok' });
		yield* emitAndRecord(emitter, workspace, { type: 'run.end', runId });
		yield* display.runEnd(runId);
	}).pipe(
		Effect.withSpan('factory.run', {
			attributes: { 'factory.pipeline': factoryOpts.name },
		}),
	);
