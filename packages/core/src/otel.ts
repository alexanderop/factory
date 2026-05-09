import { NodeSdk } from '@effect/opentelemetry';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Layer } from 'effect';

/**
 * Effect-OTel layer that emits factory span trees via OTLP/gRPC.
 *
 * Defaults to localhost:4317 (the Aspire Dashboard's default). Override with
 * standard OpenTelemetry env vars: `OTEL_EXPORTER_OTLP_ENDPOINT`,
 * `OTEL_EXPORTER_OTLP_HEADERS`, etc.
 */
export const OtelLayer = NodeSdk.layer(() => ({
	resource: { serviceName: 'factory' },
	spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter()),
}));

/** No-op OTel layer used when --no-otel or OTEL_SDK_DISABLED=true. */
export const NoOtelLayer = Layer.empty;
