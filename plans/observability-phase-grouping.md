---
name: observability-phase-grouping
description: Make Aspire/OTel traces readable at a glance — group spans into phases (steps), name them with the step id and iter number, so a fresh reader can tell which ralph loop and which iteration any work belongs to.
type: plan
status: draft
created: 2026-05-10
---

# Observability — phase grouping & self-describing span names

Owner: @alex. Follow-up to
[`observability-trace-narrative.md`](./observability-trace-narrative.md),
based on Aspire trace `6c8941d` (`factory.run`, 11m 4s, 118 spans, depth 4).

## Problem

In Aspire today, the run shows as a flat stripe of identical-looking
rows:

```
factory.step.load        3.74ms
factory.step             1m 13s
factory.step.load        654µs
factory.step             35.22s
factory.step.load        836.4µs
factory.step             8m 49s
factory.step.load        734.3µs
factory.harness.spawn    1.67ms
factory.harness.tool Bash 4.05s
factory.harness.tool Bash 54.2ms
…
```

Two structural defects make this unreadable:

1. **No phase grouping.** `factory.step.load` runs _outside_ the
   `factory.step` span (orchestrator.ts:712 vs orchestrator.ts:665), so
   every step contributes two sibling rows under `factory.run` instead of
   one collapsible "phase" row. Three steps → six top-level rows.
2. **Generic span names.** `factory.step`, `factory.iter`,
   `factory.step.load`, `factory.harness.spawn`,
   `factory.harness.stream`, `factory.until.eval` carry their
   discriminators (`step`, `iter`, `harness`) only in **attributes**.
   Aspire's tree shows the **name**, so plan / branch / 02-ralph all read
   as `factory.step`. The only span that already includes its
   discriminator is `factory.harness.tool Bash` — and it is the only one
   that reads naturally in the tree.

Result: to know which row is which, you must click each span open and
read attributes. With 118 spans and a depth-4 tree, this is unworkable.

## Goals

1. **One collapsible row per step.** Each pipeline step (plan, branch,
   ralph, …) appears as a single `factory.step <stepId>` parent in
   Aspire, containing both its load and its run.
2. **Self-describing names.** Every span's name carries the discriminator
   you'd otherwise have to click open: step id, iter number, harness
   name. A trace tree should be readable without expanding any row.
3. **Stable hierarchy.** The depth and parent–child shape of the tree is
   deterministic across runs of the same pipeline; only the discriminator
   suffix changes.

## Non-goals

- Adding new spans for things that aren't already traced (covered in
  `observability-trace-narrative.md`).
- Changing span attributes — those stay as-is and remain the source of
  truth for filtering / metrics.
- Reworking metric derivation. See _Tradeoff_ below; metrics that key off
  span name are addressed in a separate ticket if at all.

## Target tree

```
factory.run effect-review
├─ factory.step 00-plan
│  ├─ factory.step.load 00-plan
│  └─ factory.step.run 00-plan
│     └─ factory.iter 00-plan#1
│        ├─ factory.harness.spawn claude-code
│        └─ factory.harness.stream claude-code
│           ├─ factory.harness.tool Bash
│           └─ factory.harness.tool Edit
├─ factory.step 01-branch
│  ├─ factory.step.load 01-branch
│  └─ factory.step.run 01-branch
│     └─ factory.iter 01-branch#1
│        └─ …
└─ factory.step 02-ralph
   ├─ factory.step.load 02-ralph
   └─ factory.step.run 02-ralph
      ├─ factory.iter 02-ralph#1
      │  ├─ factory.harness.stream claude-code
      │  └─ factory.until.eval 02-ralph#1
      ├─ factory.iter 02-ralph#2
      └─ factory.iter 02-ralph#3
```

## Items

### P1. Promote `factory.step` to a phase span around the loop body

File: `packages/core/src/orchestrator.ts:705-777`
(`runStepLoop` per-iteration body).

Today the body of `for (const [ord, entry] of steps.entries())` calls
`loader.load(...).pipe(Effect.withSpan('factory.step.load', …))` and
later `runStep(...)`. `runStep` itself wraps in
`Effect.withSpan('factory.step', …)` at line 665, which means
`step.load` is a **sibling** of `step`, not its child.

Fix shape:

- Move the `Effect.withSpan('factory.step', …)` out of `runStep` and
  wrap the entire per-iteration body of `runStepLoop` (load + harness
  resolve + permission/capability check + `runStep`).
- The phase span's attributes are the union of today's two: step id,
  source path, harness name, permission mode, run id.
- Use the step id as the name suffix: `` `factory.step ${stepId}` ``.

Result: one `factory.step <stepId>` row per pipeline step, containing
`factory.step.load <stepId>` and `factory.step.run <stepId>` as
children.

### P2. Rename the inner span `factory.step` → `factory.step.run`

File: `packages/core/src/orchestrator.ts:665`.

After P1, the inner `runStep` span no longer covers loading — it covers
the iter loop and the until-eval. Rename it so its purpose reads off
the name and so it visually pairs with `factory.step.load`.

### P3. Suffix span names with their discriminator

| File / line           | Today                                | After                                         |
| --------------------- | ------------------------------------ | --------------------------------------------- |
| `orchestrator.ts:603` | `factory.iter`                       | `` `factory.iter ${stepId}#${i}` ``           |
| `orchestrator.ts:581` | `factory.until.eval`                 | `` `factory.until.eval ${stepId}#${i}` ``     |
| `orchestrator.ts:711` | `factory.step.load`                  | `` `factory.step.load ${stepId}` ``           |
| `subprocess.ts:105`   | `factory.harness.spawn`              | `` `factory.harness.spawn ${config.name}` ``  |
| `subprocess.ts:144`   | `factory.harness.stream`             | `` `factory.harness.stream ${config.name}` `` |
| `orchestrator.ts:280` | `factory.harness.tool ${event.name}` | unchanged (already conforms)                  |
| `orchestrator.ts:874` | `factory.run`                        | `` `factory.run ${factoryOpts.name}` ``       |

Attributes are unchanged — the discriminator continues to live there too,
so anything currently filtering on `factory.step` / `factory.iter` /
`factory.harness` keeps working.

### P4. Span tests

File: `packages/core/src/observability.test.ts` (or new
`spanTree.test.ts` if the file is full).

- Assert the parent–child shape of a small pipeline run: `factory.run`
  has N `factory.step <id>` children, each with exactly two children
  (`factory.step.load <id>`, `factory.step.run <id>`).
- Assert names embed the step id / iter index for one ralph step with
  three iters.

Use `@effect/vitest` + the in-memory tracer fixture already in
`testing/`. Don't introduce new test infra.

## Tradeoff

Embedding discriminators in span **names** raises name cardinality. This
matters for two cases:

- **Span-name-keyed RED metrics** (e.g., latency histograms grouped by
  `span.name`). Step ids are bounded (a pipeline has a handful), iter
  numbers grow with `maxIters` (~20 for ralph). For our scale this is
  fine; for backends that auto-derive metrics from span names (Honeycomb
  BubbleUp, some Datadog views) we can collapse on the
  `factory.step` / `factory.iter` attributes instead — those stay
  low-cardinality.
- **Span-name search.** A literal search for `factory.iter` still
  matches via prefix in Aspire; exact-match queries need to use the
  attribute. Acceptable.

`observability-trace-narrative.md` already flags name-suffix cardinality
("every iteration is its own series for span-name-keyed metrics"). This
plan accepts that cost as a deliberate trade for tree readability.

## Acceptance

- A factory run with three steps (one with three iters) renders in
  Aspire as exactly three top-level `factory.step <id>` rows under
  `factory.run`, each collapsible.
- Reading the trace tree top-to-bottom without expanding attributes
  tells you: pipeline name, every step id, every iter number, every
  harness name, every tool name.
- `pnpm check` passes; existing observability tests still pass; new
  span-tree tests added in P4 pass.

## Out of scope (next plan)

- Renaming `factory.harness.stream` to something domain-meaningful
  (covered in `observability-trace-narrative.md`).
- Adding cost / token / `gen_ai.*` attributes (covered in
  `observability-trace-narrative.md`).
- Replacing custom `factory.iter.tokens.*` keys with OTel GenAI
  semantic conventions (covered in `observability-trace-narrative.md`).
