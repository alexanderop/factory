# Observability — logs, traces, metrics, tool calls

Status: draft. Owner: @alex.

## Goal

Make every interesting thing that happens during a `factory run` visible
without scraping `.factory/runs/<runId>/`. Specifically:

1. A trace per run that nests every step, every iter, every harness spawn,
   and every tool call the coding agent made (Bash, Read, Edit, ...).
2. Logs auto-correlated to the active span.
3. Metrics for cost, tokens, tool calls, errors by `_tag`, durations.
4. Test ergonomics: assert on spans/metrics in `it.effect` without a real
   collector.

## Non-goals

- Replacing on-disk artifacts. Trace = summary, disk = archive. We do not
  ship full stdout to OTLP.
- Backend choice. The OTLP exporter is already pointed at Aspire; this spec
  is exporter-agnostic.
- Realtime dashboards / UI changes. Out of scope.

## Current state

What exists:

- `OtelLayer` in `packages/core/src/otel.ts` — OTLP gRPC tracer only.
- Spans: `factory.run`, `factory.step` in `orchestrator.ts`.
- `FactoryEvent` union + `EventEmitter` service + SQLite `event` table.
- `HarnessEvent` union with an unused `{ type: 'tool'; name; input? }` variant.
- `HarnessCapabilities.factory.toolEvents: boolean` — `true` for claude-code,
  `false` for codex/copilot. Already declares intent.
- `RunWorkspace` writes `stdout.log`, `stderr.log`, `prompt.md` per iter.

What's missing:

- No metrics anywhere.
- No structured logs (a couple of `logDebug`; otherwise `console.log`).
- No spans below `factory.step` — iter, harness spawn/stream, until-eval,
  step load are opaque.
- No parsing of harness output. Claude Code is invoked with plain text mode
  even though `--output-format stream-json` would give us NDJSON tool events.
- No log/trace correlation (no OTel logger plugged into `Logger`).
- No OTel context propagation into the subprocess.

## Design

### 1. Layer wiring: replace `OtelLayer` with `NodeSdk.layer`

`NodeSdk.layer` from `@effect/opentelemetry` composes tracer + meter + logger
providers from a single resource. Switch to it so logs and metrics ride along.

```ts
// packages/core/src/otel.ts
export const OtelLayer = NodeSdk.layer(() => ({
  resource: { serviceName: 'factory', serviceVersion: VERSION },
  spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter({ url: OTEL_TRACES_URL })),
  logRecordProcessor: new BatchLogRecordProcessor(new OTLPLogExporter({ url: OTEL_LOGS_URL })),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: OTEL_METRICS_URL }),
    exportIntervalMillis: 10_000,
  }),
}));

// And install the OTel-aware logger so Effect.log* lands in OTel logs
// with traceId/spanId stamped automatically.
export const OtelLoggerLayer = Logger.replaceScoped(Logger.defaultLogger, OtelLogger.make);
```

`NoOtelLayer` stays available for `--no-otel` / `OTEL_SDK_DISABLED=true`.

### 2. Span tree

```
factory.run                            attrs: runId, pipeline, cwd, prdSource
└─ factory.step                        attrs: stepId, ord, harness, maxIters, until
   ├─ factory.step.load                attrs: stepPath
   ├─ factory.iter                     attrs: iter, kind=internal
   │  ├─ factory.harness.spawn         kind=producer; attrs: bin, argsHash, cwd, permissionMode
   │  ├─ factory.harness.stream        kind=consumer
   │  │  ├─ factory.harness.tool       attrs: tool.name, tool.id, tool.input.summary
   │  │  ├─ factory.harness.tool       …
   │  │  └─ events: assistant.message, stdout.line (text harnesses), exit
   │  └─ factory.until.eval            attrs: predicate, result
```

Span events (not child spans) for: stdout/stderr lines (truncated to 256 ch),
`assistant.message` text, partial tool-result chunks. Cardinality stays bounded.

### 3. Tool-call capture

Two strategies, run together. Strategy A is the source of truth; B adds depth.

#### Strategy A — parse harness structured output

Per-harness output adapter that parses NDJSON/text into a richer
`HarnessEvent` stream. Wire it into `subprocess.ts` after `Stream.splitLines`.

Extend `HarnessEvent`:

```ts
export type HarnessEvent =
  | { readonly type: 'stdout'; readonly line: string }
  | { readonly type: 'stderr'; readonly line: string }
  | { readonly type: 'exit'; readonly code: number }
  // new:
  | {
      readonly type: 'tool.start';
      readonly id: string; // toolu_… from Claude
      readonly name: string; // 'Bash' | 'Read' | 'Edit' | …
      readonly input: unknown; // raw block, redaction at sink
    }
  | {
      readonly type: 'tool.end';
      readonly id: string;
      readonly ok: boolean;
      readonly output: unknown;
      readonly durationMs?: number;
    }
  | {
      readonly type: 'assistant.message';
      readonly text: string;
      readonly thinking?: string; // when stream-json --include-partial-messages
    }
  | {
      readonly type: 'result';
      readonly ok: boolean;
      readonly costUsd?: number;
      readonly tokens?: { input: number; output: number; cacheRead?: number; cacheCreate?: number };
      readonly model?: string;
      readonly durationMs: number;
    };
```

Claude Code adapter (first; the only harness with `toolEvents: true`):

- Switch `claudeBuildArgs` to add `--output-format stream-json --verbose`.
- Parse each NDJSON line:
  - `system` → log + annotate iter span (`session.id`, `cwd`, `tools`).
  - `assistant` content blocks:
    - `text` → `assistant.message`
    - `thinking` → annotate (or drop, configurable)
    - `tool_use` → `tool.start { id, name, input }`
  - `user` content blocks:
    - `tool_result` → `tool.end { id, ok = !is_error, output }`
  - `result` → `result { ok, costUsd, tokens, durationMs, model }`
- Malformed lines: emit `stderr` event with `parse_error: true` attribute, do
  not crash.

Codex / Copilot adapter (later): keep emitting raw `stdout`/`stderr` events
until those CLIs expose a structured stream we can rely on. `toolEvents: false`
already signals this.

The orchestrator's stream consumer (today: append-to-disk + display) gets
extended:

```ts
Stream.tap((event) =>
  Match.type<HarnessEvent>().pipe(
    Match.tag('tool.start', (e) =>
      Effect.gen(function* () {
        const span = yield* Effect.makeSpanScoped(`factory.harness.tool`, {
          attributes: {
            'tool.name': e.name,
            'tool.id': e.id,
            'tool.input.summary': summarize(e.input),
            'tool.input.bytes': sizeOf(e.input),
          },
        });
        // park span in a Ref keyed by tool id so tool.end can close it
      }),
    ),
    Match.tag('tool.end', (e) => /* close span, set status, record metrics */),
    Match.tag('result', (e) => /* annotate iter span with cost, tokens */),
    Match.orElse(() => Effect.void),
  )(event),
);
```

A `Ref<HashMap<string, Span>>` per iter holds open tool spans; `tool.end`
ends them. Unmatched `tool.end` (no prior `tool.start`) → log warning, drop.
On iter exit, force-end any leftover spans with status `unset` + warning.

#### Strategy B — propagate OTel into the subprocess

For harnesses that ship their own OTel (Claude Code's
`CLAUDE_CODE_ENABLE_TELEMETRY=1`), inject env so their spans nest under ours:

```ts
// when spawning the harness:
env: {
  ...process.env,
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  OTEL_SERVICE_NAME: harness.name,
  OTEL_RESOURCE_ATTRIBUTES: `factory.run.id=${runId},factory.step=${stepId},factory.iter=${iter}`,
  // W3C traceparent so the child roots under our iter span
  TRACEPARENT: `00-${iterSpan.traceId}-${iterSpan.spanId}-01`,
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
},
```

This is opt-in (`--harness-otel-passthrough`, default on for capable
harnesses) and additive: even if the harness emits nothing, we still have
Strategy A.

### 4. Metrics

Define in `packages/core/src/metrics.ts`. All counters/histograms; no gauges
unless we add a long-running daemon.

| Metric                             | Type      | Tags                                                              |
| ---------------------------------- | --------- | ----------------------------------------------------------------- |
| `factory.runs_total`               | counter   | `pipeline`, `outcome`                                             |
| `factory.run_duration_ms`          | histogram | `pipeline`, `outcome`                                             |
| `factory.steps_total`              | counter   | `pipeline`, `step`, `harness`, `outcome`                          |
| `factory.step_duration_ms`         | histogram | `pipeline`, `step`, `harness`, `outcome`                          |
| `factory.iters_total`              | counter   | `harness`, `terminated_by` (until/maxIters/error/idle)            |
| `factory.iter_duration_ms`         | histogram | `harness`, `terminated_by`                                        |
| `factory.harness_spawns_total`     | counter   | `harness`, `outcome`                                              |
| `factory.idle_timeouts_total`      | counter   | `harness`                                                         |
| `factory.errors_total`             | counter   | `_tag`                                                            |
| `factory.tool_calls_total`         | counter   | `harness`, `tool`, `ok`                                           |
| `factory.tool_call_duration_ms`    | histogram | `harness`, `tool`                                                 |
| `factory.tokens_total`             | counter   | `harness`, `model`, `kind` (input/output/cache_read/cache_create) |
| `factory.cost_usd`                 | counter   | `harness`, `model`                                                |
| `factory.assistant_messages_total` | counter   | `harness`                                                         |
| `factory.subprocess_output_bytes`  | histogram | `harness`, `stream` (stdout/stderr)                               |

Increment at the existing emit points. `tokens_total` and `cost_usd` come
from the `result` event in stream-json — pure win once Strategy A lands.

### 5. Logs

After the `OtelLogger` is installed, every `Effect.log{Debug,Info,Warning,Error}`
inside a span gets `traceId` + `spanId` stamped on the log record by Effect's
OTel logger (see `repos/effect/packages/opentelemetry/src/Logger.ts`).

What to log (sparingly; the trace is the primary surface):

- `logInfo` at run start/end, step start/end (already implicit via spans, but
  useful for log-only consumers).
- `logWarning` on idle timeout, parser errors in stream-json, leftover tool
  spans at iter exit, missing `tool_result` for a `tool_use`.
- `logError` on every `FactoryError._tag` at the orchestrator boundary.
- `logDebug` on per-line stdout/stderr only when `FACTORY_LOG_LINES=true`.
  Default off. Lines live on disk.

### 6. Errors

Add a helper in `packages/core/src/observability.ts`:

```ts
export const recordTaggedError = <R, A, E extends { _tag: string }>(
  eff: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  eff.pipe(
    Effect.tapError((e) =>
      Effect.all(
        [
          Effect.annotateCurrentSpan({
            'factory.error._tag': e._tag,
            'factory.error.message': 'message' in e ? String(e.message) : undefined,
          }),
          Metric.increment(errorsTotal.pipe(Metric.tagged('tag', e._tag))),
          Effect.logError(`factory error`, e),
        ],
        { discard: true },
      ),
    ),
  );
```

Wrap the orchestrator's per-step boundary with it. Every `FactoryError._tag`
becomes a span attribute, a counter increment, and a correlated log entry —
without per-callsite work.

### 7. Privacy & redaction

Tool inputs (file paths, prompts) and outputs (file contents, command output)
can be huge and sensitive. Defaults:

- `tool.input.summary`: first 200 chars of `JSON.stringify(input)`,
  ellipsized.
- `tool.input.bytes`: full size for sanity.
- For known tool shapes, prefer structural attrs over raw input:
  `Bash` → `tool.cmd.head` (first 200 chars of `command`)
  `Read` → `tool.file_path`
  `Edit`/`Write` → `tool.file_path`, `tool.diff.bytes`
  `Grep`/`Glob` → `tool.pattern`
- Tool output: never on the span by default. `tool.output.bytes` only.
- Full inputs/outputs land on disk in a new `tool-events.jsonl` per iter
  (see §8) so we can replay without leaking to OTLP.
- `--otel-include-tool-content` flag flips the truncation off for debugging.
- Hard cap: per-span attribute string ≤ 1 KiB. Reject larger.

### 8. Persistence: `tool-events.jsonl`

Per iter, write a new file alongside `stdout.log` / `stderr.log`:

```
.factory/runs/<runId>/steps/<ord>-<stepId>/iters/<n>/tool-events.jsonl
```

One line per parsed `HarnessEvent` of type `tool.start | tool.end |
assistant.message | result`. This is the durable record for replay,
debugging, and offline analysis. The SQLite `event` table can also store a
new `FactoryEvent` variant `{ type: 'tool', runId, step, iter, tool, ... }`
for indexed querying.

### 9. Test infrastructure

- Add `packages/core/src/testing/OtelTest.ts` exposing `OtelTest.layer({})`
  that wires `InMemorySpanExporter` + `InMemoryMetricExporter` and exposes
  `getFinishedSpans()`, `getMetrics()` for assertions.
- Extend `scriptedHarness` with a `toolScript` form so tests can simulate a
  run that emits `tool.start`/`tool.end`/`result`:
  ```ts
  scriptedHarness({
    capabilities: { factory: { toolEvents: true } },
    script: [
      { type: 'tool.start', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool.end', id: 't1', ok: true, output: 'a\nb\n' },
      { type: 'assistant.message', text: 'done' },
      { type: 'result', ok: true, durationMs: 12, tokens: { input: 100, output: 20 } },
      { type: 'exit', code: 0 },
    ],
  });
  ```
- Tests assert on span tree shape (parent/child, names, attrs) and metric
  values. No real exporter, no flakes.

## Implementation phases

Each phase is independently shippable. Don't bundle.

### Phase 1 — Layer + low-level spans (no behavior change)

- Switch `otel.ts` to `NodeSdk.layer` (tracer + logger + meter).
- Install `OtelLogger` so `Effect.log*` flows to OTLP.
- Add spans: `factory.iter`, `factory.harness.spawn`, `factory.harness.stream`,
  `factory.step.load`, `factory.until.eval`. Each is 5–10 lines in existing
  files.
- Add `recordTaggedError` helper at orchestrator boundary.
- `OtelTest` layer + a regression test asserting the span tree for a trivial
  scripted run.

Acceptance: running a pipeline shows the full span tree in Aspire; no
metrics yet; logs correlate to spans.

### Phase 2 — Tool-call parsing for Claude Code

- Extend `HarnessEvent` union (see §3).
- Add `packages/core/src/harnessAdapters/claudeStreamJson.ts` — pure
  function `(line: string) => HarnessEvent | null`. Tested with golden
  fixtures captured from a real run.
- Add a stream operator that wraps `lineEvents` based on the harness's
  `capabilities.factory.toolEvents`. When true and the harness opts in
  (claude-code), pipe stdout lines through the parser.
- Modify `claudeBuildArgs` to add `--output-format stream-json --verbose`.
- In orchestrator's `streamHarnessIter`: open `factory.harness.tool` spans
  on `tool.start`, close on `tool.end`. Annotate iter span with `result`.
- Add `tool-events.jsonl` writer in `RunWorkspace`.
- Add new `FactoryEvent` variants and a new SQLite column or JSON payload
  index for querying.

Acceptance: a Claude Code run produces a span per Bash/Read/Edit; cost and
tokens annotate the iter span; `tool-events.jsonl` is on disk; SQLite has
the events.

### Phase 3 — Metrics

- Define all metrics in `packages/core/src/metrics.ts`.
- Increment at the right places (per the table in §4). Most are one-liners.
- `Effect.tagMetrics` at run/step boundaries so all child increments inherit
  `pipeline` / `harness` / `step` tags.
- Test: `OtelTest.getMetrics()` snapshot for a known scripted run.

Acceptance: Aspire's metrics view shows non-zero counters; cost & tokens are
queryable; error rate by `_tag` is queryable.

### Phase 4 — Subprocess OTel passthrough

- Inject env (§3, Strategy B) into `Command.start` for harnesses that opt in.
- Compute `traceparent` from the active iter span via Effect's tracer.
- `--harness-otel-passthrough` CLI flag; default on when `OTEL_SDK_DISABLED`
  is unset.

Acceptance: Claude Code's own internal spans appear under our `factory.iter`
in Aspire when `CLAUDE_CODE_ENABLE_TELEMETRY=1`.

### Phase 5 — Codex / Copilot tool events

- Investigate Codex's structured output options. Codex CLI has `--json` in
  recent versions; check what it emits.
- Write adapter, flip `toolEvents: true`.
- Same shape; reuse the same downstream.

## Open questions

- **Span span-events vs child spans for stdout lines**: events are cheaper,
  but Aspire's UI shows child spans more prominently. Default to events,
  promote a span only for `tool_use`.
- **Cost attribution when token usage is cumulative**: stream-json's `result`
  is final; partial deltas don't exist. We attribute the whole iter's cost
  to the `result` event time. Fine for now.
- **Truncation policy**: 200 chars / 1 KiB are guesses. Revisit after a
  week of real data.
- **Structured logs vs span events for `assistant.message`**: pick one; not
  both (duplication). Lean toward span events, since the message belongs to
  a tool-call thread.
- **Where to define the `OTEL_*_URL` env vars**: today `OtelLayer` hardcodes
  `localhost:4317`. Spec a single env var (`OTEL_EXPORTER_OTLP_ENDPOINT`)
  with sensible defaults — match the OTel SDK convention so the same value
  works for the subprocess passthrough.
- **MCP servers as tool sources**: Claude Code can call MCP tools. The
  stream-json `tool_use.name` is the MCP tool name, prefixed. Treat it the
  same; tag `tool.transport=mcp` if name has a `mcp__` prefix.
