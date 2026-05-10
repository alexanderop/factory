---
name: effect-vitest-migration
description: Adopt `@effect/vitest` idioms across our test suite — `it.effect`/`it.scoped`, `assertSuccess`/`assertFailure` from `@effect/vitest/utils`, scoped temp dirs, and `it.layer` for shared layers — and codify the result as `patterns/testing-effect.md` v2.
type: plan
status: in-progress
created: 2026-05-09
---

# Plan: align our test setup with Effect's idioms

## Goal

`@effect/vitest@^0.29` is already a devDependency, but only one of our ten
test files (`factory.test.ts`) imports from it. Everything else uses plain
`vitest` + `await Effect.runPromise(...)` + manual `Exit`/`Cause` narrowing.
That works, but it costs us:

- ~40 lines of repeated `Exit.isFailure` + `Cause.failureOption` + nested
  `if (_tag === 'Some' && value._tag === 'X')` ladders across seven test
  blocks.
- Manual `mkdtempSync` + `afterAll(rmSync)` instead of scoped temp dirs that
  clean themselves up on fiber interrupt.
- Per-test `Ref.unsafeMake` allocations threaded through the layer builder.
- No way to share a heavy layer across multiple `it.effect` blocks (the
  `buildLayer` helper rebuilds everything per test).

The Effect monorepo already has the answers we want: `it.scoped` +
`fs.makeTempDirectoryScoped()` (see
`repos/effect/packages/sql-sqlite-node/test/Client.test.ts`),
`assertSuccess`/`assertFailure` (see
`repos/effect/packages/effect/test/Config.test.ts`), and `it.layer(L)((it) =>
…)` for shared fixtures (see
`repos/effect/packages/cluster/test/SqlMessageStorage.test.ts:38`).

This plan migrates our existing tests to that style and lands a refreshed
`patterns/testing-effect.md` so future work follows it.

## Non-goals

- **No property-based tests.** `it.effect.prop` would fit
  `capabilities.test.ts:matchRequirements`, but adding fast-check arbitraries
  is a separate decision and a separate diff. Park.
- **No new test coverage.** This is a refactor: same tests, smaller surface.
  Behavior changes go in their own PRs.
- **No migration of `factory.test.ts`.** It already uses `@effect/vitest`'s
  `expectTypeOf` + `expect.toEqualTypeOf`. Leave alone.
- **No vitest config changes.** `vitest.config.ts` stays as-is —
  `@effect/vitest` re-exports vitest's API and `it.effect` works without
  config.
- **No live-CLI test rework.** `harness-*/src/index.test.ts` already use
  `it.skipIf`. They don't run Effect bodies, so there's nothing to migrate.
  Confirm only.

## What changes

### New pattern: `patterns/testing-effect.md` (rewrite)

Today's `testing-effect.md` already nudges toward `it.effect`, but it
documents the mixed style as acceptable ("don't migrate working tests"). We
update it to:

1. Say **`it.effect` / `it.scoped` is the default** for new tests.
2. Document **`@effect/vitest/utils`** assertions (`assertSuccess`,
   `assertFailure`, `assertSome`, `assertInstanceOf`, `assertInclude`,
   `deepStrictEqual`, `strictEqual`).
3. Document **`it.layer(L)((it) => …)`** for shared fixtures — currently
   the file mentions `layer(...)` only as a footnote.
4. Document **scoped resources**: prefer `fs.makeTempDirectoryScoped()` over
   `mkdtempSync` + `afterAll(rmSync)`.
5. Drop the "two test styles" framing. There's one preferred style now;
   plain `vitest` is the fallback for tests with no Effect body
   (`error-handler.test.ts`, `subprocess.test.ts:39`, the type-only
   `factory.test.ts`).

The pattern file lands first — once approved, every test migration cites it
in the diff.

### Migration: per-file

| File                          | Before                                                                                | After                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `orchestrator.test.ts`        | `vitest` + `Effect.runPromise` + manual Exit narrowing × 3                            | `@effect/vitest` `it.effect` / `it.layer(buildLayer(...))` + `assertFailure`        |
| `loader.test.ts`              | `vitest` + `mkdtempSync`/`afterAll` + `Effect.runPromise` + manual Exit narrowing × 3 | `it.scoped` + `fs.makeTempDirectoryScoped()` + `assertFailure` + `assertInstanceOf` |
| `runWorkspace.test.ts`        | `vitest` + `mkdtempSync` × 2 + `Effect.runPromise` × many                             | `it.scoped` + `fs.makeTempDirectoryScoped()`, single Effect body per test           |
| `capabilities.test.ts`        | plain `vitest` + `expect.toEqual`                                                     | unchanged (pure data, no Effect)                                                    |
| `error-handler.test.ts`       | plain `vitest`                                                                        | unchanged (pure data)                                                               |
| `subprocess.test.ts`          | plain `vitest` + `Effect.runPromise` × 1                                              | switch the one Effect block to `it.effect`                                          |
| `factory.test.ts`             | `vitest` `expectTypeOf`                                                               | unchanged (type-level only)                                                         |
| `harness-*/src/index.test.ts` | plain `vitest` + `it.skipIf`                                                          | unchanged (no Effect body)                                                          |

Net: 4 files migrate, 6 stay as-is. Don't touch what doesn't benefit.

### Test-double surface (small follow-up, separate PR)

Today `SilentDisplay.layer(displayRef)` and `recordingEventEmitter.layer(eventsRef)`
take a `Ref` from the call site. With `it.scoped` we can offer
`SilentDisplay.layerScoped` / `recordingEventEmitter.layerScoped` that
allocate the `Ref` internally and expose it via a service tag (e.g.
`RecordedDisplay.entries: Effect<…>`). Tests then `yield* RecordedDisplay`
instead of holding the `Ref` themselves.

This is **out of scope for this plan** — the migration above lands first
without it. We add the scoped-Ref variants only if the migrated tests still
look noisy after the assertion-helper cleanup.

## Concrete examples

### Before — `orchestrator.test.ts:259`

```ts
const exit = await Effect.runPromiseExit(program);
expect(Exit.isFailure(exit)).toBe(true);
if (Exit.isFailure(exit)) {
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag === 'Some' && failure.value._tag === 'CapabilityMismatchError').toBe(true);
  if (failure._tag === 'Some' && failure.value._tag === 'CapabilityMismatchError') {
    expect(failure.value.missing).toEqual(['session.resume']);
  }
}
expect(calls).toEqual([]);
```

### After

```ts
import { describe, it } from '@effect/vitest';
import { assertInstanceOf } from '@effect/vitest/utils';

it.effect('fails with CapabilityMismatchError before spawning', () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(program);
    const cause = Exit.isFailure(exit) ? exit.cause : null;
    const failure = cause && Cause.failureOption(cause);
    assertInstanceOf(failure?._tag === 'Some' ? failure.value : null, CapabilityMismatchError);
    expect(failure?._tag === 'Some' && failure.value.missing).toEqual(['session.resume']);
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(layer)),
);
```

Or, when we don't care about narrowing the typed error and only need the
`Exit` shape:

```ts
import { assertFailure } from '@effect/vitest/utils';

it.effect('rejects when caps are missing', () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(program);
    assertFailure(
      exit,
      Cause.fail(
        new CapabilityMismatchError({
          message: '…',
          harness: 'claude-code',
          missing: ['session.resume'],
        }),
      ),
    );
  }).pipe(Effect.provide(layer)),
);
```

Pick `assertFailure` when the full `Cause` is meaningful; pick
`assertInstanceOf` + spot-checks on fields when we just want "the right
class came out, with the right missing-list."

### Before — `loader.test.ts:11`

```ts
describe('FileStepLoader', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'factory-loader-'));
    writeFileSync(join(dir, 'plan.md'), '---\nname: plan\n---\nbody');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads markdown + frontmatter from disk', async () => {
    const program = Effect.gen(function* () { … }).pipe(Effect.provide(FileStepLoader.layer.pipe(Layer.provide(NodeContext.layer))));
    const loaded = await Effect.runPromise(program);
    expect(loaded.frontmatter.name).toBe('plan');
  });
});
```

### After

```ts
import { describe, it } from '@effect/vitest';
import { strictEqual } from '@effect/vitest/utils';
import { FileSystem } from '@effect/platform';

describe('FileStepLoader', () => {
  it.scoped('reads markdown + frontmatter from disk', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-loader-' });
      yield* fs.writeFileString(`${dir}/plan.md`, '---\nname: plan\n---\nbody');

      const loader = yield* StepLoader;
      const loaded = yield* loader.load('plan.md', dir);
      strictEqual(loaded.frontmatter.name, 'plan');
    }).pipe(Effect.provide(FileStepLoader.layer.pipe(Layer.provide(NodeContext.layer)))),
  );
});
```

Wins: no `beforeAll`/`afterAll`, cleanup tied to the fiber Scope, the test
body is one cohesive Effect.

### Before — `orchestrator.test.ts` shared `buildLayer`

`buildLayer` is rebuilt on every `it`. Each test allocates two fresh
`Ref`s, builds a fresh layer, runs the program, asserts. That's correct
but noisy.

### After — share via `it.layer`

```ts
import { describe, it } from '@effect/vitest';
import { Layer, Ref } from 'effect';

describe('runFactoryEffect — happy path', () => {
  // Each `it.effect` inside still gets a fresh memoised layer instance per
  // test (no cross-test bleed) — we just write the layer once.
  it.layer(buildLayer(/* default args */))(({ it }) => {
    it.effect('emits lifecycle events in order', () =>
      Effect.gen(function* () {
        const events = yield* RecordedEvents; // when scoped-Ref doubles land
        // assertions …
      }),
    );
  });
});
```

Until the scoped-Ref doubles land (separate PR), the shared `buildLayer`
arg-set is limited to "tests that all want the same canned harness output
and verdicts." Use `it.effect` + per-test `buildLayer(...)` for the
permissions-resolution sub-suite, since those tests vary inputs.

## Implementation checklist

- [ ] Land `patterns/testing-effect.md` rewrite.
- [ ] Migrate `orchestrator.test.ts`:
  - Imports → `@effect/vitest` for `describe`/`it`, `@effect/vitest/utils`
    for assertions.
  - All `it(name, async () => { … runPromise … })` → `it.effect(name, () =>
…)`.
  - Three Exit-narrowing blocks (`:259`, `:314`, `:405`) →
    `assertInstanceOf` + field spot-check, or `assertFailure` when the
    `Cause` is constructible cleanly.
- [ ] Migrate `loader.test.ts`:
  - `FileStepLoader` block → `it.scoped` + `fs.makeTempDirectoryScoped()`.
  - Drop `mkdtempSync`/`rmSync`/`writeFileSync`/`tmpdir`/`join` imports
    once unused.
  - `InMemoryStepLoader` block → `it.effect`.
  - Three Exit-narrowing blocks → `assertInstanceOf(failure.value,
StepLoadError)`.
- [ ] Migrate `runWorkspace.test.ts`:
  - Both tests → `it.scoped` + `fs.makeTempDirectoryScoped()`.
  - Replace the `fsRead` helper with a direct `yield* fs.readFileString`
    inside the test body — no `Effect.provide(NodeContext.layer)` re-wrapping
    since the test scope already has it.
  - Replace the `readDb` helper similarly: provide `SqliteClient.layer` once
    via the test-level scope or via `Effect.provide` on the inner read.
- [ ] Migrate `subprocess.test.ts:17` (the one `Effect.runPromise` test) →
      `it.effect`.
- [ ] Confirm `pnpm test` passes locally.
- [ ] Update `patterns/testing-effect.md` if any wrinkle surfaces during
      migration (e.g. `NodeContext.layer` vs `NodeFileSystem.layer` choice).

## Sequencing

1. **PR 1 — pattern only.** Land `patterns/testing-effect.md` rewrite. No
   code changes. Reviewers can sanity-check the prescribed style before code
   churns.
2. **PR 2 — `loader.test.ts` migration.** Smallest, self-contained,
   demonstrates the scoped-temp-dir pattern.
3. **PR 3 — `orchestrator.test.ts` migration.** Largest. Demonstrates
   `it.effect` + `assertInstanceOf` for typed errors.
4. **PR 4 — `runWorkspace.test.ts` + `subprocess.test.ts`.** The remaining
   files.
5. **PR 5 (optional, deferred) — scoped-Ref test doubles.** Only if the
   migrated tests still look noisy.

Each PR is independently revertible. PR 1 has no behavior risk. PRs 2–4 are
test-only and `pnpm test` is the sole gate.

## Verification

After each migration PR:

```sh
pnpm test                # everything green, same count of test cases
pnpm typecheck           # no `Effect.Effect<…, …, never>` regressions
git grep -nE 'Effect\.runPromise(Exit)?\(' packages/*/src
                         # decreasing count, eventually ~0 in tests
git grep -nE 'Exit\.isFailure|Cause\.failureOption' packages/*/src
                         # decreasing
git grep -nE 'mkdtempSync' packages/*/src
                         # zero in tests after PR 4
```

## Risks & open questions

- **`it.effect` interrupt-on-timeout semantics.** `@effect/vitest`'s
  `it.effect` interrupts the fiber on test timeout (see
  `repos/effect/packages/vitest/test/index.test.ts:71`). Any test that
  spawns a subprocess via `subprocess.ts` must release on interrupt. Our
  `scriptedHarness` is pure Effect, so this is fine. Live `subprocess.test.ts`
  cases should stay plain `vitest` to avoid surprises.
- **`Layer.provideMerge(NodeContext.layer)` inside `it.scoped`.** The
  scoped temp dir comes from `FileSystem`, which is in `NodeContext`. The
  layer must be provided to the `it.scoped` block, not bolted on inside
  the program. Test-by-test as we migrate.
- **`runWorkspace.test.ts` opens a SQLite file.** `SqliteClient.layer` is
  scoped (closes the connection on release), so it composes with `it.scoped`
  cleanly. Confirm by grepping `SqliteClient.make`'s release in the Effect
  source if a test leaks file descriptors.
- **`@effect/vitest@0.29` API stability.** The package is at 0.x, so minor
  bumps can break. Pin in `package.json` (already `^0.29.0`) and re-verify
  on bump.

## Out of scope, on the radar

- **Property-based tests for `matchRequirements`.** `it.effect.prop` with a
  fast-check arbitrary over `HarnessCapabilities`/`StepRequirements` would
  exercise invariants ("missing ⊆ requirement keys", "missing empty iff
  caps satisfy req"). Add when we touch capabilities again.
- **Scoped-Ref test doubles.** `SilentDisplay.layerScoped` /
  `recordingEventEmitter.layerScoped` that internally allocate the `Ref`
  and expose it via accessor methods on the service. Removes Ref-threading
  from every test. Land only if the migration above doesn't already make
  the call sites tidy.
- **`it.layer` for shared expensive setup.** Today nothing in our suite is
  expensive enough to share. If we ever add a real-DB integration test
  (Postgres container, etc.), `it.layer(ContainerLive)((it) => …)` is the
  shape — see `repos/effect/packages/cluster/test/SqlMessageStorage.test.ts`.
- **`it.flakyTest` for any HTTP-touching test.** Not relevant today; we
  have none. Document in the pattern file as a future tool.
