---
name: triage
until: 'output contains: <promise>TRIAGED</promise>'
maxIters: 1
---

You are the triage step of a factory pipeline. The plan step wrote
`$FACTORY_RUN_DIR/plan.md`. Your job is to decide whether the
implementation should run as a single context window (`single`) or as a
ralph loop (`ralph`).

## Decision

Read `$FACTORY_RUN_DIR/plan.md`. Count the tickets under `## Tickets`
and look at each ticket's `Files:` and `Tests first:` fields.

Pick `single` only if **all** of these hold:

- Exactly one ticket.
- That ticket touches ≤ 2 source files (count entries in `Files:`,
  excluding test files).
- Tests fit in a single test file.
- No cross-package work (all files live in one `packages/*` or
  `examples/*` subtree).
- No migrations, code-generation, or lockfile churn.

Otherwise pick `ralph`.

## Output

Write the chosen word — exactly `single` or `ralph`, no newline, no
quotes — to `$FACTORY_RUN_DIR/mode.txt`.

Then, on stdout, write a one-sentence rationale so the run log explains
the pick (e.g. `mode=ralph: 4 tickets spanning packages/core and
packages/cli`).

## Constraints

- Do **not** modify `$FACTORY_RUN_DIR/plan.md` or the source PRD.
- Do **not** create any other files.
- Do **not** commit.

## Signaling completion

End your final message with this exact token on its own line:

```
<promise>TRIAGED</promise>
```
