---
name: factory
description: Spec for a TypeScript software-factory framework that orchestrates spec-driven dev pipelines (PRD → slice → ralph → verify → QA → simplify) over any locally-installed coding harness (Claude Code, Codex, Copilot CLI).
type: project
---

# Feature: factory

> Flue-style TypeScript framework that runs a fully-AFK spec-driven-development pipeline on top of whichever coding harness you already have installed.

## Overview

`factory` lets you define multi-step coding pipelines as TypeScript code, where each step is a markdown prompt (Flue-skill style) executed by a coding-harness subprocess (`claude`, `codex`, `copilot`, etc.). The headline workflow is a classical SDD loop — `PRD → vertical slices → ralph loop → verify → QA → simplify` — wrapped so a developer can hand it a markdown PRD and walk away. v0 runs locally; GitHub Actions execution comes later.

## Goals

- Make a full SDD pipeline expressible in a few lines of TypeScript.
- Reuse the harness the user already has installed — no new model SDK, no API keys to wire.
- Keep prompts in markdown so they are editable without touching code.
- Stay harness-agnostic: same pipeline, swap `claude-code` for `codex` per step or factory-wide.
- Give power users full control of failures (events out, no opinionated retry/resume).
- **Observable by default:** OpenTelemetry traces/metrics/logs from v0, vendor-neutral OTLP — debug locally with the Aspire Dashboard, ship to any OTel backend in production.

## Pipeline Domain (the SDD arc)

The reference pipeline `sdd` ships in v0:

1. **plan** — read PRD, produce a list of vertical slices.
2. **ralph** — Geoff-Huntley-style loop: keep iterating on a slice until an exit condition holds (tests green / lint clean / reviewer approves).
3. **verify** — read original PRD + resulting diff, confirm the slice satisfies the spec.
4. **qa** — exploratory checks (typecheck, run tests, optional browser QA).
5. **simplify** — Fowler-style refactor pass to remove smells introduced during ralph.
6. **(out)** — push branch, open PR.

v0 ships single-slice (one PRD → one PR). Parallel fan-out across slices is a v1 concern.

## Architecture

### Step shape — markdown-first

Each step is a `.md` file under `.factory/steps/<name>.md` with frontmatter + prompt body:

```markdown
---
name: ralph
harness: claude-code # optional override
until: tests pass # exit predicate (eval'd by framework)
maxIters: 10
---

Keep iterating on the failing tests until the whole suite is green.
Only edit files under src/. Run `pnpm test` between iterations.
```

TypeScript wires the graph:

```ts
// .factory/factory.ts
import { factory } from 'factory';

export default factory({ name: 'sdd', harness: 'claude-code' })
  .step('plan', './steps/plan.md')
  .step('ralph', './steps/ralph.md', { harness: 'codex' }) // override
  .step('verify', './steps/verify.md')
  .step('qa', './steps/qa.md')
  .step('simplify', './steps/simplify.md');
```

### Harness binding

- Factory-wide default set in `factory({ harness })`.
- Per-step override via the step options object.
- CLI flag (post-MVP): `factory run sdd --harness codex` for run-time overrides.

Harness names map to subprocess adapters — `claude-code` → spawns `claude`, `codex` → spawns `codex`, etc. Adapters are user-extensible; ship the common three out of the box.

### Harness adapter API (subprocess + streaming)

```ts
interface Harness {
  exec(opts: ExecOpts): Promise<ExecResult>;
  stream(opts: ExecOpts): AsyncIterable<HarnessEvent>;
}

type HarnessEvent =
  | { type: 'stdout'; line: string }
  | { type: 'stderr'; line: string }
  | { type: 'tool'; name: string; input?: unknown }
  | { type: 'exit'; code: number };
```

Adapters shell out to the installed binary with a non-interactive flag (`claude -p`, `codex exec`, etc.). Streaming events are best-effort — adapters parse stdout for tool-call markers when the harness emits them, and fall back to raw lines otherwise. Sessions/multi-turn deferred to v1.

### State flow — shared run context

Steps read/write a single `ctx.state` bag. Loose typing in v0; TS users can cast or declare a project-local `State` interface.

```ts
factory({ name: 'sdd', harness: 'claude-code' })
  .step('plan', './steps/plan.md') // writes ctx.state.slices
  .step('ralph', './steps/ralph.md') // reads slices, writes ctx.state.diff
  .step('verify', './steps/verify.md'); // reads ctx.state.prd, ctx.state.diff
```

Big artifacts live in the workspace filesystem (the harness already edits files there); `ctx.state` carries the small structured handles between steps (slice ids, status flags, summaries).

### PRD source (v0)

Local markdown file or inline text:

```bash
factory run sdd --prd ./feature.md
factory run sdd --prd "Add dark mode toggle to settings page."
```

Stdin / GitHub issue / Linear / Jira sources are pluggable v1+.

### Observability — OpenTelemetry first-class

OTel is wired in from v0, not bolted on later. Every factory run emits a trace tree so you can see exactly what each harness did, how long it took, and where a pipeline drifted off the rails.

**Span hierarchy (default instrumentation):**

```
factory.run                        (root span — run id, pipeline name, harness)
├── factory.step  name=plan        (one span per step)
│   └── harness.exec  bin=claude   (subprocess invocation)
│       └── harness.tool  name=Read   (one per tool call, when the harness emits them)
├── factory.step  name=ralph
│   ├── factory.iter  n=1          (ralph loop iterations as siblings)
│   │   └── harness.exec ...
│   └── factory.iter  n=2
└── factory.step  name=verify
```

**Signals:**

- **Traces:** spans as above, with attributes for harness binary, model (when known), exit code, token usage if reported, slice id, and `until` predicate result.
- **Metrics:** `factory.step.duration`, `factory.iter.count` (for ralph), `harness.exec.duration`, `harness.exec.exit_code`.
- **Logs:** structured logs correlated to the active span (each `HarnessEvent` becomes a log record on the `harness.exec` span).

**Configuration — vendor-neutral OTLP:**

```bash
# Defaults to OTLP/gRPC at http://localhost:4317 (Aspire Dashboard's default)
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317 factory run sdd --prd ./x.md

# Or any OTel backend — Honeycomb, Grafana Cloud, Datadog, Tempo, etc.
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io \
OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=$KEY" \
factory run sdd --prd ./x.md
```

**Local debug story (Aspire Dashboard):**

Document a one-liner in the README to run the standalone Aspire Dashboard via Docker — it speaks OTLP, ships an excellent trace UI, and is the recommended local-dev viewer. Aspire is just the default we suggest; nothing in `factory` depends on it.

```bash
docker run --rm -it -p 18888:18888 -p 4317:18889 \
  mcr.microsoft.com/dotnet/aspire-dashboard:latest
# → open http://localhost:18888, run `factory run ...`, watch traces appear live
```

**Disable / opt-out:** `factory run --no-otel` or `OTEL_SDK_DISABLED=true`.

### Failure model — events out, user decides

No built-in retry, no checkpoint/resume in v0. The factory emits lifecycle events; the user wires retry/halt/notify/persist as they need.

```ts
factory.run({
  prd: './feature.md',
  onStep: (ev) => log(ev), // start | end | output
  onError: (ev) => Sentry.captureException(ev.error),
});
```

This is the explicit v0 trade — power-user surface, less hand-holding. Checkpoint/resume is a candidate for v1 once we know which steps are most worth resuming.

## Killer demo (README opener)

```bash
$ factory run sdd --prd ./feature.md
✓ plan:     1 slice identified
✓ ralph:    7 iters, tests green
✓ verify:   matches PRD
✓ qa:       typecheck + tests pass
✓ simplify: 2 smells fixed
→ PR opened: #142
```

Single PRD in, single PR out, walk away. Sells the AFK promise without paying the parallel-fan-out tax.

## Implementation Details

- **Project name:** `factory` (working name; revisit before publishing to npm).
- **Package layout (proposed):**
  - `packages/core` — factory builder, step runner, ctx, event bus.
  - `packages/harness-claude-code`, `packages/harness-codex`, `packages/harness-copilot` — subprocess adapters.
  - `packages/cli` — `factory run`, `factory init`, `factory list`.
  - `packages/steps-sdd` — the reference plan/ralph/verify/qa/simplify markdown bundle.
- **Until-conditions:** `until: tests pass` is a string DSL the framework knows how to evaluate (run `pnpm test`, check exit code). Provide `until: (ctx) => boolean` escape hatch for arbitrary predicates.
- **Workspace:** runs in the user's CWD by default; `--cwd` override. No sandboxing in v0 — harnesses already edit your files, this just orchestrates them.
- **Logging:** stream stdout from each harness invocation prefixed with `[step]`. JSON event log written to `.factory/runs/<id>/events.jsonl` for postmortems even though resume is not supported.
- **OTel SDK:** use `@opentelemetry/sdk-node` with the OTLP/gRPC exporter as default. Auto-init on `factory run` unless disabled. Resource attributes set: `service.name=factory`, `factory.run.id`, `factory.pipeline`, `factory.harness`.

## Scope

### MVP (v0)

- `factory(...).step(...).step(...)` builder + markdown-step loader.
- Subprocess adapters for `claude-code`, `codex`, `copilot` with `exec` + `stream`.
- Reference `sdd` pipeline (plan → ralph → verify → qa → simplify).
- `factory run <name> --prd <file|text>` CLI.
- Event emission (`onStep`, `onError`).
- OpenTelemetry traces + metrics + logs via OTLP, configured by env. Aspire Dashboard documented as the recommended local viewer.
- Local execution only.

### Future (v1+)

- [ ] GitHub Actions native runner (issue-opened → run pipeline → open PR).
- [ ] Parallel fan-out: PRD → N slices → N concurrent pipelines → N PRs.
- [ ] Pluggable PRD sources (Linear, Jira, GitHub issues, stdin).
- [ ] Harness sessions / multi-turn (claude --resume, codex resume).
- [ ] Checkpoint + resume (`factory resume <run-id>`).
- [ ] CLI-level `--harness` override for shootouts.
- [ ] Cloudflare Durable Object runtime (long-running, webhook-triggered factories).
- [ ] Conditional branching + human-in-the-loop gates.

## Open questions

- Naming — is `factory` too generic for npm? Candidates: `forge`, `assembly`.
- Does `until:` deserve a structured DSL or just be a TS predicate from day one?
- How tightly should we lean on Flue itself? `factory` could be a thin layer over `@flue/sdk` (using `init()` + `session.shell()` to spawn harnesses) rather than a separate runtime.

## Status

**Status:** Spec Complete
**Created:** 2026-05-09
**Priority:** TBD
