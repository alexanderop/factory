import { factory } from '@factory/core';
import { claudeCode } from '@factory/harness-claude-code';
import { Effect, Schema } from 'effect';

/** What each review agent must emit to `$FACTORY_STEP_OUTPUT`. */
const ReviewSchema = Schema.Struct({
	file: Schema.String,
	severity: Schema.Literal('P1', 'P2', 'P3'),
	summary: Schema.String,
});
type Review = typeof ReviewSchema.Type;

const stringFiles = (value: unknown): ReadonlyArray<string> =>
	Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/**
 * Programmatic triage workflow. Demonstrates the new primitives:
 *
 *  - `phase(title)`   — breadcrumb that maps onto Display + the `phase.start` event
 *  - `parallel(...)`  — bounded fan-out; a failing agent becomes `null`
 *  - `agent(p, opts)` — one harness turn; with `schema` returns a typed value
 *  - `args`           — values passed through `.run({ args })`
 *
 * Run with: `factory({...}).workflow('triage', body).run({ args: { files } })`.
 */
export const triage = factory({
	name: 'triage',
	harnesses: [claudeCode],
}).workflow('triage', ({ agent, parallel, phase, args }) =>
	Effect.gen(function* () {
		yield* phase('classify');
		const files = stringFiles(args.files);
		const reviews = yield* parallel(
			files.map((f) => () => agent(`review ${f}`, { schema: ReviewSchema, label: `review-${f}` })),
		);
		const kept = reviews.filter((r): r is Review => r !== null);

		yield* phase('summarize');
		yield* agent(`summarize the following reviews: ${JSON.stringify(kept)}`, { label: 'summary' });
	}),
);

if (import.meta.main) {
	await triage.run({ args: { files: ['src/auth.ts', 'src/db.ts'] } });
}
