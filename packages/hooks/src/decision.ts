import { Schema } from 'effect';

const InputRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown });

export const HookDecisionAllow = Schema.Struct({
	action: Schema.Literal('allow'),
	updatedInput: Schema.optional(InputRecord),
	additionalContext: Schema.optional(Schema.String),
});
export type HookDecisionAllow = typeof HookDecisionAllow.Type;

export const HookDecisionDeny = Schema.Struct({
	action: Schema.Literal('deny'),
	reason: Schema.String,
});
export type HookDecisionDeny = typeof HookDecisionDeny.Type;

export const HookDecisionAsk = Schema.Struct({
	action: Schema.Literal('ask'),
	reason: Schema.String,
});
export type HookDecisionAsk = typeof HookDecisionAsk.Type;

export const HookDecisionBlock = Schema.Struct({
	action: Schema.Literal('block'),
	reason: Schema.String,
});
export type HookDecisionBlock = typeof HookDecisionBlock.Type;

export const HookDecision = Schema.Union(
	HookDecisionAllow,
	HookDecisionDeny,
	HookDecisionAsk,
	HookDecisionBlock,
);
export type HookDecision = typeof HookDecision.Type;

export const ALLOW: HookDecisionAllow = { action: 'allow' };

const concatContext = (a: string | undefined, b: string | undefined): string | undefined => {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return `${a}\n\n${b}`;
};

const mergeAllow = (left: HookDecisionAllow, right: HookDecisionAllow): HookDecisionAllow => {
	const additionalContext = concatContext(left.additionalContext, right.additionalContext);
	const updatedInput = right.updatedInput ?? left.updatedInput;
	const merged: HookDecisionAllow = { action: 'allow' };
	if (additionalContext !== undefined) {
		Object.assign(merged, { additionalContext });
	}
	if (updatedInput !== undefined) {
		Object.assign(merged, { updatedInput });
	}
	return merged;
};

/** Merge handler decisions per patterns/hooks.md: deny short-circuits, ask
 *  beats allow, additionalContext concats with `\n\n`, updatedInput is
 *  last-writer-wins, block reasons join with `\n`. */
export const mergeDecisions = (decisions: ReadonlyArray<HookDecision>): HookDecision => {
	let result: HookDecision = ALLOW;
	for (const next of decisions) {
		if (next.action === 'deny') return next;
		// `result` cannot be deny here: the only way to get a deny into the
		// merged accumulator is the line above, which short-circuits.
		if (next.action === 'ask') {
			result = next;
			continue;
		}
		if (result.action === 'ask') {
			// next is allow or block — ask wins
			continue;
		}
		if (next.action === 'block') {
			result =
				result.action === 'block'
					? { action: 'block', reason: `${result.reason}\n${next.reason}` }
					: next;
			continue;
		}
		if (result.action === 'block') {
			// next is allow — block stays
			continue;
		}
		// both allow
		result = mergeAllow(result, next);
	}
	return result;
};
