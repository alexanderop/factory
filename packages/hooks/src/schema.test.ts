import { describe, it } from '@effect/vitest';
import { deepStrictEqual } from '@effect/vitest/utils';
import { Effect, Schema } from 'effect';
import {
	AllowDecision,
	AskDecision,
	DenyDecision,
	HookDecision,
	ModifyDecision,
} from './schema.ts';

describe('HookDecision round-trips', () => {
	const decode = Schema.decodeUnknown(Schema.parseJson(HookDecision));

	it.effect('Allow round-trips through Schema.parseJson', () =>
		Effect.gen(function* () {
			const json = JSON.stringify({ _tag: 'Allow' });
			const result = yield* decode(json);
			deepStrictEqual(result._tag, 'Allow');
			deepStrictEqual(result instanceof AllowDecision, true);
		}),
	);

	it.effect('Deny round-trips through Schema.parseJson', () =>
		Effect.gen(function* () {
			const json = JSON.stringify({ _tag: 'Deny', reason: 'blocked by policy' });
			const result = yield* decode(json);
			deepStrictEqual(result._tag, 'Deny');
			deepStrictEqual(result instanceof DenyDecision, true);
			if (result._tag === 'Deny') {
				deepStrictEqual(result.reason, 'blocked by policy');
			}
		}),
	);

	it.effect('Ask round-trips through Schema.parseJson', () =>
		Effect.gen(function* () {
			const json = JSON.stringify({ _tag: 'Ask', prompt: 'Confirm push?' });
			const result = yield* decode(json);
			deepStrictEqual(result._tag, 'Ask');
			deepStrictEqual(result instanceof AskDecision, true);
			if (result._tag === 'Ask') {
				deepStrictEqual(result.prompt, 'Confirm push?');
			}
		}),
	);

	it.effect('Modify round-trips through Schema.parseJson', () =>
		Effect.gen(function* () {
			const json = JSON.stringify({ _tag: 'Modify', args: { command: 'echo safe' } });
			const result = yield* decode(json);
			deepStrictEqual(result._tag, 'Modify');
			deepStrictEqual(result instanceof ModifyDecision, true);
			if (result._tag === 'Modify') {
				deepStrictEqual(result.args, { command: 'echo safe' });
			}
		}),
	);
});
