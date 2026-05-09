# factory

> **Experimental** — early scaffold. Nothing is implemented yet; see `docs/feature-specs/factory.md`.

`factory` is a TypeScript framework for building **software factories** — multi-step coding pipelines that run fully AFK on top of whichever coding harness you already have installed (`claude`, `codex`, `copilot`, ...).

The headline pipeline is the classical spec-driven-development arc:

```
PRD → plan (slices) → ralph loop → verify → QA → simplify → PR
```

Each step is a markdown prompt (Flue-skill style), wired together in TypeScript. Harnesses are invoked as subprocesses, so you reuse the binary you already have on your `$PATH` — no new model SDK, no new API keys.

## Demo (target API)

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

## Step shape (markdown-first)

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

```ts
// .factory/factory.ts
import { factory } from '@factory/core';

export default factory({ name: 'sdd', harness: 'claude-code' })
  .step('plan', './steps/plan.md')
  .step('ralph', './steps/ralph.md', { harness: 'codex' })
  .step('verify', './steps/verify.md')
  .step('qa', './steps/qa.md')
  .step('simplify', './steps/simplify.md');
```

## Observability

OpenTelemetry is wired in from day one. Default exporter is OTLP/gRPC at `localhost:4317` — point it at any OTel backend.

For local debugging, run the standalone Aspire Dashboard:

```bash
docker run --rm -it -p 18888:18888 -p 4317:18889 \
  mcr.microsoft.com/dotnet/aspire-dashboard:latest
# open http://localhost:18888 and run `factory run ...`
```

Send to your production backend instead:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io \
OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=$KEY" \
factory run sdd --prd ./x.md
```

Disable with `--no-otel` or `OTEL_SDK_DISABLED=true`.

## Packages

| Package                                                        | Description                                         |
| -------------------------------------------------------------- | --------------------------------------------------- |
| [`@factory/core`](packages/core)                               | Builder, step runner, run context, OTel init        |
| [`@factory/cli`](packages/cli)                                 | `factory` CLI                                       |
| [`@factory/harness-claude-code`](packages/harness-claude-code) | Subprocess adapter for `claude`                     |
| [`@factory/harness-codex`](packages/harness-codex)             | Subprocess adapter for `codex`                      |
| [`@factory/harness-copilot`](packages/harness-copilot)         | Subprocess adapter for `copilot`                    |
| [`@factory/steps-sdd`](packages/steps-sdd)                     | Reference SDD steps (plan/ralph/verify/qa/simplify) |

## Status

v0 scaffold only. See [`docs/feature-specs/factory.md`](docs/feature-specs/factory.md) for the full design.
