import { Context, Effect, Layer, Ref } from 'effect';
import { AgentSeq } from '../ids.ts';

/**
 * Hands out a strictly-monotonic `AgentSeq` for every programmatic `agent()`
 * call across the WHOLE run (never per-phase). `Ref.modify` makes `next` atomic
 * so concurrent `parallel()` / `pipeline()` fan-out cannot hand out duplicate
 * or gapped seqs.
 */
export interface AgentSequenceService {
	readonly next: Effect.Effect<AgentSeq>;
}

export class AgentSequence extends Context.Tag('@factory/AgentSequence')<
	AgentSequence,
	AgentSequenceService
>() {}

const makeService = (startAt: number): Effect.Effect<AgentSequenceService> =>
	Effect.gen(function* () {
		const counter = yield* Ref.make(startAt);
		return {
			next: Ref.modify(counter, (n) => [AgentSeq.make(n), n + 1] as const),
		} satisfies AgentSequenceService;
	});

/** Fresh sequence for a new run, starting at 0. */
export const layer: Layer.Layer<AgentSequence> = Layer.effect(AgentSequence, makeService(0));

/** Resumed sequence seeded past the highest recorded seq so resume never
 *  reuses an existing agent directory. Pass `maxRecordedSeq + 1` (or 0). */
export const resumedLayer = (startAt: number): Layer.Layer<AgentSequence> =>
	Layer.effect(AgentSequence, makeService(startAt));
