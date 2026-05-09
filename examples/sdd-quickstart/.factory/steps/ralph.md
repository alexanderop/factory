---
name: ralph
until: tests pass
maxIters: 10
---

You are the ralph step of an AFK software factory.

Read `$FACTORY_PROJECT_PLAN` (the project's `IMPLEMENTATION_PLAN.md`). Pick
the first unchecked slice — the first line that begins with `- [ ]` — and
implement it **test-first**.

For the slice you picked:

1. **Red.** Write one failing test under `./app/src/__tests__/` that pins
   down the user-visible behaviour the slice promises. Run
   `pnpm --filter sdd-quickstart-app test` and confirm the new test fails
   for the right reason (assertion failure, not a syntax error or missing
   import).
2. **Green.** Edit production code under `./app/src/` until that test
   passes. Re-run `pnpm --filter sdd-quickstart-app test`. Do not delete
   or weaken the test to make it pass.
3. **Iterate.** If other tests broke, fix them. Stop when the full suite
   is green or `maxIters` is reached.

When the slice is green, edit `$FACTORY_PROJECT_PLAN`: flip the picked
line from `- [ ]` to `- [x]` and append a one-line note describing what
shipped (e.g. `- [x] dark-toggle: header toggle wired to colorMode — 1
test, all green`). Leave other lines untouched.

Do not run the refactor step's job: do not extract helpers, dedupe code,
or rename APIs in this iteration. Smell removal happens in the refactor
phase. Do not edit files outside the working tree. Do not push or open
PRs.
