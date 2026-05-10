---
name: simplify
until: 'output contains: <promise>SIMPLIFIED</promise>'
maxIters: 2
---

You are the simplify step of a factory pipeline. The implementation
step (single or ralph) finished — `git log main..HEAD` holds the
work, all gates are green. Your job is to review the accumulated diff
with fresh eyes, fix what you find, and commit once.

This step always runs, regardless of `mode.txt`. Fresh-context review
is the whole point — the implementer was inside the change; you are
outside it.

## Inputs

- `git diff main..HEAD` — the whole branch's work as one diff.
- `$FACTORY_RUN_DIR/plan.md` — context for _why_ the changes were made.
- The changed files themselves. Read them fully, not just the hunks —
  reuse opportunities live in the surrounding code.
- `patterns/*.md` and `repos/effect/` — the codebase's vocabulary.

## Phase 1 — Review (parallel subagent fan-out)

In a **single message**, spawn three subagents concurrently using the
`Task` tool with `subagent_type: general-purpose`. Pass each subagent
the full diff plus the plan, and tell each one to report findings as
a numbered list with file paths and line numbers. No fixes from the
subagents — you do the fixing in Phase 2.

### Subagent 1 — Reuse

Look for:

- New code that duplicates something already in `packages/`, in the
  vendored `repos/effect/`, or in `patterns/*.md`.
- Hand-rolled string / path / env helpers where `@effect/platform`
  exposes one.
- Re-implemented `Schema` shapes or `Data.TaggedError` variants where
  one already exists in the project.
- Ad-hoc type guards where `Predicate.isRecord` / `Schema.is` would do.
- Branded IDs re-derived inline instead of using `ids.ts`.

### Subagent 2 — Quality

Look for:

- Redundant state — values that duplicate other state, cached values
  that could be derived, observers/effects that could be direct calls.
- Parameter sprawl — new parameters bolted on instead of restructuring.
- Near-duplicate blocks that should be unified.
- Leaky abstractions — internal details exposed across module borders.
- Stringly-typed code where a brand from `ids.ts` or a schema literal
  union exists.
- Lint rules silenced inline, hooks skipped, `as` casts (lint forbids
  these — flag any that snuck in).

### Subagent 3 — Efficiency

Look for:

- Sequential `Effect`s that could be `Effect.all({ concurrency: ... })`
  or `Effect.forEach({ concurrency })`.
- Repeated file reads, N+1 patterns, duplicate work across iterations.
- TOCTOU existence checks (pre-checking a file before opening it
  instead of just opening and handling the error).
- Hot-path bloat — new blocking work added to startup or per-iteration
  paths.
- Unbounded data structures, missing scope cleanup, leaked listeners.
- Overly broad reads — slurping whole files when a slice would do.

## Phase 2 — Fix

Wait for all three subagents to return. Aggregate their findings.
Fix each one directly in the source. False positives or
not-worth-it findings: skip silently — do not argue back, do not
write a justification doc.

Stay scoped to the diff under review. Do **not** rewrite code the
implementation step didn't touch, even if it's smelly — that's a
separate PRD.

## Phase 3 — Gates

After fixes, all three must still pass:

- `pnpm typecheck`
- `pnpm lint` (don't silence rules; fix the code)
- `pnpm test`

If a gate fails, you have one more iteration to fix it.

## Phase 4 — Commit

If you changed anything, make exactly one commit:

```
refactor: simplify and clean up implementation
```

Body is optional. No trailers.

If the review found nothing worth changing, do **not** create an
empty commit. Skip straight to signalling completion.

## Constraints

- Do not modify `$FACTORY_RUN_DIR/`, the source PRD, or the plan.
- Do not push, do not open a PR — that's the `pr` step.
- Do not skip hooks (`--no-verify`); do not disable lint inline.
- One commit total, no matter how many findings you fix.
- Do not amend or rewrite commits made by the implementation step.

## Signaling completion

End your final message with this exact token on its own line:

```
<promise>SIMPLIFIED</promise>
```
