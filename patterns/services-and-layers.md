# Services and Layers

How to define services and wire layers in **factory**.

> Source of truth: `repos/effect/packages/effect/test/Effect/service.test.ts`,
> `repos/effect/packages/effect/src/Effect.ts` (`Service` declaration around
> line ~13540), `packages/core/src/services/*.ts` (current factory style).

## Current factory style: `Context.Tag` + hand-written `Layer`

This is what `packages/core/src/services/` uses today. Use it when the service
is small, has no dependencies, and you want multiple distinct
implementations (`ConsoleDisplay`, `SilentDisplay`).

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

Conventions:

- **Tag string** is namespaced: `'@factory/<Name>'`. Never use the bare class
  name — it collides across packages.
- **Interface** is the value shape (`DisplayService`); the **class** is the
  tag (`Display`). Don't merge them.
- Methods on the service return `Effect.Effect<A, E, R>` — never raw values
  or `Promise`.
- Multiple implementations live as named objects (`ConsoleDisplay`,
  `SilentDisplay`) each exposing a `layer` field. Keeps the call site
  honest: `Layer.provide(ConsoleDisplay.layer)`.

## Preferred for new services: `Effect.Service`

Use `Effect.Service` when the service has dependencies on other services or
needs a scoped lifecycle. It collapses the tag, default layer, and accessor
boilerplate into one class.

```ts
import { Effect, Layer } from 'effect';

class Prefix extends Effect.Service<Prefix>()('@factory/Prefix', {
  sync: () => ({ prefix: 'PRE' }),
}) {}

class Logger extends Effect.Service<Logger>()('@factory/Logger', {
  accessors: true,
  effect: Effect.gen(function* () {
    const { prefix } = yield* Prefix;
    return {
      info: (message: string) => Effect.sync(() => console.log(`[${prefix}] ${message}`)),
    };
  }),
  dependencies: [Prefix.Default],
}) {
  // Test override: provide a no-op implementation.
  static Test = Layer.succeed(this, new Logger({ info: () => Effect.void }));
}
```

Pick the right factory variant:

| Variant   | When to use                                              |
| --------- | -------------------------------------------------------- |
| `sync`    | Pure, no deps, no async setup.                           |
| `succeed` | Static value, no setup at all.                           |
| `effect`  | Needs other services (`yield* OtherService`).            |
| `scoped`  | Holds a resource that must be released (file, DB, port). |

Other rules:

- **Always pass the `Self` generic**: `Effect.Service<Logger>()(...)`.
  Forgetting it produces the
  `` `Missing `Self` generic ...` `` type error.
- `dependencies: [X.Default, Y.Default]` wires sub-services automatically.
  Don't manually `Layer.provide` them at call sites.
- `accessors: true` lets callers do `yield* Logger.info(...)` instead of
  `const { info } = yield* Logger; yield* info(...)`. Use it.
- Provide a `static Test` layer alongside the service. It's the canonical
  swap point for `@effect/vitest`'s `it.effect`.

## Composing layers

```ts
const AppLayer = Layer.mergeAll(Logger.Default, Display.Default).pipe(
  Layer.provide(Prefix.Default),
);
```

- Use `Layer.mergeAll` for siblings, `Layer.provide` to satisfy a layer's
  requirements.
- Build one `AppLayer` per entrypoint (CLI, examples, tests). Don't scatter
  `Layer.provide` calls through business logic.

## Don't

- Don't reach for `Context.GenericTag` — use the class form.
- Don't put non-`Effect` methods on a service. If you need a sync helper,
  wrap the call site in `Effect.sync`.
- Don't define a service inside a function — it must be top-level so the
  tag identity is stable across calls.
- Don't import from `repos/effect/`. It's reference material, not a
  dependency.

## Migration note

Existing `Context.Tag` services in `packages/core/src/services/` are fine as-is.
When touching one for unrelated reasons, leave the style alone. New services
should use `Effect.Service`.
