---
name: observability-improvements
description: Follow-up to observability.md addressing gaps surfaced by the first end-to-end Aspire run — sharper traces/logs/metrics for ralph loops with broken tests.
type: plan
status: in-progress
created: 2026-05-09
---

# Observability — improvements after first end-to-end run

Owner: @alex.

Follow-up to [`observability.md`](./observability.md). The base implementation
ships traces, logs, metrics, and tool-call spans; this plan addresses the gaps
surfaced by the first real Aspire run (trace `317444c…`, claude-code `ralph`
loop with a deliberately broken test).

## Findings from trace 317444c

41 spans total, breakdown:

- 1 × `factory.run`
- 1 × `factory.step`
- 1 × `factory.iter`
- 1 × `factory.harness.stream`, 1 × `factory.harness.spawn`
- 7 × `factory.harness.tool` — three red (1 failed `Bash(pnpm test)`,
  2 `Read` cancelled by Claude after the sibling Bash failed)
- 1 × `factory.until.eval` (215ms — `pnpm test` PASS)
- 1 × `factory.step.load`
- **~26 × `sql.execute`** — effect-sql instrumentation on every write to
  `run.db`, the local recording store

Signal-to-noise on the trace is poor (~63% plumbing). Several semantic gaps
also surfaced.

## Improvements

### Phase 1 — make the trace tell the story

These three change the trace from "confusing" to "narrative".

#### 1. Suppress `sql.execute` spans from the recording store

**Symptom**: 26 of 41 spans are SQLite writes from `LiveRunWorkspace`. They
have no observability value (the recording store is internal infra) and they
drown out the 15 spans that do.

**Fix**: wrap each `RunWorkspaceService` method body in
`Effect.withTracerEnabled(false)`. Effect-sql's statement executor uses
`Effect.makeSpanScoped("sql.execute", ...)` (see
`repos/effect/packages/sql/src/internal/statement.ts:151`); disabling the
tracer in the parent scope suppresses the child span without changing
behaviour.

Files: `packages/core/src/services/RunWorkspace.ts`.

Tests: existing `runWorkspace.test.ts` covers behaviour. Add a
`it.scoped` test that asserts no `sql.execute` span shows up in the
captured spans list when `recordRunStart` is invoked.

#### 2. Add `factory.run.id` to the `factory.run` span

**Symptom**: the run span only carries `factory.pipeline`. The factory run id
is on `factory.step` and `factory.iter` but not on the root, so you can't
pivot from "Aspire trace 317444c" to "factory run 58385b1e" without drilling.

**Fix**: pass `runId` as a span attribute on `factory.run`.

Files: `packages/core/src/orchestrator.ts:697`.

#### 3. Distinguish cancelled tools from failed tools

**Symptom**: when Claude fires tools in parallel and one fails, the others
arrive as `tool_result` blocks with `is_error: true` and content
`<tool_use_error>Cancelled: parallel tool call Bash(...) errored`. The
orchestrator ends those spans with `Exit.fail(new Error('tool errored'))`,
making them indistinguishable from a real tool failure in Aspire.

**Fix** (two parts):

1. In the claude-code parser, detect the `<tool_use_error>Cancelled` prefix
   and emit `tool.end` with a new `cancelled: true` flag.
   - Files: `packages/core/src/types.ts` (extend `HarnessEvent.tool.end`),
     `packages/harness-claude-code/src/streamJson.ts` (set the flag).
2. In the orchestrator, branch on the cancelled flag:
   - cancelled → end span with `Exit.void`, attach attribute
     `tool.cancelled = true` and a span event `tool.cancelled` carrying the
     output summary;
   - not-ok and not-cancelled → use `span.recordException` with the
     `outputSummary` so Aspire's exception view picks it up, then end with
     `Exit.fail`.
   - Files: `packages/core/src/orchestrator.ts:243-259`.

Metrics also gain a `cancelled` tag on `factory.tool_calls_total` so the rate
of cancelled-vs-failed is queryable.

Tests: `toolEvents.test.ts`, `streamJson.test.ts`, plus an orchestrator
test covering cancelled and failed paths.

### Phase 2 — fill in semantic gaps

#### 4. Propagate OTLP endpoint to harness subprocesses

`harnessOtelEnv.ts:25` early-returns `{}` unless the parent has
`OTEL_EXPORTER_OTLP_ENDPOINT` set. The `OtelLayer` exporters default to
`localhost:4317` internally without setting the env, so `TRACEPARENT` never
propagates and claude-code's per-tool spans (with
`CLAUDE_CODE_ENABLE_TELEMETRY=1` set) never reach the collector. Setting the
env when `OtelLayer` is active closes the gap.

#### 5. Span events for loop dynamics

Add to `factory.iter`:

- `until.evaluated` (predicate, passed)
- `loop.terminated` (terminator: `until` | `iter` | `error`)
- `tool.cancelled` (one per cancelled tool, deduped by id)

Makes "did the loop run more than once and why" a glance, not an inference.

#### 6. Run-level rollup attributes

Carry totals on `factory.run` so dashboards don't need to traverse children:
`run.tokens.input/output/cache_*`, `run.cost_usd`, `run.tool_calls`,
`run.tool_calls_failed`, `run.tool_calls_cancelled`, `run.terminator`.

Computed once at run-end from the metrics emitted during the run.

### Phase 3 — polish

#### 7. Aspire UI "unhandled error has occurred"

Recurring toast in the dashboard. Suspect: long `tool.output.summary`
attribute (currently capped at 200 chars but UTF-8 byte length isn't
bounded) or oversized stdout content. Investigate with a minimal repro,
tighten the cap if confirmed.

#### 8. Move `factory.step.load` to debug

1.68 ms parsing frontmatter. Sibling-of-`factory.step` placement makes the
trace tree look noisier than it is. Either drop the span or move it under
`factory.step` as a child so it contributes to the step's duration only.

## Out of scope for this round

- Anything that requires changing the OTel SDK choice or the resource model.
- Backend-specific UX (Aspire-only annotations).
- Automated trace-shape regression tests (defer to after Phase 1 lands).

## Done definition for Phase 1

- A fresh `pnpm example` run renders ~15 spans in Aspire (down from 41), with
  the same factory-domain hierarchy.
- `factory.run` span carries `factory.run.id`.
- Tool spans are red only when the tool actually failed; cancelled tools are
  green with a `tool.cancelled` event and `tool.cancelled = true` attribute.
- `factory.tool_calls_total{cancelled=true}` is queryable.
- All existing tests pass; new tests cover the three changes.
