import { randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import { loadStep } from './loader.ts';
import { resolveHarness } from './registry.ts';
import type {
	Factory,
	FactoryEvent,
	FactoryOptions,
	LoadedStep,
	RunOptions,
	StepOptions,
} from './types.ts';

const tracer = trace.getTracer('factory');

interface StepEntry {
	id: string;
	source: string;
	options: StepOptions;
}

export function factory(opts: FactoryOptions): Factory {
	const steps: StepEntry[] = [];

	const self: Factory = {
		name: opts.name,
		step(id, source, stepOptions) {
			steps.push({ id, source, options: stepOptions ?? {} });
			return self;
		},
		async run(runOpts) {
			await runFactory(opts, steps, runOpts);
		},
	};

	return self;
}

async function runFactory(
	factoryOpts: FactoryOptions,
	steps: StepEntry[],
	runOpts: RunOptions,
): Promise<void> {
	const runId = randomUUID();
	const cwd = runOpts.cwd ?? process.cwd();
	const emit = (event: FactoryEvent) => {
		runOpts.onStep?.(event);
		if (event.type === 'error') runOpts.onError?.(event);
	};

	await tracer.startActiveSpan(
		'factory.run',
		{ attributes: { 'factory.run.id': runId, 'factory.pipeline': factoryOpts.name } },
		async (rootSpan) => {
			emit({ type: 'run.start', runId, pipeline: factoryOpts.name });
			try {
				for (const entry of steps) {
					const loaded = await loadStep(entry.source, cwd);
					const harnessName =
						entry.options.harness ?? loaded.frontmatter.harness ?? factoryOpts.harness;
					if (!harnessName) {
						throw new Error(
							`step '${entry.id}' has no harness (set factory({ harness }), step option, or frontmatter)`,
						);
					}
					await runStep({
						runId,
						pipeline: factoryOpts.name,
						stepId: entry.id,
						loaded,
						harnessName,
						cwd,
						prd: runOpts.prd,
						emit,
					});
				}
				emit({ type: 'run.end', runId });
			} catch (error) {
				emit({ type: 'error', runId, error });
				rootSpan.recordException(error as Error);
				throw error;
			} finally {
				rootSpan.end();
			}
		},
	);
}

interface RunStepArgs {
	runId: string;
	pipeline: string;
	stepId: string;
	loaded: LoadedStep;
	harnessName: string;
	cwd: string;
	prd: string;
	emit: (event: FactoryEvent) => void;
}

async function runStep(args: RunStepArgs): Promise<void> {
	const { runId, stepId, loaded, harnessName, cwd, emit } = args;
	const harness = resolveHarness(harnessName);

	await tracer.startActiveSpan(
		'factory.step',
		{ attributes: { 'factory.step': stepId, 'factory.harness': harnessName } },
		async (span) => {
			emit({ type: 'step.start', runId, step: stepId });
			try {
				// TODO: actually run the harness, handle until/maxIters loop, write output to ctx.state.
				throw new Error(
					`step runner not implemented yet — would run '${stepId}' on '${harnessName}' with prompt of length ${loaded.prompt.length}`,
				);
			} catch (error) {
				emit({ type: 'step.end', runId, step: stepId, ok: false });
				span.recordException(error as Error);
				throw error;
			} finally {
				span.end();
			}
		},
	);
}
