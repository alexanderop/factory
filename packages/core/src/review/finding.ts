import { Schema } from 'effect';

export const Severity = Schema.Literal('P1', 'P2', 'P3');
export type Severity = typeof Severity.Type;

export const Finding = Schema.Struct({
	role: Schema.String,
	severity: Severity,
	file: Schema.String,
	line: Schema.optional(Schema.Number),
	message: Schema.String,
	suggestion: Schema.optional(Schema.String),
});
export type Finding = typeof Finding.Type;

/** Findings as written by a role (no `role` field — core stamps it from the role id). */
export const RoleFinding = Schema.Struct({
	severity: Severity,
	file: Schema.String,
	line: Schema.optional(Schema.Number),
	message: Schema.String,
	suggestion: Schema.optional(Schema.String),
});
export type RoleFinding = typeof RoleFinding.Type;

export const Findings = Schema.Struct({ findings: Schema.Array(Finding) });
export type Findings = typeof Findings.Type;

export const RoleFindings = Schema.Struct({ findings: Schema.Array(RoleFinding) });
export type RoleFindings = typeof RoleFindings.Type;

export const FindingsJson = Schema.parseJson(Findings);
export const RoleFindingsJson = Schema.parseJson(RoleFindings);

export const decodeFindings = Schema.decodeUnknown(FindingsJson);
export const decodeRoleFindings = Schema.decodeUnknown(RoleFindingsJson);
export const encodeFindings = Schema.encode(FindingsJson);
