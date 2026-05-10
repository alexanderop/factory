import { NodeContext } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { assertInstanceOf, assertTrue, deepStrictEqual } from '@effect/vitest/utils';
import { Cause, Effect, Exit } from 'effect';
import type { HarnessCapabilities } from './capabilities.ts';
import { UnsupportedPermissionError } from './errors.ts';
import { createSubprocessHarness } from './subprocess.ts';
import type { PermissionMode } from './types.ts';

const baseCaps = (permissions: ReadonlyArray<PermissionMode>): HarnessCapabilities => ({
	loadSession: false,
	mcp: { http: false, sse: false },
	prompt: { image: false, audio: false, embeddedContext: false },
	session: { list: false, resume: false, close: false },
	factory: { permissions, toolEvents: false },
});

describe('createSubprocessHarness', () => {
	it.effect('passes the resolved permissions mode to buildArgs ctx', () =>
		Effect.gen(function* () {
			const calls: { prompt: string; permissions: PermissionMode }[] = [];
			const harness = createSubprocessHarness({
				name: 'echo-harness',
				bin: 'echo',
				capabilities: baseCaps(['skip', 'read-only']),
				defaultPermissions: 'skip',
				buildArgs: (prompt, { permissions }) => {
					calls.push({ prompt, permissions });
					return [];
				},
			});

			yield* harness.exec({ prompt: 'hi', permissions: 'read-only' });

			deepStrictEqual(calls, [{ prompt: 'hi', permissions: 'read-only' }]);
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it('exposes the configured permissions and defaultPermissions on the harness', () => {
		const harness = createSubprocessHarness({
			name: 'echo-harness',
			bin: 'echo',
			capabilities: baseCaps(['accept-edits', 'read-only']),
			defaultPermissions: 'accept-edits',
			buildArgs: () => [],
		});

		expect([...harness.capabilities.factory.permissions]).toEqual(['accept-edits', 'read-only']);
		expect(harness.defaultPermissions).toBe('accept-edits');
	});

	it.effect(
		'fails with UnsupportedPermissionError when exec is called with an unsupported permission mode',
		() =>
			Effect.gen(function* () {
				const harness = createSubprocessHarness({
					name: 'echo-harness',
					bin: 'echo',
					capabilities: baseCaps(['skip']),
					defaultPermissions: 'skip',
					buildArgs: () => [],
				});

				const exit = yield* Effect.exit(harness.exec({ prompt: 'hi', permissions: 'read-only' }));

				assertTrue(Exit.isFailure(exit));
				const failure = Cause.failureOption(exit.cause);
				assertTrue(failure._tag === 'Some');
				assertInstanceOf(failure.value, UnsupportedPermissionError);
				deepStrictEqual([...failure.value.supported], ['skip']);
				expect(failure.value.requested).toBe('read-only');
				expect(failure.value.harness).toBe('echo-harness');
			}).pipe(Effect.provide(NodeContext.layer)),
	);

	it('leaves defaultPermissions undefined when not configured', () => {
		const harness = createSubprocessHarness({
			name: 'echo-harness',
			bin: 'echo',
			capabilities: baseCaps(['skip', 'accept-edits', 'read-only', 'prompt']),
			buildArgs: () => [],
		});

		expect(harness.defaultPermissions).toBeUndefined();
	});
});
