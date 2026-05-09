import { Metric, MetricBoundaries } from 'effect';

/** 1ms..32s exponential histogram, sized for short tool calls and long iters. */
const durationBoundaries = MetricBoundaries.exponential({ start: 1, factor: 2, count: 16 });

/** 64B..2MiB exponential histogram for byte sizes. */
const byteBoundaries = MetricBoundaries.exponential({ start: 64, factor: 4, count: 12 });

export const runsTotal = Metric.counter('factory.runs_total', {
	description: 'Total factory runs by outcome.',
});

export const runDurationMs = Metric.histogram(
	'factory.run_duration_ms',
	durationBoundaries,
	'Run duration in milliseconds.',
);

export const stepsTotal = Metric.counter('factory.steps_total', {
	description: 'Total step executions by outcome.',
});

export const stepDurationMs = Metric.histogram(
	'factory.step_duration_ms',
	durationBoundaries,
	'Step duration in milliseconds.',
);

export const itersTotal = Metric.counter('factory.iters_total', {
	description: 'Total iter executions by terminator (until/maxIters/error).',
});

export const iterDurationMs = Metric.histogram(
	'factory.iter_duration_ms',
	durationBoundaries,
	'Iter duration in milliseconds.',
);

export const harnessSpawnsTotal = Metric.counter('factory.harness_spawns_total', {
	description: 'Subprocess spawn attempts by outcome.',
});

export const idleTimeoutsTotal = Metric.counter('factory.idle_timeouts_total', {
	description: 'Idle-timeout kills.',
});

export const errorsTotal = Metric.counter('factory.errors_total', {
	description: 'Tagged FactoryError occurrences.',
});

export const toolCallsTotal = Metric.counter('factory.tool_calls_total', {
	description: 'Tool calls observed in coding-harness output.',
});

export const toolCallDurationMs = Metric.histogram(
	'factory.tool_call_duration_ms',
	durationBoundaries,
	'Tool call duration in milliseconds.',
);

export const tokensTotal = Metric.counter('factory.tokens_total', {
	description: 'Tokens consumed by kind (input/output/cache_read/cache_create).',
});

/** USD cost expressed in micro-dollars (cents × 10000) to keep counter integral. */
export const costMicroUsd = Metric.counter('factory.cost_micro_usd', {
	description: 'Accumulated cost in micro-dollars (USD × 1e6).',
});

export const assistantMessagesTotal = Metric.counter('factory.assistant_messages_total', {
	description: 'Assistant message blocks emitted by the harness.',
});

export const subprocessOutputBytes = Metric.histogram(
	'factory.subprocess_output_bytes',
	byteBoundaries,
	'Subprocess output in bytes per iter, per stream.',
);
