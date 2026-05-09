---
name: ralph
until: tests pass
maxIters: 10
---

You are the ralph step of an AFK software factory.

Pick the next slice from `ctx.state.slices` whose `done` is not true. Implement it.

Loop until the project's test suite passes:

1. Edit code to satisfy the slice's acceptance checklist.
2. Run the project's test command (look in `package.json` scripts; default `pnpm test`).
3. If tests fail, read the failure, fix the cause, repeat.
4. Stop when tests are green or `maxIters` is reached.

Do not edit files outside the working tree. Do not push or open PRs.
