---
title: Step frontmatter
description: Valid frontmatter for a markdown step file.
sidebar:
  order: 1
editUrl: https://github.com/alexanderop/factory/edit/main/apps/docs/src/content/docs/reference/step-frontmatter.md
---

A step is a markdown file with YAML frontmatter and a prompt body:

```markdown
---
name: ralph
harness: claude-code
until: tests pass
maxIters: 10
---

Keep iterating on the failing tests until the whole suite is green.
```

Frontmatter is parsed and validated by [`StepFrontmatter`](https://github.com/alexanderop/factory/blob/main/packages/core/src/types.ts) in `@factory/core`. All fields are optional.

## Fields

### `name`

- **Type:** `StepId` (branded string)
- **Optional.** Falls back to the `id` passed to `.step(id, source)`.
- **Use it to:** override the canonical name when you reuse a markdown file
  for multiple step ids.

### `harness`

- **Type:** `HarnessName` (`claude-code` | `codex` | `copilot` | custom)
- **Optional.** Falls back to the per-step option, then the factory default.
- **Selection precedence (highest first):**
  1. Per-step option `.step(id, source, { harness })`.
  2. Frontmatter `harness:`.
  3. `factory({ harness })`.

### `until`

- **Type:** `string`
- **Optional.** A predicate the framework knows how to evaluate (e.g.
  `tests pass`, `lint clean`). Used inside the ralph loop to decide when to
  stop iterating.

### `maxIters`

- **Type:** `number`
- **Optional.** Hard cap on iterations for looping steps. The step ends with
  an error event when the cap is hit before `until` is satisfied.

## See also

- [Factory options](/reference/factory-options/)
- [`packages/core/src/types.ts`](https://github.com/alexanderop/factory/blob/main/packages/core/src/types.ts) — canonical schema.
