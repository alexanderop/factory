---
title: '@factory/harness-copilot'
description: Subprocess adapter for the copilot binary.
sidebar:
  order: 5
editUrl: https://github.com/alexanderop/factory/edit/main/apps/docs/src/content/docs/packages/harness-copilot.md
---

Spawns `copilot` as a subprocess and surfaces its output as a stream of
`HarnessEvent` values.

- **Source:** [`packages/harness-copilot`](https://github.com/alexanderop/factory/tree/main/packages/harness-copilot)
- **Harness name:** `copilot`
- **Binary required on `$PATH`:** `copilot`

```ts
.step('qa', './steps/qa.md', { harness: 'copilot' })
```
