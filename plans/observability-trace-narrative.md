---
name: observability-trace-narrative
description: Follow-up to observability-improvements based on the second end-to-end Aspire run — make the trace narrate itself so a fresh reader can reconstruct what happened from spans alone.
type: plan
status: draft
created: 2026-05-09
---

# Observability — make the trace narrate itself

Owner: @alex. Follow-up to
[`observability-improvements.md`](./observability-improvements.md), based on
the second end-to-end Aspire run (trace
`d342ca79b464bdf5dbebc979823801db`, `factory.run sdd`, 14m 1s, 94 spans,
depth 5).

`observability-improvements.md` already addresses the noisiest issues from
the first trace: SQL-span suppression, `run.id` on root, cancelled-vs-failed
distinction, OTLP env propagation to subprocesses, span events for loop
dynamics, run-level rollups, and the `factory.step.load` placement. Treat
those as still-pending; this plan does not duplicate them.

What trace `d342ca7` makes obvious that the previous plan does not:

- The `factory.harness.stream` span owns the wall-clock (42.43 s of a
  42.44 s plan iter, 10m 43s of the ralph step) but carries only six
  attributes — none of them answer "why was it slow" or "why did it stop".
- Cost/tokens use private keys (`factory.iter.tokens.*`,
  `factory.iter.cost_usd`). Aspire renders them generically; GenAI-aware
  backends (Phoenix, Langfuse, Honeycomb) do not.
- Tool spans answer "what tool ran" but not "what did it do": Bash has no
  `exit_code` or `stderr.bytes`; Read/Write have no file size or lines
  changed.
- Span names embed `#1`, `#2` (`factory.iter plan#1`,
  `factory.until.eval plan#1`), so every iteration is its own series for
  span-name-keyed metrics and the timeline reads as noise.
- A failed tool sets the tool span Status to error, but iter / step / run
  Status stay Ok unless the whole pipeline throws. "Show me runs where any
  tool failed" needs an attribute query, not a Status filter.
- `factory.permission.mode` only sits on `harness.stream`. There is no way
  to filter at the run or step level.

## Phase A — fill the gap on `factory.harness.stream`

This is the single biggest comprehension win. The span that owns the time
should carry the metadata that explains the time.

### A1. Enrich the stream span as the harness runs

While iterating over `harness.stream(...)` in `orchestrator.ts:191`,
accumulate counters and annotate the _iter_ span (the parent of
`harness.stream` is the iter; we already annotate it with the `result`
event payload at `:292`). Move from "annotate once at result" to
"annotate progressively":

- `factory.iter.assistant.message.count` — increment on `assistant.message`.
- `factory.iter.tool.calls` — increment on `tool.start`.
- `factory.iter.tool.calls_failed` — increment on `tool.end` with `ok=false`
  and not cancelled.
- `factory.iter.tool.calls_cancelled` — increment on the new cancelled flag
  from `observability-improvements.md` Phase 1 #3.
- `factory.iter.bytes.stdout`, `factory.iter.bytes.stderr` — accumulate from
  `stdout`/`stderr` events.
- `factory.iter.exit.reason` — set once when the stream ends:
  `assistant_end` | `idle_timeout` | `error` | `subprocess_exit_nonzero`.

Files: `packages/core/src/orchestrator.ts:191-336`.

Tests: extend `toolEvents.test.ts` with an iter that exits via each reason
and asserts the span attribute set.

### A2. Carry harness identity + permission mode up the tree

`factory.harness` and `factory.permission.mode` live only on
`harness.stream` today (`orchestrator.ts:191` block). Lift both to:

- the `factory.iter` span (so iter rollups can be sliced by harness/mode),
- the `factory.step` span (for step-level dashboards),
- the `factory.run` span (set once at run start, makes "all skip-permission
  runs" filterable from the trace list).

Files: `packages/core/src/orchestrator.ts:484` (iter span attrs),
`:560` (step span attrs), `:765` (run span attrs).

## Phase B — adopt GenAI semantic conventions

OpenTelemetry's GenAI conventions (stable enough for Phoenix, Langfuse,
Honeycomb to auto-render) overlap directly with what we already record on
the iter span. Mirror them; do not replace the `factory.iter.*` keys (they
are queryable and the migration cost is real).

At `orchestrator.ts:292`, additionally set:

- `gen_ai.system = "claude-code"` (or harness name).
- `gen_ai.request.model = event.model`.
- `gen_ai.usage.input_tokens = event.tokens.input`.
- `gen_ai.usage.output_tokens = event.tokens.output`.
- `gen_ai.usage.cache_read_input_tokens = event.tokens.cacheRead`.
- `gen_ai.usage.cache_creation_input_tokens = event.tokens.cacheCreate`.
- `gen_ai.response.finish_reasons = [event.ok ? "stop" : "error"]`.

Same names on `factory.run` rollups in
`observability-improvements.md` Phase 2 #6: emit both
`run.tokens.input` and `gen_ai.usage.input_tokens` totals.

Files: `packages/core/src/orchestrator.ts:292`,
`packages/core/src/services/runManifest.ts` if rollups land there.

Tests: assert both the legacy and GenAI keys are present in
`observability.test.ts`.

## Phase C — make tool spans answer "what happened"

`toolInputAttributes` in `observability.ts:65` only captures inputs.
Add an output-shaping equivalent:

```ts
toolOutputAttributes(tool: string, output: unknown, ok: boolean):
  Readonly<Record<string, string | number | boolean>>
```

Per-tool extras (called from `orchestrator.ts:252` in the `tool.end`
branch, alongside the existing `tool.output.summary` / `tool.output.bytes`):

- **Bash** — `tool.exit_code`, `tool.stderr.bytes`, `tool.stdout.bytes`,
  `tool.timed_out`. Source these from the harness `tool_result` payload
  shape (claude-code emits stderr separately).
- **Read** — `tool.file.bytes`, `tool.file.lines`.
- **Write** / **Edit** / **NotebookEdit** — `tool.file.bytes_before`,
  `tool.file.bytes_after`, `tool.lines_added`, `tool.lines_removed`.
- **Glob** / **Grep** — `tool.matches.count`.

Where the harness payload doesn't expose a field, omit the attribute (do
not store `0` — it implies the tool ran and produced nothing).

Files: `packages/core/src/observability.ts`,
`packages/core/src/orchestrator.ts:252-289`.

Tests: extend `toolEvents.test.ts` with one fixture per tool family.

## Phase D — stable span names

Embedding `#n` in the name (`factory.iter plan#1`,
`factory.until.eval plan#1`) breaks aggregation — every iteration is a new
series. Move the dynamic parts out of the name and keep them as already-set
attributes (`factory.step`, `factory.iter` are present; just stop putting
them in the name).

Rename:

- `factory.iter ${stepId}#${i}` → `factory.iter`.
- `factory.until.eval ${stepId}#${i}` → `factory.until.eval`.
- `factory.harness.stream claude-code` → `factory.harness.stream`
  (harness already in `factory.harness` attribute).
- `factory.harness.tool ${event.name}` → keep as-is. Tool name is bounded
  and useful as the visible name in the timeline.
- `factory.step ${stepId}` → `factory.step`. Step id stays as
  `factory.step` attribute.
- `factory.run ${name}` → `factory.run`. Pipeline already on
  `factory.pipeline`.

Files: `orchestrator.ts:484`, `:501`, `:560`, `:605`, `:765`, `:930`,
plus any matching `Effect.makeSpan` calls.

Tests: `observability.test.ts` snapshots — update once. New assertion:
top-level span name is exactly `factory.run`, with `factory.pipeline`
attribute set.

This is a breaking change for anyone with saved Aspire/Tempo queries
keyed on the old names. Land it with a CHANGELOG entry and a one-shot
note in the run's stdout banner.

## Phase E — propagate Status up the tree

Today: `tool.end` with `ok=false` ends the tool span as `Exit.fail`
(`orchestrator.ts:267`), but iter, step, and run spans only fail if the
whole effect throws. Expected behaviour:

- iter span: Status=Error if any non-cancelled tool inside it failed,
  `factory.iter.ok=false` already covers this — propagate it as Status too
  via `Effect.failCause`-shaped wrap, or directly set the span status when
  annotating the result event.
- step span: Status=Error if any iter ended Status=Error.
- run span: Status=Error if any step ended Status=Error.

Implementation note: Effect's `withSpan` derives Status from the wrapped
effect's exit. The cleanest path is for the orchestrator to fail-then-
catch at the iter boundary when `event.ok === false` and we want to
continue iterating (current ralph behaviour). At step / run boundaries,
the existing `tapError` paths already set Status=Error correctly.

Files: `orchestrator.ts:291` (where `iter.ok=false` is observed),
`:540s` (step end), `:760s` (run end).

Tests: `observability.test.ts` assert span Status across a fixture run
that has one failing tool inside one of two iters.

## Phase F — span events for the long stream

`observability-improvements.md` Phase 2 #5 already lists `until.evaluated`,
`loop.terminated`, `tool.cancelled`. Extend the list now that we know the
stream span is the natural anchor for the per-message narrative:

On the _iter_ span, add events:

- `assistant.message` (one per message; attribute `bytes`).
- `tool.start` / `tool.end` (id, name, `ok` on end).
- `idle.warning` (when an idle-timeout watchdog fires before timing out).

Span events are timestamped — the timeline view becomes a readable story
without needing to jump to structured logs.

Files: same `orchestrator.ts:191-336` block, alongside the metric updates.

Tests: extend `toolEvents.test.ts`; assert events on the captured iter
span via `@effect/vitest`'s span helpers.

## Done definition

- A fresh `pnpm example` run on the `sdd` pipeline shows:
  - `factory.harness.stream` carries harness, model, exit reason, message
    counts, tool counts, byte counts (Phase A).
  - `factory.iter` and `factory.run` carry both `factory.iter.tokens.*`
    and `gen_ai.usage.*` (Phase B).
  - Bash spans carry `tool.exit_code` and `tool.stderr.bytes` (Phase C).
  - Span names contain no iteration indices or step ids (Phase D).
  - Iter, step, run Status propagates from failed tools (Phase E).
  - Iter span events list per-message and per-tool entries (Phase F).
- `observability.test.ts` covers each of the six phases.
- No new GenAI keys leak into metrics labels (cardinality check). Token
  values stay in span attributes; metric tags remain `kind` + `model`.

## Out of scope

- Reworking the metric set (already shipped).
- Backend-specific UI (Aspire-only renderers).
- Aspire `unhandled error` toast — tracked in
  `observability-improvements.md` Phase 3 #7.
