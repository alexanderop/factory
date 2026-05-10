---
name: dogfood-pipeline-bugs
description: Two bugs in the effect-review pipeline (branch + ralph steps) that the /dogfood loop hit on plans/effect-review-red.md. Branch step re-picks already-shipped tickets; ralph step then ships the wrong ticket onto the stale branch.
type: plan
status: open
created: 2026-05-10
---

# Plan: dogfood-pipeline-bugs

Surfaced by `/dogfood plans/effect-review-red.md` on 2026-05-10. Two
iterations ran; the second one corrupted branch-to-ticket mapping.

## Iter 1 (clean)

- `plan` scaffolded `plans/effect-review-red/tickets/` (commit `a1390e220` on `main`).
- `branch` picked R3, created `fix/r3-harness-idle-timeout` off `main`,
  flipped the ticket on the branch to `in-progress`.
- `ralph` implemented R3.
- `commit` flipped the ticket to `done` and landed `e7aef34b5` on
  `fix/r3-harness-idle-timeout`. Branch never merged back to `main`, so
  the ticket file on `main` still says `status: open`.

## Iter 2 (bugs)

State at start of iter 2:

- `main`: all five tickets `status: open`, `fix/r3-harness-idle-timeout`
  exists locally with R3 shipped and ticket `done` on the branch.

What happened:

- `branch` step:
  - Read tickets from `main`, saw all `open`, picked lowest-priority =
    R3 (priority 1).
  - Noticed the branch already exists (`"already exists locally with one
commit"`) and checked it out instead of creating it.
  - Still emitted `<promise>PICKED r3-harness-idle-timeout</promise>`.
- `ralph` step:
  - Recognised the PICKED was stale: `"R3 was already shipped … there's
no in-progress ticket. To advance the plan rather than spin, I'll
pick the next-priority open ticket (R2) and implement it."`
  - Implemented R2 on the R3 branch.
  - Flipped R2's ticket file (which was `open`) to `in-progress` and
    appended a Done note.
- `commit` step:
  - Flipped R2 to `done`, landed `c7110227a` on
    `fix/r3-harness-idle-timeout`.
  - Branch now carries two tickets (R3 + R2), violating one-ticket-per-branch.

## Bugs

### B1 — branch step's "open" check is main-local

**Symptom**: branch step keeps picking the same lowest-priority ticket
on every iteration because tickets on `main` never flip to `done`. The
`done` flip only lands on the per-ticket feature branch and is never
merged back.

**Where**: `.factory/steps/branch.md` "pick lowest-priority `open`
ticket" rule.

**Options to fix** (pick one — needs a decision before re-running the loop):

1. **Branch-existence as ground truth.** Before considering a ticket
   `open`, check whether `fix/<id>` / `feat/<id>` / `chore/<id>` exists
   locally (or on the remote). If the branch exists, treat the ticket
   as taken — don't pick it. Cheap, no plumbing.
2. **Cross-branch ticket scan.** Check the ticket file on each
   candidate branch; only `open` if every branch's copy is still
   `open`. Closer to "true" status but slower and brittle if branches
   are stale.
3. **Merge-back-on-commit.** After the commit step lands on
   `fix/<id>`, fast-forward `main` so the `done` flip is visible to
   the next iteration's branch step. Cleanest invariant ("main is the
   ground truth") but means iterations land on `main` directly, which
   is at odds with "open PRs with `/pr` later, in priority order."
4. **Manifest under `.factory/`.** Have the commit step append the
   shipped ticket id + branch name to a tracked manifest file on
   `main`. Branch step consults the manifest. Decouples ticket state
   from per-branch git plumbing.

Recommendation: **Option 1**. Matches the existing artifact (the branch),
no extra files, and the loop-terminator (`NO-OPEN-TICKETS`) starts
working without any other change.

### B2 — ralph step ships off-spec when PICKED is stale

**Symptom**: ralph received a stale `PICKED r3` promise, decided on its
own to "pick the next-priority open ticket (R2)", and shipped R2 onto
the R3 branch. No promise was raised back to the orchestrator.

**Where**: `.factory/steps/ralph.md` — needs a precondition check that
the PICKED ticket is actually `in-progress` on the current branch (and
not already `done`), and a hard stop if not.

**Fix**:

- Ralph's first action: read the ticket named in the PICKED promise on
  the current branch. If `status: done`, emit
  `<promise>BLOCKED: branch step picked already-completed ticket
<id></promise>` and exit. Do **not** silently substitute another
  ticket.
- The dogfood loop already terminates on `BLOCKED`, so this becomes a
  loud stop instead of a silent corruption.

Strictly, B2 only fires because of B1 — but defence-in-depth is cheap
here and protects against future branch-step bugs.

## Cleanup of this run's mess

After fixing B1 + B2, the existing `fix/r3-harness-idle-timeout` branch
still carries R2's commit (`c7110227a`). Either:

- Cherry-pick `c7110227a` onto a fresh `fix/r2-unsupported-permission-error`
  branch off `main`, then reset `fix/r3-harness-idle-timeout` to
  `e7aef34b5`. Preserves both implementations.
- Or drop both branches and re-run the loop from scratch once the steps
  are fixed.

## Sequencing

1. Fix B1 (`.factory/steps/branch.md`).
2. Fix B2 (`.factory/steps/ralph.md`).
3. Clean up the R2-on-R3 branch (cherry-pick or reset).
4. Re-run `/dogfood plans/effect-review-red.md` end-to-end, expect
   `NO-OPEN-TICKETS` to fire after R5+R6+R7 lands.
