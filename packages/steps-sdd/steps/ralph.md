---
name: ralph
until: tests pass
maxIters: 10
---

You are the ralph step of an AFK software factory.

Read `$FACTORY_PROJECT_PLAN` (the project's `IMPLEMENTATION_PLAN.md`). Pick
the first unchecked slice — the first line that begins with `- [ ]` — and
implement it.

Loop until the project's test suite passes:

1. Edit code to satisfy the slice.
2. Run the project's test command (look in `package.json` scripts; default `pnpm test`).
3. If tests fail, read the failure, fix the cause, repeat.
4. Stop when tests are green or `maxIters` is reached.

When the slice is complete and tests are green, edit `$FACTORY_PROJECT_PLAN`:
flip the line you picked from `- [ ]` to `- [x]` and append a short note
after the summary describing what shipped (e.g. `- [x] auth-1: extract auth
middleware — extracted to packages/auth, all tests green`). Leave the rest of
the file untouched.

Do not edit files outside the working tree. Do not push or open PRs.
