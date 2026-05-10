---
id: r2-unsupported-permission-error
title: Replace raw throw in buildCommand with typed UnsupportedPermissionError
priority: 2
status: open
---

Lift `subprocess.buildCommand` from a sync function that `throw`s to an
`Effect` that fails with a typed `UnsupportedPermissionError` — see
`### R2` in `plans/effect-review-red.md`.

Files: `packages/core/src/subprocess.ts`, `packages/core/src/errors.ts`
(extend the `FactoryError` union); call sites in `subprocess.ts` switch
to `yield*`.

Tests: type-level coverage via `pnpm check`; confirm
`runHarness` still composes through `Effect.gen` with the widened
error channel.
