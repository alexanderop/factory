import { describe, it } from '@effect/vitest';
import { strictEqual } from '@effect/vitest/utils';
import { Effect, FastCheck, Schema } from 'effect';
import { HarnessName, PipelineName, RunId, StepId } from './ids.ts';

// Brands in `ids.ts` are `Schema.String.pipe(Schema.brand(...))` — no min-length
// or pattern constraint. Any string (including empty) is a valid input. We use
// a plain `FastCheck.string()` arbitrary directly.

describe('branded IDs', () => {
	it.effect.prop(
		'RunId / StepId / HarnessName / PipelineName round-trip through decode/encode',
		{ raw: FastCheck.string() },
		({ raw }) =>
			Effect.gen(function* () {
				for (const brand of [RunId, StepId, HarnessName, PipelineName]) {
					const id = yield* Schema.decode(brand)(raw);
					const encoded = yield* Schema.encode(brand)(id);
					strictEqual(encoded, raw);
				}
			}),
	);
});
