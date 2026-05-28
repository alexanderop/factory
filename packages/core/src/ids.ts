import { Schema } from 'effect';

export const RunId = Schema.String.pipe(Schema.brand('RunId'));
export type RunId = typeof RunId.Type;

export const StepId = Schema.String.pipe(Schema.brand('StepId'));
export type StepId = typeof StepId.Type;

export const HarnessName = Schema.String.pipe(Schema.brand('HarnessName'));
export type HarnessName = typeof HarnessName.Type;

/** Sentinel recorded on a review step's `step.json` when its roles span more
 *  than one harness. Consumers of `run.json`/`step.json` should treat this as
 *  "no single harness owns this step" rather than a real harness name. */
export const MIXED_HARNESS: HarnessName = HarnessName.make('<mixed>');

export const PipelineName = Schema.String.pipe(Schema.brand('PipelineName'));
export type PipelineName = typeof PipelineName.Type;

/** Monotonic per-run counter assigned to each programmatic `agent()` call. */
export const AgentSeq = Schema.Number.pipe(Schema.brand('AgentSeq'));
export type AgentSeq = typeof AgentSeq.Type;

/** Human-readable label for a programmatic agent (`opts.label` or `agent-<seq>`). */
export const AgentLabel = Schema.String.pipe(Schema.brand('AgentLabel'));
export type AgentLabel = typeof AgentLabel.Type;

const padSeq = (seq: number, width = 3): string => seq.toString().padStart(width, '0');

/** Replace path-hostile characters in an agent label so it is safe as a
 *  single directory segment (`agents/<seq>-<label>/`). */
export const slugify = (label: string): string =>
	label
		.trim()
		.replace(/[\s/\\]+/g, '-')
		.replace(/[^a-zA-Z0-9._-]/g, '')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '') || 'agent';

/** Pure path builder for an agent's workspace directory: `agents/<pad(seq)>-<slug>`. */
export const agentDirName = (seq: AgentSeq, label: AgentLabel): string =>
	`agents/${padSeq(seq)}-${slugify(label)}`;
