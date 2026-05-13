# Services and Layers

How to define services and wire layers in **factory**.

> Source of truth: `repos/effect/packages/effect/test/Effect/service.test.ts`,
> `repos/effect/packages/effect/src/Effect.ts` (`Service` declaration around
> line ~13540), `packages/core/src/services/*.ts` (current factory style).

## Two valid styles, one default

Effect supports two equally-valid ways to declare a service:

1. **`Context.Tag` + hand-written `Layer.succeed` / `Layer.effect`** — verbose
   but explicit; what Effect's own source uses for low-level services.
2. **`Effect.Service`** — collapses the tag, default layer, and accessor
   boilerplate into a single class declaration.

**Default in factory: `Effect.Service`.** Use it for new services. It's
shorter, integrates with `dependencies: [...]` for automatic wiring, and the
`.Default` layer name is a stable, predictable handle for the production
implementation. The Context.Tag style is still acceptable for trivial
zero-dependency services where it reads more clearly.

## The `Effect.Service` pattern (preferred)

```ts
import { FileSystem, Path } from '@effect/platform';
import { Effect, Layer } from 'effect';
import { StepLoadError } from '../errors.ts';

export interface StepLoaderService {
  readonly load: (source: string, cwd: string) => Effect.Effect<LoadedStep, StepLoadError>;
}

export class StepLoader extends Effect.Service<StepLoader>()('@factory/StepLoader', {
  accessors: true,
  effect: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return {
      load: (source, cwd) => {
        /* ...uses fs/path... */
      },
    } satisfies StepLoaderService;
  }),
}) {
  // Test/alternate layers live as static fields. Each builds a Layer for the
  // same tag (`this`) using `new this({...})` to construct the instance.
  static inMemory = (map: ReadonlyMap<string, string>): Layer.Layer<StepLoader> =>
    Layer.succeed(StepLoader, new StepLoader({ load: (source) => /* ... */ }));
}
```

Use sites:

```ts
// Production wiring:
program.pipe(Effect.provide(StepLoader.Default));

// Test wiring:
program.pipe(Effect.provide(StepLoader.inMemory(stepFiles)));

// Inside an Effect — both forms work; pick whichever reads better:
const loader = yield * StepLoader;
yield * loader.load(source, cwd);
// or, thanks to `accessors: true`:
yield * StepLoader.load(source, cwd);
```

Why `Effect.Service` over the older `Context.Tag` + `Layer.effect` pair:

| Concern              | `Context.Tag` style                               | `Effect.Service` style                                  |
| -------------------- | ------------------------------------------------- | ------------------------------------------------------- |
| Tag declaration      | Separate `class` extends `Context.Tag(...)`       | Same class **is** the tag                               |
| Default layer        | Hand-written `Layer.effect(Tag, Effect.gen(...))` | Auto-generated `.Default`                               |
| Dependency wiring    | Caller must `Layer.provide(SubService.layer)`     | `dependencies: [SubService.Default]` in the declaration |
| Accessors            | `const s = yield* Service; yield* s.method(...)`  | `yield* Service.method(...)` with `accessors: true`     |
| Test override        | Sibling exports each with their own `.layer`      | `static Test = Layer.succeed(this, new Self({...}))`    |
| Tag identity at site | `Context.Tag` instance — stable                   | Class itself — stable, plus `instanceof` works          |

Pick the right factory variant:

| Variant   | When to use                                              |
| --------- | -------------------------------------------------------- |
| `sync`    | Pure, no deps, no async setup.                           |
| `succeed` | Static value, no setup at all.                           |
| `effect`  | Needs other services (`yield* OtherService`).            |
| `scoped`  | Holds a resource that must be released (file, DB, port). |

Other rules:

- **Always pass the `Self` generic**: `Effect.Service<StepLoader>()(...)`.
  Forgetting it produces the
  `` `Missing `Self` generic ...` `` type error.
- `dependencies: [X.Default, Y.Default]` wires sub-services automatically.
  Don't manually `Layer.provide` them at call sites.
- `accessors: true` lets callers do `yield* StepLoader.load(...)` instead of
  `const loader = yield* StepLoader; yield* loader.load(...)`. Use it.
- **Naming**: stick to `static <Variant>` (`static inMemory`, `static Test`,
  `static silent`). Lowercase for instance-variant factories that take args,
  PascalCase for static layer constants. Don't ship parallel
  `Sibling.layer` exports — they fragment the call surface.

## The `Context.Tag` style (still valid for trivial cases)

When a service has zero dependencies, multiple sibling implementations of
similar shape, and no scoped lifecycle, the older `Context.Tag` style reads
cleanly. It's what `Display`, `EventEmitter`, `UntilEvaluator`, and
`HarnessRegistry` currently use:

```ts
import { Context, Effect, Layer } from 'effect';

export interface DisplayService {
  readonly info: (message: string) => Effect.Effect<void>;
}

export class Display extends Context.Tag('@factory/Display')<Display, DisplayService>() {}

export const ConsoleDisplay = {
  layer: Layer.succeed(Display, {
    info: (message) => Effect.sync(() => console.log(message)),
  } satisfies DisplayService),
};
```

Conventions for this style:

- **Tag string** is namespaced: `'@factory/<Name>'`. Never use the bare class
  name — it collides across packages.
- **Interface** is the value shape (`DisplayService`); the **class** is the
  tag (`Display`). Don't merge them.
- Methods on the service return `Effect.Effect<A, E, R>` — never raw values
  or `Promise`.
- Multiple implementations live as named objects (`ConsoleDisplay`,
  `SilentDisplay`) each exposing a `layer` field. Keeps the call site
  honest: `Layer.provide(ConsoleDisplay.layer)`.

When a Context.Tag service grows dependencies or a scoped lifecycle,
**migrate it to `Effect.Service`** — that's the trigger. See the StepLoader
migration in `packages/core/src/services/StepLoader.ts` (commit history) for
the worked example.

## Composing layers

```ts
const AppLayer = Layer.mergeAll(StepLoader.Default, Display.Default).pipe(
  Layer.provide(NodeContext.layer),
);
```

- Use `Layer.mergeAll` for siblings, `Layer.provide` to satisfy a layer's
  requirements.
- Build one `AppLayer` per entrypoint (CLI, examples, tests). Don't scatter
  `Layer.provide` calls through business logic.
- `Layer.provideMerge` exposes the provided layer's services back out — use
  it when callers below your layer also want `NodeContext`'s `FileSystem` /
  `Path` directly.

## Internal state belongs in `Ref`

Services often need mutable state — caches, request counters, running
workspace records. **Use `Ref` (or `SynchronizedRef` if updates need to be
serialised), never `let` closure variables or mutable fields on objects in
`Map`s.** The Effect runtime can't reason about JS-level mutation, so two
fibers racing on a `let` will silently lose updates. `Ref.update` is atomic.

The canonical example in this repo is `RunWorkspace.ts`: an earlier version
captured `let runRecord: RunRecord | undefined` plus a `Map<number, StepEntry>`
where each `StepEntry.record` was a mutable field. It "worked" only because
the orchestrator happened to be sequential per step — and even then needed
an explicit semaphore around role updates (which fan out concurrently). The
current version stores everything in `Ref`s and only takes the semaphore
where read-modify-write-and-disk-write needs to be atomic across fibers.

When you do need a permit, prefer `Effect.makeSemaphore(n)` (returns
`Effect<Semaphore>`) over `Effect.unsafeMakeSemaphore(n)`. Allocating inside
the runtime keeps tracing/finalizers consistent; the `unsafe` prefix is a
real warning, not decoration.

## Don't

- Don't reach for `Context.GenericTag` — use the class form (either style).
- Don't put non-`Effect` methods on a service. If you need a sync helper,
  wrap the call site in `Effect.sync`.
- Don't define a service inside a function — it must be top-level so the
  tag identity is stable across calls.
- Don't import from `repos/effect/`. It's reference material, not a
  dependency.
- Don't ship parallel `Sibling = { layer: ... }` exports alongside an
  `Effect.Service` class — pick one surface. Either everything-is-a-static
  on the class, or everything-is-a-sibling-export. Mixing is the worst of
  both worlds.
- Don't use `Effect.unsafeMakeSemaphore` or `Ref.unsafeMake` in production
  code paths. The `unsafe` variants exist for the runtime's own bootstrap —
  user code lives inside an Effect and should use the safe variants.
