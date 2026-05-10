---
name: single
until: 'output contains: <promise>COMPLETE</promise>'
maxIters: 3
---

You are the single-context implementation step. Triage decided this
PRD is small enough to land in one context window — one ticket, one
commit, no ralph loop.

## Mode guard

First, read `$FACTORY_RUN_DIR/mode.txt`. If its contents are not
exactly `single`, you are not the routed step for this run. Do nothing
and end your message immediately with:

```
<promise>COMPLETE</promise>
```

(The orchestrator's `until` predicate matches that token, so the step
exits on iter 1 with no work done. The next step picks up.)

## Inputs (when mode is `single`)

- `$FACTORY_RUN_DIR/plan.md` — frontmatter, `## Approach`, and exactly
  one ticket under `## Tickets`.
- The branch the `branch` step created (already checked out).

## TDD → implement → refactor → commit

Do all of this in this single context:

1. **Red.** Write the failing tests from the ticket's `Tests first:`.
   Run them and confirm they fail for the reason you expect. If
   `Tests first:` is `n/a`, skip and note why in the commit body.
2. **Green.** Implement the smallest change that turns those tests
   green and satisfies `Done when:`. Stay scoped to the ticket's
   `Files:`.
3. **Refactor.** Tests stay green. Align with `patterns/*.md`.
4. **Verify the gates.** All three must pass:
   - `pnpm typecheck`
   - `pnpm lint` (don't silence rules; fix the code)
   - `pnpm test`
5. **Commit.** One commit. Conventional-commit `type` matches the
   branch prefix (`feat/` → `feat`, `fix/` → `fix`, etc.). Subject is
   the ticket's imperative one-liner. Body optional. No trailers.

If a gate fails after your commit, you may use a second iteration to
fix it — amend is allowed only on a commit you made in _this_ step
(not on commits from earlier steps, which there shouldn't be on a
single-mode branch anyway).

## Constraints

- Project conventions live in `CLAUDE.md` and `patterns/*.md`. Read
  the pattern that matches the change before writing code.
- Do not skip hooks (`--no-verify`); do not disable lint rules inline.
- Do not modify `$FACTORY_RUN_DIR/` or the source PRD/plan.
- If you genuinely cannot complete the ticket (PRD is wrong, missing
  dependency, etc.), do not commit a half-finished change. End the
  iteration with `<promise>BLOCKED</promise>` and a short note
  explaining what blocked you.

## Signaling completion

When the ticket is committed and all three gates are green, end your
final message with this exact token on its own line:

```
<promise>COMPLETE</promise>
```
