---
title: '@factory/harness-claude-code'
description: Subprocess adapter for the claude binary.
sidebar:
  order: 3
editUrl: https://github.com/alexanderop/factory/edit/main/apps/docs/src/content/docs/packages/harness-claude-code.md
---

Spawns `claude` as a subprocess and surfaces its output as a stream of
`HarnessEvent` values.

- **Source:** [`packages/harness-claude-code`](https://github.com/alexanderop/factory/tree/main/packages/harness-claude-code)
- **Harness name:** `claude-code`
- **Binary required on `$PATH`:** `claude`

Select per-step:

```ts
.step('plan', './steps/plan.md', { harness: 'claude-code' })
```

Or factory-wide:

```ts
factory({ name: 'sdd', harness: 'claude-code' });
```
