---
title: Getting started
description: Install factory, write your first pipeline, and run a step.
sidebar:
  order: 1
editUrl: https://github.com/alexanderop/factory/edit/main/apps/docs/src/content/docs/start/getting-started.md
---

`factory` is an early scaffold. This page shows the **target API** — the
shape pipelines have today and will keep as v0 stabilises.

## Prerequisites

- **Node.js ≥ 22** and **pnpm ≥ 11**.
- At least one coding harness binary on your `$PATH` — `claude`, `codex`, or
  `copilot`. The harness is invoked as a subprocess; factory does not bundle
  a model SDK.

## Install

`factory` is not yet published to npm. Until then, work inside the repo:

```bash
git clone https://github.com/alexanderop/factory.git
cd factory
pnpm install
```

The CLI runs from the workspace:

```bash
pnpm --filter @factory/cli dev -- --help
```

Once published, the install will look like this:

```bash
pnpm add -D @factory/core @factory/cli
```

## Define a pipeline

Create `.factory/factory.ts`:

```ts
import { factory } from '@factory/core';

export default factory({ name: 'sdd', harness: 'claude-code' })
  .step('plan', './steps/plan.md')
  .step('ralph', './steps/ralph.md', { harness: 'codex' })
  .step('verify', './steps/verify.md')
  .step('qa', './steps/qa.md')
  .step('simplify', './steps/simplify.md');
```

Each step points at a markdown file with frontmatter and a prompt body — see
[Step frontmatter](/reference/step-frontmatter/).

## Write a step

`.factory/steps/ralph.md`:

```markdown
---
name: ralph
harness: claude-code
until: tests pass
maxIters: 10
---

Keep iterating on the failing tests until the whole suite is green.
Only edit files under src/. Run `pnpm test` between iterations.
```

## Run

```bash
factory run sdd --prd ./feature.md
```

```
✓ plan:     1 slice identified
✓ ralph:    7 iters, tests green
✓ verify:   matches PRD
✓ qa:       typecheck + tests pass
✓ simplify: 2 smells fixed
→ PR opened: #142
```

## Observability

OpenTelemetry is wired in from day one. The default exporter is OTLP/gRPC at
`localhost:4317` — point it at any OTel backend.

For local debugging, run the standalone Aspire Dashboard:

```bash
docker run --rm -it -p 18888:18888 -p 4317:18889 \
  mcr.microsoft.com/dotnet/aspire-dashboard:latest
```

Open <http://localhost:18888> and run `factory run …` to watch traces appear
live.

Disable OTel with `--no-otel` or `OTEL_SDK_DISABLED=true`.

## Where to next

- [Patterns](/patterns/services-and-layers/) — the Effect subset factory uses.
- [Feature specs](/feature-specs/factory/) — the full design doc.
- [Reference: step frontmatter](/reference/step-frontmatter/).
- [Reference: factory options](/reference/factory-options/).
