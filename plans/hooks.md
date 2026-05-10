---
name: hooks
description: Let factory users author hooks once in TS/Effect and have factory compile them to per-harness configs (Claude Code, Codex CLI, Copilot CLI) before each run, so a single rule works everywhere.
type: plan
status: not-started
created: 2026-05-09
---

# Hooks — unified hook authoring across harnesses

Owner: @alex.

Let factory users author hooks once in TS/Effect and have factory compile
them to per-harness configs (Claude Code, Codex CLI, Copilot CLI) before
each run. A single rule like "deny reads of `.env`" should work everywhere
without the user knowing each harness's wire format.

## Problem

All three harnesses we target expose ~the same hook surface — JSON-on-stdin,
events for `PreToolUse` / `PostToolUse` / `SessionStart` / `Stop` /
`PermissionRequest`, JSON-or-exit-code decisions — but they disagree on
event casing, config file location, and capability edges (e.g. `modifiedArgs`
on Copilot, `permissionDecisionInput` on Claude). Authors today would have
to write three near-identical configs and keep them in sync.

Factory is the right place to unify this: it already drives all three
harnesses, knows the `runDir`, and brands `HarnessName` at the orchestrator
boundary.

## Goals

1. One TS module — `.factory/hooks.ts` — defines hooks for every harness in
   a pipeline.
2. Two authoring tiers: declarative rules (covers the 80% case; deny paths,
   deny commands, format-on-write, audit-log) and an Effect-handler escape
   hatch (`Hook.effect({ handler: (e) => Effect<HookDecision> })`).
3. Decisions form a closed union — `Hook.allow | Hook.deny(reason) |
Hook.ask(prompt) | Hook.modify({...args})` — and each is rendered to the
   matching wire shape per harness.
4. Compilation runs inside the orchestrator after `recordRunStart`, into a
   run-scoped directory, and is invisible to the user. `factory hooks
compile` exists for debugging.
5. Hook errors are typed and join `FactoryError` so a hook deny shows up as
   a normal run failure.

## Non-goals (v1)

- User-level config (`~/.claude/settings.json` etc.). Per-pipeline + per-
  project covers real use cases; user-level mutation is hard to undo and
  collides with humans using harnesses outside factory.
- Mutating tool results in `PostToolUse` (`Hook.modify` is `PreToolUse`-only
  in v1).
- Auto-enabling Codex's `[features] codex_hooks = true` flag — refuse with
  a fix-it message instead.
- A bundler step. We rely on node's `--experimental-strip-types` (already
  used by `cli/src/main.ts`) plus the existing dynamic `import()` that
  loads `.factory/factory.ts`.
- JSON authoring format (`.factory/hooks.config.json`). TS only.

## Resolved design decisions

### TS-only authoring at `.factory/hooks.ts`

Loaded the same way `.factory/factory.ts` is today
(`packages/cli/src/cli.ts:54-114`). `Hook.effect` handlers stay live as
functions on the loaded `HookSpec[]`; the runtime shim re-imports the same
module to look them up by `HookId`.

### Both tiers desugar to the same execution path

Built-ins (`Hook.denyPaths`, `Hook.denyCommands`, `Hook.formatOnWrite`,
`Hook.auditLog`) are sugar over `Hook.rule` and produce `RuleSpec`. The
escape hatch `Hook.effect` produces `EffectSpec`. Both compile to a per-
harness command that re-invokes `factory-hook <event> --hook <hookId>`.
There is one execution path.

### `Hook.ask` deny-fallback with compile-time warning

When a target harness lacks prompt capability, the compiler emits a
warning naming the hook id and the harness, then emits a `deny` in the
generated config. Reserve `Hook.ask({ fallback: 'allow' })` for later.

### `Hook.modify` is `PreToolUse`-only

All three harnesses support arg modification on `PreToolUse` (Claude via
`permissionDecisionInput`, Codex via the matching output schema, Copilot
via `modifiedArgs`). Enforce at the type level: `ModifyDecision` is only
assignable from a `PreToolUse` handler. `PostToolUse`-modify is deferred.

### Per-pipeline target by default

Compile to `${runDir}/.hooks/<harness>/`, pass `--settings` (Claude),
`CODEX_HOME` (Codex), and the documented Copilot env knob to point each
harness at its run-scoped file. `factory hooks compile --target project`
opts into the committed `.claude/settings.json` flow.

### Hook errors join `FactoryError`

`HookCompileError | HookRuntimeError | HookConfigError` are
`Data.TaggedError` subclasses and added to the existing union in
`packages/core/src/errors.ts`. A hook denying a tool call is a run-level
outcome; it belongs in the same channel as step failures.

### Codex flag: refuse with a fix-it message

Don't mutate user-owned config. If Codex is a target and `[features]
codex_hooks = true` is missing in both `~/.codex/config.toml` and
`.codex/config.toml`, fail compile with a `HookConfigError` instructing
the user to add it. Reserve `factory hooks doctor --fix` for later.

## Module layout

New workspace `packages/hooks/`. Reasons for not nesting under
`packages/core/src/`:

- Each harness package owns the wire format for its emitter — that
  registration belongs next to the harness, not in core.
- The runtime shim ships its own `bin` (`factory-hook`).
- Core already has 13 services; adding a sub-namespace would invert the
  dep graph.

`packages/hooks/` depends on `core`. Harness packages depend on `hooks`
for their emitter.

```
packages/hooks/
  package.json                        # bin: { "factory-hook": "./src/runtime/shim.ts" }
  src/
    index.ts                          # Hook DSL + barrel
    schema.ts                         # HookEvent, HookDecision, HookSpec union
    ids.ts                            # HookId brand
    errors.ts                         # HookCompileError/RuntimeError/ConfigError
    builders.ts                       # Hook.rule, Hook.effect, Hook.denyPaths, ...
    services/
      HookRegistry.ts                 # Effect.Service wrapping HookSpec[]
      HookCompiler.ts                 # Effect.Service: HookSpec[] -> per-harness configs
      HookEmitter.ts                  # interface; one impl per harness
    runtime/
      shim.ts                         # factory-hook <event> entrypoint
      handlerRegistry.ts              # loaded HookSpec[] keyed by HookId
    testing/
      InMemoryHookRegistry.ts
      goldenSnapshots.ts

packages/harness-claude-code/src/hookEmitter.ts
packages/harness-codex/src/hookEmitter.ts
packages/harness-copilot/src/hookEmitter.ts
```

## Patterns from `repos/effect/`

Locked-in references — implementation should mirror these:

- `Schema.TaggedClass` for each event/decision/spec variant —
  `repos/effect/packages/effect/src/Schema.ts:8771`. Union construction
  shape from `repos/effect/packages/cluster/src/Envelope.ts:255-273`.
- `Schema.parseJson(...)` for stdin payload decoding —
  `repos/effect/packages/effect/src/Schema.ts:4838`.
- `Match.value` / `Match.tag` / `Match.tagsExhaustive` for dispatch on
  `HookSpec._tag` and `HookDecision._tag` —
  `repos/effect/packages/effect/src/Match.ts:237, 736, 879`.
- `NodeStream.stdin` for the runtime shim —
  `repos/effect/packages/platform-node-shared/src/NodeStream.ts:136`.
- `FileSystem.writeFileString` + `makeDirectory({ recursive: true })` —
  `repos/effect/packages/platform/src/FileSystem.ts:256` (matches
  `RunWorkspace.ts:138-145`).
- `Effect.Service` with a `static Test = Layer.succeed(...)` for unit
  tests, per `patterns/services-and-layers.md`.
- `Data.TaggedError` per `patterns/typed-errors.md`.

## Steps

Each step is independently shippable, lands its own tests, and does not
require subsequent steps to compile.

### Step 1 — schemas, ids, errors

Files: `packages/hooks/src/schema.ts`, `packages/hooks/src/ids.ts`,
`packages/hooks/src/errors.ts`. Extend
`packages/core/src/errors.ts:FactoryError` to include the three new
errors.

- `HookEvent`: `Schema.Union` of `Schema.TaggedClass` per event
  (`PreToolUse`, `PostToolUse`, `SessionStart`, `Stop`,
  `PermissionRequest`, …). Common fields (`toolName?`, `path?`,
  `command?`) live on the relevant variants only.
- `HookDecision`: `Schema.Union(AllowDecision, DenyDecision, AskDecision,
ModifyDecision)` as `TaggedClass`es. `ModifyDecision` is parameterised
  on event tag at the type level so it's only assignable from a
  `PreToolUse` handler.
- `HookId = Schema.String.pipe(Schema.brand('HookId'))`.
- `HookCompileError`, `HookRuntimeError`, `HookConfigError` —
  `Data.TaggedError`. Re-export from `packages/hooks/src/errors.ts` and
  add to `FactoryError` in core.

Test: `it.effect` round-trips a sample of each decision through
`Schema.parseJson(HookDecision)`.

### Step 2 — `HookSpec` union and builder API

Files: `packages/hooks/src/schema.ts` (add `HookSpec` union),
`packages/hooks/src/builders.ts`, `packages/hooks/src/index.ts`.

- `RuleSpec`, `EffectSpec`, `DenyPathsSpec`, `DenyCommandsSpec`,
  `FormatOnWriteSpec`, `AuditLogSpec` — all `Schema.TaggedClass`.
  `EffectSpec` carries `handler: (e: HookEvent) => Effect<HookDecision,
HookRuntimeError>`; field is `Schema.Any` and documented as behaviour-
  shaped (`patterns/schema-at-the-edge.md` rule applies — handler is
  validated by use, not by schema).
- `Hook.rule({...})`, `Hook.effect({...})` return raw spec instances.
  `Hook.denyPaths(...)`, `Hook.denyCommands(...)`,
  `Hook.formatOnWrite(...)`, `Hook.auditLog(...)` desugar to `RuleSpec`.
- `Hook.allow / Hook.deny / Hook.ask / Hook.modify` are `HookDecision`
  constructors used inside handlers.
- Auto-assign `HookId` from a stable hash of spec contents at builder
  time, so `factory-hook --hook <id>` is reproducible across runs.

Test: plain `vitest` test asserting builders produce expected `_tag`s and
that `Hook.denyPaths` desugars to a `RuleSpec` with the right matchers.
Type-level `expectTypeOf` test that `HookSpec` is a closed union and that
`Hook.modify` is rejected outside `PreToolUse`.

### Step 3 — `HookRegistry` service

File: `packages/hooks/src/services/HookRegistry.ts`.

`class HookRegistry extends Effect.Service<HookRegistry>()(...)` exposing
`all`, `byId`, `byEvent`. `HookRegistry.layer(specs)` for production;
`HookRegistry.Test = Layer.succeed(...)` for tests.

Test: `it.effect` checks `byEvent('preToolUse')` returns only relevant
specs.

### Step 4 — `HookEmitter` per harness

Files: `packages/hooks/src/services/HookEmitter.ts`, plus one
`hookEmitter.ts` in each of the three harness packages.

- `HookEmitter` interface in `hooks` package: `emit(specs, runDir):
Effect<EmittedConfig, HookCompileError, FileSystem>`.
- `EmittedConfig = { files: ReadonlyArray<{ path; contents }>;
envForHarness: Record<string,string>; argsForHarness:
ReadonlyArray<string> }`.
- Each emitter registered under a harness key (`'claude-code'`,
  `'codex'`, `'copilot'`) so the compiler can `Match.value(harnessName)`.
- `Hook.ask` capability gate lives here: emit `Effect.logWarning` and
  downgrade to deny when the target lacks prompt support.

Test (per emitter): `it.effect` feeds a small `HookSpec[]`, asserts
file paths and structural contents.

### Step 5 — `HookCompiler` service

File: `packages/hooks/src/services/HookCompiler.ts`.

- `Effect.Service` with `dependencies: [HookRegistry.Default]`. Method
  `compile({ harness, runDir }): Effect<EmittedConfig, HookCompileError,
HookEmitter | FileSystem | Path>`.
- Normalises built-in specs to `RuleSpec` via `Match.tagsExhaustive`
  before handing to the emitter.
- Codex precondition: when `harness === 'codex'`, check
  `~/.codex/config.toml` and project `.codex/config.toml` for `[features]
codex_hooks = true`; fail with `HookConfigError` if missing.
- Writes via `FileSystem.writeFileString` after `makeDirectory({
recursive: true })`.

Test: `it.scoped` with `fs.makeTempDirectoryScoped()`, compile a fixture
for each harness, assert file paths and env keys.

### Step 6 — runtime shim `factory-hook <event>`

Files: `packages/hooks/src/runtime/shim.ts`,
`packages/hooks/src/runtime/handlerRegistry.ts`. `package.json` adds
`bin: { "factory-hook": "./src/runtime/shim.ts" }` with the same
`#!/usr/bin/env -S node --experimental-strip-types` shebang as
`cli/src/main.ts`.

The shim:

1. Reads `--hook <hookId>` from argv.
2. Reads stdin via `NodeStream.stdin`, accumulates with `Stream.runCollect`,
   decodes with `Schema.parseJson(HookEvent)`.
3. Re-imports `.factory/hooks.ts` (same logic as `loadFactoryConfig` in
   `cli.ts:54`), looks up the spec by `HookId`, runs its handler under
   `NodeContext.layer`.
4. `Match.tag` on the resulting `HookDecision` to produce stdout JSON /
   exit code per harness conventions. Harness dialect comes from env var
   `FACTORY_HOOK_HARNESS`, set by the emitter in step 4.
5. Errors → `HookRuntimeError`, formatted via `withFriendlyErrors`,
   exit 1.

Test: `it.effect` constructs a fake stdin (`Stream.fromIterable([new
TextEncoder().encode(json)])`), provides an `InMemoryHookRegistry`,
asserts captured stdout matches the decision encoding for each harness
dialect.

### Step 7 — pipeline wiring + CLI

Files: `packages/core/src/factory.ts` (extend `FactoryOptions` with
`hooks?: ReadonlyArray<HookSpec> | { '*': ...; claude?: ...; codex?:
...; copilot?: ... }`), `packages/core/src/orchestrator.ts` (call
`HookCompiler.compile` after `recordRunStart`, before the step loop),
`packages/cli/src/cli.ts` (subcommands).

- Compilation runs inside the orchestrator once per harness used, so
  `runDir` is known via `RunWorkspace.runDir` and the run-scoped target
  works automatically.
- Emitted env+args merge into `factoryHarnessEnv(runDir, cwd)` and pass
  through `ExecOpts.env` to subprocess spawn.
- CLI: `hooksCommand = Command.make('hooks').pipe(Command.withSubcommands(
[listCmd, compileCmd, checkCmd]))` registered next to `runCommand`.
  `factory hooks check '<event-json>'` runs the registry against a
  synthetic event and prints the decision — for debugging rules.
- `factory run` continues to auto-compile (it goes through the
  orchestrator).

Test: extend `orchestrator.test.ts` with a sub-`describe` building an
`AppLayer` that includes `HookRegistry.Test`, asserts harness `exec` was
called with env containing `FACTORY_HOOK_HARNESS=claude-code` and a
`--settings` arg pointing into `runDir`.

### Step 8 — golden-file snapshot test

File: `packages/hooks/src/goldenCompile.test.ts`, fixture
`packages/hooks/test/fixtures/hooks.example.ts`.

Fixture is the canonical example from `Goals` above (`Hook.denyPaths`,
`Hook.denyCommands`, `Hook.formatOnWrite`, `Hook.auditLog`, one
`Hook.rule`, one `Hook.effect`). `it.effect` runs `HookCompiler.compile`
for each harness against `fs.makeTempDirectoryScoped()`, reads the
produced files, snapshots with `expect(...).toMatchFileSnapshot(...)`.
Three snapshots, reviewed in PR.

### Step 9 — docs

- `docs/adr/00XX-hooks.md` — captures the resolved design decisions
  above so future agents don't relitigate them.
- `packages/hooks/README.md` — user-facing API.

## Critical files for implementation

- `packages/core/src/orchestrator.ts` — compile call site
- `packages/core/src/factory.ts` — `FactoryOptions.hooks`
- `packages/core/src/subprocess.ts` — env/args merge
- `packages/core/src/errors.ts` — extend `FactoryError`
- `packages/cli/src/cli.ts` — subcommand registration, dynamic import of
  `.factory/hooks.ts`
- `packages/harness-claude-code/src/index.ts`,
  `packages/harness-codex/src/index.ts`,
  `packages/harness-copilot/src/index.ts` — emitter registration

## Reference: example user-facing API

```ts
// .factory/hooks.ts
import { Hook } from '@factory/hooks';
import { Effect } from 'effect';

export default [
  Hook.denyPaths(['**/.env*', '**/secrets/**']),
  Hook.denyCommands([/curl .* \| (ba)?sh/, 'rm -rf /']),
  Hook.formatOnWrite({ run: 'pnpm prettier --write {{path}}' }),
  Hook.auditLog({ to: '.factory/runs/{{runId}}/tools.jsonl' }),

  Hook.rule({
    on: 'preToolUse',
    match: { tool: ['Read', 'Edit', 'Write', 'Bash'] },
    when: (e) => /\.env(\..+)?$/.test(e.path ?? e.command ?? ''),
    decide: 'deny',
    reason: 'factory: .env access is blocked',
  }),

  Hook.effect({
    on: 'preToolUse',
    match: { tool: 'Bash' },
    handler: (event) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        yield* audit.record(event);
        return event.command.startsWith('git push')
          ? Hook.ask('Confirm push to remote?')
          : Hook.allow;
      }),
  }),
];
```

```ts
// pipeline.ts
import { factory } from '@factory/core';
import hooks from './.factory/hooks';

export default factory({ name: 'sdd-quickstart', hooks })
  .step('plan', 'plan.md')
  .step('build', 'build.md');
```
