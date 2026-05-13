# Testing Effect code

`@effect/vitest` is the default for tests whose body is an `Effect`. Plain
`vitest` is the fallback for tests with no Effect body (pure-data assertions,
type-level checks, etc.).

> Source of truth: `packages/core/src/runWorkspace.test.ts` (the canonical
> integration shape — see "Canonical test shape" below),
> `packages/core/src/orchestrator.test.ts` (`it.layer` + per-test variation),
> `packages/core/src/testing/` (the test doubles, helpers, and rig),
> `repos/effect/packages/vitest/` for `it.effect`/`it.scoped`/`it.layer`/`@effect/vitest/utils`.

## Canonical test shape

The default shape for any new orchestrator-level test. Mirrors
`runWorkspace.test.ts:319-419` (the crash-and-resume e2e) — that's the
template. If a test doesn't look like this, the burden is on the test to
justify why.

```ts
import { describe, it } from '@effect/vitest';
import { strictEqual } from '@effect/vitest/utils';
import { Effect } from 'effect';
import {
  assertExitFailedWith,
  capturingScripted,
  cycledHarness,
  makeTestRig,
  reviewRoleFindings,
} from './testing/index.ts';

it.effect('end-to-end: <user-visible behavior>', () =>
  Effect.gen(function* () {
    // 1. Build a two-sided harness (capture inputs, script outputs).
    const { harness, calls } = capturingScripted('claude-code', [
      { stdout: 'plan\n' },
      { stdout: 'iter-1\n', writes: [{ path: 'out.json', content: '{}' }] },
    ]);

    // 2. Build the rig — refs for events/display come for free.
    const { layer, events } = makeTestRig({ harnesses: [harness] });

    // 3. Run the program through to its Exit.
    const exit = yield* runFactoryEffect(/* … */).pipe(Effect.provide(layer), Effect.exit);

    // 4. Assert on user-visible side effects:
    //    - Exit shape (success / failure class)
    //    - Captured event types
    //    - Captured call sequence
    //    - Files on disk (when `LiveRunWorkspace` is in use)
    assertExitFailedWith(exit, StepMaxItersError);
    deepStrictEqual(
      (yield* events).map((e) => e.type),
      ['run.start', 'step.start' /* … */],
    );
    deepStrictEqual(
      (yield* calls).map((c) => c.permissions),
      ['skip', 'skip'],
    );
  }),
);
```

Five rules:

1. **One mockable seam: the harness.** Everything else (workspace, step
   loader, until evaluator) uses the in-memory test impl by default. The
   harness is the only thing scripted per test.
2. **Capture inputs, script outputs.** `capturingScripted` gives you both —
   reach for it instead of allocating a `Ref` and wiring `onCall` by hand.
3. **Read refs at the end of the test, not mid-flight.** `events` and `calls`
   are `Effect`s; `yield*` them after the program completes.
4. **Assert on user-visible side effects.** Exit shape, event types in order,
   call sequence, file contents. Don't assert on display strings unless the
   test is specifically about display output.
5. **One test per behavior, not per phase.** Don't write "Phase A / Phase B"
   sub-tests of one underlying behaviour — write one cohesive test that
   asserts on every relevant aspect of that behaviour.

## Choosing a harness factory

Reach for the named factory whose intent matches the test, not the bare
`scriptedHarness` god-fake. Each name documents what the test is verifying:

| Factory                              | Use when…                                                                                        | Defined in                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `cycledHarness(name, [r1, r2, …])`   | The orchestrator makes N sequential calls in a known order.                                      | `packages/core/src/testing/scriptedHarness.ts` |
| `routedHarness(name, responder)`     | Calls fan out concurrently (review roles, parallel steps) — pick the response by inbound `opts`. | `packages/core/src/testing/scriptedHarness.ts` |
| `echoHarness(name)`                  | The test verifies _what was sent_ (cwd / env / permissions / prompt), not what came back.        | `packages/core/src/testing/scriptedHarness.ts` |
| `silentHarness(name)`                | The test verifies the orchestrator _reached_ this step at all (pipeline shape, routing).         | `packages/core/src/testing/scriptedHarness.ts` |
| `flakeyHarness(name, { failAfter })` | The test exercises resume / retry / partial-failure behaviour.                                   | `packages/core/src/testing/scriptedHarness.ts` |
| `capturingScripted(name, …)`         | Wrap any of the above to also capture the inbound `ExecOpts` for assertion at end-of-test.       | `packages/core/src/testing/factories.ts`       |

`scriptedHarness` itself remains as the underlying builder; prefer the
named factories so the `import` line and call site read as documentation.

### Per-response options

Every response in a `cycledHarness` / `routedHarness` script can carry:

- `delay: Duration.DurationInput` — sleep before the response is materialised.
  Use to test interruption, cancellation, ordering against concurrent fan-out.
- `events: ReadonlyArray<HarnessEvent>` — emit a specific event sequence
  (followed by an implicit `exit`). Craft a custom sequence ending with a
  non-zero `exit` to simulate mid-stream crash.
- `writes: ReadonlyArray<ScriptedWrite>` — materialise files on disk before
  the `exit` event. Paths are resolved against `env.FACTORY_RUN_DIR` (or
  `opts.cwd`) so tests don't have to know absolute paths.

For review roles: don't hard-code `steps/00-review/roles/<id>/findings.json`
in tests. Use `reviewRoleFindings({ roleId, findings })` — the helper
encapsulates the orchestrator's path convention.

### Exhaust mode

`cycledHarness('claude-code', [resp], { exhaust: 'error' })` throws if the
orchestrator makes more calls than scripted. Use this to catch silent
"orchestrator iterated past the script" bugs that the default `'cycle'`
mode would mask. Default is `'cycle'` for backwards compatibility.

## Garbage-output testing

Real harnesses fail in ways that real-harness e2e doesn't reproduce
reliably: malformed JSON in `findings.json`, exit 0 with empty stdout,
partial writes (file exists, half-written), stderr-only output with no
events, exit mid-stream after some events.

This is _uniquely the scripted layer's job_ — build a small suite asserting
the orchestrator survives each malformation. See
`packages/core/src/orchestrator-malformed.test.ts` for the canonical set.
Pattern: craft a deliberately broken `ScriptedResponse` and assert the
orchestrator's failure mode (typed error class, recorded step status,
event types) rather than asserting it succeeds.

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
  }).pipe(Effect.provide(StepLoader.inMemory(map))),
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

describe('StepLoader.Default', () => {
  it.scoped('reads markdown + frontmatter from disk', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-loader-' });
      yield* fs.writeFileString(`${dir}/plan.md`, '---\nname: plan\n---\nbody');

      const loader = yield* StepLoader;
      const loaded = yield* loader.load('plan.md', dir);
      strictEqual(loaded.frontmatter.name, 'plan');
    }).pipe(Effect.provide(StepLoader.Default.pipe(Layer.provide(NodeContext.layer)))),
  );
});
```

Prefer `fs.makeTempDirectoryScoped()` over `mkdtempSync` + `afterAll(rmSync)`.
The scoped variant releases on fiber interrupt, so a flaky test won't leak
directories between runs.

## Virtual time: `TestClock`

`it.effect` and `it.scoped` auto-provide `TestServices`, which includes a
`TestClock`. Use it to advance virtual time deterministically instead of
real-sleeping. This is the Effect-native alternative to wall-clock `delay`s
in `ScriptedResponse`.

```ts
import { describe, it } from '@effect/vitest';
import { assertSuccess } from '@effect/vitest/utils';
import { Effect, TestClock } from 'effect';

it.effect('completes after 1 day of virtual time', () =>
  Effect.gen(function* () {
    const fiber = yield* program.pipe(Effect.fork);
    yield* TestClock.adjust('1 day');
    const exit = yield* fiber.await;
    assertSuccess(exit, expectedResult);
  }),
);
```

Two timing dials, not one:

- **`TestClock.adjust(duration)`** — when the test cares about _timing
  semantics_: schedule firing, retry backoff, timeout triggering. The fiber
  sleeps in virtual time and returns immediately in wall-clock time.
- **`ScriptedResponse.delay`** — when the test cares about _what happens
  during a real-time gap_: cancelling an in-flight call, racing two harness
  invocations, asserting on interruption ordering. Stays on the wall clock
  because we're asserting on real fiber interruption.

If a test needs `it.effect`'s ergonomics but explicitly _doesn't_ want
`TestClock` (e.g. exercising a real third-party retry), use `it.live` —
same shape, no auto-injected `TestServices`.

## Live mode and flaky retries

`@effect/vitest` exposes a few less-common entry points worth knowing:

| Tester          | When to reach for it                                                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `it.live`       | The test must run against real clocks / real `Random` / real services — `TestServices` would break it.                                                                              |
| `it.scopedLive` | `it.live` + `Scope` for resource acquisition.                                                                                                                                       |
| `it.flakyTest`  | Wraps an `Effect` so vitest retries it for up to a timeout (default `Schedule.recurs(10)`). For genuinely flaky externalities (network, third-party). Don't use to paper over bugs. |

Example, from `repos/effect/packages/platform/test/HttpClient.test.ts:64`:

```ts
it.effect('hits google.com', () =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get('https://www.google.com/').pipe(
      Effect.flatMap((_) => _.text),
    );
    assertInclude(response, 'Google');
  }).pipe(it.flakyTest, Effect.provide(FetchHttpClient.layer)),
);
```

Naming caveat: `it.flakyTest` retries the **test**; `flakeyHarness` (this
repo) builds a harness that **fails after N calls**. Different concepts,
similar names — read the import line.

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

`it.layer` blocks **nest**, and inner blocks merge layers with outer ones —
useful when a `describe` shares the orchestrator rig and inner blocks vary
one service:

```ts
it.layer(baseRig)(({ it }) => {
  it.effect('happy path', () => /* uses base rig */);

  it.layer(scriptedUntilEvaluator.layer([false, true]))(({ it }) => {
    it.effect('two iterations then stop', () => /* base + overridden verdicts */);
  });
});
```

## Property tests with `it.prop`

`@effect/vitest` ships `it.prop` (and `it.effect.prop` / `it.scoped.prop`)
for FastCheck-driven property tests. Use `Schema` or `FastCheck` arbitraries
interchangeably:

```ts
import { describe, it } from '@effect/vitest';
import { Effect, FastCheck, Schema } from 'effect';

it.effect.prop(
  'RunId round-trips through decode/encode',
  { raw: Schema.String.pipe(Schema.minLength(1)) },
  ({ raw }) =>
    Effect.gen(function* () {
      const id = yield* Schema.decode(RunId)(raw);
      return Schema.encode(RunId)(id) === raw;
    }),
);
```

Where property tests earn their keep in this repo:

- Branded ID parsing in `packages/core/src/ids.ts` (round-trip, rejection of
  malformed inputs).
- `Schema.decodeUnknown` at the orchestrator boundary — generate noise,
  assert "either decodes cleanly or fails with `ParseError`."
- Combinatorial harness output: generate `events[]` permutations and assert
  the orchestrator's invariant ("non-zero `exit` always surfaces a tagged
  failure").

Don't reach for property tests when the failure mode you care about is one
specific malformed shape — write a unit case in
`orchestrator-malformed.test.ts`. Properties pay off when the _space_ of
inputs is what matters, not a single point in it.

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

For the common "expect this `Exit` to be a typed failure of class `X` and
narrow the value for further field checks" pattern, prefer
`assertExitFailedWith` from `testing/factories.ts`:

```ts
import { assertExitFailedWith } from './testing/index.ts';

const err = assertExitFailedWith(exit, CapabilityMismatchError);
deepStrictEqual(err.missing, ['session.resume']);
```

Replaces the four-line `Exit.isFailure` + `Cause.failureOption` + `_tag` +
`assertInstanceOf` dance.

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
| `StepLoader.Default`                  | `StepLoader.inMemory(map)`                                                    | Reads from a `Map<string, string>`. |
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

Most tests should reach for `makeTestRig` (above) — it builds the full layer
_and_ returns the capture refs so the test body doesn't have to allocate
them. The lower-level `makeTestLayer` is still available in `testing/factories.ts`
for tests that want to compose layers manually.

Below is the original pattern from `orchestrator.test.ts` — useful when the
permission-resolution sub-tests need to vary the layer inputs per case:

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
    StepLoader.inMemory(new Map(steps)),
    scriptedUntilEvaluator.layer(verdicts),
    InMemoryRunWorkspace.layer({ runId: RunId.make('test-run') }),
  ).pipe(Layer.provideMerge(NodeContext.layer));
```

`Layer.provideMerge(NodeContext.layer)` provides `FileSystem`, `Path`, and
`CommandExecutor` — even tests that use `StepLoader.inMemory` need it because
the orchestrator calls `Path.Path` for resolution.

## When to fall back to plain `vitest`

- The test body is pure data with no Effect (`error-handler.test.ts`,
  `capabilities.test.ts`).
- The test is type-level only (`factory.test.ts` uses `expectTypeOf`).
- The test wraps a long-running real process and needs vitest's lifecycle
  hooks rather than fiber interrupt semantics.

Otherwise: `it.effect` (or `it.scoped` if scoped resources are involved).

## Don't

- **Don't import the real `StepLoader.Default` or `DefaultUntilEvaluator` in a
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
