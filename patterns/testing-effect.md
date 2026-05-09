# Testing Effect code

Two things to learn: how to run an Effect program from a test, and how to
provide test layers (services with controllable behaviour) instead of the
real ones.

> Source of truth: `packages/core/src/orchestrator.test.ts` (full pattern in
> use), `packages/core/src/testing/` (the test doubles), `repos/effect/packages/vitest/`
> for `it.effect`/`it.scoped`.

## Two test styles

The repo currently uses **plain `vitest` + `Effect.runPromise`**:

```ts
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

it('reads markdown + frontmatter from disk', async () => {
  const program = Effect.gen(function* () {
    const loader = yield* StepLoader;
    return yield* loader.load('plan.md', dir);
  }).pipe(Effect.provide(FileStepLoader.layer.pipe(Layer.provide(NodeContext.layer))));

  const loaded = await Effect.runPromise(program);
  expect(loaded.frontmatter.name).toBe('plan');
});
```

Prefer `it.effect` from `@effect/vitest` for _new_ tests where the body is a
pure Effect — no `mkdtempSync`, no `beforeAll`, no setup that spans tests:

```ts
import { describe, expect, it } from '@effect/vitest';

it.effect('reads from in-memory loader', () =>
  Effect.gen(function* () {
    const loader = yield* StepLoader;
    const loaded = yield* loader.load('./plan.md', '/');
    expect(loaded.frontmatter.name).toBe('plan');
  }).pipe(Effect.provide(InMemoryStepLoader.layer(map))),
);
```

Why both: `it.effect` is cleaner when the test _is_ an Effect, but plain
`vitest` is simpler for tests that interleave Node-API setup
(`mkdtempSync`, file fixtures) with Effect runs. Don't migrate working
tests; pick the right tool for new ones.

For tests that allocate scoped resources, use `it.scoped`. For tests that
share a layer across multiple `it.effect` blocks, use `layer(MyLayer)((it) => { ... })`
from `@effect/vitest` — see `repos/effect/packages/vitest/test/index.test.ts`.

## Test doubles

`packages/core/src/testing/` exports test layers for every service. Use
them instead of the real ones:

| Real layer                            | Test layer                                                                    | What it does                        |
| ------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------- |
| `ConsoleDisplay`                      | `SilentDisplay`                                                               | Captures entries to a `Ref`.        |
| `callbackEventEmitter`                | `recordingEventEmitter`                                                       | Captures events to a `Ref`.         |
| `harnessRegistryLayer([realHarness])` | `harnessRegistryLayer([scriptedHarness('claude-code', [{ stdout: '...' }])])` | Cycles through canned outputs.      |
| `FileStepLoader`                      | `InMemoryStepLoader.layer(map)`                                               | Reads from a `Map<string, string>`. |
| `DefaultUntilEvaluator`               | `scriptedUntilEvaluator.layer([true, false])`                                 | Cycles through canned verdicts.     |

The pattern: every service has a real impl + at least one test impl, both
exposing a `.layer`. Tests build an `AppLayer` from the test impls and
provide it. Adding a new service? Add a test impl alongside, in the same
file or under `testing/`.

## Capturing state with `Ref`

The `recordingEventEmitter` and `SilentDisplay` test layers take a `Ref`
that they push entries into. Pattern:

```ts
const eventsRef = Ref.unsafeMake<ReadonlyArray<FactoryEvent>>([]);
const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);

const layer = Layer.mergeAll(
  SilentDisplay.layer(displayRef),
  recordingEventEmitter.layer(eventsRef),
  // ... other test layers
);

await Effect.runPromise(myProgram.pipe(Effect.provide(layer)));

const events = await Effect.runPromise(Ref.get(eventsRef));
expect(events.map((e) => e.type)).toEqual(['run.start', 'step.start' /* ... */]);
```

`Ref.unsafeMake` is fine in tests (no Effect context needed). In production
code, use `Ref.make` inside an `Effect.gen`.

## Building the test layer

Helper in `orchestrator.test.ts:23`:

```ts
const buildLayer = (
  displayRef: Ref.Ref<ReadonlyArray<DisplayEntry>>,
  eventsRef: Ref.Ref<ReadonlyArray<FactoryEvent>>,
  steps: Iterable<readonly [string, string]>,
  verdicts: ReadonlyArray<boolean>,
) =>
  Layer.mergeAll(
    SilentDisplay.layer(displayRef),
    recordingEventEmitter.layer(eventsRef),
    harnessRegistryLayer([scriptedHarness('claude-code', [{ stdout: 'iter-1\n' }])]),
    InMemoryStepLoader.layer(new Map(steps)),
    scriptedUntilEvaluator.layer(verdicts),
  ).pipe(Layer.provideMerge(NodeContext.layer));
```

`Layer.provideMerge(NodeContext.layer)` provides `FileSystem`, `Path`, and
`CommandExecutor` — even tests that use `InMemoryStepLoader` need it
because the orchestrator calls `Path.Path` for resolution.

## Asserting failures

```ts
const exit = await Effect.runPromiseExit(program);
expect(Exit.isFailure(exit)).toBe(true);
if (Exit.isFailure(exit)) {
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === 'Some') {
    expect(failure.value._tag).toBe('StepMaxItersError');
  }
}
```

`Effect.runPromiseExit` returns `Exit<A, E>`. `Cause.failureOption` extracts
the typed `E` (skipping defects). The narrowed `failure.value` is
`FactoryError` and `_tag` works without any cast — see
`patterns/schema-at-the-edge.md` (lint forbids `as` casts here).

## Don't

- **Don't import the real `FileStepLoader` or `DefaultUntilEvaluator` in a
  test.** That's the production layer; you lose test control. Use the
  in-memory / scripted variants.
- **Don't use `Effect.runSync` for tests** unless the program is provably
  synchronous. Vitest tests are async by default — `await runPromise` is
  the safe bet.
- **Don't reach into private services.** If you need to assert on what a
  service was called with, that's a design smell; either expose the
  recorded state via a test layer (like `recordingEventEmitter`) or assert
  on the _output_ the service produces.
- **Don't share `Ref`s across tests.** Each `it` allocates its own.
  Sharing leads to order-dependent flakes when one test pollutes another.
- **Don't mix `it.effect` and `await Effect.runPromise` in the same test.**
  Pick one per test. Mixing leads to confused error reporting.
