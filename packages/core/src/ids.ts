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
