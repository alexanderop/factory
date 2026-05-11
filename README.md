# factory

> **Experimental** — APIs and step shapes are still moving. The dogfood pipeline in this repo runs end-to-end; the published CLI is not stable yet. See `docs/feature-specs/factory.md` for the full design.

`factory` is a TypeScript framework for building **software factories** — multi-step coding pipelines that run fully AFK on top of whichever coding harness you already have installed (`claude`, `codex`, `copilot`, ...).

Each step is a markdown prompt (Flue-skill style), wired together in TypeScript. Harnesses are invoked as subprocesses, so you reuse the binary you already have on your `$PATH` — no new model SDK, no new API keys.

This repo dogfoods itself with a 4-step pipeline:

```
PRD → plan (slices into tickets) → branch → ralph (TDD loop, one commit per ticket) → pr
```

The longer SDD arc (`plan → ralph → verify → qa → simplify → pr`) is the reference target API; see `@factory/steps-sdd` and the walkthrough below for the dogfood subset that's wired up today.

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

   `dogfood` does a pre-flight (clean tree + on `main`), caches the PRD
   path in `.factory/last-prd`, and calls `factoryDef.run({ prd, cwd })`.
   Subsequent `pnpm dogfood` (no args) re-run against the cached PRD.

   Want the trace dashboard up at the same time? `pnpm dogfood:up` brings
   up Aspire and runs the pipeline in one shot. Watch the events stream
   live in another pane with `pnpm dogfood:tail`.

4. **Review the PR.** The pipeline ends by opening one PR with one
   commit per ticket, titled by the plan's `title:` and bodied with the
   ticket checklist + test plan. Merge or push back to ralph by
   committing follow-up work and re-running.

5. **Tidy up.** After merging a few dogfood PRs, drop the locally-merged
   branches:

   ```bash
   pnpm dogfood:clean
   ```

### Optional: bare `factory` command

If you want to type `factory` instead of `pnpm factory`, link the CLI
once into your global pnpm bin:

```bash
pnpm setup:cli   # pnpm --dir packages/cli link --global
```

After that, `factory <args>` works from anywhere. The link points at the
workspace source (`packages/cli/src/main.ts`), so local changes are
picked up live.

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
// .factory/factory.ts (this repo's dogfood pipeline)
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { factory } from '@factory/core';
import { claudeCode } from '@factory/harness-claude-code';

const here = dirname(fileURLToPath(import.meta.url));
const step = (name: string): string => resolve(here, 'steps', `${name}.md`);

export default factory({
  name: 'effect-review',
  harness: 'claude-code',
  harnesses: [claudeCode],
})
  .step('plan', step('plan'))
  .step('branch', step('branch'))
  .step('ralph', step('ralph'))
  .step('pr', step('pr'));
```

## Review step (parallel fan-out)

`.review(id, { roles })` is a step that fans out N **roles** in parallel, each
one a separate harness invocation. Roles emit structured findings; core merges
them into a single `findings.json` artifact the next step consumes. Different
roles can target different harnesses — claude reviews security, codex reviews
performance, copilot reviews style — all in one wall-clock invocation.

```ts
import { factory } from '@factory/core';
import { claudeCode } from '@factory/harness-claude-code';
import { codex } from '@factory/harness-codex';

const role = (name: string): string => resolve(here, 'roles', `${name}.md`);

export default factory({
  name: 'effect-review',
  harness: 'claude-code',
  harnesses: [claudeCode, codex],
})
  .step('plan', step('plan'))
  .step('branch', step('branch'))
  .step('ralph', step('ralph'))
  .review('review', {
    roles: [
      { id: 'security', source: role('security') },
      { id: 'quality', source: role('quality') },
      { id: 'perf', source: role('perf'), harness: 'codex' },
    ],
    concurrency: 3, // optional; default = roles.length
  })
  .step('resolve', step('resolve')) // reads $FACTORY_RUN_DIR/findings.json
  .step('pr', step('pr'));
```

### Role shape

A role is a markdown file — same shape as a step. The role's harness is
selected (in order) by: `role.harness` → step default → factory default.

```markdown
---
name: security
---

You are a security reviewer. The PRD above is the unit of work.

Write findings to `$FACTORY_ROLE_DIR/findings.json`:

{
"findings": [
{ "severity": "P1" | "P2" | "P3",
"file": "<path>",
"line": <number, optional>,
"message": "<one line>",
"suggestion": "<optional>" }
]
}

End your final message with `<promise>REVIEWED</promise>`.
```

The orchestrator passes each role two extra env vars on top of the usual
`FACTORY_RUN_DIR` / `FACTORY_RUN_ID`:

- `FACTORY_ROLE_ID` — the role's id from the builder
- `FACTORY_ROLE_DIR` — `$FACTORY_RUN_DIR/steps/<ord>-<stepId>/roles/<role-id>/`,
  where it should write `findings.json`

### Behaviour

- **Parallel.** Roles run concurrently via `Effect.partition`. Wall-clock time
  is roughly `max(role)` instead of `sum(role)`. Cap with `concurrency: N`.
- **Failure-isolated.** A role that exits non-zero or emits invalid JSON does
  **not** halt the review step. It becomes a synthetic `P3` finding in the
  merged output (`message: "review role 'X' failed: …"`). Sibling roles still
  run; the review step exits `ok`.
- **Per-role harness.** Set `harness` per role to mix model/provider per
  reviewer.
- **Findings are stamped.** Roles write findings without a `role:` field; core
  adds it on merge. Downstream `resolve` step gets `findings.json` keyed by
  role.

### Artifacts

```
.factory/runs/<runId>/
  prd.md
  findings.json                     ← merged output (next step reads this)
  steps/00-review/
    step.json                       ← includes roles: [{name, harness, status, findings, ...}]
    step.md                         ← synthesised review manifest
    roles/
      security/findings.json        ← raw role output (no `role:` field)
      quality/findings.json
      perf/findings.json
```

`step.json.roles[]` records per-role outcome — status (`ok`/`failed`), the
harness used, finding count, and `errorTag` on failure — so observability and
resume planning see what each reviewer did without parsing the merged file.

## Observability

OpenTelemetry is wired in from day one. Default exporter is OTLP/gRPC at `localhost:4317` — point it at any OTel backend.

For local debugging, run the standalone Aspire Dashboard:

```bash
pnpm aspire:up        # starts the dashboard at http://localhost:18888
pnpm dogfood plans/<topic>.md
# or, in one shot:
pnpm dogfood:up plans/<topic>.md
```

Send to your production backend instead:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io \
OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=$KEY" \
pnpm dogfood plans/<topic>.md
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

The dogfood pipeline (`plan → branch → ralph → pr`) runs end-to-end against PRDs in `plans/`. The published CLI, the SDD reference steps (`@factory/steps-sdd`), and the public step API are still moving. See [`docs/feature-specs/factory.md`](docs/feature-specs/factory.md) for the full design.
