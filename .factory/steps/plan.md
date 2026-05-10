---
name: plan
until: 'output contains: <promise>PLANNED</promise>'
maxIters: 1
---

You are the planning step of a factory pipeline. The PRD above is the
unit of work for this run. Your job is to read it and produce an
implementation plan that the rest of the pipeline (`branch → ralph →
pr`) consumes.

The plan does two things at once:

- Picks the branch name and PR title for the whole PRD.
- Splits the PRD vertically into ordered, independently-shippable
  **tickets**. Ralph implements them one-by-one on the same branch,
  one commit per ticket. The PR bundles all of them.

## Output location

Write the plan to `$FACTORY_RUN_DIR/plan.md` (the run artifact directory
exposed to the harness). It is **not** committed — it lives with the
run artifacts and is regenerated each time the pipeline runs.

## Plan file shape

```md
---
branch: <conventional-prefix>/<kebab-slug>
title: <imperative subject for the PR / overall scope>
---

## Approach

<2–6 sentences: how you intend to satisfy the PRD as a whole. Mention
the patterns from `patterns/*.md` that apply.>

## Tickets

### T1 — <imperative one-line subject>

- Files: <comma-separated paths or globs>
- Tests first: <bullet list of failing tests to write, or `n/a`>
- Done when: <bullet list of observable conditions>

### T2 — <imperative one-line subject>

- Files: …
- Tests first: …
- Done when: …

<…repeat for each ticket…>

## Done when (overall)

- All tickets' `Done when` conditions are met.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` all green.
- <any PRD-level acceptance criteria>
```

Frontmatter rules:

- `branch`: conventional-commit prefix (`feat/`, `fix/`, `refactor/`,
  `test/`, `docs/`, `chore/`) + a short kebab-case slug derived from
  the PRD's overall intent. Default `feat/` if unsure.
- `title`: imperative, fits on one line, no trailing period. Used as
  the PR title.

Ticket rules:

- Numbered `T1`, `T2`, … in the order ralph should implement them.
  Earlier tickets must not depend on later ones.
- One ticket = one commit = one logical change. If two changes belong
  in the same commit (shared file, mechanical refactor), make them one
  ticket. If they're independent, split them.
- If the PRD already enumerates items (numbered list, `## Items`,
  `## Sequencing`), use that as your starting structure — don't
  re-invent the slicing.

## Constraints

- Do **not** modify the source PRD.
- Do **not** create files outside `$FACTORY_RUN_DIR/`.
- Do **not** commit. The plan is a run artifact, not project history.
- Read the relevant `patterns/*.md` files for any code referenced in
  the PRD before deciding the slicing.

## Signaling completion

After writing `$FACTORY_RUN_DIR/plan.md`, end your final message with
this exact token on its own line:

```
<promise>PLANNED</promise>
```
