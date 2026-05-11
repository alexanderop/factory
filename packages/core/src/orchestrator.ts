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
	ResumeUnavailableError,
	StepIdleTimeoutError,
	StepMaxItersError,
	UnsupportedPermissionError,
	type FactoryError,
	type HarnessSpawnError,
	type RunRecordingError,
} from './errors.ts';
import { emitAndRecord, factoryHarnessEnv, resolvePermissions } from './pipelineHelpers.ts';
import { runReview } from './review/runReview.ts';
import { planResume, readStep, type ResumePlan } from './services/runManifest.ts';
import { harnessOtelEnv } from './harnessOtelEnv.ts';
import { HarnessName, PipelineName, type RunId, StepId } from './ids.ts';
import {
	describeForSpan,
	recordTaggedError,
	toolInputAttributes,
	toolOutputAttributes,
} from './observability.ts';
import { Display, type DisplayService } from './services/Display.ts';
import { EventEmitter, type EventEmitterService } from './services/EventEmitter.ts';
import { HarnessRegistry } from './services/HarnessRegistry.ts';
import { buildIterPrompt } from './services/iterPrompt.ts';
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
	PipelineEntry,
	ResumeOptions,
	RunOptions,
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

interface IterStreamResult {
	readonly result: ExecResult;
	readonly toolFailures: number;
}

type ExitReason = 'assistant_end' | 'idle_timeout' | 'error' | 'subprocess_exit_nonzero';

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
	IterStreamResult,
	HarnessExecError | HarnessSpawnError | StepIdleTimeoutError | RunRecordingError,
	CommandExecutor.CommandExecutor
> =>
	Effect.gen(function* () {
		const stdoutLines: string[] = [];
		const stderrLines: string[] = [];
		const toolSpans = new Map<string, ToolSpanEntry>();
		let exitCode = 0;

		let assistantMessageCount = 0;
		let toolCalls = 0;
		let toolCallsFailed = 0;
		const toolCallsCancelled = 0;
		let bytesStdout = 0;
		let bytesStderr = 0;
		let resultEventCount = 0;

		const iterSpan = yield* Effect.option(Effect.currentSpan);
		const annotateIter = (key: string, value: unknown) => {
			if (iterSpan._tag === 'Some') iterSpan.value.attribute(key, value);
		};
		const eventOnIter = (
			name: string,
			startTime: bigint,
			attrs?: Record<string, string | number | boolean>,
		) => {
			if (iterSpan._tag === 'Some') iterSpan.value.event(name, startTime, attrs);
		};

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

		const annotateExitReasonOnError = <A, E extends { readonly _tag: string }, R>(
			eff: Effect.Effect<A, E, R>,
		): Effect.Effect<A, E, R> =>
			eff.pipe(
				Effect.tapError((error) =>
					Effect.sync(() => {
						annotateIter(
							'factory.iter.exit.reason',
							error._tag === 'StepIdleTimeoutError' ? 'idle_timeout' : 'error',
						);
					}),
				),
			);

		yield* annotateExitReasonOnError(
			Stream.runForEach(harness.stream(optsWithEnv), (event) =>
				Effect.gen(function* () {
					switch (event.type) {
						case 'stdout': {
							stdoutLines.push(event.line);
							bytesStdout += Buffer.byteLength(event.line, 'utf8') + 1;
							yield* workspace.appendStdout(stepOrd, n, `${event.line}\n`);
							yield* display.harnessLine(stepId, 'stdout', event.line);
							return;
						}
						case 'stderr': {
							stderrLines.push(event.line);
							bytesStderr += Buffer.byteLength(event.line, 'utf8') + 1;
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
							bytesStdout += Buffer.byteLength(event.text, 'utf8') + 1;
							assistantMessageCount += 1;
							yield* workspace.appendStdout(stepOrd, n, `${event.text}\n`);
							yield* display.harnessLine(stepId, 'stdout', event.text);
							yield* Metric.increment(assistantMessagesTotal);
							const ts = yield* Clock.currentTimeMillis;
							eventOnIter('assistant.message', BigInt(ts) * 1_000_000n, {
								bytes: Buffer.byteLength(event.text, 'utf8'),
							});
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
							const span = yield* Effect.makeSpan(`factory.harness.tool ${event.name}`, {
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
							toolCalls += 1;
							eventOnIter('tool.start', BigInt(startedAt) * 1_000_000n, {
								'tool.id': event.id,
								'tool.name': event.name,
							});
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
								yield* Effect.logWarning(
									`tool.end for unknown tool id ${event.id} (parser desync?)`,
								);
								return;
							}
							const endedAt = yield* Clock.currentTimeMillis;
							const durationMs = endedAt - entry.startedAt;
							const { summary: outputSummary, bytes: outputBytes } = describeForSpan(event.output);
							entry.span.attribute('tool.ok', event.ok);
							entry.span.attribute('tool.output.summary', outputSummary);
							entry.span.attribute('tool.output.bytes', outputBytes);
							entry.span.attribute('tool.duration_ms', durationMs);
							const outputAttrs = toolOutputAttributes(entry.name, event.output, event.ok);
							for (const [key, value] of Object.entries(outputAttrs)) {
								entry.span.attribute(key, value);
							}
							entry.span.end(
								BigInt(endedAt) * 1_000_000n,
								event.ok ? Exit.void : Exit.fail(new Error('tool errored')),
							);
							toolSpans.delete(event.id);
							if (!event.ok) toolCallsFailed += 1;
							yield* Metric.increment(toolCallsTotal).pipe(
								Effect.tagMetrics('tool', entry.name),
								Effect.tagMetrics('ok', event.ok ? 'true' : 'false'),
							);
							yield* Metric.update(toolCallDurationMs, durationMs).pipe(
								Effect.tagMetrics('tool', entry.name),
							);
							eventOnIter('tool.end', BigInt(endedAt) * 1_000_000n, {
								'tool.id': event.id,
								'tool.name': entry.name,
								'tool.ok': event.ok,
							});
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
							resultEventCount += 1;
							const tokensInput = event.tokens?.input ?? 0;
							const tokensOutput = event.tokens?.output ?? 0;
							const tokensCacheRead = event.tokens?.cacheRead ?? 0;
							const tokensCacheCreate = event.tokens?.cacheCreate ?? 0;
							annotateIter('factory.iter.cost_usd', event.costUsd ?? 0);
							annotateIter('factory.iter.tokens.input', tokensInput);
							annotateIter('factory.iter.tokens.output', tokensOutput);
							annotateIter('factory.iter.tokens.cache_read', tokensCacheRead);
							annotateIter('factory.iter.tokens.cache_create', tokensCacheCreate);
							annotateIter('factory.iter.harness_duration_ms', event.durationMs);
							annotateIter('factory.iter.model', event.model ?? '');
							annotateIter('factory.iter.ok', event.ok);
							annotateIter('gen_ai.system', harness.name);
							if (event.model) annotateIter('gen_ai.request.model', event.model);
							annotateIter('gen_ai.usage.input_tokens', tokensInput);
							annotateIter('gen_ai.usage.output_tokens', tokensOutput);
							annotateIter('gen_ai.usage.cache_read_input_tokens', tokensCacheRead);
							annotateIter('gen_ai.usage.cache_creation_input_tokens', tokensCacheCreate);
							annotateIter('gen_ai.response.finish_reasons', [event.ok ? 'stop' : 'error']);
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

		const exitReason: ExitReason =
			exitCode !== 0 ? 'subprocess_exit_nonzero' : resultEventCount > 0 ? 'assistant_end' : 'error';

		annotateIter('factory.iter.assistant.message.count', assistantMessageCount);
		annotateIter('factory.iter.tool.calls', toolCalls);
		annotateIter('factory.iter.tool.calls_failed', toolCallsFailed);
		annotateIter('factory.iter.tool.calls_cancelled', toolCallsCancelled);
		annotateIter('factory.iter.bytes.stdout', bytesStdout);
		annotateIter('factory.iter.bytes.stderr', bytesStderr);
		annotateIter('factory.iter.exit.reason', exitReason);

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

		return {
			result: { exitCode, stdout, stderr },
			toolFailures: toolCallsFailed,
		} satisfies IterStreamResult;
	});

const runStep = (
	args: RunStepArgs,
): Effect.Effect<
	void,
	FactoryError,
	| Display
	| EventEmitter
	| UntilEvaluator
	| RunWorkspace
	| CommandExecutor.CommandExecutor
	| FileSystem.FileSystem
	| Path.Path
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

		const basePrompt = prd ? `# PRD\n\n${prd}\n\n# Step\n\n${loaded.prompt}` : loaded.prompt;

		let success = false;
		for (let i = 1; i <= maxIters; i++) {
			const iterStartedAt = yield* Clock.currentTimeMillis;
			const iterOutcome = yield* Effect.gen(function* () {
				const fullPrompt = yield* buildIterPrompt({
					runDir: workspace.runDir,
					stepOrd,
					stepId,
					previousIter: i - 1,
					basePrompt,
				});
				yield* workspace.recordIterStart({ stepOrd, n: i, prompt: fullPrompt });
				yield* emitAndRecord(emitter, workspace, {
					type: 'step.iter',
					runId,
					step: stepId,
					iter: i,
				});
				yield* display.stepIter(stepId, i, maxIters);

				const { result: lastResult, toolFailures } = yield* streamHarnessIter({
					runId,
					harness,
					harnessName,
					opts: {
						prompt: fullPrompt,
						cwd,
						idleTimeoutMs,
						permissions,
						env: factoryHarnessEnv(workspace.runDir, cwd, runId),
					},
					stepId,
					stepOrd,
					n: i,
					workspace,
					emitter,
					display,
				});

				let passed: boolean;
				if (until === undefined) {
					yield* workspace.recordIterEnd({ stepOrd, n: i, exitCode: lastResult.exitCode });
					passed = true;
				} else {
					passed = yield* evaluator.evaluate(until, { step: stepId, cwd, lastResult }).pipe(
						Effect.withSpan(`factory.until.eval ${stepId}#${i}`, {
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
				}

				if (toolFailures > 0) {
					return yield* Effect.fail({ _tag: 'IterToolFailure' as const, passed });
				}
				return passed;
			}).pipe(
				Effect.withSpan(`factory.iter ${stepId}#${i}`, {
					attributes: {
						'factory.run.id': runId,
						'factory.step': stepId,
						'factory.harness': args.harness.name,
						'factory.permission.mode': permissions,
						'factory.iter': i,
						'factory.iter.max': maxIters,
					},
				}),
				Effect.catchTag('IterToolFailure', (e) => Effect.succeed(e.passed)),
			);
			const iterPassed = iterOutcome;

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
		Effect.withSpan(`factory.step.run ${args.stepId}`, {
			attributes: {
				'factory.step': args.stepId,
				'factory.harness': args.harness.name,
				'factory.permission.mode': args.permissions,
				'factory.run.id': args.runId,
			},
		}),
	);

interface StepLoopArgs {
	readonly runId: RunId;
	readonly factoryOpts: FactoryOptions;
	readonly steps: ReadonlyArray<PipelineEntry>;
	readonly cwd: string;
	readonly prd: string;
	readonly idleTimeoutMs: number | undefined;
	readonly permissionsOverride: PermissionMode | undefined;
	readonly skipBeforeOrd: number;
	readonly defaultHarness: HarnessName | undefined;
}

const runStepLoop = (args: StepLoopArgs) =>
	Effect.gen(function* () {
		const loader = yield* StepLoader;
		const registry = yield* HarnessRegistry;
		const display = yield* Display;
		const {
			runId,
			factoryOpts,
			steps,
			cwd,
			prd,
			idleTimeoutMs,
			permissionsOverride,
			skipBeforeOrd,
			defaultHarness,
		} = args;
		for (const [ord, entry] of steps.entries()) {
			const stepId = StepId.make(entry.id);
			if (ord < skipBeforeOrd) {
				yield* display.stepStart(stepId);
				yield* display.stepEnd(stepId, true);
				continue;
			}
			if (entry.kind === 'review') {
				yield* runReview({
					runId,
					stepOrd: ord,
					entry,
					cwd,
					prd,
					defaultHarness,
					factoryOpts,
					permissionsOverride,
				}).pipe(
					recordTaggedError,
					Effect.withSpan(`factory.step ${stepId}`, {
						attributes: {
							'factory.step': stepId,
							'factory.step.kind': 'review',
							'factory.run.id': runId,
						},
					}),
				);
				continue;
			}
			yield* Effect.gen(function* () {
				const loaded = yield* loader.load(entry.source, cwd).pipe(
					Effect.withSpan(`factory.step.load ${stepId}`, {
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
					permissionsOverride,
					loaded,
					entry.options,
					factoryOpts,
					harness,
				);
				yield* Effect.annotateCurrentSpan({
					'factory.harness': harnessName,
					'factory.permission.mode': permissions,
				});
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
					idleTimeoutMs,
					permissions,
				});
			}).pipe(
				recordTaggedError,
				Effect.withSpan(`factory.step ${stepId}`, {
					attributes: {
						'factory.step': stepId,
						'factory.step.source': entry.source,
						'factory.run.id': runId,
					},
				}),
			);
		}
	});

export const runFactoryEffect = (
	factoryOpts: FactoryOptions,
	steps: ReadonlyArray<PipelineEntry>,
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
		const workspace = yield* RunWorkspace;

		const runId = workspace.runId;
		const pipeline = PipelineName.make(factoryOpts.name);
		const cwd = runOpts.cwd ?? process.cwd();

		const defaultHarness = factoryOpts.harness ? HarnessName.make(factoryOpts.harness) : undefined;
		const runPermissions = runOpts.permissions ?? factoryOpts.permissions;

		yield* Effect.annotateCurrentSpan({
			'factory.run.id': runId,
			'factory.pipeline': pipeline,
			'factory.cwd': cwd,
			'factory.prd.source': runOpts.prd,
			'factory.steps.count': steps.length,
			...(defaultHarness ? { 'factory.harness': defaultHarness } : {}),
			...(runPermissions ? { 'factory.permission.mode': runPermissions } : {}),
		});

		yield* display.runStart(pipeline, runId);

		const runStartedAt = yield* Clock.currentTimeMillis;

		const prd = yield* resolvePrdContent(runOpts.prd, cwd);

		yield* workspace.recordRunStart({
			pipeline,
			defaultHarness,
			cwd,
			prdSource: runOpts.prd,
			prdContent: prd,
		});
		yield* emitAndRecord(emitter, workspace, { type: 'run.start', runId, pipeline });

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

		yield* runStepLoop({
			runId,
			factoryOpts,
			steps,
			cwd,
			prd,
			idleTimeoutMs: runOpts.idleTimeoutMs,
			permissionsOverride: runOpts.permissions,
			skipBeforeOrd: 0,
			defaultHarness,
		}).pipe(
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
		Effect.withSpan(`factory.run ${factoryOpts.name}`, {
			attributes: { 'factory.pipeline': factoryOpts.name },
		}),
	);

const readPrdFromRunDir = (runDir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const prdPath = path.join(runDir, 'prd.md');
		return yield* fs.readFileString(prdPath).pipe(
			Effect.mapError(
				(e) =>
					new PrdLoadError({
						message: `failed to read PRD from run dir: ${e.message}`,
						path: prdPath,
					}),
			),
		);
	});

const loadRecordedSteps = (runDir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const stepsRoot = path.join(runDir, 'steps');
		const exists = yield* fs.exists(stepsRoot).pipe(
			Effect.mapError(
				(e) =>
					new ResumeUnavailableError({
						message: `failed to stat ${stepsRoot}: ${e.message}`,
						reason: 'not-found',
					}),
			),
		);
		if (!exists) return [];
		const subdirs = yield* fs.readDirectory(stepsRoot).pipe(
			Effect.mapError(
				(e) =>
					new ResumeUnavailableError({
						message: `failed to read ${stepsRoot}: ${e.message}`,
						reason: 'not-found',
					}),
			),
		);
		const records = [];
		for (const name of subdirs) {
			const stepJsonPath = path.join(stepsRoot, name, 'step.json');
			const has = yield* fs.exists(stepJsonPath).pipe(
				Effect.mapError(
					(e) =>
						new ResumeUnavailableError({
							message: `failed to stat ${stepJsonPath}: ${e.message}`,
							reason: 'not-found',
						}),
				),
			);
			if (!has) continue;
			records.push(yield* readStep(stepJsonPath));
		}
		return records.toSorted((a, b) => a.ord - b.ord);
	});

export const resumeFactoryEffect = (
	factoryOpts: FactoryOptions,
	steps: ReadonlyArray<PipelineEntry>,
	resumeOpts: ResumeOptions,
): Effect.Effect<
	ResumePlan,
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
		const workspace = yield* RunWorkspace;

		const runId = workspace.runId;
		const pipeline = PipelineName.make(factoryOpts.name);
		const cwd = resumeOpts.cwd ?? process.cwd();

		const recorded = yield* loadRecordedSteps(workspace.runDir);
		const pipelineRefs = steps.map((entry, ord) => ({ ord, stepId: StepId.make(entry.id) }));
		const plan = yield* planResume(recorded, pipelineRefs);
		if (plan.kind === 'already-done') {
			return yield* Effect.fail(
				new ResumeUnavailableError({
					message: `run '${runId}' is already complete; nothing to resume`,
					reason: 'already-complete',
				}),
			);
		}

		const defaultHarness = factoryOpts.harness ? HarnessName.make(factoryOpts.harness) : undefined;
		const runPermissions = resumeOpts.permissions ?? factoryOpts.permissions;

		yield* Effect.annotateCurrentSpan({
			'factory.run.id': runId,
			'factory.pipeline': pipeline,
			'factory.cwd': cwd,
			'factory.steps.count': steps.length,
			'factory.resume.from_ord': plan.stepOrd,
			...(defaultHarness ? { 'factory.harness': defaultHarness } : {}),
			...(runPermissions ? { 'factory.permission.mode': runPermissions } : {}),
		});

		yield* display.runStart(pipeline, runId);

		const runStartedAt = yield* Clock.currentTimeMillis;

		const prd = yield* readPrdFromRunDir(workspace.runDir);

		yield* workspace.recordRunResume({ fromStepOrd: plan.stepOrd });
		yield* emitAndRecord(emitter, workspace, { type: 'run.start', runId, pipeline });

		const recordRunMetrics = (outcome: 'ok' | 'error') =>
			Effect.gen(function* () {
				const endedAt = yield* Clock.currentTimeMillis;
				yield* Metric.increment(runsTotal).pipe(
					Effect.tagMetrics('outcome', outcome),
					Effect.tagMetrics('pipeline', pipeline),
					Effect.tagMetrics('resumed', 'true'),
				);
				yield* Metric.update(runDurationMs, endedAt - runStartedAt).pipe(
					Effect.tagMetrics('outcome', outcome),
					Effect.tagMetrics('pipeline', pipeline),
					Effect.tagMetrics('resumed', 'true'),
				);
			});

		yield* runStepLoop({
			runId,
			factoryOpts,
			steps,
			cwd,
			prd,
			idleTimeoutMs: resumeOpts.idleTimeoutMs,
			permissionsOverride: resumeOpts.permissions,
			skipBeforeOrd: plan.stepOrd,
			defaultHarness,
		}).pipe(
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
		return plan;
	}).pipe(
		Effect.withSpan(`factory.resume`, {
			attributes: { 'factory.pipeline': factoryOpts.name },
		}),
	);
