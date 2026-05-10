---
name: ralph
until: 'output contains: <promise>COMPLETE</promise>'
maxIters: 12
---

You are the ralph step of a factory pipeline. The PRD above is the
overall unit of work; `$FACTORY_RUN_DIR/plan.md` is the implementation
plan with an ordered `## Tickets` list (T1, T2, …). You are on the
branch the branch step created.

Your job: walk the ticket list in order, doing TDD → implement →
refactor → commit for each one. One commit per ticket. The branch
accumulates them all; the next step opens a single PR.

## Mode guard

First, read `$FACTORY_RUN_DIR/mode.txt`. If its contents are not
exactly `ralph`, you are not the routed step for this run. Do nothing
and end your message immediately with:

```
<promise>COMPLETE</promise>
```

(The orchestrator's `until` predicate matches that token, so the step
exits on iter 1 with no work done. The next step picks up.)

## Figuring out where you are

Read `$FACTORY_RUN_DIR/plan.md` and `git log main..HEAD --oneline` on
the current branch. A ticket `Tn` is **done** if its subject already
appears as a commit on this branch (subject match is enough — don't
re-do work). Pick the lowest-numbered **not-yet-done** ticket.

If every ticket is done and all gates are green, you're finished —
jump to "Signaling completion".

## Implementing the current ticket

For the picked ticket only:

1. **Red.** Write or extend the failing tests listed in the ticket's
   `Tests first`. Run them and confirm they fail for the reason you
   expect. If `Tests first` is `n/a`, skip and note why in the commit
   body.
2. **Green.** Implement the smallest change that turns those tests
   green and satisfies the ticket's `Done when`. Keep the diff scoped
   to the ticket's `Files`.
3. **Refactor.** With tests green, clean up: extract names, collapse
   duplication, align with `patterns/*.md`. Re-run tests after each
   refactor — they must stay green.
4. **Verify the gates.** All three must pass before you commit:
   - `pnpm typecheck`
   - `pnpm lint` (don't silence rules; fix the code)
   - `pnpm test` (or a focused vitest run that covers the changed
     packages)
5. **Commit.** Stage only this ticket's diff. Use a conventional-commit
   message whose **type** matches the branch prefix (`feat/` → `feat`,
   `fix/` → `fix`, etc.) and whose **subject** is the ticket's
   imperative one-liner. Body is optional. No trailers.

After committing, stop the iteration. The orchestrator will run the
next iteration, you'll re-check the ticket list, and pick the next
undone one.

## When everything is done

When `git log main..HEAD` covers every ticket in the plan and all
three gates are green, end your final message with this exact token
on its own line:

```
<promise>COMPLETE</promise>
```

## Constraints

- Project conventions live in `CLAUDE.md` and `patterns/*.md`. Read the
  pattern that matches the change (`typed-errors.md`, `branded-ids.md`,
  `testing-effect.md`, etc.) before writing code.
- Do not skip hooks (`--no-verify`); do not disable lint rules inline.
- Do not modify `$FACTORY_RUN_DIR/` — those are read-only run artifacts.
- Do not modify the source PRD or the source plan.
- One ticket per iteration. Don't bundle multiple tickets into one
  commit even if they look related.
- If you genuinely cannot complete the current ticket (PRD is wrong,
  dependency missing, etc.), do not commit a half-finished change. End
  the iteration with `<promise>BLOCKED</promise>` and a short note
  explaining what blocked you.
