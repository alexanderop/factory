import { describe, it } from '@effect/vitest';
import { deepStrictEqual } from '@effect/vitest/utils';
import { Effect, Ref } from 'effect';
import type { HookConfig } from './config.ts';
import { ALLOW, type HookDecision } from './decision.ts';
import { dispatch } from './dispatcher.ts';
import type { FactoryHookEvent } from './events.ts';
import {
	makePostToolUseEvent,
	makePreToolUseEvent,
	makeSessionStartEvent,
} from './testing/events.ts';

describe('dispatch', () => {
	it.effect('returns allow when the config has no entries for the event', () =>
		Effect.gen(function* () {
			const decision = yield* dispatch({}, makePreToolUseEvent());
			deepStrictEqual(decision, ALLOW);
		}),
	);

	it.effect('returns allow when entries exist for a different event type', () =>
		Effect.gen(function* () {
			const config: HookConfig = {
				postToolUse: [{ handler: () => Effect.succeed({ action: 'deny', reason: 'no' }) }],
			};
			const decision = yield* dispatch(config, makePreToolUseEvent());
			deepStrictEqual(decision, ALLOW);
		}),
	);

	it.effect('runs handlers in declared order, merging via mergeDecisions', () =>
		Effect.gen(function* () {
			const order = yield* Ref.make<ReadonlyArray<string>>([]);
			const config: HookConfig = {
				preToolUse: [
					{
						handler: () =>
							Ref.update(order, (xs) => [...xs, 'a']).pipe(
								Effect.as<HookDecision>({ action: 'allow', additionalContext: 'A' }),
							),
					},
					{
						handler: () =>
							Ref.update(order, (xs) => [...xs, 'b']).pipe(
								Effect.as<HookDecision>({ action: 'allow', additionalContext: 'B' }),
							),
					},
				],
			};
			const decision = yield* dispatch(config, makePreToolUseEvent());
			deepStrictEqual(yield* Ref.get(order), ['a', 'b']);
			deepStrictEqual(decision, { action: 'allow', additionalContext: 'A\n\nB' });
		}),
	);

	it.effect('deny short-circuits — later handlers do not run', () =>
		Effect.gen(function* () {
			const order = yield* Ref.make<ReadonlyArray<string>>([]);
			const config: HookConfig = {
				preToolUse: [
					{
						handler: () =>
							Ref.update(order, (xs) => [...xs, 'first']).pipe(
								Effect.as<HookDecision>({ action: 'deny', reason: 'nope' }),
							),
					},
					{
						handler: () => Ref.update(order, (xs) => [...xs, 'second']).pipe(Effect.as(ALLOW)),
					},
				],
			};
			const decision = yield* dispatch(config, makePreToolUseEvent());
			deepStrictEqual(decision, { action: 'deny', reason: 'nope' });
			deepStrictEqual(yield* Ref.get(order), ['first']);
		}),
	);

	it.effect('skips handlers whose matcher rejects the event', () =>
		Effect.gen(function* () {
			const calls = yield* Ref.make<ReadonlyArray<string>>([]);
			const config: HookConfig = {
				preToolUse: [
					{
						match: 'Bash',
						handler: () => Ref.update(calls, (xs) => [...xs, 'bash']).pipe(Effect.as(ALLOW)),
					},
					{
						match: 'Write',
						handler: () =>
							Ref.update(calls, (xs) => [...xs, 'write']).pipe(
								Effect.as<HookDecision>({ action: 'deny', reason: 'forbidden' }),
							),
					},
				],
			};
			const decision = yield* dispatch(config, makePreToolUseEvent({ tool: 'Bash' }));
			deepStrictEqual(decision, ALLOW);
			deepStrictEqual(yield* Ref.get(calls), ['bash']);
		}),
	);

	it.effect('handler returning void is treated as allow', () =>
		Effect.gen(function* () {
			const config: HookConfig = {
				sessionStart: [{ handler: () => Effect.void }],
			};
			const decision = yield* dispatch(config, makeSessionStartEvent());
			deepStrictEqual(decision, ALLOW);
		}),
	);

	it.effect('handler receives the typed event payload it was configured for', () =>
		Effect.gen(function* () {
			const seen = yield* Ref.make<FactoryHookEvent | null>(null);
			const config: HookConfig = {
				postToolUse: [
					{
						handler: (event) => Ref.set(seen, event).pipe(Effect.as<HookDecision>(ALLOW)),
					},
				],
			};
			const event = makePostToolUseEvent({ tool: 'Edit', durationMs: 12 });
			yield* dispatch(config, event);
			deepStrictEqual(yield* Ref.get(seen), event);
		}),
	);
});
