You are the planning step.

Read the PRD provided above and break it into the smallest set of vertical
slices that each ship as an independent change. A slice cuts through whatever
layers the PRD requires and delivers an end-to-end behaviour you can verify.

Write the result to the file at `$FACTORY_PROJECT_PLAN`. Use this exact format:

```md
# Implementation plan

- [ ] <slice-id>: <one-line summary>
- [ ] <slice-id>: <one-line summary>

<!-- ralph: pick the first unchecked item; mark it `- [x]` with a one-line note when complete. -->
```

For each slice:

- `<slice-id>` is short, kebab-case, and globally unique within this plan.
- The summary describes the user-visible behaviour delivered by that slice.

Do not write anything else to the file. The ralph step depends on this exact shape.
