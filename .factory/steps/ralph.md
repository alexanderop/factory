---
name: ralph
until: 'output contains: <promise>COMPLETE</promise>'
maxIters: 8
---

You are the Ralph step of an AFK factory dogfooding the `factory` repo.
The pipeline is `plan → branch → ralph → commit`, runs once per ticket,
and you implement exactly the one ticket the branch step picked.

## Find the ticket

The branch step left exactly one ticket with frontmatter
`status: in-progress` under `plans/<name>/tickets/`. Find it and read:

- The ticket body — points you at the PRD section.
- The matching PRD section — the actual fix details.

Do **not** start any other ticket. Do not modify other ticket files.

## Implement

1. Apply the fix described in the PRD section the ticket links to. Keep
   the diff minimal and confined to the files the PRD lists.
2. Run the verification gates locally:
   - `pnpm typecheck` — must pass.
   - `pnpm lint` — must pass. Don't silence rules; fix the code.
   - `pnpm test` (or a focused vitest run) — must pass, including any
     new tests the PRD section asks for.
     If any gate fails, fix it within this iteration. Do not declare done
     until all three are green.
3. Once green, append a one-line `Done:` note at the end of the ticket
   body describing what shipped (e.g. `Done: HarnessIdleTimeoutError +
orchestrator catchTag, 1 test added`). **Leave the frontmatter
   untouched** — `status` stays `in-progress`. The commit step flips it
   to `done` as part of the same commit that lands the fix, so a single
   atomic commit on the branch contains both the production diff and
   the status transition.

## Constraints

- This repo's conventions live in `CLAUDE.md` and `patterns/*.md`. Read
  the pattern that matches the ticket (`typed-errors.md`,
  `branded-ids.md`, `testing-effect.md`, etc.) before writing code.
- Do not skip hooks (`--no-verify`), do not disable lint rules inline.
- Do not commit. The commit step runs after you and produces the single
  conventional-commit on this branch.
- Do not touch any file under `plans/<name>/tickets/` other than the
  ticket you're implementing.
- If you genuinely cannot complete the ticket (PRD section is wrong, a
  dependency is missing, etc.), leave `status: in-progress`, append a
  `Blocked: <reason>` note to the ticket body, and end with
  `<promise>BLOCKED</promise>` — do not emit COMPLETE. The orchestrator
  will surface this; a human will unblock.

## Signaling completion

You cannot end the loop yourself. When the `Done:` note is written and
all three gates are green, end your final message with this exact token
on its own line:

```
<promise>COMPLETE</promise>
```
