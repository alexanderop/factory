---
id: r5-r6-test-cleanup
title: Remove nested runSync and split the resume mega-test
priority: 5
status: open
---

Bundle the test cleanup the PRD groups together: drop the nested
`Effect.runSync` inside `it.scoped` and split the four-assertion resume
test into three focused cases. Includes the R7 coverage check after
the split — see `### R5`, `### R6`, and `### R7` in
`plans/effect-review-red.md`. Depends on R1 for the new
`'interrupted'`-status assertion.

Files: `packages/core/src/runWorkspace.test.ts`.

Tests: the file itself — replace the `Ref`-based `recordCall` with a
plain array, then split the mega-test into:

1. phase-1 records run + step state on failure;
2. resume reuses ok steps without re-invoking plan;
3. resume re-executes the failed step.
   After the split, run `pnpm test --coverage` and add a fourth case
   asserting the harness call sequence if the resume path coverage drops.
