---
title: '@factory/core'
description: Pipeline builder, step runner, run context, and OpenTelemetry init.
sidebar:
  order: 1
editUrl: https://github.com/alexanderop/factory/edit/main/apps/docs/src/content/docs/packages/core.md
---

`@factory/core` is the heart of factory. It exports the `factory(...)` builder,
the orchestrator that runs steps, the run context, and the OpenTelemetry
bootstrap.

- **Source:** [`packages/core`](https://github.com/alexanderop/factory/tree/main/packages/core)
- **Public surface:**
  - `factory({ name, harness, harnesses })` — define a pipeline.
  - `.step(id, source, options?)` — append a step.
  - `.run(options)` — run the pipeline (Promise).
  - `.runEffect(options)` — Effect-returning variant for Effect callers.
- **Types:** see [`packages/core/src/types.ts`](https://github.com/alexanderop/factory/blob/main/packages/core/src/types.ts).

## Reference

- [Step frontmatter](/reference/step-frontmatter/)
- [Factory options](/reference/factory-options/)
