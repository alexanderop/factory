import * as OtelMetrics from '@opentelemetry/api';

/**
 * Low-cardinality OTel instruments for factory.
 * Tags MUST NOT include run IDs, step IDs, file paths, or prompt fragments.
 * High-cardinality context belongs on spans (via attributes), not metrics.
 */

const meter = OtelMetrics.metrics.getMeter('factory');

/** Duration of a step (all iterations) in milliseconds. Tags: step, harness, ok. */
export const stepDuration = meter.createHistogram('factory.step.duration', {
	description: 'Duration of a factory step (all iterations) in milliseconds',
	unit: 'ms',
});

/** Number of iterations a step ran. Tags: step, harness. */
export const stepIters = meter.createHistogram('factory.step.iters', {
	description: 'Number of iterations a factory step ran',
	unit: '{iterations}',
});

/** Count of tool calls made by a harness. Tags: harness, tool_name, ok. */
export const toolCalls = meter.createCounter('factory.tool.calls', {
	description: 'Number of tool calls made by a harness',
	unit: '{calls}',
});

/** Duration of a single tool call in milliseconds. Tags: harness, tool_name. */
export const toolDuration = meter.createHistogram('factory.tool.duration', {
	description: 'Duration of a single tool call in milliseconds',
	unit: 'ms',
});

/** Token usage reported by the harness. Tags: harness, model, kind (input|output|cache_read|cache_creation). */
export const genAiTokens = meter.createHistogram('factory.gen_ai.tokens', {
	description: 'Token usage reported by the harness',
	unit: '{tokens}',
});

/** Exit code emitted by the harness subprocess. Tags: harness, code. */
export const harnessExitCode = meter.createCounter('factory.harness.exit_code', {
	description: 'Exit code emitted by the harness subprocess',
	unit: '{exits}',
});
