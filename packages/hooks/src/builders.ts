import { createHash } from 'node:crypto';
import { HookId } from './ids.ts';
import {
	AllowDecision,
	AskDecision,
	DenyDecision,
	ModifyDecision,
	type HookDecision,
	type HookEvent,
	EffectSpec,
	RuleSpec,
} from './schema.ts';

type HookEventTag = 'preToolUse' | 'postToolUse' | 'sessionStart' | 'stop' | 'permissionRequest';

function stableId(fields: Record<string, unknown>): HookId {
	const digest = createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 16);
	return HookId.make(digest);
}

export interface RuleOptions {
	readonly on: HookEventTag;
	readonly decide: 'allow' | 'deny';
	readonly matchTools?: ReadonlyArray<string>;
	readonly reason?: string;
	readonly pathPatterns?: ReadonlyArray<string>;
	readonly commandPatterns?: ReadonlyArray<string>;
	readonly formatRun?: string;
	readonly auditTo?: string;
}

export interface EffectOptions {
	readonly on: HookEventTag;
	readonly match?: { readonly tool?: string | ReadonlyArray<string> };
	readonly handler: (event: HookEvent) => unknown;
}

export const Hook = {
	rule(opts: RuleOptions): RuleSpec {
		const id = stableId({ kind: 'rule', ...opts });
		return new RuleSpec({
			id,
			on: opts.on,
			decide: opts.decide,
			matchTools: opts.matchTools ? [...opts.matchTools] : undefined,
			reason: opts.reason,
			pathPatterns: opts.pathPatterns ? [...opts.pathPatterns] : undefined,
			commandPatterns: opts.commandPatterns ? [...opts.commandPatterns] : undefined,
			formatRun: opts.formatRun,
			auditTo: opts.auditTo,
		});
	},

	effect(opts: EffectOptions): EffectSpec {
		const id = stableId({ kind: 'effect', on: opts.on, match: opts.match });
		return new EffectSpec({ id, on: opts.on, handler: opts.handler });
	},

	denyPaths(patterns: ReadonlyArray<string>): RuleSpec {
		return Hook.rule({ on: 'preToolUse', decide: 'deny', pathPatterns: [...patterns] });
	},

	denyCommands(patterns: ReadonlyArray<string | RegExp>): RuleSpec {
		const stringified = patterns.map((p) => (p instanceof RegExp ? p.source : p));
		return Hook.rule({ on: 'preToolUse', decide: 'deny', commandPatterns: stringified });
	},

	formatOnWrite(opts: { readonly run: string }): RuleSpec {
		return Hook.rule({ on: 'postToolUse', decide: 'allow', formatRun: opts.run });
	},

	auditLog(opts: { readonly to: string }): RuleSpec {
		return Hook.rule({ on: 'preToolUse', decide: 'allow', auditTo: opts.to });
	},

	get allow(): HookDecision {
		return new AllowDecision({});
	},

	deny(reason?: string): HookDecision {
		return new DenyDecision({ reason });
	},

	ask(prompt: string): HookDecision {
		return new AskDecision({ prompt });
	},

	modify(args: Record<string, unknown>): HookDecision {
		return new ModifyDecision({ args });
	},
} as const;
