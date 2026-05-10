import { NodeContext } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { assertInstanceOf, deepStrictEqual, strictEqual, assertTrue } from '@effect/vitest/utils';
import { Cause, Duration, Effect, Exit, Redacted, Ref, TestClock } from 'effect';
import type { HarnessCapabilities } from './capabilities.ts';
import { HarnessAuthError } from './errors.ts';
import { HarnessName } from './ids.ts';
import { createSubprocessHarness, withAuth } from './subprocess.ts';
import { OtelTestLayer, getFinishedSpans } from './testing/OtelTest.ts';
import type { PermissionMode } from './types.ts';

const baseCaps = (permissions: ReadonlyArray<PermissionMode>): HarnessCapabilities => ({
	loadSession: false,
	mcp: { http: false, sse: false },
	prompt: { image: false, audio: false, embeddedContext: false },
	session: { list: false, resume: false, close: false },
	factory: { permissions, toolEvents: false },
});

const authSpec = {
	envVars: [
		{ name: 'TEST_API_KEY', kind: 'api-key' as const, description: 'Test API key' },
		{ name: 'TEST_BEARER', kind: 'bearer' as const, description: 'Test bearer' },
	],
};

const printEnvHarness = (name = 'print-env') =>
	createSubprocessHarness({
		name,
		bin: 'node',
		capabilities: baseCaps(['skip']),
		defaultPermissions: 'skip',
		buildArgs: (prompt) => ['-e', prompt],
		auth: authSpec,
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

describe('withAuth', () => {
	describe('Inherit', () => {
		it.effect('child receives parent PATH and no injected auth keys', () =>
			Effect.gen(function* () {
				const harness = printEnvHarness();
				const authed = withAuth(harness, { _tag: 'Inherit' });
				const result = yield* authed.exec({
					prompt: `process.stdout.write(JSON.stringify({
  hasPath: typeof process.env.PATH === 'string',
  authKey: process.env.TEST_API_KEY ?? null,
}))`,
					permissions: 'skip',
				});
				const parsed: unknown = JSON.parse(result.stdout);
				expect(parsed).toMatchObject({ hasPath: true, authKey: null });
			}).pipe(Effect.provide(NodeContext.layer)),
		);
	});

	describe('ApiKey', () => {
		it.effect('injects first envVar with Redacted value into child env', () =>
			Effect.gen(function* () {
				const harness = printEnvHarness();
				const authed = withAuth(harness, {
					_tag: 'ApiKey',
					value: Redacted.make('sk-test-secret'),
				});
				const result = yield* authed.exec({
					prompt: `process.stdout.write(process.env.TEST_API_KEY ?? 'NOT_SET')`,
					permissions: 'skip',
				});
				strictEqual(result.stdout.trim(), 'sk-test-secret');
			}).pipe(Effect.provide(NodeContext.layer)),
		);

		it.effect('step-level env overrides auth env', () =>
			Effect.gen(function* () {
				const harness = printEnvHarness();
				const authed = withAuth(harness, {
					_tag: 'ApiKey',
					value: Redacted.make('sk-from-auth'),
				});
				const result = yield* authed.exec({
					prompt: `process.stdout.write(process.env.TEST_API_KEY ?? 'NOT_SET')`,
					permissions: 'skip',
					env: { TEST_API_KEY: 'sk-from-step' },
				});
				strictEqual(result.stdout.trim(), 'sk-from-step');
			}).pipe(Effect.provide(NodeContext.layer)),
		);

		it.effect('span includes factory.harness.auth.kind and factory.harness.auth.envKeys', () =>
			Effect.gen(function* () {
				const harness = printEnvHarness();
				const authed = withAuth(harness, {
					_tag: 'ApiKey',
					value: Redacted.make('sk-test'),
				});
				yield* authed
					.exec({
						prompt: `process.stdout.write('')`,
						permissions: 'skip',
					})
					.pipe(Effect.withSpan('test-root'));

				const spans = yield* getFinishedSpans();
				const authSpan = spans.find(
					(s) => s.attributes['factory.harness.auth.kind'] !== undefined,
				);
				strictEqual(authSpan?.attributes['factory.harness.auth.kind'], 'api-key');
				strictEqual(authSpan?.attributes['factory.harness.auth.envKeys'], 'TEST_API_KEY');
			}).pipe(Effect.provide(OtelTestLayer), Effect.provide(NodeContext.layer)),
		);

		it.effect('fails with HarnessAuthError when harness has no auth spec', () =>
			Effect.gen(function* () {
				const harness = createSubprocessHarness({
					name: 'no-spec',
					bin: 'echo',
					capabilities: baseCaps(['skip']),
					buildArgs: () => [],
				});
				const authed = withAuth(harness, {
					_tag: 'ApiKey',
					value: Redacted.make('sk-test'),
				});
				const exit = yield* Effect.exit(authed.exec({ prompt: 'hi', permissions: 'skip' }));
				assertTrue(Exit.isFailure(exit));
				const err = Cause.failureOption(exit.cause);
				if (err._tag === 'Some') {
					assertInstanceOf(err.value, HarnessAuthError);
				}
			}).pipe(Effect.provide(NodeContext.layer)),
		);
	});

	describe('Env', () => {
		it.effect('injects multiple env vars with mixed Redacted and plain string values', () =>
			Effect.gen(function* () {
				const harness = printEnvHarness();
				const authed = withAuth(harness, {
					_tag: 'Env',
					env: {
						TEST_API_KEY: Redacted.make('redacted-key'),
						TEST_PLAIN: 'plain-value',
					},
				});
				const result = yield* authed.exec({
					prompt: `process.stdout.write(JSON.stringify({
  k: process.env.TEST_API_KEY ?? null,
  p: process.env.TEST_PLAIN ?? null,
}))`,
					permissions: 'skip',
				});
				const parsed: unknown = JSON.parse(result.stdout);
				expect(parsed).toMatchObject({ k: 'redacted-key', p: 'plain-value' });
			}).pipe(Effect.provide(NodeContext.layer)),
		);
	});

	describe('Helper', () => {
		it.effect('fetch is invoked once across two consecutive execs within TTL', () =>
			Effect.gen(function* () {
				const callsRef = yield* Ref.make(0);
				const fetch = Ref.updateAndGet(callsRef, (n) => n + 1).pipe(
					Effect.map((n) => ({ TEST_API_KEY: `value-${n}` })),
				);
				const harness = printEnvHarness();
				const authed = withAuth(harness, {
					_tag: 'Helper',
					fetch,
					ttl: Duration.minutes(5),
				});
				const prompt = `process.stdout.write(process.env.TEST_API_KEY ?? 'NOT_SET')`;
				const r1 = yield* authed.exec({ prompt, permissions: 'skip' });
				const r2 = yield* authed.exec({ prompt, permissions: 'skip' });
				const calls = yield* Ref.get(callsRef);
				strictEqual(calls, 1);
				strictEqual(r1.stdout.trim(), 'value-1');
				strictEqual(r2.stdout.trim(), 'value-1');
			}).pipe(Effect.provide(NodeContext.layer)),
		);

		it.effect('fetch is re-invoked after TTL expires', () =>
			Effect.gen(function* () {
				const callsRef = yield* Ref.make(0);
				const fetch = Ref.updateAndGet(callsRef, (n) => n + 1).pipe(
					Effect.map((n) => ({ TEST_API_KEY: `value-${n}` })),
				);
				const harness = printEnvHarness();
				const authed = withAuth(harness, {
					_tag: 'Helper',
					fetch,
					ttl: Duration.millis(100),
				});
				const prompt = `process.stdout.write(process.env.TEST_API_KEY ?? 'NOT_SET')`;
				yield* authed.exec({ prompt, permissions: 'skip' });
				yield* TestClock.adjust(Duration.millis(200));
				yield* authed.exec({ prompt, permissions: 'skip' });
				const calls = yield* Ref.get(callsRef);
				strictEqual(calls, 2);
			}).pipe(Effect.provide(NodeContext.layer)),
		);

		it.effect('failure from fetch propagates as HarnessAuthError', () =>
			Effect.gen(function* () {
				const fetch = Effect.fail(
					new HarnessAuthError({ message: 'vault error', harness: HarnessName.make('print-env') }),
				);
				const harness = printEnvHarness();
				const authed = withAuth(harness, { _tag: 'Helper', fetch });
				const exit = yield* Effect.exit(
					authed.exec({ prompt: `process.stdout.write('')`, permissions: 'skip' }),
				);
				assertTrue(Exit.isFailure(exit));
				const err = Cause.failureOption(exit.cause);
				if (err._tag === 'Some') {
					assertInstanceOf(err.value, HarnessAuthError);
					strictEqual(err.value.message, 'vault error');
				}
			}).pipe(Effect.provide(NodeContext.layer)),
		);
	});

	it.effect('withAuth method on harness delegates to re-wrapped withAuth', () =>
		Effect.gen(function* () {
			const harness = printEnvHarness();
			const authed1 = withAuth(harness, { _tag: 'ApiKey', value: Redacted.make('key-1') });
			const authed2 = authed1.withAuth!({ _tag: 'ApiKey', value: Redacted.make('key-2') });
			const result = yield* authed2.exec({
				prompt: `process.stdout.write(process.env.TEST_API_KEY ?? 'NOT_SET')`,
				permissions: 'skip',
			});
			strictEqual(result.stdout.trim(), 'key-2');
		}).pipe(Effect.provide(NodeContext.layer)),
	);
});
