---
title: '@factory/harness-codex'
description: Subprocess adapter for the codex binary.
sidebar:
  order: 4
editUrl: https://github.com/alexanderop/factory/edit/main/apps/docs/src/content/docs/packages/harness-codex.md
---

Spawns `codex` as a subprocess and surfaces its output as a stream of
`HarnessEvent` values.

- **Source:** [`packages/harness-codex`](https://github.com/alexanderop/factory/tree/main/packages/harness-codex)
- **Harness name:** `codex`
- **Binary required on `$PATH`:** `codex`

```ts
.step('ralph', './steps/ralph.md', { harness: 'codex' })
```
