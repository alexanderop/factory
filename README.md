# factory

> **Experimental** — early scaffold. Nothing is implemented yet; see `docs/feature-specs/factory.md`.

`factory` is a TypeScript framework for building **software factories** — multi-step coding pipelines that run fully AFK on top of whichever coding harness you already have installed (`claude`, `codex`, `copilot`, ...).

The headline pipeline is the classical spec-driven-development arc:

```
PRD → plan (slices) → ralph loop → verify → QA → simplify → PR
```

Each step is a markdown prompt (Flue-skill style), wired together in TypeScript. Harnesses are invoked as subprocesses, so you reuse the binary you already have on your `$PATH` — no new model SDK, no new API keys.

## Demo (target API)

```bash
factory run sdd --prd ./feature.md
```

```
✓ plan:     1 slice identified
✓ ralph:    7 iters, tests green
✓ verify:   matches PRD
✓ qa:       typecheck + tests pass
✓ simplify: 2 smells fixed
→ PR opened: #142
```

## Pipeline walkthrough

A concrete run of the dogfood pipeline (`plan → branch → ralph → pr`)
on a PRD that splits into three tickets:

```
┌─────────────────────────────────────────────────────────────────────┐
│ INPUT                                                               │
│   $ pnpm dogfood plans/observability-trace-narrative.md             │
│                                                                     │
│   plans/observability-trace-narrative.md   ← committed PRD on main  │
│   git: on main, clean tree                                          │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
        ┌─────────────────────────────────────────────────────┐
        │ factoryDef.run({ prd, cwd })                        │
        │   creates .factory/runs/<id>/                       │
        │   copies PRD → .factory/runs/<id>/prd.md            │
        │   sets FACTORY_RUN_DIR=.factory/runs/<id>           │
        └─────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│ STEP 1 — plan                              maxIters: 1             │
├────────────────────────────────────────────────────────────────────┤
│ reads:   $FACTORY_RUN_DIR/prd.md                                   │
│ writes:  $FACTORY_RUN_DIR/plan.md                                  │
│                                                                    │
│   ─────────────────────────────────────────────────                │
│   ---                                                              │
│   branch: refactor/observability-trace-narrative                   │
│   title:  improve trace narrative readability                      │
│   ---                                                              │
│   ## Approach … (2–6 sentences)                                    │
│   ## Tickets                                                       │
│     T1 — rename span attributes      [files, tests-first, done]    │
│     T2 — group steps by phase        [files, tests-first, done]    │
│     T3 — add narrative summaries     [files, tests-first, done]    │
│   ## Done when (overall) …                                         │
│   ─────────────────────────────────────────────────                │
│                                                                    │
│ git:     main, untouched (plan is run-artifact, not committed)     │
│ emits:   <promise>PLANNED</promise>                                │
└────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│ STEP 2 — branch                            maxIters: 1             │
├────────────────────────────────────────────────────────────────────┤
│ reads:   $FACTORY_RUN_DIR/plan.md → branch: …                      │
│ runs:    git status --porcelain     (must be clean)                │
│          git checkout main                                         │
│          git checkout -b refactor/observability-trace-narrative    │
│                                                                    │
│ git:     ─o─o─o  main                                              │
│              ╲                                                     │
│               * refactor/observability-trace-narrative (HEAD)      │
│                                                                    │
│ emits:   <promise>BRANCHED</promise>                               │
└────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│ STEP 3 — ralph                             maxIters: 12            │
│  (orchestrator re-runs the prompt until COMPLETE; one ticket/iter) │
├────────────────────────────────────────────────────────────────────┤
│  ┌─ iter 1 ────────────────────────────────────────────────┐       │
│  │ git log main..HEAD --oneline → (empty)                  │       │
│  │ next undone = T1                                        │       │
│  │   red:      write failing tests                         │       │
│  │   green:    implement T1                                │       │
│  │   refactor: tidy, re-run tests                          │       │
│  │   gates:    pnpm typecheck/lint/test  ← all green       │       │
│  │   commit:   refactor: rename span attributes            │       │
│  └─────────────────────────────────────────────────────────┘       │
│  ┌─ iter 2 ────────────────────────────────────────────────┐       │
│  │ git log main..HEAD → contains T1's subject              │       │
│  │ next undone = T2                                        │       │
│  │   red → green → refactor → gates → commit               │       │
│  └─────────────────────────────────────────────────────────┘       │
│  ┌─ iter 3 ────────────────────────────────────────────────┐       │
│  │ next undone = T3                                        │       │
│  │   red → green → refactor → gates → commit               │       │
│  └─────────────────────────────────────────────────────────┘       │
│  ┌─ iter 4 ────────────────────────────────────────────────┐       │
│  │ all tickets present in git log + gates green            │       │
│  │   emits <promise>COMPLETE</promise>                     │       │
│  └─────────────────────────────────────────────────────────┘       │
│                                                                    │
│ git:     ─o─o─o  main                                              │
│              ╲                                                     │
│               *──*──*  refactor/… (HEAD)                           │
│              T1  T2  T3                                            │
└────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│ STEP 4 — pr                                maxIters: 1             │
├────────────────────────────────────────────────────────────────────┤
│ reads:   $FACTORY_RUN_DIR/plan.md (title, approach, tickets)       │
│          git log main..HEAD --oneline                              │
│ runs:    git push -u origin refactor/observability-trace-narrative │
│          gh pr create --title "<plan.title>" --body <<EOF          │
│            ## Summary  (from plan.approach)                        │
│            ## Tickets                                              │
│              - [x] T1 — rename span attributes                     │
│              - [x] T2 — group steps by phase                       │
│              - [x] T3 — add narrative summaries                    │
│            ## Test plan                                            │
│              - [x] pnpm typecheck                                  │
│              - [x] pnpm lint                                       │
│              - [x] pnpm test                                       │
│          EOF                                                       │
│                                                                    │
│ emits:   <promise>PR-OPENED</promise>  + PR URL printed            │
└────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│ OUTPUT                                                             │
│   github.com/<owner>/<repo>/pull/N                                 │
│   one PR, N commits (one per ticket), ready for review             │
└────────────────────────────────────────────────────────────────────┘
```

Key invariants:

- `$FACTORY_RUN_DIR/plan.md` is the **single source of truth between
  steps**. Branch reads `branch:`, ralph reads the ticket list, pr reads
  `title:` + approach.
- **Ralph's iteration boundary = ticket boundary.** One iter does one
  ticket end-to-end (red → green → refactor → gates → commit) then
  stops. The orchestrator's until-loop drives the next iteration; ralph
  re-detects "where am I" via `git log main..HEAD`.
- **Nothing writes to main.** Plan artifact is in run-dir (ephemeral);
  all production diff lands on the PRD's branch.
- **The PR is the only thing that escapes the local machine.** Up until
  step 4, everything is reversible by `git branch -D`.

## Using factory to build factory

This repo dogfoods itself: the pipeline above is wired up in `.factory/`
and used to ship changes to `factory` itself. If you want to try the
framework, this is also the smallest end-to-end example.

### Layout

```
.factory/
  factory.ts         ← pipeline definition (plan → branch → ralph → pr)
  steps/
    plan.md          ← splits the PRD into tickets, picks branch + title
    branch.md        ← creates the branch off main
    ralph.md         ← TDD loop, one commit per ticket
    pr.md            ← push + gh pr create
  runs/<id>/         ← per-run artifacts (PRD copy, plan, step outputs)
plans/               ← committed PRDs — the input to the pipeline
patterns/            ← project-specific Effect patterns the agent reads
repos/effect/        ← vendored Effect source the agent greps for refs
CLAUDE.md            ← project conventions the agent loads on every step
scripts/dogfood.ts   ← thin wrapper: one factoryDef.run() per invocation
```

### Author a PRD, run the pipeline

1. **Write a PRD** under `plans/<topic>.md`. Markdown with a `## Problem`,
   `## Goals`, and a list of items the change should land. Look at
   existing files in `plans/` for the shape — `plans/effect-review-red.md`
   and `plans/observability-improvements.md` are representative.
2. **Commit it on main.** Branch step requires a clean tree; the PRD
   itself shouldn't show up as a dirty file.
3. **Run the pipeline:**

   ```bash
   pnpm dogfood plans/<topic>.md
   ```

   That's `tsx scripts/dogfood.ts plans/<topic>.md` — a one-line wrapper
   around `factoryDef.run({ prd, cwd })`. Watch the OTel trace in the
   Aspire Dashboard if you want a live view (`pnpm aspire:up`).

4. **Review the PR.** The pipeline ends by opening one PR with one
   commit per ticket, titled by the plan's `title:` and bodied with the
   ticket checklist + test plan. Merge or push back to ralph by
   committing follow-up work and re-running.

### What the agent reads (and why)

When ralph implements a ticket, the harness has access to:

- **`CLAUDE.md`** — project conventions (Effect services, error shapes,
  test runner). Loaded into every step automatically.
- **`patterns/*.md`** — the factory-specific Effect subset
  (`typed-errors.md`, `branded-ids.md`, `services-and-layers.md`, …).
  Cheaper to read than the whole Effect monorepo.
- **`repos/effect/`** — vendored Effect source (squashed git subtree).
  The agent greps it for real implementations when a pattern doesn't
  cover the case. Excluded from `tsconfig`/`oxlint` and not imported
  from app code; it's reference material only.
- **`$FACTORY_RUN_DIR/plan.md`** — the implementation plan written by
  the plan step at the start of this run.

### Tweaking the pipeline

The four step files are markdown prompts — edit them and re-run
`pnpm dogfood`. Common tweaks:

- Change the `until:` predicate in a step's frontmatter to alter the
  loop exit condition.
- Bump `maxIters:` in `ralph.md` for PRDs with more than ~12 tickets.
- Swap harnesses per-step (e.g. plan on `claude-code`, ralph on
  `codex`) by passing `{ harness: '<name>' }` as the third arg to
  `.step(...)` in `.factory/factory.ts`.

## Step shape (markdown-first)

```markdown
---
name: ralph
harness: claude-code
until: tests pass
maxIters: 10
---

Keep iterating on the failing tests until the whole suite is green.
Only edit files under src/. Run `pnpm test` between iterations.
```

```ts
// .factory/factory.ts
import { factory } from '@factory/core';

export default factory({ name: 'sdd', harness: 'claude-code' })
  .step('plan', './steps/plan.md')
  .step('ralph', './steps/ralph.md', { harness: 'codex' })
  .step('verify', './steps/verify.md')
  .step('qa', './steps/qa.md')
  .step('simplify', './steps/simplify.md');
```

## Observability

OpenTelemetry is wired in from day one. Default exporter is OTLP/gRPC at `localhost:4317` — point it at any OTel backend.

For local debugging, run the standalone Aspire Dashboard:

```bash
docker run --rm -it -p 18888:18888 -p 4317:18889 \
  mcr.microsoft.com/dotnet/aspire-dashboard:latest
# open http://localhost:18888 and run `factory run ...`
```

Send to your production backend instead:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io \
OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=$KEY" \
factory run sdd --prd ./x.md
```

Disable with `--no-otel` or `OTEL_SDK_DISABLED=true`.

## Packages

| Package                                                        | Description                                         |
| -------------------------------------------------------------- | --------------------------------------------------- |
| [`@factory/core`](packages/core)                               | Builder, step runner, run context, OTel init        |
| [`@factory/cli`](packages/cli)                                 | `factory` CLI                                       |
| [`@factory/harness-claude-code`](packages/harness-claude-code) | Subprocess adapter for `claude`                     |
| [`@factory/harness-codex`](packages/harness-codex)             | Subprocess adapter for `codex`                      |
| [`@factory/harness-copilot`](packages/harness-copilot)         | Subprocess adapter for `copilot`                    |
| [`@factory/steps-sdd`](packages/steps-sdd)                     | Reference SDD steps (plan/ralph/verify/qa/simplify) |

## Status

v0 scaffold only. See [`docs/feature-specs/factory.md`](docs/feature-specs/factory.md) for the full design.
