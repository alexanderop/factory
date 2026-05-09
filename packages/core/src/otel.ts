import { NodeSdk } from '@effect/opentelemetry';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Layer } from 'effect';

/**
 * Effect-OTel layer that emits factory traces, logs, and metrics via OTLP/gRPC.
 *
 * Defaults to localhost:4317 (the Aspire Dashboard's default). Override with
 * standard OpenTelemetry env vars: `OTEL_EXPORTER_OTLP_ENDPOINT`,
 * `OTEL_EXPORTER_OTLP_HEADERS`, etc.
 *
 * `NodeSdk.layer` auto-installs an Effect logger that stamps the active
 * `traceId` / `spanId` onto every `Effect.log*` record, so logs and traces
 * are correlated in the backend without per-callsite work.
 */
export const OtelLayer = NodeSdk.layer(() => ({
	resource: { serviceName: 'factory' },
	spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter()),
	logRecordProcessor: new BatchLogRecordProcessor(new OTLPLogExporter()),
	metricReader: new PeriodicExportingMetricReader({
		exporter: new OTLPMetricExporter(),
		exportIntervalMillis: 10_000,
	}),
}));

/** No-op OTel layer used when --no-otel or OTEL_SDK_DISABLED=true. */
export const NoOtelLayer = Layer.empty;
