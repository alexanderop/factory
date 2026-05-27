import { describe, it } from '@effect/vitest';
import { deepStrictEqual } from '@effect/vitest/utils';
import { HookRunner } from '@factory/core';
import { Effect, Ref } from 'effect';
import type { HookConfig } from '../config.ts';
import { ALLOW } from '../decision.ts';
import { makePreToolUseEvent } from '../testing/events.ts';
import { liveHookRunner } from './HookRunner.ts';

describe('liveHookRunner', () => {
	it.effect('decodes the structural event and runs the configured handler', () => {
		const seen = Ref.unsafeMake<ReadonlyArray<string>>([]);
		const config: HookConfig = {
			preToolUse: [
				{
					handler: (event) => Ref.update(seen, (xs) => [...xs, event.tool]).pipe(Effect.as(ALLOW)),
				},
			],
		};
		return Effect.gen(function* () {
			const runner = yield* HookRunner;
			const decision = yield* runner.dispatch(makePreToolUseEvent({ tool: 'Bash' }));
			deepStrictEqual(decision, { action: 'allow' });
			deepStrictEqual(yield* Ref.get(seen), ['Bash']);
		}).pipe(Effect.provide(liveHookRunner.layer(config)));
	});

	it.effect('an unknown event shape fails open (allow) instead of crashing', () =>
		Effect.gen(function* () {
			const runner = yield* HookRunner;
			const decision = yield* runner.dispatch({ _tag: 'notAFactoryHook', foo: 1 });
			deepStrictEqual(decision, { action: 'allow' });
		}).pipe(Effect.provide(liveHookRunner.layer({}))),
	);
});
