---
name: sdd-quickstart-tdd
description: Reshape the sdd-quickstart example into a 3-phase pipeline — plan → ralph (TDD per slice) → refactor — using example-local step overrides. Wires up the `.factory/factory.ts` that the README already promises.
type: plan
status: done
created: 2026-05-09
---

# Plan: sdd-quickstart TDD pipeline

Make `examples/sdd-quickstart` a self-contained demonstration of the
factory's intended SDD shape:

```
PRD (feature.md) → plan → ralph → refactor
                          ^^^^^
                          per-slice TDD loop
```

The current example references a `.factory/factory.ts` in its README but
that file does not exist on disk. The shared `@factory/steps-sdd` package
ships generic steps (`plan`, `ralph`, `verify`, `qa`, `simplify`); this
plan keeps that package untouched and ships **example-only** step overrides
plus a wired-up factory file.

## Why these choices

- **3 phases, not 5.** User wants the example to read as `plan → ralph →
refactor`. Verify/QA are valuable in production pipelines but they
  obscure the SDD story for newcomers; drop them from this example.
- **Example-local step overrides** (decided with user). The shared
  `@factory/steps-sdd` package stays as-is so other examples / downstream
  users keep the generic prompts. The TDD discipline is opinionated and
  belongs to the example, not the shared package.
- **Refactor = renamed simplify** (decided with user). The existing
  `simplify.md` body already encodes "behavior-preserving cleanups, no new
  tests, no API renames" — that's exactly what we want post-ralph. We
  copy its body verbatim into `refactor.md`.
- **Plan stays separate** (decided with user). Folding plan into ralph
  conflates two responsibilities (decompose vs. implement) into one
  prompt. The shared `plan.md` is already correct; the example just
  copies it locally so the example is self-contained (no
  `@factory/steps-sdd` dep, no monorepo path traversal in `factory.ts`).

## Pre-requisite: the app needs a test runner

`examples/sdd-quickstart/app/package.json` currently exposes only
`dev/build/preview/typecheck`. TDD-driven ralph runs `pnpm test` against
the project after each iteration; without a runner the loop is a no-op.

Add to the app:

- `vitest` + `@vue/test-utils` + `jsdom` as devDependencies.
- `vite.config.ts` updated with the `test` config (`environment: 'jsdom'`,
  `globals: true`).
- One trivial passing seed test under
  `app/src/__tests__/smoke.test.ts` (e.g. asserts `1+1 === 2`) so the
  command exits 0 before ralph adds anything. Without a seed, ralph's
  first iteration sees "no tests found" and may treat that as failure.
- Scripts: `"test": "vitest run"`, `"test:watch": "vitest"`.

This is the minimum viable test surface. The PRD (`feature.md`) currently
describes dark mode — its acceptance criteria become the source of slices
and the targets of TDD tests.

## File-by-file changes

### 1. `examples/sdd-quickstart/.factory/factory.ts` (new)

```ts
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { factory } from '@factory/core';
import { claudeCode } from '@factory/harness-claude-code';

const here = dirname(fileURLToPath(import.meta.url));
const step = (name: string) => resolve(here, 'steps', `${name}.md`);

export default factory({
  name: 'sdd',
  harness: 'claude-code',
  harnesses: [claudeCode],
})
  .step('plan', step('plan'))
  .step('ralph', step('ralph'))
  .step('refactor', step('refactor'));
```

Resolution by absolute path side-steps `cwd`-relative lookups in
`FileStepLoader` (`packages/core/src/services/StepLoader.ts:48`), so the
example works regardless of where the user ran `factory` from.

### 2. `examples/sdd-quickstart/.factory/steps/plan.md` (new)

Verbatim copy of `packages/steps-sdd/steps/plan.md`. Same shape: write
`IMPLEMENTATION_PLAN.md` at the project root with `- [ ] <slice-id>: ...`
lines. The shared prompt already targets `$FACTORY_PROJECT_PLAN` and
matches the contract ralph reads.

No edits — keep the copy literal so a future reader can `diff` against
the shared prompt and see "this example just copied it".

### 3. `examples/sdd-quickstart/.factory/steps/ralph.md` (new — TDD-aware)

Body builds on the shared `ralph.md` but replaces the implement loop with
a TDD discipline:

```md
---
name: ralph
until: tests pass
maxIters: 10
---

You are the ralph step of an AFK software factory.

Read `$FACTORY_PROJECT_PLAN`. Pick the first unchecked slice — the first
line that begins with `- [ ]` — and implement it **test-first**.

For the slice you picked:

1. **Red.** Write one failing test under `./app/src/__tests__/` that
   pins down the user-visible behaviour the slice promises. Run
   `pnpm --filter sdd-quickstart-app test` and confirm the new test
   fails for the right reason (not a syntax error, not a missing
   import).
2. **Green.** Edit production code under `./app/src/` until that test
   passes. Re-run `pnpm --filter sdd-quickstart-app test`. Do not
   delete or weaken the test to make it pass.
3. **Iterate.** If other tests broke, fix them. Stop when the full suite
   is green or `maxIters` is reached.

When the slice is green, edit `$FACTORY_PROJECT_PLAN`: flip the picked
line from `- [ ]` to `- [x]` and append a one-line note describing what
shipped (e.g. `- [x] dark-toggle: header toggle wired to colorMode —
1 test, all green`). Leave other lines untouched.

Do not run the refactor step's job: do not extract helpers, dedupe code,
or rename APIs in this iteration. Smell removal happens in the refactor
phase. Do not push or open PRs.
```

Differences vs. shared `ralph.md`:

- Explicit Red → Green ordering, with "fail for the right reason" guard
  rail (catches the agent writing a syntactically broken test that
  trivially "fails").
- Test path pinned to `./app/src/__tests__/` so the loop stays inside
  the example app workspace.
- Explicit "no refactoring here" — orthogonal responsibilities: ralph
  proves behaviour, refactor cleans structure.

### 4. `examples/sdd-quickstart/.factory/steps/refactor.md` (new — copy of simplify.md)

Verbatim copy of `packages/steps-sdd/steps/simplify.md`, with two edits:

- Frontmatter `name: simplify` → `name: refactor`.
- The output-state line reads `Output a count of smells fixed to
ctx.state.refactor` (rename `simplify` → `refactor` so a downstream
  step that inspects state finds the right key).

Otherwise the body is unchanged: same constraints (no new tests, no API
renames, no cross-slice refactors), same `maxIters: 2`.

### 5. `examples/sdd-quickstart/app/package.json`

- Add devDeps: `vitest`, `@vue/test-utils`, `jsdom`,
  `@vitest/ui` (optional, dev ergonomics only — skip if it inflates the
  install).
- Scripts: add `"test": "vitest run"` and `"test:watch": "vitest"`.

### 6. `examples/sdd-quickstart/app/vite.config.ts`

Add a `test` block:

```ts
/// <reference types="vitest" />
// existing imports …
export default defineConfig({
  // existing plugins/resolve/etc. …
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
```

### 7. `examples/sdd-quickstart/app/src/__tests__/smoke.test.ts` (new)

```ts
import { describe, expect, it } from 'vitest';

describe('smoke', () => {
  it('runs the test runner', () => {
    expect(1 + 1).toBe(2);
  });
});
```

A single passing seed so `pnpm test` exits 0 before ralph adds slice
tests. Delete-able once the agent has shipped real tests; not worth
ceremony.

### 8. `examples/sdd-quickstart/README.md`

Replace the 5-row step table with the new 3-row table, and drop the
`verify` / `qa` / `simplify` lines from the OTel span tree. Specifically:

```diff
-| step       | harness       | why                                             |
-| ---------- | ------------- | ----------------------------------------------- |
-| `plan`     | `claude-code` | strategic decomposition into vertical slices    |
-| `ralph`    | `claude-code` | tight implement → run-tests → fix loop          |
-| `verify`   | `claude-code` | strict diff-vs-PRD review                       |
-| `qa`       | `claude-code` | run typecheck/test/lint and fix small breakages |
-| `simplify` | `claude-code` | remove smells without changing behaviour        |
+| step       | harness       | why                                                                       |
+| ---------- | ------------- | ------------------------------------------------------------------------- |
+| `plan`     | `claude-code` | break the PRD into vertical slices in `IMPLEMENTATION_PLAN.md`            |
+| `ralph`    | `claude-code` | per slice: write a failing test, make it pass, tick the slice (TDD)       |
+| `refactor` | `claude-code` | behaviour-preserving cleanup of the diff (no new tests, no API renames)   |
```

…and equivalent edits to the span tree block lower in the README.

### 9. `examples/sdd-quickstart/package.json`

Add `@factory/harness-claude-code` is already present. Confirm
`@factory/core` is present (it is). No new deps at the example root —
the harness comes through workspace deps and the steps are local files.

## Out of scope

- Wiring shared-package step paths via `@factory/steps-sdd/<file>.md`
  exports. Self-contained example beats clever resolution.
- Adding a `verify` or `qa` step "just in case". The example demonstrates
  the minimum viable shape; pipelines that need stricter gates can
  layer those steps on without changing this example.
- Rewriting the to-do app to make it more testable. The seed test +
  `jsdom` is enough; the slices ralph implements will dictate the test
  shape.
- Migrating other examples. Only `sdd-quickstart` is in scope.

## Verification

After implementation:

1. `pnpm install` from repo root — vitest pulls in cleanly.
2. `pnpm --filter sdd-quickstart-app test` — seed test passes, exit 0.
3. `pnpm --filter sdd-quickstart-app typecheck` — still clean.
4. `pnpm check` (root) — oxlint + format unchanged on new files.
5. Optional manual smoke: from `examples/sdd-quickstart`, run
   `pnpm factory run sdd --prd ./feature.md` end-to-end. Assert that
   `IMPLEMENTATION_PLAN.md` is created by `plan`, that `ralph` writes a
   test under `app/src/__tests__/` before editing `app/src/App.vue`,
   and that the `refactor` phase leaves the test count stable.

## Status

**Status:** Draft, awaiting review
**Created:** 2026-05-09
