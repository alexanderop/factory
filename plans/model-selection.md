---
name: model-selection
description: Configurable model selection per harness, with factory-wide defaults keyed by harness name and per-step overrides — same precedence shape as permissions.
type: plan
status: not-started
created: 2026-05-09
---

# Plan: model selection

## Goal

A factory user wants to pick the model each harness runs. Today there's
nothing — every harness invokes its CLI with no `--model` flag and gets the
CLI's own default. The framework should support:

1. A factory-wide default per harness:
   `factory({ models: { 'claude-code': 'claude-opus-4-7', codex: 'gpt-5-codex' } })`.
2. A per-step override: `step('plan', '...', { harness: 'claude-code', model: 'claude-sonnet-4-6' })`.
3. Frontmatter `model:` for users who keep step config next to the prompt.

Resolution mirrors `permissions` (see `plans/permissions.md`): step option →
step frontmatter → factory `models[harnessName]` → harness `defaultModel`
(constructor-injected, optional) → omit the flag (CLI's own default).

The keys of `factory.models` are typed against the registered harness names
so a typo (`'claude-cod'`) fails at compile time, the same way step `harness`
already does.

## Non-goals

- **Typed model names per harness.** Model identifiers stay `string`. Listing
  every Claude/GPT/Copilot model in the type system couples the framework to
  release schedules and ages badly. A `--help`-style snapshot fixture per
  harness is in the same spirit as the permissions plan's "drift detection";
  out of scope here.
- **CLI flag for run-time override.** `--model claude-code=foo --model codex=bar`
  adds parsing surface area for a niche use case. Users who want that today
  can edit `.factory/factory.ts`. Revisit if/when an A/B-runner asks for it.
- **Cross-harness model aliasing** (e.g. `models: { reasoning: 'opus-4-7' }`
  applied wherever a step needs reasoning). Models aren't portable across
  harnesses — each CLI has its own naming.
- **Validating the model exists.** Each CLI accepts free-form strings and
  surfaces its own "unknown model" error. We don't pre-flight.

## Surface area

### `packages/core/src/types.ts`

```ts
export interface ExecOpts {
  // … existing fields …
  readonly model?: string; // resolved by orchestrator; omitted means "use CLI default"
}

export interface StepOptions<Names extends string = string> {
  // … existing fields …
  readonly model?: string;
}

export interface FactoryOptions<Names extends string = string> {
  // … existing fields …
  readonly models?: { readonly [K in Names]?: string };
}

export const StepFrontmatter = Schema.Struct({
  // … existing fields …
  model: Schema.optional(Schema.String),
});
```

The `models` map is keyed by `Names`, which is the union of registered
harness names that `factory<Hs>` already infers. This is what makes
`models: { 'claude-cod': '...' }` a TS error.

`ExecOpts.model` stays optional — the harness's `buildArgs` decides whether
to emit `--model <name>` or skip it. The orchestrator resolves to either a
concrete string or `undefined`; we don't substitute a sentinel.

### `packages/core/src/subprocess.ts`

```ts
export interface SubprocessHarnessConfig<Name extends string, P extends PermissionMode> {
  readonly name: Name;
  readonly bin: string;
  readonly defaultModel?: string;
  // …
  readonly buildArgs: (
    prompt: string,
    ctx: { readonly permissions: P; readonly model?: string },
  ) => ReadonlyArray<string>;
}
```

`defaultModel` propagates from config to the `Harness` interface, same as
`defaultPermissions`. The wrapper itself doesn't decide — the orchestrator
reads it during resolution and passes the final value into `buildArgs`.

### `packages/core/src/types.ts` — `Harness`

```ts
export interface Harness<Name extends string = string> {
  readonly name: Name;
  readonly capabilities: HarnessCapabilities;
  readonly defaultPermissions?: PermissionMode;
  readonly defaultModel?: string;
  readonly exec: …;
  readonly stream: …;
}
```

### `packages/core/src/orchestrator.ts`

One helper next to `resolvePermissions`:

```ts
const resolveModel = (
  step: LoadedStep,
  stepOpts: StepOptions,
  pipeline: FactoryOptions,
  harness: Harness,
): string | undefined =>
  stepOpts.model ??
  step.frontmatter.model ??
  pipeline.models?.[harness.name] ??
  harness.defaultModel;
```

Threaded into `runStep` exactly like `permissions` is today (line 226 in the
current orchestrator):

```ts
opts: { prompt: fullPrompt, cwd, idleTimeoutMs, permissions, model },
```

No new tagged error: an unresolved model is legal (means "let the CLI pick").

### Per-harness `buildArgs`

All three CLIs accept `--model <name>` (verified: `claude`, `codex`,
`copilot`). Append the flag only when `model` is defined:

```ts
// packages/harness-claude-code/src/index.ts
export const claudeBuildArgs = (
  prompt: string,
  ctx: { readonly permissions: ClaudeMode; readonly model?: string },
): readonly string[] => [
  ...claudePermissionFlags(ctx.permissions),
  ...(ctx.model ? ['--model', ctx.model] : []),
  '-p',
  prompt,
];
```

Same shape for `codex` and `copilot`. Conditional spread keeps the
no-model case byte-for-byte identical to today's args, so the existing
subprocess tests don't churn.

### `packages/cli/src/cli.ts`

No change for v1. `RunOptions.model` is intentionally absent so we don't
ship a single-string CLI flag that fails confusingly when multiple harnesses
are registered.

### Effect-side patterns we're following

- **Schema at the edge** (`patterns/schema-at-the-edge.md`): `model` joins
  `StepFrontmatter`'s existing `Schema.Struct` so frontmatter values are
  decoded once at the loader boundary into `string | undefined`. No `as`,
  no manual parsing.
- **Tagged errors** (`patterns/typed-errors.md`): no new error needed.
  Resolution failures don't exist — `undefined` is a valid resolved state.
- **Typed builder shape** (`plans/typed-builder.md`): the `Names` generic
  on `factory<Hs>` already drives `step.harness` typing. `models: { [K in Names]?: string }`
  reuses the same generic, so harness-name typos surface at compile time
  identically to step `harness:` typos.
- **Decoder hoisting**: `decodeFrontmatter` in `StepLoader.ts` already
  hoists; adding a field to the schema costs nothing extra.

## Tests

`packages/core/src/orchestrator.test.ts`:

- precedence: step option > frontmatter > factory `models[name]` > harness
  `defaultModel` > undefined. One scripted harness per case, recording the
  `model` it received via `ExecOpts`.
- mismatched key (`models: { unknown: 'x' }`) — guarded at compile time, so
  this is a `expect-type` / `tsd`-style negative test if we have one,
  otherwise just a comment in the test file pointing at the type.

`packages/core/src/loader.test.ts`:

- `model: claude-opus-4-7` in frontmatter parses and round-trips.
- non-string `model:` rejects with `StepLoadError` carrying the schema
  parse message.

`packages/core/src/subprocess.test.ts`:

- with `model` set, `buildArgs` emits `--model <name>` adjacent to the
  permission flags.
- without `model`, args are unchanged from today (regression guard).

No live CLI invocation; unit-only.

## Verification

After landing, the SDD quickstart should be able to do:

```ts
// examples/sdd-quickstart/.factory/factory.ts
factory({
  name: 'sdd',
  harness: 'claude-code',
  harnesses: [claudeCode, codex, copilot],
  models: {
    'claude-code': 'claude-opus-4-7',
    codex: 'gpt-5-codex',
    copilot: 'claude-sonnet-4-6',
  },
})
  .step('plan', './.factory/steps/plan.md', { harness: 'claude-code' })
  .step('ralph', './.factory/steps/ralph.md', {
    harness: 'codex',
    model: 'gpt-5', // override for this step only
  });
// …
```

`pnpm typecheck` passes; `pnpm example` shows each step's recorded args
contain the resolved `--model` (visible in the per-iter
`runs/<id>/steps/NN-<name>/iters/001/stdout.log` capture).

## Out of scope, on the radar

- **CLI flag** `factory run sdd --model harness=name` (repeatable) for
  one-shot overrides. Same shape as `--permissions` today; trivial to add
  once a real workflow asks for it.
- **Per-harness model snapshot fixtures.** Mirror the `--help` snapshot
  idea from the capabilities plan: capture each CLI's `--help | grep
model` and check it in, so a model-flag rename surfaces as a fixture
  diff in CI rather than a runtime spawn error.
- **Telemetry.** Add `factory.model` as a span attribute on
  `factory.step` next to `factory.harness`, so OTel traces show which
  model each step actually ran. Cheap follow-up, not load-bearing.
- **Env-var fallback** (`FACTORY_MODEL_CLAUDE_CODE=…`). Useful for CI
  matrices but adds a fourth resolution layer; defer.
