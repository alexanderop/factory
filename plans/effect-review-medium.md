# Effect review — medium-severity fixes

Status: not started. Owner: @alex.

Concrete fixes for the medium-severity findings from the per-module
Effect code review. None of these block correctness today; together
they tighten error channels, remove concurrency footguns, and bring
the CLI + tests in line with the project's Effect conventions.

## Problem

The medium findings cluster in three places:

- **RunWorkspace lifecycle** has a few rough edges: `updateLatestSymlink`
  swallows errors as `unknown`, `let`-mutated closure state without
  `Ref`, and the `latest` symlink is never refreshed on resume.
- **runManifest atomic-write** uses a PID-only tmp suffix and leaks tmp
  files on crash.
- **CLI input handling** lets unvalidated `runId` flow into `path.join`,
  models the `'latest'` sentinel as a magic string, and uses
  `console.log` instead of `effect/Console`.
- **Observability + types** have structural-typing leaks: a structural
  `_tag` constraint instead of `FactoryError`, and `RunOptions` /
  `ResumeOptions` duplicate six fields by hand.
- **Tests** rebuild identical layers per case and miss one
  `Exit.isFailure` assertion.

## Goals

1. Recording-side errors are typed (`PlatformError`, not `unknown`) and
   the `latest` symlink reflects the most-recently-active run.
2. Service state is held in `Ref` consistently with sibling services.
3. Atomic writes survive concurrent in-process writers and crashes.
4. CLI inputs are validated/branded at the `@effect/cli` boundary;
   stdout goes through `effect/Console`.
5. `recordTaggedError` constrains its error parameter to `FactoryError`
   so the registry of known tags is exhaustive at compile time.
6. Test layers are hoisted with `it.layer` where they are duplicated;
   failure tests assert `Exit.isFailure`.

## Non-goals

- Changing the on-disk run/step/iter layout (covered in red plan if at
  all).
- Migrating existing `Context.Tag` services to `Effect.Service` (the
  patterns explicitly say leave these alone).
- Splitting `ResumeUnavailableError` reasons (lower-priority cosmetic;
  see "Lower-priority follow-ups" below).

## Items

### M1. RunWorkspace `updateLatestSymlink` typed-error + resume coverage

Files: `packages/core/src/services/RunWorkspace.ts:373`,
`packages/core/src/services/RunWorkspace.ts:465`.

Current code:

```ts
.pipe(Effect.catchAll((cause: unknown) => Effect.logDebug(...)))
```

`fs.remove` and `fs.symlink` fail with `PlatformError` (specifically
`SystemError`), not `unknown`. Per `patterns/typed-errors.md` lines
96-113, `catchTag('SystemError', ...)` keeps the error channel honest.

Two changes:

1. Replace `catchAll((cause: unknown) => ...)` with
   `catchTag('SystemError', (e) => Effect.logDebug(`updateLatestSymlink
   skipped: ${e.message}`))`. Any non-`SystemError` (a defect) keeps
   propagating as a defect — which is what we want.
2. Call `updateLatestSymlink(runId)` from
   `LiveRunWorkspace.resumed` after the run is hydrated, so `latest`
   tracks the resumed run too. Without this, listing or `factory show
latest` points at whatever was last _started_, which surprises
   users who resumed a different run.

Test: extend the existing symlink test in
`runWorkspace.test.ts:466-493` (or add a sibling case) to exercise
the resumed path; assert the symlink target after `LiveRunWorkspace.resumed`.

### M2. RunWorkspace state in `Ref`

File: `packages/core/src/services/RunWorkspace.ts:143-152`.

Current code holds a `let runRecord: RunRecord` plus two `Map`s in a
plain closure inside `Layer.scoped`. Today only one fiber per run
mutates these, so it is safe — but it sidesteps the Effect concurrency
story and is inconsistent with `iterPrompt.ts` and `EventEmitter.ts`,
which use `Ref.Ref`.

Refactor:

1. `runRecordRef = yield* Ref.make<RunRecord>(initial)`,
   `stepEntriesRef = yield* Ref.make(HashMap.empty<StepId, StepEntry>())`
   (or `Map`, whichever fits the access pattern best),
   `iterEntriesRef = yield* Ref.make(...)`.
2. Replace `let`-assignments with `Ref.update`/`Ref.set`. Replace
   reads with `Ref.get`. For read-modify-write across an I/O step
   (e.g. `recordStepStart` writes to disk and updates state), use
   `SynchronizedRef` so the I/O is serialised with the update.
3. The closure `Effect.provideService(FileSystem.FileSystem, fs)` at
   `:154-157` becomes redundant once the writers run inside the
   service's own `Effect.gen` and inherit `FileSystem` from the layer
   scope; drop it.

Cross-reference: `repos/effect/packages/effect/src/Ref.ts`,
`repos/effect/packages/effect/src/SynchronizedRef.ts`. No behaviour
change; tests should pass unchanged.

### M3. `atomicWriteString` — use scoped temp, deterministic cleanup

File: `packages/core/src/services/runManifest.ts:93-107`.

Current shape uses `${path}.tmp.${process.pid}` — unique per process,
not per-call. Two writers to the same `path` in the same process race;
a crash between `writeFileString` and `rename` orphans the tmp.

Fix:

1. Replace the pid suffix with `fs.makeTempFileScoped({ directory:
path.dirname(target) })` (`repos/effect/packages/platform/src/FileSystem.ts:467`).
   Scoped means the temp file is registered with the surrounding
   `Scope` and removed automatically on scope close, including on
   failure paths.
2. Wrap the write+rename in `Effect.acquireRelease`:
   - acquire: open tmp via `makeTempFileScoped`
   - use: `fs.writeFileString(tmp, payload)` →
     `fs.rename(tmp, target)`. On success the rename "consumes" the
     tmp; the scoped finalizer's `fs.remove(tmp)` becomes a no-op
     (with `Effect.ignore`).
   - release: `fs.remove(tmp).pipe(Effect.ignore)`.
3. The existing test at `runManifest.test.ts:84-98` (rename-failure
   injection) keeps working because `rename` is still injectable;
   add an assertion that on rename failure the tmp file is gone.

### M4. Orchestrator `loadRecordedSteps` — flatten less, fail less

File: `packages/core/src/orchestrator.ts:786-826`.

Current code:

```ts
const exists = yield* fs.exists(stepsRoot).pipe(
  Effect.mapError(e => new ResumeUnavailableError({ ..., reason: 'not-found' })),
);
```

A permissions error becomes `'not-found'`. Confusing. Also the
imperative `for` loop with `records.push` is non-idiomatic given the
file otherwise uses `Effect.gen` + `Effect.forEach`.

Fix:

1. Mirror `resolvePrdContent` (`:93-112`):
   `Effect.catchTag('SystemError', (e) => e.reason === 'NotFound'
? Effect.succeed(false) : Effect.fail(e))`. Any non-NotFound stays
   typed.
2. Convert the loop to `Effect.forEach(subdirs, (name) => decodeStep(...),
{ concurrency: 'unbounded' })` — concurrent reads, no aliasing.
3. New `ResumeUnavailableError` reason variants are out of scope here;
   leave the `'not-found'` mapping for the case that actually was
   `NotFound`.

### M5. CLI runId validation + `'latest'` sentinel + `Console.log`

Files: `packages/cli/src/cli.ts:21-22`, `:151-188`, `:228-231`.

Three changes, one PR:

1. **Validate `runIdArg`.** Add
   `RunIdInputSchema = Schema.String.pipe(Schema.pattern(/^[a-zA-Z0-9_-]+$/))`
   (or whatever `RunId` requires) and pass via `Args.text(...).pipe(
Args.withSchema(RunIdInputSchema))` (cf.
   `repos/effect/packages/cli/src/Args.ts:465`). Rejects path
   separators and `..` at the boundary; everything downstream can
   trust the value.
2. **Model `'latest'` explicitly.** Add `--latest`
   (`Options.boolean('latest')`) to the `resume`/`show` commands that
   currently accept `'latest'` as a magic argument. If both `--latest`
   and a positional runId are given, fail at the boundary. Inside the
   command body, branch on the boolean rather than string-comparing.
3. **`Console.log` instead of `console.log`.** Replace the two
   `Effect.sync(() => console.log(...))` calls in the root command
   with `yield* Console.log(...)` from `effect/Console`. Match the
   style in `repos/effect/packages/cli/examples/naval-fate.ts:43,55`.

Tests: extend `cli.test.ts` (or add a smoke case) with a
`runIdArg = '../etc/passwd'` input and assert the CLI rejects with the
schema-decode error message.

### M6. Constrain `recordTaggedError` to `FactoryError`

File: `packages/core/src/observability.ts:11-14`.

Current signature:

```ts
const recordTaggedError = <E extends { readonly _tag: string; readonly message?: string }>(
  effect: Effect.Effect<...>,
) => ...
```

Structural — anyone can pass a freshly-invented `{ _tag: 'Foo' }` and
it compiles. Worse, the special-case `if (error._tag === 'StepIdleTimeoutError')`
at line 23 is a runtime check the type system can't verify against the
known tag set.

Fix:

1. Import `FactoryError` from `./errors`. Replace the `extends ...`
   constraint with `extends FactoryError`.
2. The `'StepIdleTimeoutError'` branch becomes exhaustively narrowable
   via `Match.value(error).pipe(Match.tag(...))` if we want it; even
   without `Match`, TypeScript will refuse if the tag isn't part of
   `FactoryError`.
3. Add a `defaultExhaustive` for the union or rely on `_tag` narrowing
   so that adding a new error in `errors.ts` triggers a compile error
   here.

No runtime change; one type-level change. Tests pass unchanged.

### M7. `RunOptions` / `ResumeOptions` shared base

File: `packages/core/src/types.ts:202-210`.

`RunOptions` and `ResumeOptions` differ only in `prd` (run) vs `runId`
(resume). The other six fields are duplicated by hand.

Fix:

```ts
type BaseRunOptions = Readonly<{
  factory: Factory;
  signal?: AbortSignal;
  onEvent?: (event: FactoryEvent) => void;
  onError?: (event: Extract<FactoryEvent, { type: 'error' }>) => void;
  cwd?: string;
  // ... shared
}>;

export type RunOptions = BaseRunOptions & Readonly<{ prd: string }>;
export type ResumeOptions = BaseRunOptions & Readonly<{ runId: RunId }>;
```

Once R4 (medium-plan-adjacent: red-plan R4) lands, `onError` here is
already `Extract<FactoryEvent, ...>`. Run `pnpm check`; consumers may
need a one-line annotation if they were narrowing structurally.

### M8. observability test — assert `Exit.isFailure`

File: `packages/core/src/observability.test.ts:88-94`.

```ts
yield * Effect.exit(programThatFails);
// ... assertions on span attributes only
```

Fix: bind the exit and assert it really failed.

```ts
const exit = yield * Effect.exit(programThatFails);
assertTrue(Exit.isFailure(exit));
// then proceed with span attribute assertions
```

A regression that swallows the error (e.g. someone adds a `catchAll`
upstream) would otherwise pass this test.

### M9. Hoist shared layer in `toolEvents.test.ts`

File: `packages/core/src/toolEvents.test.ts:38-148`.

Three `it.effect`s build the same layer (`SilentDisplay +
recordingEventEmitter + harnessRegistry + InMemoryStepLoader +
scriptedUntilEvaluator + InMemoryRunWorkspace + NodeContext`).

Fix: use `it.layer(buildLayer)(({ it }) => { ... })`
(`repos/effect/packages/vitest/src/utils.ts`,
`repos/effect/packages/cluster/test/SqlMessageStorage.test.ts:38`).
Per-test `Ref.make`s for capture stay inside each case body — only
the layer composition is hoisted.

Same fix is borderline-applicable to `observability.test.ts`; only do
it there if a third test joins.

## Lower-priority follow-ups (not in this plan)

These came out of the same review but are cosmetic; flag here so they
don't get lost:

- Split `ResumeUnavailableError.reason` enum into three tags
  (`RunAlreadyComplete` / `RunNotFound` / `RunInProgress`).
- Tighten `RunRecordingError.path` to required.
- Collapse the six `decodeX/encodeX` wrappers in `runManifest.ts` into
  one `withRecordingError(message, path)` helper.
- Mark `readRun` / `readStep` `@internal` in `index.ts` (or route
  through `RunWorkspace`).
- Replace `Cause.failureOption` ladder in `runManifest.test.ts` with
  `assertSome` / `assertFailure` from `@effect/vitest`.
- Use `it.scoped.skipIf(process.platform === 'win32', …)` in
  `runWorkspace.test.ts:466-493` instead of an in-body `if`.

## Sequencing

Most items are independent. Suggested grouping:

1. **M1 + M2 + M3** — RunWorkspace / runManifest cleanup, one PR per
   item; touches the same files in sequence.
2. **M4** — orchestrator nit, drops in cleanly.
3. **M5** — CLI input boundary; ship as one PR.
4. **M6 + M7 + M8** — type tightening + one test assertion; small PR.
5. **M9** — test layer hoist, last so it benefits from any new tests
   added in earlier PRs.

## Verification

- `pnpm check` (oxlint + tsc) passes after each step.
- `pnpm test` passes after each step.
- Manual smoke: `factory run --prd ./prd.md` → `factory show latest`
  → kill mid-step → `factory resume latest` → confirm `latest`
  symlink updates and CLI rejects an injected `'../etc/passwd'`
  argument cleanly.
