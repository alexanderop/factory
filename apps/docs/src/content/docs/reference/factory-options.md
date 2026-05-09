---
title: Factory options
description: Options accepted by factory(...) and .run(...).
sidebar:
  order: 2
editUrl: https://github.com/alexanderop/factory/edit/main/apps/docs/src/content/docs/reference/factory-options.md
---

Options for the `factory(...)` builder and the `.run(...)` invocation.
Canonical types live in
[`packages/core/src/types.ts`](https://github.com/alexanderop/factory/blob/main/packages/core/src/types.ts).

## `factory(options)`

```ts
factory({ name: 'sdd', harness: 'claude-code' });
```

### `name`

- **Type:** `string`
- **Required.** The pipeline name. Surfaces in CLI invocation
  (`factory run <name>`) and OpenTelemetry resource attributes.

### `harness`

- **Type:** `string`
- **Optional.** The factory-wide default harness. Steps can override per-step
  via `.step(id, source, { harness })` or via frontmatter — see
  [Step frontmatter](/reference/step-frontmatter/).

### `harnesses`

- **Type:** `ReadonlyArray<Harness>`
- **Optional.** Custom harness adapters to register alongside the built-ins.

## `.step(id, source, options?)`

Appends a step to the pipeline. Returns the `Factory` for chaining.

- **`id`** — the step id used in events and traces.
- **`source`** — path to the markdown step file.
- **`options.harness`** — per-step harness override.
- **`options.until`** — per-step exit predicate.
- **`options.maxIters`** — per-step iteration cap.

## `.run(options)`

```ts
await pipeline.run({ prd: './feature.md' });
```

### `prd`

- **Type:** `string`
- **Required.** Path to a PRD markdown file or inline text.

### `cwd`

- **Type:** `string`
- **Optional.** Working directory for harness subprocesses. Defaults to
  `process.cwd()`.

### `idleTimeoutMs`

- **Type:** `number`
- **Optional.** Idle timeout per harness invocation, in milliseconds.

### `onStep`

- **Type:** `(event: FactoryEvent) => void`
- **Optional.** Lifecycle callback — receives `run.start`, `step.start`,
  `step.iter`, `step.end`, `step.output`, `run.end` events.

### `onError`

- **Type:** `(event) => void`
- **Optional.** Receives error events. Wire your own retry / halt / notify
  logic here — factory does not retry by default.

### `otel`

- **Type:** `boolean`
- **Optional.** Disable OpenTelemetry by passing `false`. The CLI exposes
  this as `--no-otel`.

## See also

- [Step frontmatter](/reference/step-frontmatter/)
- [Feature spec](/feature-specs/factory/)
