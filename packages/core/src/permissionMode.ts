import { Schema } from 'effect';

export const PermissionMode = Schema.Literal('skip', 'accept-edits', 'read-only', 'prompt');
export type PermissionMode = typeof PermissionMode.Type;
