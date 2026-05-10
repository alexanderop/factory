import { describe, it } from '@effect/vitest';
import { deepStrictEqual, strictEqual } from '@effect/vitest/utils';
import { Effect } from 'effect';
import { Hook } from '../builders.ts';
import { HookRegistry } from './HookRegistry.ts';

const denyPathsSpec = Hook.denyPaths(['**/.env*']);
const effectSpec = Hook.effect({
	on: 'preToolUse',
	handler: () => Effect.succeed(Hook.allow),
});
const stopSpec = Hook.rule({ on: 'stop', decide: 'allow' });

describe('HookRegistry', () => {
	it.effect('all returns all registered specs', () =>
		Effect.gen(function* () {
			const registry = yield* HookRegistry;
			const all = yield* registry.all;
			strictEqual(all.length, 3);
		}).pipe(
			Effect.provide(HookRegistry.layer([denyPathsSpec, effectSpec, stopSpec])),
		),
	);

	it.effect('byId returns the matching spec', () =>
		Effect.gen(function* () {
			const registry = yield* HookRegistry;
			const found = yield* registry.byId(denyPathsSpec.id);
			deepStrictEqual(found?._tag, 'RuleSpec');
		}).pipe(
			Effect.provide(HookRegistry.layer([denyPathsSpec, effectSpec])),
		),
	);

	it.effect('byEvent returns specs for matching event type', () =>
		Effect.gen(function* () {
			const registry = yield* HookRegistry;
			const preSpecs = yield* registry.byEvent('preToolUse');
			strictEqual(preSpecs.length, 2);
			const stopSpecs = yield* registry.byEvent('stop');
			strictEqual(stopSpecs.length, 1);
		}).pipe(
			Effect.provide(HookRegistry.layer([denyPathsSpec, effectSpec, stopSpec])),
		),
	);

	it.effect('byEvent returns empty array when no specs match', () =>
		Effect.gen(function* () {
			const registry = yield* HookRegistry;
			const sessionSpecs = yield* registry.byEvent('sessionStart');
			strictEqual(sessionSpecs.length, 0);
		}).pipe(
			Effect.provide(HookRegistry.layer([denyPathsSpec])),
		),
	);

	it.effect('HookRegistry.Test layer works as a test double', () =>
		Effect.gen(function* () {
			const registry = yield* HookRegistry;
			const all = yield* registry.all;
			strictEqual(all.length, 0);
		}).pipe(Effect.provide(HookRegistry.Test)),
	);
});
