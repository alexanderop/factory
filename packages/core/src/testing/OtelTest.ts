import { NodeSdk } from '@effect/opentelemetry';
import {
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { Context, Effect, Layer } from 'effect';

export interface OtelTestService {
	readonly exporter: InMemorySpanExporter;
}

export class OtelTest extends Context.Tag('@factory/testing/OtelTest')<
	OtelTest,
	OtelTestService
>() {}

const exporterLayer: Layer.Layer<OtelTest> = Layer.sync(OtelTest, () => ({
	exporter: new InMemorySpanExporter(),
}));

const sdkLayer = Layer.unwrapEffect(
	Effect.gen(function* () {
		const { exporter } = yield* OtelTest;
		return NodeSdk.layer(() => ({
			resource: { serviceName: 'factory-test' },
			spanProcessor: new SimpleSpanProcessor(exporter),
		}));
	}),
);

/**
 * In-memory OTel layer for tests. Provides a `SpanExporter` you can read with
 * `getFinishedSpans()` after the effect completes. No network, no flakes.
 */
export const OtelTestLayer = sdkLayer.pipe(Layer.provideMerge(exporterLayer));

export const getFinishedSpans = (): Effect.Effect<ReadonlyArray<ReadableSpan>, never, OtelTest> =>
	Effect.gen(function* () {
		const { exporter } = yield* OtelTest;
		return exporter.getFinishedSpans();
	});

export const getSpanNames = (): Effect.Effect<ReadonlyArray<string>, never, OtelTest> =>
	getFinishedSpans().pipe(Effect.map((spans) => spans.map((s) => s.name)));

export const resetSpans = (): Effect.Effect<void, never, OtelTest> =>
	Effect.gen(function* () {
		const { exporter } = yield* OtelTest;
		exporter.reset();
	});
