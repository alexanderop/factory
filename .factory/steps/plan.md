---
name: plan
until: tickets folder exists with at least one ticket
maxIters: 1
---

You are the planning step of an AFK factory dogfooding the `factory` repo.
The PRD above is a markdown plan (e.g. `plans/effect-review-red.md`) with a
numbered list of fixes and usually a `## Sequencing` section.

Your job is to slice it into ticket files that the rest of the pipeline
(branch → ralph → commit) consumes one at a time.

## Where tickets live

For a PRD at `plans/<name>.md`, write tickets under `plans/<name>/tickets/`
(create the folder if it doesn't exist). One file per ticket, named
`<priority>-<id>.md` with the priority zero-padded so `ls` sorts correctly
(e.g. `01-r3-harness-idle-timeout.md`).

## Idempotency

If `plans/<name>/tickets/` already contains `*.md` files, **do nothing and
exit**. Plan only runs once per PRD; subsequent pipeline runs reuse the
existing tickets.

## Ticket file shape

Each ticket is a markdown file with frontmatter and a body:

```md
---
id: r3-harness-idle-timeout
title: Drop StepId.make('') placeholder via HarnessIdleTimeoutError
priority: 1
status: open
---

<body: a short paragraph pointing at the source-plan section, plus the
file paths and the test the PRD asks for. Do not duplicate the PRD —
reference it by section heading (e.g. "see `### R3` in
plans/effect-review-red.md").>
```

Frontmatter rules:

- `id`: short, kebab-case, globally unique within this plan. Used for the
  branch name.
- `title`: imperative one-liner. Used for the conventional-commit subject.
- `priority`: integer, **lower number = higher priority**. Honour any
  `## Sequencing` section in the PRD — the first item gets `priority: 1`,
  the next `priority: 2`, etc.
- `status`: always `open` at plan time. Branch and ralph mutate it later.

## What to write in the body

A few sentences pointing at the PRD section, the files touched, and the
specific tests the PRD asks for. Treat the body as the briefing card
ralph will read; do not paraphrase the fix details, link to them.

## After writing the tickets

The tickets folder is committed so the rest of the pipeline starts from a
clean tree. After writing the files, on the **current branch (main)**:

1. `git add plans/<name>/tickets/`.
2. `git commit -m "chore(plan): scaffold tickets for <name>"`.

Do not switch branches; the branch step does that.

## Constraints

- Do **not** write a top-level `IMPLEMENTATION_PLAN.md`. The tickets
  folder is the source of truth.
- Do **not** modify the source PRD.
- Do **not** group fixes that the PRD's `## Sequencing` lists separately.
  One PRD-item = one ticket, except where the PRD itself bundles them
  (e.g. "R5 + R6 ship as one PR" → one ticket).
