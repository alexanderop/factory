---
name: testing-strategy-upgrade
description: Build on the `effect-vitest-migration` plan with the next layer of test idioms from the Effect monorepo — `TestClock`, `it.effect.prop` for `matchRequirements`, scoped env, `withLatch`/`Counter` fixtures, `it.layer` for the orchestrator happy path, and three assertion helpers we don't yet use.
type: plan
status: proposed
created: 2026-05-10
---

# Plan: next-level testing idioms from Effect

## Goal

`effect-vitest-migration` got us onto `@effect/vitest`, scoped temp dirs,
`assertSuccess`/`assertFailure`, and the test-double catalog under
`packages/core/src/testing/`. That covers ~80% of what Effect's own monorepo
does day-to-day.

The remaining 20% — TestClock for time-dependent code, property-based tests
for pure predicates, latches/counters for concurrency assertions,
`it.layer` for shared fixtures, and a handful of assertion helpers — is what
keeps Effect's own tests fast, deterministic, and readable. None of it is
new infrastructure; it's all already in `repos/effect/`.

This plan adopts those patterns where they pay off in our current code, and
documents them as patterns + helpers so future tests reach for them
naturally.

## Non-goals

- **Not a coverage push.** This plan adds fixtures and converts a couple of
  existing tests; it doesn't try to fill coverage gaps. New tests go in
  their own PRs.
- **No `ObservableResource` yet.** Useful when we add a Pool/Cache, not
  before. Tracked in tier 3 below; defer.
- **No `it.flakyTest` adoption yet.** Reserve for when a real-subprocess
  harness test actually flakes on CI.
- **No test framework swap.** `@effect/vitest` stays. Vitest config
  unchanged.
- **No `OtelTestLayer` rewrite.** Item 7 is investigation-only — a 1h
  read-and-compare against `repos/effect/packages/opentelemetry/test/`,
  not a guaranteed change.

## Tier 1 — high payoff, low risk

### 1. Adopt three assertion helpers we don't yet use

**Why.** `repos/effect/packages/vitest/src/utils.ts` exports three helpers
we haven't documented and haven't reached for, all with clean wins:

| Helper                   | Source                                              | Win                                                                                                 |
| ------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `assertEquals`           | `repos/effect/packages/vitest/src/utils.ts:58`      | Uses `Equal.equals` trait — handles `Data`, `HashMap`, branded values better than `deepStrictEqual` |
| `throws` / `throwsAsync` | `repos/effect/packages/vitest/src/utils.ts:140,160` | Sync error assertion with optional matcher fn; replaces `expect(() => x).toThrow(...)`              |
| `notDeepStrictEqual`     | `repos/effect/packages/vitest/src/utils.ts:40`      | Inverse of `deepStrictEqual` — we don't have one today                                              |

**Change.** Add three rows to the assertion table in
`patterns/effect-vitest.md:74-83`. No existing-test churn; adopt as we
touch tests.

**Effort.** 15min.

---

### 2. Migrate `harnessOtelEnv.test.ts` to scoped env

**Why.** `harnessOtelEnv.test.ts:20-30` is the only non-idiomatic spot in
our suite — plain-vitest `beforeEach`/`afterEach` mutating `process.env`.
It works, but:

- Leaks env vars to neighbouring tests if a `beforeEach` mutation succeeds
  and an early `expect` throws before `afterEach` restores.
- It's the example a new contributor will copy when they need env handling
  in an Effect test, propagating the non-idiomatic pattern.

**Effect reference.** `Layer.scoped` + `Effect.acquireRelease` is the
canonical scoped-side-effect pattern. See any `Layer.scoped` in
`repos/effect/packages/sql-sqlite-node/test/Client.test.ts` for the shape.

**Change.**

1. New helper at `packages/core/src/testing/scopedEnv.ts`:

   ```ts
   export const withEnv = (overrides: Record<string, string | undefined>) =>
     Effect.acquireRelease(
       Effect.sync(() => {
         const prev: Record<string, string | undefined> = {};
         for (const [k, v] of Object.entries(overrides)) {
           prev[k] = process.env[k];
           if (v === undefined) delete process.env[k];
           else process.env[k] = v;
         }
         return prev;
       }),
       (prev) =>
         Effect.sync(() => {
           for (const [k, v] of Object.entries(prev)) {
             if (v === undefined) delete process.env[k];
             else process.env[k] = v;
           }
         }),
     );
   ```

2. Re-export from `packages/core/src/testing/index.ts`.
3. Convert each `it(...)` in `harnessOtelEnv.test.ts` to `it.scoped(...)`,
   `yield* withEnv({...})` at the top, drop the `beforeEach`/`afterEach`
   block.

**Effort.** 1h.

---

### 3. Property-based tests for `capabilities.matchRequirements`

**Why.** `capabilities.test.ts:24-58` is six hand-crafted cases over a
recursive nested-object predicate — the textbook `it.effect.prop` target.
The non-goal in `effect-vitest-migration` parked this; now is the right
time. Bugs we'd catch: handling of `undefined` vs missing keys, deep
nesting, permission-array semantics, key-collision edge cases.

This is also the first `it.effect.prop` example in the repo, so we get a
template for future property tests (branded ID round-trips, schema
codecs).

**Effect references.**

- `repos/effect/packages/vitest/test/index.test.ts` — `it.prop("symmetry",
[realNumber, FastCheck.integer()], ([a, b]) => a + b === b + a)` — the
  minimal example.
- `repos/effect/packages/vitest/test/advent-of-pbt-2024/day-1.test.ts` —
  `it.prop("...", [Letter.Array], ([letters]) => ...)` using a
  Schema-derived arbitrary.

**Change.** Add an `it.prop` block to `capabilities.test.ts` with two or
three properties:

```ts
import { it } from '@effect/vitest';
import { FastCheck as fc, Schema } from 'effect';

const capArb = /* derive from HarnessCapabilities Schema or hand-roll */;
const reqArb = /* partial-keyed variant */;

it.prop('caps satisfy a requirements object that is a subset of caps', [capArb], ([caps]) => {
  const req = capsAsRequirements(caps); // helper: copy true fields only
  return matchRequirements(caps, req).length === 0;
});

it.prop('every reported missing key is actually missing in caps', [capArb, reqArb], ([caps, req]) => {
  const missing = matchRequirements(caps, req);
  return missing.every((path) => !pathTrueIn(caps, path));
});

it.prop('extra cap fields never produce missing entries', [capArb, reqArb], ([caps, req]) => {
  const stripped = stripExtras(caps, req);
  return matchRequirements(caps, req).length === matchRequirements(stripped, req).length;
});
```

**Effort.** 2–3h: build the `Schema.Arbitrary` (or hand-rolled
`fc.record(...)`), three properties, ~100 generated cases each.

---

## Tier 2 — medium payoff, scoped change

### 4. `TestClock` pattern doc

**Why.** Our suite has zero `TestClock` usage. The moment we test a retry,
backoff, repeat, or scheduled flush, we need it — real-time tests are
slow and flaky. We don't have a current test that needs the conversion,
but we want the pattern documented and ready, so the first person who
touches a timer doesn't reach for `await new Promise(setTimeout, ...)`.

**Effect references.**

- `repos/effect/packages/effect/test/Schedule.test.ts:562-582` — fork an
  Effect, `TestClock.adjust("8 minutes")`, assert the accumulated outputs.
- `repos/effect/packages/effect/test/RcRef.test.ts:80-92` —
  `TestClock.adjust(1000)` to expire a ref-counted resource.
- Pattern: `Effect.fork(program)` → `TestClock.adjust(...)` → `Fiber.join`
  → assert.

**Change.** New `patterns/test-clock.md` (~80 lines) covering:

- Why `TestClock` (deterministic, fast, no real waits).
- The fork → adjust → join shape, with the `Schedule.test.ts` example
  trimmed down.
- When to use `it.live` instead (real wall-clock when `TestClock`
  semantics don't fit — see `repos/effect/packages/effect/test/Random.test.ts:38`).
- "Don't" list: don't `Effect.sleep` in a test without forking;
  don't mix `TestClock.adjust` with real-time assertions.

No code change required. Pattern only.

**Effort.** 1h.

---

### 5. Concurrency fixtures: `withLatch` and `Counter`

**Why.** Our event-ordering assertions in `orchestrator.test.ts` work
because the orchestrator is sequential. The first time we test interrupt
behavior, parallel steps, or "verify event X came out before resource Y
was released," sleeps will be racy. Effect already factored both
primitives as standalone utilities; we copy them.

**Effect references.**

- `repos/effect/packages/effect/test/utils/latch.ts:6-15` — `withLatch(f)`:
  `f` receives a `release` Effect; the test blocks on the latch until `f`
  triggers it. 32 lines total including `withLatchAwait`.
- `repos/effect/packages/effect/test/utils/counter.ts:14-47` — `Counter`
  with `acquire()` (registers finalizer), `acquired()`, `released()`. 55
  lines. Used across `RcRef`, `ScopedRef`, `Pool` tests.
- `repos/effect/packages/effect/test/Fiber.test.ts:26-52` — example
  application: `withLatch` to coordinate fork → status check timing for
  `Fiber.await` and `Effect.race`.

**Change.**

1. New file `packages/core/src/testing/sync.ts` — copy `withLatch`,
   `withLatchAwait`, and `Counter` near-verbatim. They have no Effect
   internals dependencies; just `Deferred`, `Ref`, `Effect`.
2. Re-export from `packages/core/src/testing/index.ts`.
3. Add a "Concurrency primitives" section to
   `patterns/testing-effect.md` referencing them with one example each.

**Effort.** 30min copy + 1h to write 1–2 example tests in
`orchestrator.test.ts` showing the pattern (e.g. assert "step.start fires
before harness.spawn unblocks" using a latch).

---

### 6. `it.layer` for the orchestrator happy-path subtree

**Why.** `orchestrator.test.ts` uses the `buildLayer(...)` helper from
`patterns/testing-effect.md:222-234` and rebuilds the layer per test.
That's correct for tests where the inputs vary per case (permission
resolution suites), but wasteful for the happy-path describe where every
test wants identical canned harness output / verdicts. `it.layer` builds
the layer once and shares it across the inner `it.effect` blocks while
each still gets its own fiber and Scope.

**Effect references.**

- `repos/effect/packages/cluster/test/MessageStorage.test.ts:19-22` — one
  `MemoryLive` layer shared across the suite via `Effect.provide`.
- `repos/effect/packages/cluster/test/SqlMessageStorage.test.ts:38` —
  `it.layer(L)((it) => { ... })` shares a Postgres container across 20
  tests.

**Change.** In `orchestrator.test.ts`, wrap the `describe('happy path',
...)` block in `it.layer(buildLayer(defaults))((it) => { ... })`. Leave
the variation suites alone. Verify no `Ref` is shared across the inner
tests (each test still allocates its own `displayRef`/`eventsRef`).

**Effort.** 1h.

---

### 7. `OtelTestLayer` review against `repos/effect/packages/opentelemetry/test/`

**Why.** `packages/core/src/testing/OtelTest.ts` is a hand-rolled
in-memory span exporter. Effect ships their own OTEL test patterns we
haven't audited. They may have helpers for asserting on span trees,
event payloads, or attribute matching that beat ours. Worst case: we
confirm we're already as good and document the choice.

**Change.** 1h read-and-compare. Output one of:

- (a) "We're equivalent" — add a comment in `OtelTest.ts:1` linking to
  the Effect file we compared against, plus a note in
  `patterns/testing-effect.md` so future readers don't re-litigate.
- (b) "Effect has a nicer X" — port it. Likely small.

**Effort.** 1h investigation, 0–2h adoption.

---

## Tier 3 — when we need it (not in this plan)

### 8. `it.flakyTest` for real-subprocess harness tests

**Why.** `harness-claude-code/src/index.test.ts` and friends spawn real
CLIs gated by `it.skipIf(!available)`. They don't flake today, but if
they ever do on CI, `it.flakyTest` is the right answer (bounded retry
instead of disabling).

**Effect references.**

- `repos/effect/packages/effect/test/Metric.test.ts:401-424` —
  `it.live("histogram with sleeps", () => it.flakyTest(Effect.gen(...)))`.
- `repos/effect/packages/platform/test/HttpClient.test.ts:64-74` —
  wrapping real Google requests.

**When.** Defer until first real flake.

---

### 9. `ObservableResource` pattern

**Why.** If we add a Pool/Cache (cached harness sessions, subprocess
pooling), we'll want "acquired exactly once, released exactly once"
assertions.

**Effect reference.**
`repos/effect/packages/effect/test/utils/cache/ObservableResource.ts:15-40`
— `make(value).scoped` + `assertAcquiredOnceAndCleaned()`. ~60 lines,
copyable.

**When.** Defer until we have a pool to test.

---

## Plan of record

| #   | Item                                           | Tier | Effort | Files touched                                                                                                                  |
| --- | ---------------------------------------------- | ---- | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Adopt new assertion helpers (doc-only)         | 1    | 15min  | `patterns/effect-vitest.md`                                                                                                    |
| 2   | Migrate `harnessOtelEnv.test.ts` to scoped env | 1    | 1h     | `packages/core/src/testing/scopedEnv.ts`, `packages/core/src/testing/index.ts`, `harnessOtelEnv.test.ts`                       |
| 3   | Property tests for `matchRequirements`         | 1    | 2–3h   | `packages/core/src/capabilities.test.ts`                                                                                       |
| 4   | `patterns/test-clock.md`                       | 2    | 1h     | new doc                                                                                                                        |
| 5   | `withLatch` + `Counter` in `testing/sync.ts`   | 2    | 1.5h   | `packages/core/src/testing/sync.ts`, `packages/core/src/testing/index.ts`, `patterns/testing-effect.md`, one orchestrator test |
| 6   | `it.layer` refactor of orchestrator happy path | 2    | 1h     | `packages/core/src/orchestrator.test.ts`                                                                                       |
| 7   | OTEL test layer comparison                     | 2    | 1–3h   | `packages/core/src/testing/OtelTest.ts` (maybe), `patterns/testing-effect.md`                                                  |
| 8   | (deferred) `it.flakyTest`                      | 3    | —      | when needed                                                                                                                    |
| 9   | (deferred) `ObservableResource`                | 3    | —      | when we add a pool                                                                                                             |

**Net new files** (3): `packages/core/src/testing/scopedEnv.ts`,
`packages/core/src/testing/sync.ts`, `patterns/test-clock.md`.

**Touched existing files** (5): `packages/core/src/testing/index.ts`,
`packages/core/src/capabilities.test.ts`,
`packages/core/src/harnessOtelEnv.test.ts`,
`packages/core/src/orchestrator.test.ts`, `patterns/effect-vitest.md`,
`patterns/testing-effect.md`.

**Suggested PR slicing.** Each tier-1 item is independent and stands as
its own PR. Tier 2 items 5+6 can ship together (the latch test in
`orchestrator.test.ts` reads cleaner alongside the `it.layer` refactor);
items 4 and 7 are docs and ship alone.

## Done means

- All tier-1 items merged.
- `patterns/effect-vitest.md` lists the three new assertion helpers.
- A `patterns/test-clock.md` exists, even if no test uses `TestClock`
  yet.
- `packages/core/src/testing/` exports `withEnv`, `withLatch`,
  `withLatchAwait`, and `Counter`.
- `harnessOtelEnv.test.ts` no longer uses `beforeEach`/`afterEach`.
- `capabilities.test.ts` has at least two `it.prop` blocks running ≥100
  cases each.
- Tier-2 items 5–7 either landed or have a follow-up issue with a
  citation back to this plan.
