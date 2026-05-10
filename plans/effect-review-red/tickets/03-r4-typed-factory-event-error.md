---
id: r4-typed-factory-event-error
title: Type FactoryEvent.error as FactoryError instead of unknown
priority: 3
status: open
---

Tighten `FactoryEvent`'s error variant from `unknown` to `FactoryError`
so `onError` consumers narrow on `_tag` without `as`-casts — see
`### R4` in `plans/effect-review-red.md`. Depends on R3 so the
`FactoryError` union is exhaustive.

Files: `packages/core/src/types.ts`,
`packages/core/src/orchestrator.ts` (emit sites),
`packages/core/src/cli.ts` (onError handler tweak).

Tests: `pnpm check` is the assertion — no new tests required.
