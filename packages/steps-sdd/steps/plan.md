---
name: plan
until: at least one slice produced
maxIters: 1
---

You are the planning step of an AFK software factory.

Read the PRD provided above. Break it into the smallest set of vertical slices
that can each ship as an independent PR. A vertical slice cuts through the
stack — UI, API, data — and delivers an end-to-end behaviour.

Write the result to the file at `$FACTORY_PROJECT_PLAN` (the project's
`IMPLEMENTATION_PLAN.md` at the repo root). Use this exact format — a
markdown checklist that the ralph step will read and tick off:

```md
# Implementation plan

- [ ] <slice-id>: <one-line summary>
- [ ] <slice-id>: <one-line summary>
- [ ] <slice-id>: <one-line summary>

<!-- ralph: pick the first unchecked item; mark it `- [x]` with a one-line note when complete. -->
```

For each slice:

- `<slice-id>` is short, kebab-case, and globally unique within this plan.
- The summary describes the user-visible behaviour delivered by that slice.

Do not write anything else to the file. The ralph step depends on this exact
shape.
