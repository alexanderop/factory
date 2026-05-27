import { RunId, StepId } from '@factory/core';
import { expect } from 'vitest';
import type { HarnessHookAdapter, HarnessHookAdapterArgs } from '../adapter.ts';
import type { HookEventType } from '../events.ts';
import { HOOK_EVENT_TYPES } from '../events.ts';

const SOCKET = '/tmp/factory-hooks.sock';
const OUT_DIR = '/tmp/factory-run/out';

const args = (events: ReadonlyArray<HookEventType>): HarnessHookAdapterArgs => ({
	socketPath: SOCKET,
	events,
	outDir: OUT_DIR,
	runId: RunId.make('contract-run'),
	stepId: StepId.make('contract-step'),
	iter: 1,
});

/** Reusable contract suite every harness adapter must satisfy. Each test
 *  uses RED-state friendly assertions: if `buildConfig` is unimplemented the
 *  TypeError surfaces immediately, so a passing run proves the adapter
 *  actually built a config. */
export const assertAdapterContract = (
	adapter: HarnessHookAdapter,
	expectations: {
		readonly supportedEvents: ReadonlyArray<HookEventType>;
		readonly format: 'json' | 'toml';
	},
): void => {
	const supported = new Set(expectations.supportedEvents);
	const firstUnsupported = HOOK_EVENT_TYPES.find((e) => !supported.has(e));

	expect(adapter.supportedEvents).toEqual(supported);

	const result = adapter.buildConfig(args(expectations.supportedEvents));
	expect(result.format).toBe(expectations.format);
	expect(result.path.startsWith(OUT_DIR)).toBe(true);
	expect(result.content.includes(SOCKET)).toBe(true);

	for (const event of expectations.supportedEvents) {
		expect(result.content.includes(event), `config must reference event ${event}`).toBe(true);
	}

	if (firstUnsupported !== undefined) {
		expect(() => adapter.buildConfig(args([firstUnsupported]))).toThrow(
			/does not support|unsupported|HookCapabilityError/i,
		);
	}
};
