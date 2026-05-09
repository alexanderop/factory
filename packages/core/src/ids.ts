import { Schema } from 'effect';

export const RunId = Schema.String.pipe(Schema.brand('RunId'));
export type RunId = typeof RunId.Type;

export const StepId = Schema.String.pipe(Schema.brand('StepId'));
export type StepId = typeof StepId.Type;

export const HarnessName = Schema.String.pipe(Schema.brand('HarnessName'));
export type HarnessName = typeof HarnessName.Type;

export const PipelineName = Schema.String.pipe(Schema.brand('PipelineName'));
export type PipelineName = typeof PipelineName.Type;
