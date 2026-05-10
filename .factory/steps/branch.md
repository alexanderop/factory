---
name: branch
until: a ticket has status in-progress and the working branch matches it
maxIters: 1
---

You are the branch step of an AFK factory. Your job is to pick the next
ticket to work on and create a clean branch off `main` for it.

## Picking the ticket

The PRD path is in the prompt above (and corresponds to a tickets folder
at `plans/<name>/tickets/`). Find that folder and:

1. **Resume case.** If exactly one ticket has frontmatter `status:
in-progress`, pick that ticket. Do not flip its status. Do not
   re-create its branch — checkout the existing one
   (`fix/<id>` or `<type>/<id>`, see below) if it exists, otherwise
   create it.
2. **Fresh case.** Otherwise pick the ticket with `status: open` and the
   lowest `priority` integer. Flip its frontmatter `status: open` →
   `status: in-progress`, but **do not commit** — the working tree stays
   dirty and the commit step bundles this with the production diff.
3. **Nothing-to-do case.** If no ticket has `status: open` or
   `in-progress`, output exactly:

   ```
   <promise>NO-OPEN-TICKETS</promise>
   ```

   …and stop. The orchestrator will treat this as success; the dogfood
   skill polls for it to know the queue is empty.

If multiple tickets are `in-progress`, that's a bug — output the ids and
stop with an error message.

## Branch naming

Derive a conventional-commit-style branch name from the ticket
frontmatter:

- Default prefix is `fix/` for review-red tickets (the PRDs are bug
  fixes). If the ticket title clearly matches another type, use that
  prefix instead: `feat/`, `refactor/`, `test/`, `docs/`, `chore/`.
- The slug after the prefix is the ticket `id` verbatim (already kebab-
  case).

Examples:

- `id: r3-harness-idle-timeout` → `fix/r3-harness-idle-timeout`
- `id: typed-events-narrowing` → `refactor/typed-events-narrowing`

## Branch creation

The order matters because the picking step left the ticket file dirty:

1. Pre-flight: `git status --porcelain`. The only modified path allowed
   is the picked ticket file. Anything else dirty → stop and surface the
   diff; do not stash or discard.
2. `git checkout main`. (Do not `git pull` — this is a local dogfood
   loop, not a tracked remote workflow.)
3. `git checkout -b <branch-name>` (or `git checkout <branch-name>` if
   the branch already exists from a prior resumed run). The dirty ticket
   file follows you onto the new branch — that's intentional. Do not
   commit it here.

## Output

End your message with the picked ticket id on its own line, in this
exact form:

```
<promise>PICKED <id></promise>
```

Ralph reads this. Do not include any other `<promise>` markers.
