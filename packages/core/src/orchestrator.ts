import { randomUUID } from 'node:crypto';
import { FileSystem, Path, type CommandExecutor } from '@effect/platform';
import { Effect } from 'effect';
import {
	MissingHarnessError,
	PrdLoadError,
	StepIdleTimeoutError,
	StepMaxItersError,
	type FactoryError,
} from './errors.ts';
import { HarnessName, PipelineName, RunId, StepId } from './ids.ts';
import * as FactoryMetrics from './metrics.ts';
import { Display } from './services/Display.ts';
import { EventEmitter } from './services/EventEmitter.ts';
import { HarnessRegistry } from './services/HarnessRegistry.ts';
import { HarnessTelemetry } from './services/HarnessTelemetry.ts';
import { StepLoader } from './services/StepLoader.ts';
import { UntilEvaluator } from './services/UntilEvaluator.ts';
import type {
	CaptureMode,
	ExecResult,
	FactoryOptions,
	Harness,
	LoadedStep,
	RunOptions,
	StepEntry,
	StepOptions,
} from './types.ts';

interface RunStepArgs {
	readonly runId: RunId;
	readonly stepId: StepId;
	readonly loaded: LoadedStep;
	readonly harness: Harness;
	readonly options: StepOptions;
	readonly cwd: string;
	readonly prd: string;
	readonly idleTimeoutMs?: number;
	readonly captureMode: CaptureMode;
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

const runStep = (
	args: RunStepArgs,
): Effect.Effect<
	void,
	FactoryError,
	Display | EventEmitter | UntilEvaluator | HarnessTelemetry | CommandExecutor.CommandExecutor
> =>
	Effect.gen(function* () {
		const display = yield* Display;
		const emitter = yield* EventEmitter;
		const evaluator = yield* UntilEvaluator;
		const telemetry = yield* HarnessTelemetry;
		const { runId, stepId, loaded, harness, options, cwd, prd, idleTimeoutMs, captureMode } = args;

		const maxIters = options.maxIters ?? loaded.frontmatter.maxIters ?? 1;
		const until = options.until ?? loaded.frontmatter.until;

		yield* emitter.emit({ type: 'step.start', runId, step: stepId });
		yield* display.stepStart(stepId);

		const fullPrompt = prd ? `# PRD\n\n${prd}\n\n# Step\n\n${loaded.prompt}` : loaded.prompt;

		const stepStartMs = Date.now();
		let success = false;
		let lastResult: ExecResult = { exitCode: 0, stdout: '', stderr: '' };

		for (let i = 1; i <= maxIters; i++) {
			yield* emitter.emit({ type: 'step.iter', runId, step: stepId, iter: i });
			yield* display.stepIter(stepId, i, maxIters);

			lastResult = yield* Effect.gen(function* () {
				const result = yield* telemetry
					.processStream(
						harness.stream({ prompt: fullPrompt, cwd, idleTimeoutMs }),
						HarnessName.make(harness.name),
						captureMode,
					)
					.pipe(
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
				return result;
			}).pipe(
				Effect.withSpan('factory.harness.exec', {
					attributes: {
						'factory.harness': harness.name,
						'factory.harness.bin': harness.name,
						'factory.step': stepId,
					},
				}),
			);

			if (until === undefined) {
				success = true;
				break;
			}

			const passed = yield* Effect.gen(function* () {
				return yield* evaluator.evaluate(until, { step: stepId, cwd, lastResult });
			}).pipe(
				Effect.withSpan('factory.until.eval', {
					attributes: {
						'factory.until': until,
						'factory.step': stepId,
					},
				}),
			);

			if (passed) {
				success = true;
				break;
			}
		}

		const stepDurationMs = Date.now() - stepStartMs;
		FactoryMetrics.stepDuration.record(stepDurationMs, {
			step: stepId,
			harness: harness.name,
			ok: String(success),
		});

		yield* emitter.emit({ type: 'step.end', runId, step: stepId, ok: success });
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
	| HarnessTelemetry
	| FileSystem.FileSystem
	| Path.Path
	| CommandExecutor.CommandExecutor
> =>
	Effect.gen(function* () {
		const display = yield* Display;
		const emitter = yield* EventEmitter;
		const loader = yield* StepLoader;
		const registry = yield* HarnessRegistry;

		const runId = RunId.make(randomUUID());
		const pipeline = PipelineName.make(factoryOpts.name);
		const cwd = runOpts.cwd ?? process.cwd();
		const captureMode = runOpts.captureMode ?? 'redacted';

		yield* display.runStart(pipeline, runId);
		yield* emitter.emit({ type: 'run.start', runId, pipeline });

		const prd = yield* resolvePrdContent(runOpts.prd, cwd);

		const body = Effect.gen(function* () {
			for (const entry of steps) {
				const stepId = StepId.make(entry.id);
				const loaded = yield* loader.load(entry.source, cwd);
				const harnessName =
					(entry.options.harness ? HarnessName.make(entry.options.harness) : undefined) ??
					loaded.frontmatter.harness ??
					(factoryOpts.harness ? HarnessName.make(factoryOpts.harness) : undefined);
				if (!harnessName) {
					return yield* Effect.fail(
						new MissingHarnessError({
							message: `step '${stepId}' has no harness (factory({harness}), step option, or frontmatter required)`,
							step: stepId,
						}),
					);
				}
				const harness = yield* registry.resolve(harnessName);
				yield* runStep({
					runId,
					stepId,
					loaded,
					harness,
					options: entry.options,
					cwd,
					prd,
					idleTimeoutMs: runOpts.idleTimeoutMs,
					captureMode,
				});
			}
		});

		yield* body.pipe(Effect.tapError((error) => emitter.emit({ type: 'error', runId, error })));

		yield* emitter.emit({ type: 'run.end', runId });
		yield* display.runEnd(runId);
	}).pipe(
		Effect.withSpan('factory.run', {
			attributes: { 'factory.pipeline': factoryOpts.name },
		}),
	);
