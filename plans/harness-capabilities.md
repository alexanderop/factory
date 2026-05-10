---
name: harness-capabilities
description: Replace the implicit `supports: PermissionMode[]` array with an ACP-shaped capability contract per harness, so steps can declare requirements and the orchestrator picks/rejects harnesses by structural match.
type: plan
status: done
created: 2026-05-09
---

# Plan: harness capability contract

## Goal

Today every harness exposes one capability — `supports: PermissionMode[]`.
Everything else (does it stream tool events? can it resume a session? does it
take image input? does it speak MCP?) is implicit and only knowable by reading
the wrapping code. As more harnesses land, steps need a way to say "I require
session resume and image input" and the orchestrator needs to refuse harnesses
that can't satisfy the requirement _before_ the subprocess spawns.

The contract should be a typed Effect `Schema` struct on every `Harness`,
modeled on the **Agent Client Protocol (ACP)** capability shape so we get free
interop later if we ever expose factory steps as ACP clients, plus factory's
own `permissions` extension that ACP doesn't have.

Reference (the prior art we're aligning to):

- `AgentCapabilities` in ACP — `loadSession`, `mcpCapabilities.{http,sse}`,
  `promptCapabilities.{image,audio,embeddedContext}`,
  `sessionCapabilities.{list,resume,close}`, `_meta` (extensibility).
- Spec page: <https://agentclientprotocol.com/protocol/initialization>.
- Schema: <https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/schema.json>.

## Non-goals

- Implementing the ACP transport (JSON-RPC over stdio) itself. We're adopting
  the _shape_ of `AgentCapabilities`, not becoming an ACP client. That can
  come later as a separate `harness-acp` package.
- Auto-discovering capabilities by parsing `--help`. Help text is unstructured
  natural language; the semantic mapping (e.g. `--dangerously-skip-permissions`
  ⇒ `permissions: skip`) needs human judgement and lives in the harness file.
  We _will_ snapshot `--help` per harness as a drift-detection fixture, see
  below.
- Per-tool allow/deny lists or sandboxing. Same scope split as in
  `plans/permissions.md`.
- Capability _negotiation_ (client also declares capabilities). Factory is the
  client; for now it just demands. If/when a step needs to advertise (e.g.
  "I can show images back to the agent"), revisit.

## The capability shape

```ts
// packages/core/src/capabilities.ts
import { Schema } from 'effect';
import { PermissionMode } from './types.ts';

export const McpCapabilities = Schema.Struct({
  http: Schema.Boolean,
  sse: Schema.Boolean,
  // ACP has only http/sse today; stdio is implicit. Add stdio when we need it.
});

export const PromptCapabilities = Schema.Struct({
  image: Schema.Boolean,
  audio: Schema.Boolean,
  embeddedContext: Schema.Boolean,
});

export const SessionCapabilities = Schema.Struct({
  list: Schema.Boolean,
  resume: Schema.Boolean,
  close: Schema.Boolean,
});

// Factory's own extension — ACP doesn't model permission modes because it
// assumes the editor mediates approval. Headless factory needs them.
export const FactoryCapabilities = Schema.Struct({
  permissions: Schema.Array(PermissionMode),
  // Streaming event shape — does the harness emit structured tool events
  // ({type:'tool', name, input}) or only raw stdout/stderr lines?
  toolEvents: Schema.Boolean,
});

export const HarnessCapabilities = Schema.Struct({
  loadSession: Schema.Boolean,
  mcp: McpCapabilities,
  prompt: PromptCapabilities,
  session: SessionCapabilities,
  factory: FactoryCapabilities,
  // ACP-style extensibility escape hatch. Use sparingly; promote to typed
  // fields as patterns emerge.
  meta: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});
export type HarnessCapabilities = typeof HarnessCapabilities.Type;
```

ACP field names are kept verbatim (`loadSession`, `prompt.image`, etc.) so a
future `harness-acp` adapter is a one-to-one map. Factory-only fields live
under `factory.*` to make the boundary obvious.

**Defaults: missing means unsupported.** Every boolean defaults to `false`.
Adopting a capability is an explicit `true` in the harness declaration.

## Step-side requirement declaration

```ts
// packages/core/src/types.ts
export const StepRequirements = Schema.Struct({
  permissions: Schema.optional(PermissionMode),
  loadSession: Schema.optional(Schema.Boolean),
  prompt: Schema.optional(
    Schema.Struct({
      image: Schema.optional(Schema.Boolean),
      audio: Schema.optional(Schema.Boolean),
      embeddedContext: Schema.optional(Schema.Boolean),
    }),
  ),
  session: Schema.optional(
    Schema.Struct({
      resume: Schema.optional(Schema.Boolean),
      list: Schema.optional(Schema.Boolean),
      close: Schema.optional(Schema.Boolean),
    }),
  ),
  factory: Schema.optional(
    Schema.Struct({
      toolEvents: Schema.optional(Schema.Boolean),
    }),
  ),
});
export type StepRequirements = typeof StepRequirements.Type;
```

A step requirement is "soft" by default (no requirements ⇒ any harness OK). A
field set to `true` on a requirement means "the harness must declare `true`".

## Surface area

### `packages/core/src/types.ts`

```ts
export interface Harness<Name extends string = string> {
  readonly name: Name;
  readonly capabilities: HarnessCapabilities;
  readonly defaultPermissions?: PermissionMode;
  readonly exec: …;
  readonly stream: …;
}

export interface StepOptions<Names extends string = string> {
  // … existing …
  readonly requires?: StepRequirements;
}

export const StepFrontmatter = Schema.Struct({
  // … existing …
  requires: Schema.optional(StepRequirements),
});
```

`supports: ReadonlyArray<P>` is **removed** — its information now lives at
`capabilities.factory.permissions`. The orchestrator's existing
`harness.supports.includes(permissions)` check becomes a `capabilities.factory
.permissions.includes(permissions)` check.

### `packages/core/src/subprocess.ts`

```ts
export interface SubprocessHarnessConfig<Name extends string, P extends PermissionMode> {
  readonly name: Name;
  readonly bin: string;
  readonly capabilities: HarnessCapabilities;
  readonly buildArgs: (prompt: string, ctx: { readonly permissions: P }) => ReadonlyArray<string>;
  readonly defaultPermissions?: P;
}
```

The narrow `P extends PermissionMode` generic stays — it still constrains
`buildArgs` to handle exactly the modes the harness declares. We derive `P`
from `capabilities.factory.permissions` (`const` inference) so the existing
typing works without a separate `supports` field.

### `packages/core/src/capabilities.ts` — new file

Holds the `HarnessCapabilities` schema above plus a single matcher:

```ts
export class CapabilityMismatchError extends Data.TaggedError('CapabilityMismatchError')<{
  readonly message: string;
  readonly harness: HarnessName;
  readonly missing: ReadonlyArray<string>; // dotted paths, e.g. 'session.resume'
}> {}

export const matchRequirements = (
  caps: HarnessCapabilities,
  req: StepRequirements | undefined,
): ReadonlyArray<string> => {
  /* return list of missing dotted paths */
};
```

Pure function, easy to test. The orchestrator calls it once per step.

### `packages/core/src/orchestrator.ts`

After resolving the harness and permissions, also check requirements:

```ts
const missing = matchRequirements(
  harness.capabilities,
  entry.options.requires ?? loaded.frontmatter.requires,
);
if (missing.length > 0) {
  return (
    yield *
    Effect.fail(
      new CapabilityMismatchError({
        message: `harness '${harnessName}' is missing required capabilities: ${missing.join(', ')}`,
        harness: harnessName,
        missing,
      }),
    )
  );
}
```

The existing `UnsupportedPermissionError` check stays — it's the
permission-specific path and gives a better message than the generic
`CapabilityMismatchError` would.

### `packages/core/src/errors.ts`

Add `CapabilityMismatchError` to the `FactoryError` union.

### Per-harness updates

#### `packages/harness-claude-code/src/index.ts`

```ts
export const claudeCode = createSubprocessHarness({
  name: 'claude-code',
  bin: 'claude',
  defaultPermissions: 'skip',
  capabilities: {
    loadSession: true, // claude --resume
    mcp: { http: true, sse: true }, // claude supports both
    prompt: { image: true, audio: false, embeddedContext: true },
    session: { list: true, resume: true, close: false },
    factory: { permissions: ['skip', 'accept-edits', 'read-only', 'prompt'], toolEvents: true }, // emits JSON tool events
  },
  buildArgs: claudeBuildArgs,
});
```

#### `packages/harness-codex/src/index.ts`

```ts
capabilities: {
  loadSession: true,                      // codex resume
  mcp:    { http: false, sse: false },    // verify; if false today, leave false
  prompt: { image: true, audio: false, embeddedContext: false },
  session:{ list: false, resume: true, close: false },
  factory:{ permissions: ['skip', 'accept-edits', 'read-only'],
            toolEvents: false },
},
```

#### `packages/harness-copilot/src/index.ts`

```ts
capabilities: {
  loadSession: false,
  mcp:    { http: false, sse: false },
  prompt: { image: false, audio: false, embeddedContext: false },
  session:{ list: false, resume: false, close: false },
  factory:{ permissions: ['skip', 'accept-edits'], toolEvents: false },
},
```

For each harness, claims that aren't trivially verifiable (`mcp.*`, `prompt.*`,
`session.*`) are **researched against the upstream CLI's actual flags** and
referenced in a comment if non-obvious. When uncertain, default to `false` —
the contract should under-claim, not over-claim.

### Drift detection: `--help` snapshot fixtures

Per harness, add a fixture and a unit test that re-runs `--help` and diffs:

```
packages/harness-claude-code/__fixtures__/help.txt
packages/harness-claude-code/src/index.test.ts
```

The test:

1. Spawns `claude --help`, captures stdout.
2. If the fixture exists, asserts equality. On mismatch, prints a diff and
   fails with "upstream CLI changed; review capabilities and update fixture".
3. If the fixture is missing, writes it (first-run bootstrap, only in
   `UPDATE_FIXTURES=1`).
4. Tagged `it.skipIf(!process.env.HARNESS_LIVE)` — opt-in, doesn't run in
   normal CI without the binary installed.

This is the realistic version of "auto-generate from `--help`". It doesn't
auto-derive the capability struct — that's still hand-written — but it fails
loudly when upstream adds/renames a flag, prompting a capability review.

## Tests

- `capabilities.test.ts` — `matchRequirements` returns the correct missing
  dotted paths for: empty requirements, all-satisfied, partially missing,
  permissions mismatch (separate code path), nested fields.
- `orchestrator.test.ts` — new case: a step with `requires: { session:
{ resume: true } }` against a harness that declares
  `session.resume: false` fails with `CapabilityMismatchError` _before_
  spawning. Use `scriptedHarness` and assert the spawn was never called.
- `loader.test.ts` — `requires:` block in frontmatter parses; an unknown
  field rejects with a schema error.
- `subprocess.test.ts` (already exists, untracked) — confirm the new
  `capabilities` config field threads through to `Harness.capabilities`.

No live CLI invocation needed for the core tests; the help-fixture tests are
opt-in via `HARNESS_LIVE=1`.

## Verification

After landing:

```sh
pnpm check     # lint + typecheck
pnpm test      # unit
pnpm example   # SDD quickstart still works (claude-code unchanged behavior)
```

Smoke-test the rejection path by adding a fake step requirement that no
harness meets and confirming the run fails with `CapabilityMismatchError`.

## Migration path

1. Land `capabilities.ts` + types changes + `matchRequirements`. No behavior
   change yet — `Harness.supports` stays as a derived getter
   (`get supports() { return this.capabilities.factory.permissions }`)
   so the orchestrator's existing check keeps working.
2. Migrate the three harness packages to declare `capabilities`. Remove
   `supports` from the config side; the derived getter on the interface stays
   one release for any external harness authors.
3. Wire `requires` through `StepOptions` / `StepFrontmatter` / orchestrator.
4. Drop the derived `supports` getter; the orchestrator reads
   `capabilities.factory.permissions` directly.
5. Add `--help` snapshot fixtures for the three harnesses.

Steps 1–2 ship together (typed, no behavior change). Steps 3–4 ship together
(new feature). Step 5 is independent — can land alongside or after.

## Out of scope, on the radar

- **`harness-acp` package.** Once we have the capability struct, an ACP-native
  harness is a small step: spawn the agent in ACP mode, read the real
  `initialize` handshake, populate `capabilities` from it. Auto-generated for
  free. This is the eventual answer to "can we auto-generate" — but only for
  agents that speak ACP, which today is Claude Code and Gemini CLI.
- **MCP server input.** Once `capabilities.mcp.http` etc. are honored,
  step frontmatter could declare `mcp: [...]` servers and the harness wrapper
  forwards them. Needs a separate config schema; park.
- **Capability negotiation.** Factory advertising client-side capabilities
  back to the agent (image rendering, file system access). Only matters for
  interactive flows; headless factory doesn't need it yet.
- **Versioned capability schema.** ACP versions its protocol; if our struct
  starts churning, add `protocolVersion: '1'` to harness declarations and
  gate orchestrator behavior on it.
