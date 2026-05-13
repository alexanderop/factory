# `@effect/vitest` idioms

How to write tests with `@effect/vitest` instead of plain `vitest` +
`Effect.runPromise`. This is the **preferred style for new tests**;
`patterns/testing-effect.md` covers the broader picture (test layers, the
test-double catalog, capturing state with `Ref`).

> Source of truth: `repos/effect/packages/vitest/` (the package),
> `repos/effect/packages/vitest/src/utils.ts` (assertion helpers),
> `repos/effect/packages/sql-sqlite-node/test/Client.test.ts` (`it.scoped` +
> `makeTempDirectoryScoped`),
> `repos/effect/packages/effect/test/Config.test.ts` (`assertSuccess` /
> `assertFailure`),
> `repos/effect/packages/cluster/test/SqlMessageStorage.test.ts:38`
> (`it.layer` for shared fixtures).

## Imports

Always import from `@effect/vitest`, not `vitest`:

```ts
import { describe, expect, it } from '@effect/vitest';
import {
  assertFailure,
  assertInstanceOf,
  assertSome,
  deepStrictEqual,
  strictEqual,
} from '@effect/vitest/utils';
```

`@effect/vitest` re-exports vitest's API (`describe`, `expect`, `it`,
`beforeAll`, …) and adds `it.effect`, `it.scoped`, `it.live`, `it.layer`,
`it.flakyTest`, `it.prop`. No `vitest.config.ts` change required — the
package is already a devDependency.

## Pick the right `it`

| Variant     | Use when…                                                               |
| ----------- | ----------------------------------------------------------------------- |
| `it.effect` | Body is a pure Effect, no scoped resources.                             |
| `it.scoped` | Body acquires resources that must be released (temp dirs, DB, sockets). |
| `it.live`   | Body needs the real `Clock` (no `TestClock` virtual time).              |
| `it`        | Body is plain JS — pure data, type-only tests, snapshot fixtures.       |

Default to `it.effect`. Reach for `it.scoped` the moment you want a temp
dir, a SQLite file, or any `Layer.scoped` resource — Scope replaces
`beforeAll`/`afterAll`.

## Assertion helpers

`@effect/vitest/utils` ships typed assertions that produce real diffs and
narrow types. Prefer them over hand-rolled `Exit.isFailure` /
`Cause.failureOption` ladders:

```ts
import {
  assertFailure,
  assertSuccess,
  assertInstanceOf,
  assertSome,
  assertNone,
  assertLeft,
  assertRight,
  assertInclude,
  assertMatch,
  deepStrictEqual,
  strictEqual,
} from '@effect/vitest/utils';
```

Most useful in this repo:

| Helper                                | Replaces                                                  |
| ------------------------------------- | --------------------------------------------------------- |
| `assertSuccess(exit, value)`          | `expect(Exit.isSuccess(exit)).toBe(true)` + value extract |
| `assertFailure(exit, Cause.fail(e))`  | `Exit.isFailure` + `Cause.failureOption` + nested `if`    |
| `assertInstanceOf(value, ErrorClass)` | `_tag === 'X'` ladder narrowing a union member            |
| `assertSome(option, value)`           | `option._tag === 'Some'` + `option.value` deep equal      |
| `assertInclude(actual, substring)`    | `expect(actual).toContain(substring)`                     |
| `strictEqual(a, b)`                   | `expect(a).toBe(b)` (richer message, narrows)             |
| `deepStrictEqual(a, b)`               | `expect(a).toEqual(b)`                                    |

`assertFailure` requires the full `Cause` to match, which is brittle when
the error payload contains noise (paths, timestamps). Use
`assertInstanceOf` + targeted field assertions when you only care that "the
right typed error came out, with these fields":

```ts
const exit = yield * Effect.exit(program);
const failure = Cause.failureOption(exit.cause);
assertSome(
  failure,
  /* value matcher unused; we just want narrowing */ failure._tag === 'Some' ? failure.value : null,
);
assertInstanceOf(failure._tag === 'Some' ? failure.value : null, CapabilityMismatchError);
expect(failure._tag === 'Some' && failure.value.missing).toEqual(['session.resume']);
```

## Scoped resources

Allocate everything that needs cleanup inside the Effect body, not in
`beforeAll`:

```ts
import { describe, it } from '@effect/vitest';
import { strictEqual } from '@effect/vitest/utils';
import { FileSystem } from '@effect/platform';
import { NodeContext } from '@effect/platform-node';
import { Effect } from 'effect';

it.scoped('writes a step file under a fresh tmp dir', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-' });
    yield* fs.writeFileString(`${dir}/plan.md`, 'body');

    const loader = yield* StepLoader;
    const loaded = yield* loader.load('plan.md', dir);
    strictEqual(loaded.frontmatter.name, 'plan');
  }).pipe(Effect.provide(StepLoader.Default.pipe(Layer.provide(NodeContext.layer)))),
);
```

`fs.makeTempDirectoryScoped()` returns the path and registers a finalizer
on the test's Scope. The dir is removed on test end **and** on test
interrupt — no `afterAll(rmSync)`, no orphan tmp dirs.

The same pattern works for SQLite (`SqliteClient.layer({ filename })` is
scoped — closes the connection on release) and any other `Layer.scoped`
resource.

## Sharing a layer across tests

When several `it.effect` blocks all want the same expensive layer (real
DB, container, mocked HTTP server), wrap them in `it.layer(L)((it) => …)`:

```ts
describe('runFactoryEffect', () => {
  it.layer(
    buildLayer({
      /* canned outputs */
    }),
  )((it) => {
    it.effect('emits run.start then step.start', () =>
      Effect.gen(function* () {
        // …
      }),
    );

    it.effect('emits run.end last', () =>
      Effect.gen(function* () {
        // …
      }),
    );
  });
});
```

Each inner `it.effect` still gets its own fiber and Scope, but the layer is
built once. See `repos/effect/packages/cluster/test/SqlMessageStorage.test.ts:38`
for the canonical pattern (Postgres container shared across 20 tests).

If every test wants a different layer (e.g. our permissions-resolution
sub-suite varies harness defaults per case), don't use `it.layer` — pass
the layer per test via `.pipe(Effect.provide(layer))`.

## Asserting failures — the patterns

Three idiomatic shapes, in order of preference:

### 1. Just confirm the typed-error class

```ts
const exit = yield * Effect.exit(program);
const failure = Cause.failureOption(exit.cause);
assertInstanceOf(failure._tag === 'Some' ? failure.value : null, StepLoadError);
```

Use this for "rejects with a schema error" — we don't care about message
text or fields.

### 2. Confirm class + spot-check fields

```ts
assertInstanceOf(failure._tag === 'Some' ? failure.value : null, CapabilityMismatchError);
expect(failure._tag === 'Some' && failure.value.missing).toEqual(['session.resume']);
```

Use this when the typed error carries data we care about
(`missing`, `step`, `path`).

### 3. Match the full `Cause` (rare)

```ts
assertFailure(
  exit,
  Cause.fail(new StepMaxItersError({ message: 'gave up', step: ralph, maxIters: 10 })),
);
```

Only when the error payload is fully deterministic (no paths, no
timestamps). Otherwise the diff fails on irrelevant fields.

## Property-based tests (`it.effect.prop`)

Park for now — we have no property tests. When we add them, the shape is:

```ts
import { Schema } from 'effect';

const realNumber = Schema.Finite.pipe(Schema.nonNaN());

it.effect.prop('symmetry', [realNumber, realNumber], ([a, b]) =>
  Effect.gen(function* () {
    return a + b === b + a;
  }),
);
```

Good fit: `matchRequirements` invariants in `capabilities.test.ts`. Add
when we next touch capabilities.

## When to fall back to plain `vitest`

- **Type-only tests** (`expectTypeOf`) — `factory.test.ts` is the example.
- **Pure-data tests** — `error-handler.test.ts`, `capabilities.test.ts`.
- **Snapshot fixtures driven by `spawnSync`** — `harness-*/src/index.test.ts`.
  Plain vitest's `it.skipIf` is the right tool; no Effect runtime involved.
- **Tests that must spawn a real subprocess and care about its real-time
  behavior.** `it.effect` interrupts on timeout (see
  `repos/effect/packages/vitest/test/index.test.ts:71`); the subprocess
  must release cleanly. If you don't trust the cleanup path, stay on plain
  `vitest`.

## Don't

- **Don't mix `it.effect` and `await Effect.runPromise` in the same test
  body.** Pick one. `it.effect` _is_ the runner.
- **Don't use `mkdtempSync` + `afterAll(rmSync)` in new tests.** Use
  `it.scoped` + `fs.makeTempDirectoryScoped()`.
- **Don't import `assert` from `node:assert`.** `@effect/vitest/utils`
  wraps it with the helpers above.
- **Don't put `await` inside `Effect.gen`** unless the value really is a
  `Promise`. `yield*` is the operator.
- **Don't share a `Ref` across `it.effect` blocks via closure.** Each test
  gets its own fiber. Allocate per test, or wrap in `it.layer` so the
  layer-level state is fresh-per-suite.

## Migration cheat sheet

| Before                                                | After                                                                 |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| `import { it } from 'vitest'`                         | `import { it } from '@effect/vitest'`                                 |
| `it('x', async () => { await Effect.runPromise(p) })` | `it.effect('x', () => p)`                                             |
| `await Effect.runPromiseExit(p); Exit.isFailure…`     | `const exit = yield* Effect.exit(p); assertInstanceOf(value, ErrCls)` |
| `mkdtempSync(...)` + `afterAll(rmSync)`               | `it.scoped` + `fs.makeTempDirectoryScoped()`                          |
| `expect(x).toBe(y)`                                   | `strictEqual(x, y)` (optional — both fine; pick one per file)         |
| `expect(x).toEqual(y)`                                | `deepStrictEqual(x, y)` (same)                                        |
