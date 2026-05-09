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
import { Display } from './services/Display.ts';
import { EventEmitter } from './services/EventEmitter.ts';
import { HarnessRegistry } from './services/HarnessRegistry.ts';
import { StepLoader } from './services/StepLoader.ts';
import { UntilEvaluator } from './services/UntilEvaluator.ts';
import type {
	ExecResult,
	FactoryOptions,
	Harness,
	LoadedStep,
	RunOptions,
	StepEntry,
	StepOptions,
} from './types.ts';

interface RunStepArgs {
	readonly runId: string;
	readonly stepId: string;
	readonly loaded: LoadedStep;
	readonly harness: Harness;
	readonly options: StepOptions;
	readonly cwd: string;
	readonly prd: string;
	readonly idleTimeoutMs?: number;
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
	Display | EventEmitter | UntilEvaluator | CommandExecutor.CommandExecutor
> =>
	Effect.gen(function* () {
		const display = yield* Display;
		const emitter = yield* EventEmitter;
		const evaluator = yield* UntilEvaluator;
		const { runId, stepId, loaded, harness, options, cwd, prd, idleTimeoutMs } = args;

		const maxIters = options.maxIters ?? loaded.frontmatter.maxIters ?? 1;
		const until = options.until ?? loaded.frontmatter.until;

		yield* emitter.emit({ type: 'step.start', runId, step: stepId });
		yield* display.stepStart(stepId);

		const fullPrompt = prd ? `# PRD\n\n${prd}\n\n# Step\n\n${loaded.prompt}` : loaded.prompt;

		let success = false;
		let lastResult: ExecResult = { exitCode: 0, stdout: '', stderr: '' };
		for (let i = 1; i <= maxIters; i++) {
			yield* emitter.emit({ type: 'step.iter', runId, step: stepId, iter: i });
			yield* display.stepIter(stepId, i, maxIters);

			lastResult = yield* harness.exec({ prompt: fullPrompt, cwd, idleTimeoutMs }).pipe(
				Effect.mapError((e) =>
					e._tag === 'StepIdleTimeoutError'
						? new StepIdleTimeoutError({ message: e.message, step: stepId, timeoutMs: e.timeoutMs })
						: e,
				),
			);

			if (until === undefined) {
				success = true;
				break;
			}
			const passed = yield* evaluator.evaluate(until, { step: stepId, cwd, lastResult });
			if (passed) {
				success = true;
				break;
			}
		}

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
	| FileSystem.FileSystem
	| Path.Path
	| CommandExecutor.CommandExecutor
> =>
	Effect.gen(function* () {
		const display = yield* Display;
		const emitter = yield* EventEmitter;
		const loader = yield* StepLoader;
		const registry = yield* HarnessRegistry;

		const runId = randomUUID();
		const cwd = runOpts.cwd ?? process.cwd();

		yield* display.runStart(factoryOpts.name, runId);
		yield* emitter.emit({ type: 'run.start', runId, pipeline: factoryOpts.name });

		const prd = yield* resolvePrdContent(runOpts.prd, cwd);

		const body = Effect.gen(function* () {
			for (const entry of steps) {
				const loaded = yield* loader.load(entry.source, cwd);
				const harnessName =
					entry.options.harness ?? loaded.frontmatter.harness ?? factoryOpts.harness;
				if (!harnessName) {
					return yield* Effect.fail(
						new MissingHarnessError({
							message: `step '${entry.id}' has no harness (factory({harness}), step option, or frontmatter required)`,
							step: entry.id,
						}),
					);
				}
				const harness = yield* registry.resolve(harnessName);
				yield* runStep({
					runId,
					stepId: entry.id,
					loaded,
					harness,
					options: entry.options,
					cwd,
					prd,
					idleTimeoutMs: runOpts.idleTimeoutMs,
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
