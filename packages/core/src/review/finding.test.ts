import { describe, it } from '@effect/vitest';
import { strictEqual } from '@effect/vitest/utils';
import { Arbitrary, Effect } from 'effect';
import { decodeFindings, encodeFindings, Findings } from './finding.ts';

// `Finding.line` is `Schema.Number`, so the generator can produce NaN / Infinity
// which don't round-trip through JSON (`JSON.stringify(NaN) === 'null'`). Filter
// to finite numbers — the test exercises codec semantics, not JSON's lossy
// treatment of non-finites.
//
// We assert codec involution (encode → decode → encode is idempotent) instead of
// `deepStrictEqual(decoded, original)` because `Schema.optional` drops keys
// whose value is `undefined`, while the generator may produce them explicitly.

const findingsArb = Arbitrary.make(Findings).filter((v: Findings) =>
	v.findings.every((f) => f.line === undefined || Number.isFinite(f.line)),
);

describe('Findings JSON codec', () => {
	it.effect.prop(
		'Findings round-trip is involutive (encode → decode → encode is idempotent)',
		{ value: findingsArb },
		({ value }) =>
			Effect.gen(function* () {
				const json1 = yield* encodeFindings(value);
				const decoded = yield* decodeFindings(json1);
				const json2 = yield* encodeFindings(decoded);
				strictEqual(json2, json1);
			}),
	);
});
