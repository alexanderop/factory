import type { CaptureMode } from './types.ts';

const TRUNCATE_BUDGET = 200;
const TRUNCATE_MARKER = '[truncated]';

type SafeAttributeValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| { readonly kind: string; readonly length?: number; readonly keys?: string[]; readonly size?: number }
	| string[];

/** Redacts a value according to the capture mode before it becomes a span attribute or log body. */
export const redact = (value: unknown, mode: CaptureMode): SafeAttributeValue => {
	if (mode === 'off') return undefined;
	if (mode === 'counts') return counts(value);
	if (mode === 'redacted') return JSON.stringify(redactDeep(value));
	// full
	return typeof value === 'string'
		? value
		: typeof value === 'number' || typeof value === 'boolean'
			? value
			: JSON.stringify(value);
};

const counts = (value: unknown): SafeAttributeValue => {
	if (value === null || value === undefined) return { kind: 'null' };
	if (typeof value === 'string') return { kind: 'string', length: value.length };
	if (typeof value === 'number') return { kind: 'number' };
	if (typeof value === 'boolean') return { kind: 'boolean' };
	if (Array.isArray(value)) return { kind: 'array', size: value.length };
	if (typeof value === 'object') {
		const keys = Object.keys(value as Record<string, unknown>);
		return { kind: 'object', keys };
	}
	return { kind: typeof value };
};

const redactDeep = (value: unknown, depth = 0): unknown => {
	if (depth > 6) return '[max-depth]';
	if (value === null || value === undefined) return value;
	if (typeof value === 'boolean' || typeof value === 'number') return value;
	if (typeof value === 'string') {
		return value.length > TRUNCATE_BUDGET ? `${value.slice(0, TRUNCATE_BUDGET)}${TRUNCATE_MARKER}` : value;
	}
	if (Array.isArray(value)) {
		return value.map((item) => redactDeep(item, depth + 1));
	}
	if (typeof value === 'object') {
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			result[k] = redactDeep(v, depth + 1);
		}
		return result;
	}
	return String(value);
};
