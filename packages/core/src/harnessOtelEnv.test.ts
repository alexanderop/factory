import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harnessOtelEnv } from './harnessOtelEnv.ts';
import { HarnessName, RunId, StepId } from './ids.ts';

const baseArgs = {
	harness: HarnessName.make('claude-code'),
	runId: RunId.make('r'),
	stepId: StepId.make('s'),
	iter: 1,
	traceId: '0123456789abcdef0123456789abcdef',
	spanId: '0123456789abcdef',
	sampled: true,
} as const;

describe('harnessOtelEnv', () => {
	const originalEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	const originalDisabled = process.env.OTEL_SDK_DISABLED;
	const originalAttrs = process.env.OTEL_RESOURCE_ATTRIBUTES;

	beforeEach(() => {
		delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
		delete process.env.OTEL_SDK_DISABLED;
		delete process.env.OTEL_RESOURCE_ATTRIBUTES;
	});

	afterEach(() => {
		if (originalEndpoint !== undefined) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpoint;
		if (originalDisabled !== undefined) process.env.OTEL_SDK_DISABLED = originalDisabled;
		if (originalAttrs !== undefined) process.env.OTEL_RESOURCE_ATTRIBUTES = originalAttrs;
	});

	it('returns {} when OTEL_SDK_DISABLED=true', () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4317';
		process.env.OTEL_SDK_DISABLED = 'true';
		expect(harnessOtelEnv(baseArgs)).toEqual({});
	});

	it('returns {} when OTLP endpoint is unset', () => {
		expect(harnessOtelEnv(baseArgs)).toEqual({});
	});

	it('produces W3C TRACEPARENT and resource attributes when configured', () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4317';
		const env = harnessOtelEnv({
			...baseArgs,
			runId: RunId.make('run-1'),
			stepId: StepId.make('plan'),
			iter: 3,
			traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			spanId: 'bbbbbbbbbbbbbbbb',
			sampled: true,
		});
		expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://localhost:4317');
		expect(env.OTEL_SERVICE_NAME).toBe('claude-code');
		expect(env.TRACEPARENT).toBe('00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01');
		expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe(
			'factory.run.id=run-1,factory.step=plan,factory.iter=3',
		);
	});

	it('flips traceparent flags to 00 for unsampled spans', () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4317';
		const env = harnessOtelEnv({ ...baseArgs, sampled: false });
		expect(env.TRACEPARENT?.endsWith('-00')).toBe(true);
	});

	it('appends to existing OTEL_RESOURCE_ATTRIBUTES', () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4317';
		process.env.OTEL_RESOURCE_ATTRIBUTES = 'deployment.environment=dev';
		const env = harnessOtelEnv(baseArgs);
		expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe(
			'deployment.environment=dev,factory.run.id=r,factory.step=s,factory.iter=1',
		);
	});

	it('merges harness-specific extra env (e.g. CLAUDE_CODE_ENABLE_TELEMETRY)', () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4317';
		const env = harnessOtelEnv({ ...baseArgs, extraEnv: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' } });
		expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
	});
});
