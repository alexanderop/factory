---
name: dogfood
description: Run the factory on itself, one ticket at a time, against a plan markdown. Use when the user says "dogfood", "run factory on factory", "/dogfood", or asks to start an effect-review style pipeline. Optional argument is the path to the plan markdown; defaults to plans/effect-review-red.md.
allowed-tools: Bash(pnpm factory*), Bash(pnpm install*), Bash(ls *), Bash(cat *), Bash(grep *), Read, Glob
---

# /dogfood — run factory on factory, per ticket

Drives the `effect-review` pipeline defined in `.factory/factory.ts` —
`plan → branch → ralph → commit`. Each pipeline run lands one ticket on
its own branch, with one conventional-commit. To work through the whole
plan, the skill loops the pipeline until no `status: open` tickets
remain.

## Inputs

- `$1` (optional): path to the source plan markdown. Defaults to
  `plans/effect-review-red.md`.

## Pre-flight

1. Resolve the plan path (`PLAN`):

   ```sh
   PLAN="${1:-plans/effect-review-red.md}"
   test -f "$PLAN" || { echo "plan not found: $PLAN"; exit 1; }
   ```

2. Derive the tickets dir (`<plan-without-.md>/tickets`):

   ```sh
   TICKETS_DIR="${PLAN%.md}/tickets"
   ```

3. Cheap install no-op:

   ```sh
   pnpm install
   ```

## Loop

Each iteration runs the pipeline once and processes one ticket:

```sh
while :; do
  pnpm factory run effect-review --prd "$PLAN"

  # Sentinel emitted by the branch step when the queue is empty.
  if grep -rq '<promise>NO-OPEN-TICKETS</promise>' .factory/runs/latest/ 2>/dev/null; then
    echo "all tickets done"
    break
  fi

  # If ralph blocked, stop and surface it. A human unblocks before resuming.
  if grep -rq '<promise>BLOCKED</promise>' .factory/runs/latest/ 2>/dev/null; then
    echo "blocked — see .factory/runs/latest/"
    break
  fi
done
```

Stop the loop and inspect the failure if any pipeline run exits non-zero.
Resume a single failed run with `pnpm factory resume latest` before
re-entering the loop.

## What to watch for

- `$TICKETS_DIR` appears after the first iteration's plan step and is
  committed on `main` (`chore(plan): scaffold tickets for <name>`). The
  source of truth for the work itself is still `$PLAN`; tickets are the
  state machine. Each ticket frontmatter carries
  `status: open | in-progress | done`.
- Each successful iteration produces: one new branch (`<type>/<id>` off
  `main`), one ticket flipped to `status: done`, one commit on that
  branch. The next iteration starts from `main` again.
- The first line of branch step output ends with
  `<promise>PICKED <id></promise>` — that's the ticket the rest of the
  pipeline runs against.
- Final commit step ends with `<promise>COMMITTED <id></promise>`.

## After the loop

Tickets are landed as separate branches off `main`, not pushed. Open PRs
with the existing `/pr` skill, one branch at a time, in priority order.

## Notes

- Factory is v0; bugs hit during a dogfood run _are_ the point. Capture
  them as new entries under `plans/` rather than working around them in
  the steps.
- Do not edit `.factory/steps/*.md` mid-run. Steps are re-read each
  iteration, but changing the contract under an active loop is confusing.
- `plan` is idempotent: it only writes to `$TICKETS_DIR` if the folder
  doesn't already contain ticket files. To re-plan, delete the folder
  first.
