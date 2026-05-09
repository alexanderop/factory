import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | undefined;

export interface InitOtelOptions {
	enabled?: boolean;
	serviceName?: string;
}

export function initOtel(options: InitOtelOptions = {}): void {
	const enabled = options.enabled ?? process.env.OTEL_SDK_DISABLED !== 'true';
	if (!enabled || sdk) return;

	sdk = new NodeSDK({
		resource: resourceFromAttributes({
			[ATTR_SERVICE_NAME]: options.serviceName ?? 'factory',
		}),
		traceExporter: new OTLPTraceExporter(),
	});
	sdk.start();
}

export async function shutdownOtel(): Promise<void> {
	if (!sdk) return;
	await sdk.shutdown();
	sdk = undefined;
}
