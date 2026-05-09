import type { RunId, StepId } from './ids.ts';

/**
 * Build the env vars needed for an OTel-aware subprocess to nest its spans
 * under the active iter span. Returns `{}` when OTel is disabled or no
 * collector endpoint is configured.
 *
 * Standard env vars are honored:
 *   - `OTEL_EXPORTER_OTLP_ENDPOINT`
 *   - `OTEL_SDK_DISABLED`
 *   - `OTEL_RESOURCE_ATTRIBUTES`
 *   - `TRACEPARENT` (W3C trace context, format: 00-<traceId>-<spanId>-<flags>)
 */
export const harnessOtelEnv = (args: {
	readonly harness: string;
	readonly runId: RunId;
	readonly stepId: StepId;
	readonly iter: number;
	readonly traceId: string;
	readonly spanId: string;
	readonly sampled: boolean;
	readonly extraEnv?: Readonly<Record<string, string>>;
}): Readonly<Record<string, string>> => {
	if (process.env.OTEL_SDK_DISABLED === 'true') return {};
	const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	if (!endpoint) return {};

	const flags = args.sampled ? '01' : '00';
	const traceparent = `00-${args.traceId}-${args.spanId}-${flags}`;

	const baseAttrs = `factory.run.id=${args.runId},factory.step=${args.stepId},factory.iter=${args.iter}`;
	const existingAttrs = process.env.OTEL_RESOURCE_ATTRIBUTES;
	const resourceAttrs = existingAttrs ? `${existingAttrs},${baseAttrs}` : baseAttrs;

	return {
		OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
		OTEL_SERVICE_NAME: args.harness,
		OTEL_RESOURCE_ATTRIBUTES: resourceAttrs,
		TRACEPARENT: traceparent,
		...args.extraEnv,
	};
};
