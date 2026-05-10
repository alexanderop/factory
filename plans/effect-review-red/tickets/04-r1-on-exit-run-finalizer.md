---
id: r1-on-exit-run-finalizer
title: Use Effect.onExit for run finalization to handle interrupt and preserve cause
priority: 4
status: open
---

Replace the `tapError`/`tap` chains in `runFactoryEffect` and
`resumeFactoryEffect` with a shared `withRunFinalizer` built on
`Effect.onExit`. Add an `'interrupted'` status to `RunRecord` and stop
recording-side failures from masking the original cause — see
`### R1` in `plans/effect-review-red.md`.

Files: `packages/core/src/orchestrator.ts`,
`packages/core/src/types.ts` (status enum + JSON codec),
`packages/core/src/services/runManifest.ts`.

Tests:

- `runWorkspace.test.ts`: simulate `Fiber.interrupt` between
  `recordStepStart` and `recordStepEnd`; assert
  `run.json` reads `status: 'interrupted'`.
- `orchestrator.test.ts`: stub `recordRunEnd` to fail; assert the
  original `HarnessExecError` propagates and the recording failure
  shows up in the log capture.
