import { createHash } from 'node:crypto';
import { FileSystem, Path } from '@effect/platform';
import { Effect } from 'effect';
import { ResumeUnavailableError } from '../errors.ts';
import { type AgentRecord, readAgent } from '../services/runManifest.ts';

/**
 * Read every recorded `agent.json` under `<runDir>/agents/`, sorted by seq, so
 * a resumed run can hydrate its agent state and short-circuit completed agents.
 * Mirrors `loadRecordedSteps` in orchestrator.ts.
 */
export const readRecordedAgents = (
	runDir: string,
): Effect.Effect<
	ReadonlyArray<AgentRecord>,
	ResumeUnavailableError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const agentsRoot = path.join(runDir, 'agents');
		const statError = (message: string) => (e: { readonly message: string }) =>
			new ResumeUnavailableError({ message: `${message}: ${e.message}`, reason: 'not-found' });
		const exists = yield* fs
			.exists(agentsRoot)
			.pipe(Effect.mapError(statError(`failed to stat ${agentsRoot}`)));
		if (!exists) return [];
		const subdirs = yield* fs
			.readDirectory(agentsRoot)
			.pipe(Effect.mapError(statError(`failed to read ${agentsRoot}`)));
		const records: AgentRecord[] = [];
		for (const name of subdirs) {
			const agentJsonPath = path.join(agentsRoot, name, 'agent.json');
			const has = yield* fs
				.exists(agentJsonPath)
				.pipe(Effect.mapError(statError(`failed to stat ${agentJsonPath}`)));
			if (!has) continue;
			records.push(
				yield* readAgent(agentJsonPath).pipe(
					Effect.mapError(
						(e) => new ResumeUnavailableError({ message: e.message, reason: 'not-found' }),
					),
				),
			);
		}
		return records.toSorted((a, b) => a.seq - b.seq);
	});

/** Highest recorded agent seq, or `-1` when none — caller seeds `AgentSequence`
 *  at `maxRecordedSeq + 1` so resume never reuses a seq. */
export const maxRecordedSeq = (records: ReadonlyArray<AgentRecord>): number =>
	records.reduce((max, r) => Math.max(max, r.seq), -1);

/** Normalized, deterministic shape of `agent()` options for hashing. The output
 *  schema is collapsed to its canonical JSON-AST string so changing the schema
 *  changes the resume key (forcing a safe re-run, never a stale decode). */
export interface NormalizedAgentOpts {
	readonly harness: string | undefined;
	readonly permissions: string | undefined;
	readonly label: string | undefined;
	readonly phase: string | undefined;
	readonly schema: string | undefined;
}

/** Stable sorted-key serialization of the flat (string|undefined) opts shape.
 *  Reordered keys serialize identically; `undefined` values are dropped. */
const stableStringify = (opts: NormalizedAgentOpts): string => {
	const entries: ReadonlyArray<readonly [string, string]> = Object.entries(opts)
		.flatMap(([k, v]) => (v === undefined ? [] : [[k, v] as const]))
		.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return JSON.stringify(entries);
};

const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');

/**
 * Deterministic `(promptHash, optsHash)` for resume keying. Reordering opts keys
 * yields an identical `optsHash` (stable sorted-key JSON); the prompt is hashed
 * verbatim and recorded to `prompt.md` so resume replays identically.
 */
export const hashAgentInput = (
	prompt: string,
	opts: NormalizedAgentOpts,
): { readonly promptHash: string; readonly optsHash: string } => ({
	promptHash: sha256(prompt),
	optsHash: sha256(stableStringify(opts)),
});
