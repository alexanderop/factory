---
title: '@factory/cli'
description: The factory command-line interface.
sidebar:
  order: 2
editUrl: https://github.com/alexanderop/factory/edit/main/apps/docs/src/content/docs/packages/cli.md
---

`@factory/cli` ships the `factory` binary. It loads `.factory/factory.ts` from
the current working directory and runs the pipeline.

- **Source:** [`packages/cli`](https://github.com/alexanderop/factory/tree/main/packages/cli)
- **Bin:** `factory`
- **Headline command:** `factory run <name> --prd <file|text>`

```bash
factory run sdd --prd ./feature.md
factory run sdd --prd "Add dark mode toggle to settings page."
```

Disable OpenTelemetry with `--no-otel` or `OTEL_SDK_DISABLED=true`.
