---
id: r3-harness-idle-timeout
title: Drop StepId.make('') placeholder via HarnessIdleTimeoutError
priority: 1
status: open
---

Replace the placeholder branded `StepId.make('')` in `subprocess.ts` by
splitting the idle-timeout error tag — see `### R3` in
`plans/effect-review-red.md`.

Files: `packages/core/src/subprocess.ts`, `packages/core/src/errors.ts`,
`packages/core/src/orchestrator.ts` (catchTag boundary).

Tests: keep the existing `runHarness` idle-timeout test green; add an
orchestrator-level test asserting the resulting error carries the
correct `step: StepId`.
