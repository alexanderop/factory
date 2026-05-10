# Harness auth

Each harness in factory can be given explicit credentials via `.withAuth(auth)`. The
default — `Inherit` — passes the parent process env through unchanged, so existing
pipelines that rely on `~/.claude/.credentials.json`, `gh auth`, etc. require no changes.

> Source of truth: `packages/core/src/types.ts` (HarnessAuth, HarnessAuthSpec),
> `packages/core/src/subprocess.ts` (withAuth implementation),
> `packages/core/src/errors.ts` (HarnessAuthError).

## The four variants

```ts
type HarnessAuth =
  | { _tag: 'Inherit' }
  | { _tag: 'ApiKey'; value: Redacted<string> }
  | { _tag: 'Env'; env: Record<string, Redacted<string> | string> }
  | { _tag: 'Helper'; fetch: Effect<Record<string, string>, HarnessAuthError>; ttl?: DurationInput };
```

**Inherit** — nothing added. The Effect Node executor already merges `process.env` at
spawn time, so credentials from login sessions, dotfiles, and ambient env reach the CLI
automatically. This is the safe default: you can't accidentally send an empty env.

**ApiKey** — targets the harness's highest-precedence env var (the first entry in
`harness.auth.envVars`). Use this for the 80 % "I have an API key" case:

```ts
import { Redacted } from 'effect';
import { claudeCode } from '@factory/harness-claude-code';

claudeCode.withAuth({ _tag: 'ApiKey', value: Redacted.make(process.env.ANTHROPIC_API_KEY!) });
```

**Env** — injects multiple vars, optionally with `Redacted` values for secrets and plain
strings for non-sensitive extras like base-URL overrides:

```ts
copilot.withAuth({
  _tag: 'Env',
  env: {
    GH_TOKEN: Redacted.make(process.env.GH_TOKEN!),
    GITHUB_TOKEN: Redacted.make(process.env.GH_TOKEN!),
  },
});
```

**Helper** — wraps an `Effect` that fetches credentials at run time (vault, OIDC token
exchange, rotating key). The result is cached for `ttl` (default 5 minutes) via
`Effect.cachedWithTTL`, shared across all `exec`/`stream` calls on that harness instance:

```ts
import { Config, Effect, Redacted } from 'effect';

const fetch = Effect.gen(function* () {
  const key = yield* Config.redacted('ANTHROPIC_API_KEY');
  return { ANTHROPIC_API_KEY: Redacted.value(key) };
});

claudeCode.withAuth({ _tag: 'Helper', fetch, ttl: '15 minutes' });
```

`Config.redacted` is the canonical path for source-agnostic config (env, file, vault).
The helper stays composable with any Effect service because `fetch` is a plain Effect.

## Redacted discipline

Values must be `Redacted<string>` (from `effect`) for any secret. `Redacted.toString()`
returns `<redacted>`, so secrets never appear in logs, OTel spans, or error messages.

**Only unwrap with `Redacted.value` at the spawn boundary** — the `Command.env` call in
`subprocess.ts:buildCommand`. Nowhere else. Treat `Redacted.value` like a `sudo`: if you
see it outside the spawn path, it's wrong.

In OTel span attributes, factory records `factory.harness.auth.kind` (e.g. `'api-key'`)
and `factory.harness.auth.envKeys` (sorted key names, comma-joined). Values are never
emitted — only the presence of each key name.

## Step-level env wins

Auth env is merged _before_ `opts.env`. Step-level `exec({ env: {...} })` always takes
precedence — useful for overriding a single key in a specific step without touching the
harness-wide credential:

```ts
harness.exec({ env: { ANTHROPIC_API_KEY: devKey }, ... })
// devKey wins even if harness has ApiKey configured
```

## HarnessAuthSpec and factory doctor

Each harness declares the env vars it understands via `harness.auth`:

```ts
const spec: HarnessAuthSpec = {
  envVars: [
    { name: 'ANTHROPIC_AUTH_TOKEN', kind: 'bearer', description: '...' },
    { name: 'ANTHROPIC_API_KEY', kind: 'api-key', description: '...' },
    { name: 'CLAUDE_CODE_OAUTH_TOKEN', kind: 'oauth-token', description: '...' },
  ],
  extraEnv: [{ name: 'ANTHROPIC_BASE_URL', description: '...' }],
};
```

`factory doctor <name>` uses this spec to print a per-harness report showing which
vars are present in the current environment (✓/✗), the configured auth variant, and
— for harnesses with no `'api-key'` kind entry like `copilot` — a note that the listed
tokens are a transport, not a way to skip a seat subscription.

## Shipped harness specs

| Harness      | envVars (precedence)                                                 | extraEnv            |
| ------------ | -------------------------------------------------------------------- | ------------------- |
| claude-code  | ANTHROPIC_AUTH_TOKEN (bearer) → ANTHROPIC_API_KEY (api-key) → CLAUDE_CODE_OAUTH_TOKEN (oauth-token) | ANTHROPIC_BASE_URL |
| codex        | OPENAI_API_KEY (api-key)                                             | OPENAI_BASE_URL     |
| copilot      | GH_TOKEN (pat) → GITHUB_TOKEN (pat)                                  | —                   |

## Don't

- Don't pass raw strings for secrets to `Env` — use `Redacted.make(value)`.
- Don't call `Redacted.value` outside `subprocess.ts`. If you need to pass a secret to
  a child, use `Env` or `Helper` and let the harness unwrap at spawn.
- Don't set `Helper` TTL to 0 thinking it disables caching — use `Inherit` or `Env` if
  you want no caching.
- Don't pick `ApiKey` for `copilot` — it has no `'api-key'` kind entry. Use `Env` with
  `GH_TOKEN`.
