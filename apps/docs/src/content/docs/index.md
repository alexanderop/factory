---
title: factory
description: TypeScript framework for building software factories — multi-step coding pipelines that run AFK on top of any installed coding harness.
template: splash
hero:
  title: factory
  tagline: Multi-step coding pipelines that run fully AFK on top of whichever coding harness you already have installed.
  actions:
    - text: Get started
      link: /start/getting-started/
      icon: right-arrow
      variant: primary
    - text: Read the spec
      link: /feature-specs/factory/
      icon: document
    - text: View on GitHub
      link: https://github.com/alexanderop/factory
      icon: external
      variant: minimal
editUrl: https://github.com/alexanderop/factory/edit/main/apps/docs/src/content/docs/index.md
---

`factory` is a TypeScript framework for building **software factories** — multi-step coding pipelines that run on top of `claude`, `codex`, `copilot`, or any other coding harness you already have on your `$PATH`.

The headline pipeline is the classical spec-driven-development arc:

```
PRD → plan (slices) → ralph loop → verify → QA → simplify → PR
```

Each step is a markdown prompt, wired together in TypeScript. Harnesses are invoked as subprocesses, so you reuse the binary you already have installed — no new model SDK, no new API keys.

## Where to next

- **[Getting started](/start/getting-started/)** — install the CLI, write your first `factory.ts`, run a step.
- **[Patterns](/patterns/services-and-layers/)** — the factory-specific Effect subset this codebase uses.
- **[Feature specs](/feature-specs/factory/)** — the canonical design doc.
- **[Reference](/reference/step-frontmatter/)** — step frontmatter and factory options.
