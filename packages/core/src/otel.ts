import { createRequire } from 'node:module';
import { NodeSdk } from '@effect/opentelemetry';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import type { LogRecordProcessor } from '@opentelemetry/sdk-logs';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import type { MetricReader } from '@opentelemetry/sdk-metrics';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Layer } from 'effect';

const require = createRequire(import.meta.url);

/**
 * Tries to load an OTLP gRPC log exporter.
 * Returns undefined if `@opentelemetry/exporter-logs-otlp-grpc` is not installed.
 *
 * To enable OTLP log export, install: @opentelemetry/exporter-logs-otlp-grpc
 */
const tryLoadLogProcessor = (): LogRecordProcessor | undefined => {
	try {
		const mod = require('@opentelemetry/exporter-logs-otlp-grpc') as Record<string, unknown>;
		const ExporterClass = mod['OTLPLogExporter'] as new () => Parameters<typeof BatchLogRecordProcessor>[0];
		return new BatchLogRecordProcessor(new ExporterClass());
	} catch {
		return undefined;
	}
};

/**
 * Tries to load an OTLP gRPC metrics exporter.
 * Returns undefined if `@opentelemetry/exporter-metrics-otlp-grpc` is not installed.
 *
 * To enable OTLP metrics export, install: @opentelemetry/exporter-metrics-otlp-grpc
 */
const tryLoadMetricReader = (): MetricReader | undefined => {
	try {
		const mod = require('@opentelemetry/exporter-metrics-otlp-grpc') as Record<string, unknown>;
		const ExporterClass = mod['OTLPMetricExporter'] as new () => Parameters<typeof PeriodicExportingMetricReader>[0]['exporter'];
		return new PeriodicExportingMetricReader({ exporter: new ExporterClass() });
	} catch {
		return undefined;
	}
};

/**
 * Effect-OTel layer that emits factory span trees, log records, and metrics via OTLP/gRPC.
 *
 * All three signals share the same endpoint (default: localhost:4317, the Aspire Dashboard default).
 * Override with standard OpenTelemetry env vars: `OTEL_EXPORTER_OTLP_ENDPOINT`,
 * `OTEL_EXPORTER_OTLP_HEADERS`, etc.
 *
 * Logs and metrics require additional packages:
 *   pnpm add @opentelemetry/exporter-logs-otlp-grpc @opentelemetry/exporter-metrics-otlp-grpc
 * If those packages are absent, only traces are exported (no error is thrown).
 */
export const OtelLayer = NodeSdk.layer(() => {
	const logRecordProcessor = tryLoadLogProcessor();
	const metricReader = tryLoadMetricReader();

	return {
		resource: { serviceName: 'factory' },
		spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter()),
		...(logRecordProcessor ? { logRecordProcessor } : {}),
		...(metricReader ? { metricReader } : {}),
	};
});

/** No-op OTel layer used when --no-otel or OTEL_SDK_DISABLED=true. */
export const NoOtelLayer = Layer.empty;
