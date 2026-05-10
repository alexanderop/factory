---
name: harness-auth
description: Let factory users hand each harness an explicit credential — Anthropic/OpenAI API keys, GH_TOKEN PAT, or inherited subscription — at factory-config time so harness CLIs work in CI, containers, and headless machines.
type: plan
status: not-started
created: 2026-05-09
---

# Harness auth — API keys, tokens, and inherited subscriptions

Owner: @alex.

Let factory users hand each harness an explicit credential — an Anthropic API
key, an OpenAI API key, a `GH_TOKEN` PAT — at factory-config time, so the
harness CLIs work in CI, in containers, and on machines where the user has no
interactive `claude /login` / `codex login` / `gh auth login` session.
When nothing is configured, factory keeps today's behaviour: pass the parent
process env through and let the CLI find its own credentials.

## Problem

The three harnesses we ship today fall into two camps:

- **Dual-mode** — `claude-code` and `codex` accept either an interactive
  subscription login _or_ an API key billed separately. Users on free / paid
  Anthropic and OpenAI accounts often want the API-key path so they can run
  factory pipelines headlessly without burning their personal subscription.
- **Single-mode** — `copilot` requires a Copilot seat regardless. `GH_TOKEN`
  / `GITHUB_TOKEN` is just a non-interactive transport for the same identity;
  it doesn't let you skip the subscription.

Today factory has no place to declare "this harness uses _this_ key for
_this_ run." `ExecOpts.env` exists, but it's per-step, anonymous (no harness
knows which keys belong to it), and forces every step author to re-thread the
same secret. There's also no first-class place for the rotating-token case
(Claude's `apiKeyHelper`, Codex's `model_providers.<id>.auth.command`).

Effect's executor already merges `process.env` with `Command.env` overrides
at spawn time
(`repos/effect/packages/platform-node-shared/src/internal/commandExecutor.ts:71`
— `env: { ...process.env, ...Object.fromEntries(command.env) }`), so the
"do nothing" default already works. What's missing is the explicit path.

## Goals

1. One declaration per harness instance: `claudeCode.withAuth({ … })`. No
   per-step boilerplate.
2. Three credential shapes covering every CLI we target:
   - static API key (`Redacted<string>`), the 80% case;
   - free-form env record (multiple vars, e.g. PAT + base URL);
   - effectful helper (`Effect<Record<string, string>, _>`) with TTL, for
     vault-fetched / rotating tokens.
3. Default is `Inherit`: process env passes through untouched so the CLIs
   pick up `~/.claude/.credentials.json`, `~/.codex/auth.json`, `gh auth`.
4. Each harness _declares_ the env vars it understands (`HarnessAuthSpec`)
   so factory can render a `factory doctor` report — "harness `codex`
   reads `OPENAI_API_KEY`; not set; falling back to inherited login" —
   without per-CLI knowledge leaking into core.
5. Secrets never appear in OTel span attributes, logs, or error messages.
6. Helper failures are typed (`HarnessAuthError`) and join `FactoryError`,
   so an auth deny shows up as a normal run failure — not a mysterious
   exit code 1 from the CLI.

## Non-goals (v1)

- A user-level config file (`~/.factory/auth.toml`). Auth lives in the
  user's `factory.ts`, alongside the `harnesses` array. If they want it
  out of source they can read env / read a vault and pass `Helper`.
- Routing to alternate API endpoints / proxies as a first-class feature.
  `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, etc. are surfaced via the
  generic `Env` variant — no dedicated `baseUrl?: string` field.
- Cloud-provider helpers (`CLAUDE_CODE_USE_BEDROCK`, AWS SigV4 signing).
  These need their own design; today they're already reachable via the
  `Env` variant if a user wants to wire them manually.
- Auto-detecting which auth path a CLI used. We don't try to parse
  `claude --status` output. The `factory doctor` story is "what we'd
  send", not "what the CLI accepted".
- Hiding the `process.env` passthrough. Power users already rely on this
  (e.g. `PATH`, `HOME`, `LANG`); changing the default to "empty env" would
  break every existing pipeline.

## Resolved design decisions

### `HarnessAuthSpec` lives on the harness, not the user

Each harness package exports a static description of what env keys it
understands. Factory core never names a CLI-specific variable.

```ts
// packages/core/src/types.ts
export interface HarnessAuthSpec {
  /** Auth-bearing env vars, in precedence order (first = highest). */
  readonly envVars: ReadonlyArray<HarnessAuthEnvVar>;
  /** Non-auth env keys the harness honors (base URL, region). */
  readonly extraEnv?: ReadonlyArray<HarnessAuthExtraVar>;
}

export interface HarnessAuthEnvVar {
  readonly name: string;
  readonly kind: 'api-key' | 'oauth-token' | 'bearer' | 'pat';
  readonly description: string;
}

export interface HarnessAuthExtraVar {
  readonly name: string;
  readonly description: string;
}
```

`Harness` gains a required `auth: HarnessAuthSpec` field. Specs for the
three shipped harnesses:

| Harness     | env vars (precedence)                                                                                     | extras               |
| ----------- | --------------------------------------------------------------------------------------------------------- | -------------------- |
| claude-code | `ANTHROPIC_AUTH_TOKEN` (bearer) → `ANTHROPIC_API_KEY` (api-key) → `CLAUDE_CODE_OAUTH_TOKEN` (oauth-token) | `ANTHROPIC_BASE_URL` |
| codex       | `OPENAI_API_KEY` (api-key)                                                                                | `OPENAI_BASE_URL`    |
| copilot     | `GH_TOKEN` (pat) → `GITHUB_TOKEN` (pat)                                                                   | —                    |

Note `copilot` lists no `api-key` kind. `factory doctor` uses this to print
"copilot requires a Copilot seat — `GH_TOKEN` is a transport, not a
substitute" rather than implying a key-only path exists.

### `HarnessAuth` is a discriminated union with `Inherit` as default

```ts
import { Data, Effect, Redacted, type Duration } from 'effect';

export type HarnessAuth =
  | { readonly _tag: 'Inherit' }
  | { readonly _tag: 'ApiKey'; readonly value: Redacted.Redacted<string> }
  | {
      readonly _tag: 'Env';
      readonly env: Readonly<Record<string, Redacted.Redacted<string> | string>>;
    }
  | {
      readonly _tag: 'Helper';
      readonly fetch: Effect.Effect<Readonly<Record<string, string>>, HarnessAuthError>;
      readonly ttl?: Duration.DurationInput;
    };

export class HarnessAuthError extends Data.TaggedError('HarnessAuthError')<{
  readonly message: string;
  readonly harness: HarnessName;
}> {}
```

- **`Inherit`** — no override. The Effect Node executor merges
  `process.env` automatically; we add nothing on top.
- **`ApiKey`** — convenience for the 80% case. The harness's
  `auth.envVars[0]` is the target var (highest precedence). Picking
  `ApiKey` for `copilot` is a type error: we narrow `withAuth`'s
  parameter so harnesses without an `'api-key'` entry only accept
  `Inherit | Env | Helper`.
- **`Env`** — anything more elaborate (PAT + base URL, multiple vars).
  Values may be `Redacted` or plain strings; plain values are typically
  for non-sensitive extras like `OPENAI_BASE_URL`.
- **`Helper`** — wraps an `Effect` so it composes with `Layer` and other
  services. `ttl` defaults to `5 minutes` (matches Claude's
  `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` default). Implemented via
  `Effect.cachedWithTTL` (`repos/effect/packages/effect/src/Effect.ts:351`)
  inside `withAuth`, so a single resolve-effect lives across the whole run
  and only re-fetches when stale. No retry-on-401 in v1 — the CLI itself
  exits, the run fails, and the next iter re-resolves.

`Redacted` (`repos/effect/packages/effect/src/Redacted.ts`) is the right
type for secret values — its `toString` returns `<redacted>`, it's
equality-safe, and Effect's logger handles it natively. Keys must round-
trip through `Redacted.value` only at the spawn boundary (`subprocess.ts`
when calling `Command.env`), nowhere else.

### `withAuth` is a thin combinator on `Harness`

```ts
// packages/core/src/subprocess.ts (extension)
export const withAuth =
  <Name extends string>(harness: Harness<Name>, auth: HarnessAuth):
    Harness<Name> => /* … */;
```

Implementation:

1. Build `resolveAuthEnv: Effect<Record<string, string>, HarnessAuthError>`
   from the `HarnessAuth` variant.
   - `Inherit` → `Effect.succeed({})`
   - `ApiKey` → `Effect.succeed({ [spec.envVars[0].name]: Redacted.value(value) })`
   - `Env` → unwrap each value, return.
   - `Helper` → wrap `fetch` in `Effect.cachedWithTTL(_, ttl ?? '5 minutes')`.
     The cached effect is created once per harness instance (closed-over `Ref`).
2. Return a new `Harness` whose `exec` / `stream` `flatMap` over
   `resolveAuthEnv` and merge the result _under_ `opts.env`
   (so step-level `env` still wins — useful for one-off tests).
3. The merged env is passed through the existing `Command.env` call site
   in `buildCommand` (`subprocess.ts:50`). No structural change there.
4. `OTel`: in the `factory.harness.spawn` span attributes
   (`subprocess.ts:107-113`), add `factory.harness.auth.kind` (`'inherit'`
   | `'api-key'` | `'env'` | `'helper'`) and `factory.harness.auth.envKeys`
   (the _names_, sorted, joined with `,`). **Never** the values.

### Builder method on harness factories

`createSubprocessHarness` returns a `Harness` today. Wrap it so each
shipped harness has a `.withAuth(auth)` method that calls `withAuth` and
returns a new instance. The shipped harnesses also expose their `auth`
spec so user code can introspect:

```ts
import { claudeCode } from '@factory/harness-claude-code';
import { Redacted } from 'effect';

factory({
  name: 'demo',
  harnesses: [
    claudeCode.withAuth({
      _tag: 'ApiKey',
      value: Redacted.make(process.env.ANTHROPIC_API_KEY!),
    }),
    codex, // Inherit — uses ~/.codex/auth.json
    copilot.withAuth({
      _tag: 'Env',
      env: { GH_TOKEN: Redacted.make(process.env.GH_TOKEN!) },
    }),
  ],
});
```

`copilot.withAuth({ _tag: 'ApiKey', … })` is rejected at the type level
because copilot's spec has no `'api-key'` entry.

For the `Helper` case, integration with `Config.redacted`
(`repos/effect/packages/effect/src/Config.ts:367`) is the natural path —
let users write:

```ts
const fetch = Effect.gen(function* () {
  const key = yield* Config.redacted('ANTHROPIC_API_KEY');
  return { ANTHROPIC_API_KEY: Redacted.value(key) };
});
claudeCode.withAuth({ _tag: 'Helper', fetch, ttl: '15 minutes' });
```

This means we don't ship a separate "load from env" helper — `Config` is.

## Implementation phases

### Phase 1 — core types + `withAuth` combinator

Files:

- `packages/core/src/types.ts` — add `HarnessAuthSpec`, `HarnessAuth`,
  required `auth: HarnessAuthSpec` on `Harness`.
- `packages/core/src/errors.ts` — add `HarnessAuthError` to the
  `FactoryError` union (per `patterns/typed-errors.md`).
- `packages/core/src/subprocess.ts` — add `auth` to
  `SubprocessHarnessConfig`, accept it in `createSubprocessHarness`,
  return a harness with a `.withAuth(auth)` method.
- `packages/core/src/index.ts` — export new types.

Tests (`packages/core/src/subprocess.test.ts` extension):

- `Inherit` variant: spawned env contains parent vars (use `it.effect`
  - a `node -e` snippet that prints `process.env.PATH`).
- `ApiKey` variant: matches the harness's first env var; `Redacted`
  value reaches the child but never appears in span attrs (capture spans
  via `@effect/vitest` test runtime — see `patterns/testing-effect.md`).
- `Env` variant with mixed `Redacted` + plain strings.
- `Helper` variant: `Effect.cachedWithTTL` invoked once across two
  consecutive `exec` calls within the TTL; re-invoked after.
- `Helper` failure surfaces as `HarnessAuthError` and propagates.
- Step-level `opts.env` overrides auth env (last-wins merge).

### Phase 2 — per-harness specs

Files:

- `packages/harness-claude-code/src/index.ts` — declare spec
  (`ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `CLAUDE_CODE_OAUTH_TOKEN`,
  extra `ANTHROPIC_BASE_URL`).
- `packages/harness-codex/src/index.ts` — `OPENAI_API_KEY`, extra
  `OPENAI_BASE_URL`.
- `packages/harness-copilot/src/index.ts` — `GH_TOKEN` → `GITHUB_TOKEN`
  (both `kind: 'pat'`), no `api-key`.

Tests: each harness's existing `index.test.ts` gets one
`it("declares an auth spec", …)` snapshot.

### Phase 3 — `factory doctor` (or `factory auth`) CLI

Files:

- `packages/cli/src/cli.ts` — add a subcommand that loads `factory.ts`,
  iterates `harnesses`, and prints per-harness:
  - the `auth.envVars` table;
  - which entries are present in `process.env` (✓/✗, no values);
  - which `HarnessAuth` variant is configured;
  - for `copilot`-shaped specs (no `api-key` kind), an explanatory note.
- New: `packages/cli/src/commands/doctor.ts`.

Tests: snapshot the `--help` output (per
`packages/core/src/testing/helpSnapshot.ts`) and one captured doctor run
against a scripted harness.

### Phase 4 — docs

- `patterns/harness-auth.md` — short guide alongside the other patterns,
  covering the `Inherit` default, `Redacted` discipline, and when to
  reach for `Helper` over `Config.redacted` directly.
- Update `examples/sdd-quickstart/.factory/factory.ts` (if it lacks one)
  to demonstrate `Inherit` (the default) — no API key needed.

## Effect patterns we lean on

- **`Redacted`** for secret values — `Redacted.make` /
  `Redacted.value`, with `toString` already returning `<redacted>`
  (`repos/effect/packages/effect/src/Redacted.ts:1-80`).
- **`Effect.cachedWithTTL`** for the Helper case — caches the resolved
  env across iters within a TTL window
  (`repos/effect/packages/effect/src/Effect.ts:351`).
- **`Config.redacted`** as the recommended helper builder — users get
  source-agnostic config (env, file, vault) for free
  (`repos/effect/packages/effect/src/Config.ts:367`).
- **`Data.TaggedError`** for `HarnessAuthError` (per
  `patterns/typed-errors.md`).
- **Spec on the harness, not the user** — mirrors how `Harness` already
  carries `capabilities` and `defaultPermissions` as static metadata
  (`packages/core/src/types.ts:66-86`).

## Open questions

1. **Should `withAuth` accept a `Layer`?** A user might want their helper
   to depend on services (`HttpClient`, vault client). `Helper.fetch`
   typed as `Effect<…, HarnessAuthError, R>` with `R` flowing into the
   factory's requirements would be more honest. Cost: every plan/run/exec
   signature grows an `R` parameter. Lean: keep `R = never` in v1, force
   users to `Effect.provide` themselves.
2. **Should `factory doctor` actually call `Helper.fetch`?** Useful as a
   smoke test, dangerous if it triggers vault reads / rate limits. Lean:
   off by default, opt-in via `factory doctor --resolve`.
3. **Helper TTL on 401?** Claude's real `apiKeyHelper` re-runs on HTTP 401. We don't see harness HTTP responses — only stdout/stderr/exit
   code. Out of scope for v1; users can lower their TTL or restart.
