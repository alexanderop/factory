#!/usr/bin/env -S node --experimental-strip-types
import { Effect, Match, Schema, Stream } from 'effect';
import { HookRuntimeError } from '../errors.ts';
import type { HookId } from '../ids.ts';
import {
	AllowDecision,
	DenyDecision,
	HookDecision,
	HookEvent,
	type HookSpec,
} from '../schema.ts';
import { HookRegistry } from '../services/HookRegistry.ts';

const decodeEvent = Schema.decodeUnknown(Schema.parseJson(HookEvent));
const encodeHookDecision = Schema.encodeSync(HookDecision);

type EffectHandler = (event: typeof HookEvent.Type) => Effect.Effect<typeof HookDecision.Type, HookRuntimeError>;

const isEffectHandler = (v: unknown): v is EffectHandler => typeof v === 'function';

export interface RunShimOpts {
	readonly hookId: HookId;
	readonly stdinStream: Stream.Stream<Uint8Array>;
}

/** Testable core: reads an event from stdinStream, looks up spec, runs handler. */
export const runShim = (
	opts: RunShimOpts,
): Effect.Effect<typeof HookDecision.Type, HookRuntimeError, HookRegistry> =>
	Effect.gen(function* () {
		const registry = yield* HookRegistry;

		const chunks = yield* Stream.runCollect(opts.stdinStream).pipe(
			Effect.mapError(
				(): HookRuntimeError =>
					new HookRuntimeError({
						message: 'failed to read stdin',
						hookId: opts.hookId,
					}),
			),
		);
		const raw = Buffer.concat(
			[...chunks].map((b) => Buffer.from(b)),
		).toString('utf8');

		const event = yield* decodeEvent(raw).pipe(
			Effect.mapError(
				(e): HookRuntimeError =>
					new HookRuntimeError({
						message: `failed to decode hook event: ${e.message}`,
						hookId: opts.hookId,
					}),
			),
		);

		const spec: HookSpec | undefined = yield* registry.byId(opts.hookId);
		if (!spec) {
			return yield* Effect.fail(
				new HookRuntimeError({
					message: `hook spec not found: ${opts.hookId}`,
					hookId: opts.hookId,
				}),
			);
		}

		if (spec._tag === 'EffectSpec') {
			if (!isEffectHandler(spec.handler)) {
				return yield* Effect.fail(
					new HookRuntimeError({
						message: 'hook handler is not a function',
						hookId: opts.hookId,
					}),
				);
			}
			return yield* spec.handler(event);
		}

		return Match.value(spec.decide).pipe(
			Match.when('deny', (): typeof HookDecision.Type => new DenyDecision({ reason: spec.reason })),
			Match.when('allow', (): typeof HookDecision.Type => new AllowDecision({})),
			Match.when('ask', (): typeof HookDecision.Type => new AllowDecision({})),
			Match.exhaustive,
		);
	});

/** Encode a HookDecision to JSON for stdout output. */
export const encodeDecision = (
	decision: typeof HookDecision.Type,
	_harness: string,
): { readonly json: string; readonly exitCode: number } => {
	const encoded = encodeHookDecision(decision);
	const json = JSON.stringify(encoded);
	const exitCode = decision._tag === 'Allow' || decision._tag === 'Modify' ? 0 : 2;
	return { json, exitCode };
};
