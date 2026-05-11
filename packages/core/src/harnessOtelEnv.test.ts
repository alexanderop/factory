import { describe, expect, it } from 'vitest';
import { harnessOtelEnv } from './harnessOtelEnv.ts';
import { makeHarnessOtelEnvArgs, makeRunId, makeStepId } from './testing/index.ts';

const baseArgs = makeHarnessOtelEnvArgs();
const ENDPOINT = 'http://localhost:4317';

describe('harnessOtelEnv', () => {
	it('returns {} when OTEL_SDK_DISABLED=true', () => {
		expect(
			harnessOtelEnv({
				...baseArgs,
				env: { OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT, OTEL_SDK_DISABLED: 'true' },
			}),
		).toEqual({});
	});

	it('returns {} when OTLP endpoint is unset', () => {
		expect(harnessOtelEnv({ ...baseArgs, env: {} })).toEqual({});
	});

	it('produces W3C TRACEPARENT and resource attributes when configured', () => {
		const env = harnessOtelEnv({
			...baseArgs,
			runId: makeRunId('run-1'),
			stepId: makeStepId('plan'),
			iter: 3,
			traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			spanId: 'bbbbbbbbbbbbbbbb',
			sampled: true,
			env: { OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT },
		});
		expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(ENDPOINT);
		expect(env.OTEL_SERVICE_NAME).toBe('claude-code');
		expect(env.TRACEPARENT).toBe('00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01');
		expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe(
			'factory.run.id=run-1,factory.step=plan,factory.iter=3',
		);
	});

	it('flips traceparent flags to 00 for unsampled spans', () => {
		const env = harnessOtelEnv({
			...baseArgs,
			sampled: false,
			env: { OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT },
		});
		expect(env.TRACEPARENT?.endsWith('-00')).toBe(true);
	});

	it('appends to existing OTEL_RESOURCE_ATTRIBUTES', () => {
		const env = harnessOtelEnv({
			...baseArgs,
			env: {
				OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT,
				OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=dev',
			},
		});
		expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe(
			'deployment.environment=dev,factory.run.id=r,factory.step=s,factory.iter=1',
		);
	});

	it('merges harness-specific extra env (e.g. CLAUDE_CODE_ENABLE_TELEMETRY)', () => {
		const env = harnessOtelEnv({
			...baseArgs,
			extraEnv: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
			env: { OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT },
		});
		expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
	});
});
