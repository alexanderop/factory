import * as OtelApi from '@opentelemetry/api';
import { Context, Effect, Layer, Stream } from 'effect';
import { HarnessExecError } from '../errors.ts';
import type { HarnessName } from '../ids.ts';
import * as FactoryMetrics from '../metrics.ts';
import { redact } from '../redact.ts';
import type { CaptureMode, ExecResult, HarnessEvent } from '../types.ts';

export interface HarnessTelemetryService {
	/**
	 * Consumes a harness event stream and returns an ExecResult.
	 *
	 * - Opens a child span for each `tool_use`, closes it on matching `tool_result`.
	 * - Any unmatched `tool_use` spans at stream end are force-closed with ERROR status.
	 * - `stdout` lines are forwarded via `Effect.logInfo`, `stderr` via `Effect.logWarning`.
	 * - Token `usage` events are recorded as metrics.
	 * - Never fails due to OTel errors — telemetry failures are best-effort.
	 */
	readonly processStream: <E, R>(
		stream: Stream.Stream<HarnessEvent, E, R>,
		harnessName: HarnessName,
		captureMode: CaptureMode,
	) => Effect.Effect<ExecResult, E | HarnessExecError, R>;
}

export class HarnessTelemetry extends Context.Tag('@factory/HarnessTelemetry')<
	HarnessTelemetry,
	HarnessTelemetryService
>() {}

const GEN_AI_OPERATION = 'gen_ai.operation.name';
const GEN_AI_TOOL_NAME = 'gen_ai.tool.name';
const GEN_AI_PROVIDER_NAME = 'gen_ai.provider.name';
const GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
const GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
const GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
const GEN_AI_USAGE_CACHE_READ_TOKENS = 'gen_ai.usage.cache_read_input_tokens';
const GEN_AI_USAGE_CACHE_CREATION_TOKENS = 'gen_ai.usage.cache_creation_input_tokens';

const PROVIDER_MAP: Record<string, string> = {
	'claude-code': 'anthropic',
	codex: 'openai',
	copilot: 'github',
};

/** Live implementation: uses the active OTel tracer and metrics instruments. */
export const LiveHarnessTelemetry = {
	layer: Layer.succeed(HarnessTelemetry, {
		processStream: <E, R>(
			eventStream: Stream.Stream<HarnessEvent, E, R>,
			harnessName: HarnessName,
			captureMode: CaptureMode,
		): Effect.Effect<ExecResult, E | HarnessExecError, R> =>
			Effect.gen(function* () {
				const tracer = OtelApi.trace.getTracer('factory');
				const openToolSpans = new Map<string, { span: OtelApi.Span; startMs: number; name: string }>();
				const stdoutLines: string[] = [];
				const stderrLines: string[] = [];
				let exitCode = 0;
				let currentModel: string | undefined;

				const closeToolSpan = (
					id: string,
					ok: boolean,
					output: unknown,
					error: string | undefined,
				) => {
					const entry = openToolSpans.get(id);
					if (!entry) return;
					openToolSpans.delete(id);
					const { span, startMs, name: toolName } = entry;
					const durationMs = Date.now() - startMs;

					if (captureMode !== 'off') {
						const outputAttr = redact(output, captureMode);
						if (outputAttr !== undefined) {
							span.setAttribute('gen_ai.tool.output', String(outputAttr));
						}
					}

					if (ok) {
						span.setStatus({ code: OtelApi.SpanStatusCode.OK });
					} else {
						span.setStatus({ code: OtelApi.SpanStatusCode.ERROR, message: error ?? 'tool error' });
						if (error) span.setAttribute('exception.message', error);
					}

					span.end();

					FactoryMetrics.toolCalls.add(1, {
						harness: harnessName,
						tool_name: toolName,
						ok: String(ok),
					});
					FactoryMetrics.toolDuration.record(durationMs, {
						harness: harnessName,
						tool_name: toolName,
					});
				};

				yield* Stream.runForEach(eventStream, (event) =>
					Effect.gen(function* () {
						switch (event.type) {
							case 'stdout': {
								stdoutLines.push(event.line);
								yield* Effect.logInfo(event.line).pipe(
									Effect.annotateLogs({ 'factory.harness': harnessName, stream: 'stdout' }),
									Effect.ignore,
								);
								break;
							}
							case 'stderr': {
								stderrLines.push(event.line);
								yield* Effect.logWarning(event.line).pipe(
									Effect.annotateLogs({ 'factory.harness': harnessName, stream: 'stderr' }),
									Effect.ignore,
								);
								break;
							}
							case 'tool_use': {
								const parentCtx = OtelApi.context.active();
								const span = tracer.startSpan(
									'factory.tool',
									{
										attributes: {
											[GEN_AI_OPERATION]: 'execute_tool',
											[GEN_AI_TOOL_NAME]: event.name,
											[GEN_AI_PROVIDER_NAME]: PROVIDER_MAP[harnessName] ?? harnessName,
											...(currentModel ? { [GEN_AI_REQUEST_MODEL]: currentModel } : {}),
											...(captureMode !== 'off'
												? { 'gen_ai.tool.input': String(redact(event.input, captureMode)) }
												: {}),
										},
									},
									parentCtx,
								);
								openToolSpans.set(event.id, { span, startMs: Date.now(), name: event.name });
								break;
							}
							case 'tool_result': {
								closeToolSpan(event.id, event.ok, event.output, event.error);
								break;
							}
							case 'usage': {
								if (event.model) currentModel = event.model;

								const modelTag = event.model ?? currentModel ?? 'unknown';
								if (event.inputTokens) {
									FactoryMetrics.genAiTokens.record(event.inputTokens, {
										harness: harnessName,
										model: modelTag,
										kind: 'input',
									});
								}
								if (event.outputTokens) {
									FactoryMetrics.genAiTokens.record(event.outputTokens, {
										harness: harnessName,
										model: modelTag,
										kind: 'output',
									});
								}
								if (event.cacheReadTokens) {
									FactoryMetrics.genAiTokens.record(event.cacheReadTokens, {
										harness: harnessName,
										model: modelTag,
										kind: 'cache_read',
									});
								}
								if (event.cacheCreationTokens) {
									FactoryMetrics.genAiTokens.record(event.cacheCreationTokens, {
										harness: harnessName,
										model: modelTag,
										kind: 'cache_creation',
									});
								}

								// Record usage on the current active span as GenAI semantic convention attrs
								const activeSpan = OtelApi.trace.getActiveSpan();
								if (activeSpan) {
									if (event.inputTokens)
										activeSpan.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, event.inputTokens);
									if (event.outputTokens)
										activeSpan.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, event.outputTokens);
									if (event.cacheReadTokens)
										activeSpan.setAttribute(GEN_AI_USAGE_CACHE_READ_TOKENS, event.cacheReadTokens);
									if (event.cacheCreationTokens)
										activeSpan.setAttribute(
											GEN_AI_USAGE_CACHE_CREATION_TOKENS,
											event.cacheCreationTokens,
										);
								}
								break;
							}
							case 'exit': {
								exitCode = event.code;
								FactoryMetrics.harnessExitCode.add(1, {
									harness: harnessName,
									code: String(event.code),
								});
								break;
							}
							case 'message':
								break;
						}
					}),
				);

				// Force-close any unmatched tool spans (crash mid-tool)
				for (const [id, { span, name: toolName }] of openToolSpans) {
					span.setStatus({
						code: OtelApi.SpanStatusCode.ERROR,
						message: 'tool span was not closed — harness may have crashed',
					});
					span.setAttribute('exception.message', `unmatched tool_use id=${id} name=${toolName}`);
					span.end();
				}
				openToolSpans.clear();

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
			}),
	} satisfies HarnessTelemetryService),
};

/** No-op implementation used when OTel is disabled — behaves exactly like harness.exec(). */
export const NoOpHarnessTelemetry = {
	layer: Layer.succeed(HarnessTelemetry, {
		processStream: <E, R>(
			eventStream: Stream.Stream<HarnessEvent, E, R>,
			harnessName: HarnessName,
			_captureMode: CaptureMode,
		): Effect.Effect<ExecResult, E | HarnessExecError, R> =>
			Effect.gen(function* () {
				const stdoutLines: string[] = [];
				const stderrLines: string[] = [];
				let exitCode = 0;

				yield* Stream.runForEach(eventStream, (event) =>
					Effect.sync(() => {
						if (event.type === 'stdout') stdoutLines.push(event.line);
						else if (event.type === 'stderr') stderrLines.push(event.line);
						else if (event.type === 'exit') exitCode = event.code;
					}),
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
			}),
	} satisfies HarnessTelemetryService),
};
