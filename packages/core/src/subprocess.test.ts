import { NodeContext } from '@effect/platform-node';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { createSubprocessHarness } from './subprocess.ts';
import type { PermissionMode } from './types.ts';

describe('createSubprocessHarness', () => {
	it('passes the resolved permissions mode to buildArgs ctx', async () => {
		const calls: { prompt: string; permissions: PermissionMode }[] = [];
		const harness = createSubprocessHarness({
			name: 'echo-harness',
			bin: 'echo',
			supports: ['skip', 'read-only'],
			defaultPermissions: 'skip',
			buildArgs: (prompt, { permissions }) => {
				calls.push({ prompt, permissions });
				return [];
			},
		});

		await Effect.runPromise(
			harness
				.exec({ prompt: 'hi', permissions: 'read-only' })
				.pipe(Effect.provide(NodeContext.layer)),
		);

		expect(calls).toEqual([{ prompt: 'hi', permissions: 'read-only' }]);
	});

	it('exposes the configured supports list and defaultPermissions on the harness', () => {
		const harness = createSubprocessHarness({
			name: 'echo-harness',
			bin: 'echo',
			supports: ['accept-edits', 'read-only'],
			defaultPermissions: 'accept-edits',
			buildArgs: () => [],
		});

		expect([...harness.supports]).toEqual(['accept-edits', 'read-only']);
		expect(harness.defaultPermissions).toBe('accept-edits');
	});

	it('leaves defaultPermissions undefined when not configured', () => {
		const harness = createSubprocessHarness({
			name: 'echo-harness',
			bin: 'echo',
			supports: ['skip', 'accept-edits', 'read-only', 'prompt'],
			buildArgs: () => [],
		});

		expect(harness.defaultPermissions).toBeUndefined();
	});
});
