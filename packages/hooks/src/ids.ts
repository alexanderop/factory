import { Schema } from 'effect';

export const HookId = Schema.String.pipe(Schema.brand('HookId'));
export type HookId = typeof HookId.Type;
