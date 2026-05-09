# Testing Effect code

`@effect/vitest` is the default for tests whose body is an `Effect`. Plain
`vitest` is the fallback for tests with no Effect body (pure-data assertions,
type-level checks, etc.).

> Source of truth: `packages/core/src/orchestrator.test.ts` (full pattern in
> use), `packages/core/src/loader.test.ts` (`it.scoped` + temp dirs),
> `packages/core/src/testing/` (the test doubles), `repos/effect/packages/vitest/`
> for `it.effect`/`it.scoped`/`it.layer`/`@effect/vitest/utils`.

## The default: `it.effect`

```ts
import { describe, it } from '@effect/vitest';
import { strictEqual } from '@effect/vitest/utils';
import { Effect } from 'effect';

it.effect('reads from in-memory loader', () =>
  Effect.gen(function* () {
    const loader = yield* StepLoader;
    const loaded = yield* loader.load('./plan.md', '/');
    strictEqual(loaded.frontmatter.name, 'plan');
  }).pipe(Effect.provide(InMemoryStepLoader.layer(map))),
);
```

`it.effect(name, () => effect)`:

- Runs the returned Effect with the test's runtime.
- Interrupts the fiber on test timeout — any acquired resource that releases
  on interrupt is cleaned up.
- Surfaces the typed error via `Exit` (no `try`/`catch` needed).

When in doubt, reach for `it.effect` first. Don't mix `it.effect` and
`await Effect.runPromise` in the same test.

## Scoped resources: `it.scoped`

Use `it.scoped` whenever the test body acquires a `Scope`-scoped resource —
temp dirs, DB connections, subscriptions. Cleanup is tied to the fiber, so
there's no `beforeAll`/`afterAll` plumbing.

```ts
import { describe, it } from '@effect/vitest';
import { strictEqual } from '@effect/vitest/utils';
import { FileSystem } from '@effect/platform';
import { NodeContext } from '@effect/platform-node';
import { Effect, Layer } from 'effect';

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

Prefer `fs.makeTempDirectoryScoped()` over `mkdtempSync` + `afterAll(rmSync)`.
The scoped variant releases on fiber interrupt, so a flaky test won't leak
directories between runs.

## Sharing a layer: `it.layer`

When several `it.effect` blocks want the same fixture, hoist it with
`it.layer(L)((it) => …)`:

```ts
import { describe, it } from '@effect/vitest';

describe('runFactoryEffect — happy path', () => {
  it.layer(buildLayer(/* canned harness output, default verdicts */))(({ it }) => {
    it.effect('emits lifecycle events in order', () =>
      Effect.gen(function* () {
        // shared layer is provided
      }),
    );

    it.effect('records step ends', () =>
      Effect.gen(function* () {
        // …
      }),
    );
  });
});
```

Each inner `it.effect` still runs with its own fiber, so there's no
cross-test bleed — `it.layer` just memoises construction. Don't reach for
this until two or more tests _genuinely_ want the same inputs; per-test
`Effect.provide(buildLayer(...))` is fine and often clearer when inputs vary.

## Assertions: `@effect/vitest/utils`

Prefer the typed assertion helpers over hand-narrowing `Exit` / `Cause`:

| Helper                       | Use when                                                   |
| ---------------------------- | ---------------------------------------------------------- |
| `strictEqual`                | Primitives, references — replaces `expect(...).toBe(...)`. |
| `deepStrictEqual`            | Structural equality — replaces `expect(...).toEqual(...)`. |
| `assertTrue` / `assertFalse` | Boolean spot checks.                                       |
| `assertSome` / `assertNone`  | Narrowing `Option`.                                        |
| `assertLeft` / `assertRight` | Narrowing `Either`.                                        |
| `assertSuccess`              | `Exit` is `Success`, value matches.                        |
| `assertFailure`              | `Exit` is `Failure`, full `Cause` matches.                 |
| `assertInstanceOf`           | A value is an instance of a tagged-error class.            |
| `assertInclude`              | Substring assertion on optional strings.                   |

`assertFailure` and `assertInstanceOf` are the workhorses for typed errors:

```ts
import { assertFailure, assertInstanceOf } from '@effect/vitest/utils';
import { Cause, Effect, Exit } from 'effect';

// Full-cause assertion when the error is constructible cleanly
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

// Class + spot-check on fields when the message is volatile
it.effect('fails before spawning', () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(program);
    assertTrue(Exit.isFailure(exit));
    const failure = Cause.failureOption(exit.cause);
    assertSome(failure, failure._tag === 'Some' ? failure.value : undefined);
    // narrower style:
    if (failure._tag === 'Some') {
      assertInstanceOf(failure.value, CapabilityMismatchError);
      deepStrictEqual(failure.value.missing, ['session.resume']);
    }
  }).pipe(Effect.provide(layer)),
);
```

Pick `assertFailure` when the full `Cause` is meaningful; pick
`assertInstanceOf` + field spot-checks when you only need "the right class
came out, with the right `missing` list."

`vitest`'s own `expect` still works inside `it.effect` — use it freely for
arrays, snapshots, and other rich matchers. The helpers above are nicer
specifically for `Exit`/`Option`/`Either`/instance checks.

## Test doubles

`packages/core/src/testing/` exports test layers for every service. Use them
instead of the real ones:

| Real layer                            | Test layer                                                                    | What it does                        |
| ------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------- |
| `ConsoleDisplay`                      | `SilentDisplay`                                                               | Captures entries to a `Ref`.        |
| `callbackEventEmitter`                | `recordingEventEmitter`                                                       | Captures events to a `Ref`.         |
| `harnessRegistryLayer([realHarness])` | `harnessRegistryLayer([scriptedHarness('claude-code', [{ stdout: '...' }])])` | Cycles through canned outputs.      |
| `FileStepLoader`                      | `InMemoryStepLoader.layer(map)`                                               | Reads from a `Map<string, string>`. |
| `DefaultUntilEvaluator`               | `scriptedUntilEvaluator.layer([true, false])`                                 | Cycles through canned verdicts.     |

Every service has a real impl + at least one test impl, both exposing a
`.layer`. Tests build an `AppLayer` from the test impls and provide it.
Adding a new service? Add a test impl alongside it, in the same file or
under `testing/`.

## Capturing state with `Ref`

`recordingEventEmitter` and `SilentDisplay` take a `Ref` that they push into.
Pattern, inside an `it.effect`:

```ts
it.effect('emits the right events', () =>
  Effect.gen(function* () {
    const eventsRef = yield* Ref.make<ReadonlyArray<FactoryEvent>>([]);
    const displayRef = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);

    const layer = Layer.mergeAll(
      SilentDisplay.layer(displayRef),
      recordingEventEmitter.layer(eventsRef),
      // … other test layers
    );

    yield* program.pipe(Effect.provide(layer));

    const events = yield* Ref.get(eventsRef);
    deepStrictEqual(
      events.map((e) => e.type),
      ['run.start', 'step.start' /* … */],
    );
  }),
);
```

`Ref.make` works inside `Effect.gen`. `Ref.unsafeMake` is fine when the `Ref`
must outlive the Effect (e.g. allocated outside the test body so the layer
can be built up-front), but inside `it.effect` you almost always have an
Effect context, so `Ref.make` is the default.

## Building the test layer

Helper in `orchestrator.test.ts` — reuse it across permission-resolution
sub-tests so each `it.effect` only varies the inputs it cares about:

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
    InMemoryRunWorkspace.layer({ runId: RunId.make('test-run') }),
  ).pipe(Layer.provideMerge(NodeContext.layer));
```

`Layer.provideMerge(NodeContext.layer)` provides `FileSystem`, `Path`, and
`CommandExecutor` — even tests that use `InMemoryStepLoader` need it because
the orchestrator calls `Path.Path` for resolution.

## When to fall back to plain `vitest`

- The test body is pure data with no Effect (`error-handler.test.ts`,
  `capabilities.test.ts`).
- The test is type-level only (`factory.test.ts` uses `expectTypeOf`).
- The test wraps a long-running real process and needs vitest's lifecycle
  hooks rather than fiber interrupt semantics.

Otherwise: `it.effect` (or `it.scoped` if scoped resources are involved).

## Don't

- **Don't import the real `FileStepLoader` or `DefaultUntilEvaluator` in a
  test.** That's the production layer; you lose test control. Use the
  in-memory / scripted variants.
- **Don't use `Effect.runSync`, `Effect.runPromise`, or `Effect.runPromiseExit`
  in tests.** Use `it.effect`/`it.scoped` instead — they wire the runtime,
  Scope, and `Exit` reporting for you.
- **Don't reach into private services.** If you need to assert on what a
  service was called with, that's a design smell; either expose the recorded
  state via a test layer (like `recordingEventEmitter`) or assert on the
  _output_ the service produces.
- **Don't share `Ref`s across tests.** Each `it.effect` allocates its own.
  Sharing leads to order-dependent flakes when one test pollutes another.
- **Don't mix `it.effect` and `await Effect.runPromise` in the same test.**
  Pick one per test. Mixing leads to confused error reporting.
- **Don't use `mkdtempSync` + `afterAll(rmSync)`** when `it.scoped` +
  `fs.makeTempDirectoryScoped()` will do. Cleanup-on-interrupt is the whole
  point.
