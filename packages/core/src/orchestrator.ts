import { FileSystem, Path, type CommandExecutor } from '@effect/platform';
import { Clock, Effect, Exit, Metric, Stream, type Tracer } from 'effect';
import {
	assistantMessagesTotal,
	costMicroUsd,
	iterDurationMs,
	itersTotal,
	runDurationMs,
	runsTotal,
	stepDurationMs,
	stepsTotal,
	subprocessOutputBytes,
	tokensTotal,
	toolCallDurationMs,
	toolCallsTotal,
} from './metrics.ts';
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
import { harnessOtelEnv } from './harnessOtelEnv.ts';
import { HarnessName, PipelineName, StepId, type RunId } from './ids.ts';
import { describeForSpan, recordTaggedError, toolInputAttributes } from './observability.ts';
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
	readonly runId: RunId;
	readonly harness: Harness;
	readonly opts: ExecOpts;
	readonly stepId: StepId;
	readonly harnessName: HarnessName;
	readonly stepOrd: number;
	readonly n: number;
	readonly workspace: RunWorkspaceService;
	readonly emitter: EventEmitterService;
	readonly display: DisplayService;
}

interface ToolSpanEntry {
	readonly span: Tracer.Span;
	readonly name: string;
	readonly startedAt: number;
}

const streamHarnessIter = ({
	runId,
	harness,
	opts,
	stepId,
	harnessName,
	stepOrd,
	n,
	workspace,
	emitter,
	display,
}: StreamHarnessArgs): Effect.Effect<
	ExecResult,
	HarnessExecError | HarnessSpawnError | StepIdleTimeoutError | RunRecordingError,
	CommandExecutor.CommandExecutor
> =>
	Effect.gen(function* () {
		const stdoutLines: string[] = [];
		const stderrLines: string[] = [];
		const toolSpans = new Map<string, ToolSpanEntry>();
		let exitCode = 0;

		const iterSpan = yield* Effect.option(Effect.currentSpan);
		const otelEnv =
			iterSpan._tag === 'Some'
				? harnessOtelEnv({
						harness: harness.name,
						runId,
						stepId,
						iter: n,
						traceId: iterSpan.value.traceId,
						spanId: iterSpan.value.spanId,
						sampled: iterSpan.value.sampled,
						extraEnv: harness.telemetryEnv,
					})
				: {};
		const optsWithEnv: ExecOpts = {
			...opts,
			env: { ...opts.env, ...otelEnv },
		};

		const persistAndEmit = (event: FactoryEvent) =>
			Effect.all(
				[
					emitter.emit(event),
					workspace.appendEvent(event),
					workspace.appendIterEvent(stepOrd, n, event),
				],
				{ concurrency: 'unbounded', discard: true },
			);

		yield* Stream.runForEach(harness.stream(optsWithEnv), (event) =>
			Effect.gen(function* () {
				switch (event.type) {
					case 'stdout': {
						stdoutLines.push(event.line);
						yield* workspace.appendStdout(stepOrd, n, `${event.line}\n`);
						yield* display.harnessLine(stepId, 'stdout', event.line);
						return;
					}
					case 'stderr': {
						stderrLines.push(event.line);
						yield* workspace.appendStderr(stepOrd, n, `${event.line}\n`);
						yield* display.harnessLine(stepId, 'stderr', event.line);
						return;
					}
					case 'exit': {
						exitCode = event.code;
						return;
					}
					case 'assistant.message': {
						stdoutLines.push(event.text);
						yield* workspace.appendStdout(stepOrd, n, `${event.text}\n`);
						yield* display.harnessLine(stepId, 'stdout', event.text);
						yield* Metric.increment(assistantMessagesTotal);
						yield* persistAndEmit({
							type: 'assistant.message',
							runId,
							step: stepId,
							iter: n,
							text: event.text,
						});
						return;
					}
					case 'tool.start': {
						const { summary: inputSummary, bytes: inputBytes } = describeForSpan(event.input);
						const span = yield* Effect.makeSpan('factory.harness.tool', {
							attributes: {
								'tool.name': event.name,
								'tool.id': event.id,
								'tool.input.summary': inputSummary,
								'tool.input.bytes': inputBytes,
								'factory.run.id': runId,
								'factory.step': stepId,
								'factory.iter': n,
								...toolInputAttributes(event.name, event.input),
							},
						});
						const startedAt = yield* Clock.currentTimeMillis;
						toolSpans.set(event.id, { span, name: event.name, startedAt });
						yield* persistAndEmit({
							type: 'tool.start',
							runId,
							step: stepId,
							iter: n,
							toolCallId: event.id,
							tool: event.name,
							inputSummary,
							inputBytes,
						});
						return;
					}
					case 'tool.end': {
						const entry = toolSpans.get(event.id);
						if (!entry) {
							yield* Effect.logWarning(`tool.end for unknown tool id ${event.id} (parser desync?)`);
							return;
						}
						const endedAt = yield* Clock.currentTimeMillis;
						const durationMs = endedAt - entry.startedAt;
						const { summary: outputSummary, bytes: outputBytes } = describeForSpan(event.output);
						entry.span.attribute('tool.ok', event.ok);
						entry.span.attribute('tool.output.summary', outputSummary);
						entry.span.attribute('tool.output.bytes', outputBytes);
						entry.span.attribute('tool.duration_ms', durationMs);
						entry.span.end(
							BigInt(endedAt) * 1_000_000n,
							event.ok ? Exit.void : Exit.fail(new Error('tool errored')),
						);
						toolSpans.delete(event.id);
						yield* Metric.increment(toolCallsTotal).pipe(
							Effect.tagMetrics('tool', entry.name),
							Effect.tagMetrics('ok', event.ok ? 'true' : 'false'),
						);
						yield* Metric.update(toolCallDurationMs, durationMs).pipe(
							Effect.tagMetrics('tool', entry.name),
						);
						yield* persistAndEmit({
							type: 'tool.end',
							runId,
							step: stepId,
							iter: n,
							toolCallId: event.id,
							tool: entry.name,
							ok: event.ok,
							outputSummary,
							outputBytes,
							durationMs,
						});
						return;
					}
					case 'result': {
						yield* Effect.annotateCurrentSpan({
							'factory.iter.cost_usd': event.costUsd ?? 0,
							'factory.iter.tokens.input': event.tokens?.input ?? 0,
							'factory.iter.tokens.output': event.tokens?.output ?? 0,
							'factory.iter.tokens.cache_read': event.tokens?.cacheRead ?? 0,
							'factory.iter.tokens.cache_create': event.tokens?.cacheCreate ?? 0,
							'factory.iter.harness_duration_ms': event.durationMs,
							'factory.iter.model': event.model ?? '',
							'factory.iter.ok': event.ok,
						});
						const model = event.model ?? '';
						const tokensIncrement = (kind: string, amount: number) =>
							Metric.incrementBy(tokensTotal, amount).pipe(
								Effect.tagMetrics('kind', kind),
								Effect.tagMetrics('model', model),
							);
						if (event.tokens) {
							yield* tokensIncrement('input', event.tokens.input);
							yield* tokensIncrement('output', event.tokens.output);
							if (event.tokens.cacheRead !== undefined) {
								yield* tokensIncrement('cache_read', event.tokens.cacheRead);
							}
							if (event.tokens.cacheCreate !== undefined) {
								yield* tokensIncrement('cache_create', event.tokens.cacheCreate);
							}
						}
						if (event.costUsd !== undefined && event.costUsd > 0) {
							yield* Metric.incrementBy(costMicroUsd, Math.round(event.costUsd * 1_000_000)).pipe(
								Effect.tagMetrics('model', model),
							);
						}
						yield* persistAndEmit({
							type: 'iter.result',
							runId,
							step: stepId,
							iter: n,
							ok: event.ok,
							costUsd: event.costUsd,
							tokens: event.tokens,
							model: event.model,
							durationMs: event.durationMs,
						});
						return;
					}
				}
			}),
		).pipe(
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

		// Force-close any tool spans left open by parser desync.
		if (toolSpans.size > 0) {
			const endedAt = yield* Clock.currentTimeMillis;
			const endTime = BigInt(endedAt) * 1_000_000n;
			for (const [id, entry] of toolSpans) {
				yield* Effect.logWarning(
					`tool.start without matching tool.end for id ${id} (${entry.name}) — force-closing span`,
				);
				entry.span.attribute('tool.ok', false);
				entry.span.attribute('tool.unmatched', true);
				entry.span.end(endTime, Exit.fail(new Error('tool span unmatched')));
			}
			toolSpans.clear();
		}

		const stdout = stdoutLines.length === 0 ? '' : `${stdoutLines.join('\n')}\n`;
		const stderr = stderrLines.length === 0 ? '' : `${stderrLines.join('\n')}\n`;

		yield* Metric.update(subprocessOutputBytes, stdout.length).pipe(
			Effect.tagMetrics('stream', 'stdout'),
		);
		yield* Metric.update(subprocessOutputBytes, stderr.length).pipe(
			Effect.tagMetrics('stream', 'stderr'),
		);

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

		const stepStartedAt = yield* Clock.currentTimeMillis;

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
			const iterStartedAt = yield* Clock.currentTimeMillis;
			const iterPassed = yield* Effect.gen(function* () {
				yield* workspace.recordIterStart({ stepOrd, n: i, prompt: fullPrompt });
				yield* emitAndRecord(emitter, workspace, {
					type: 'step.iter',
					runId,
					step: stepId,
					iter: i,
				});
				yield* display.stepIter(stepId, i, maxIters);

				const lastResult = yield* streamHarnessIter({
					runId,
					harness,
					harnessName,
					opts: { prompt: fullPrompt, cwd, idleTimeoutMs, permissions },
					stepId,
					stepOrd,
					n: i,
					workspace,
					emitter,
					display,
				});

				if (until === undefined) {
					yield* workspace.recordIterEnd({ stepOrd, n: i, exitCode: lastResult.exitCode });
					return true;
				}
				const passed = yield* evaluator.evaluate(until, { step: stepId, cwd, lastResult }).pipe(
					Effect.withSpan('factory.until.eval', {
						attributes: {
							'factory.until.predicate': until,
							'factory.step': stepId,
							'factory.iter': i,
						},
					}),
				);
				yield* Effect.annotateCurrentSpan('factory.until.passed', passed);
				yield* workspace.recordIterEnd({
					stepOrd,
					n: i,
					exitCode: lastResult.exitCode,
					untilPassed: passed,
				});
				return passed;
			}).pipe(
				Effect.withSpan('factory.iter', {
					attributes: {
						'factory.run.id': runId,
						'factory.step': stepId,
						'factory.harness': args.harness.name,
						'factory.iter': i,
						'factory.iter.max': maxIters,
					},
				}),
			);

			const iterEndedAt = yield* Clock.currentTimeMillis;
			const terminator = iterPassed ? (until === undefined ? 'no-until' : 'until') : 'iter';
			yield* Metric.increment(itersTotal).pipe(
				Effect.tagMetrics('terminated_by', terminator),
				Effect.tagMetrics('harness', harnessName),
			);
			yield* Metric.update(iterDurationMs, iterEndedAt - iterStartedAt).pipe(
				Effect.tagMetrics('terminated_by', terminator),
				Effect.tagMetrics('harness', harnessName),
			);

			if (iterPassed) {
				success = true;
				break;
			}
		}

		const stepEndedAt = yield* Clock.currentTimeMillis;
		const stepOutcome = success ? 'ok' : 'failed';
		const stepTags = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
			eff.pipe(
				Effect.tagMetrics('outcome', stepOutcome),
				Effect.tagMetrics('step', stepId),
				Effect.tagMetrics('harness', harnessName),
			);
		yield* stepTags(Metric.increment(stepsTotal));
		yield* stepTags(Metric.update(stepDurationMs, stepEndedAt - stepStartedAt));

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
		recordTaggedError,
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

		yield* Effect.annotateCurrentSpan({
			'factory.run.id': runId,
			'factory.pipeline': pipeline,
			'factory.cwd': cwd,
			'factory.prd.source': runOpts.prd,
			'factory.steps.count': steps.length,
		});

		yield* display.runStart(pipeline, runId);

		const runStartedAt = yield* Clock.currentTimeMillis;

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
				const loaded = yield* loader.load(entry.source, cwd).pipe(
					Effect.withSpan('factory.step.load', {
						attributes: {
							'factory.step': stepId,
							'factory.step.source': entry.source,
						},
					}),
				);
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

		const recordRunMetrics = (outcome: 'ok' | 'error') =>
			Effect.gen(function* () {
				const endedAt = yield* Clock.currentTimeMillis;
				yield* Metric.increment(runsTotal).pipe(
					Effect.tagMetrics('outcome', outcome),
					Effect.tagMetrics('pipeline', pipeline),
				);
				yield* Metric.update(runDurationMs, endedAt - runStartedAt).pipe(
					Effect.tagMetrics('outcome', outcome),
					Effect.tagMetrics('pipeline', pipeline),
				);
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
			Effect.tapError(() => recordRunMetrics('error')),
		);

		yield* workspace.recordRunEnd({ status: 'ok' });
		yield* recordRunMetrics('ok');
		yield* emitAndRecord(emitter, workspace, { type: 'run.end', runId });
		yield* display.runEnd(runId);
	}).pipe(
		Effect.withSpan('factory.run', {
			attributes: { 'factory.pipeline': factoryOpts.name },
		}),
	);
