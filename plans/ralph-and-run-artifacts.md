---
name: ralph-and-run-artifacts
description: Per-run SQLite DB + on-disk artifacts as the source of truth for what happened during a factory run, plus the ralph-quality fixes that depend on having that context available.
type: plan
---

# Plan: ralph + run artifacts (SQLite per run)

## Goal

Every `factory run` produces `.factory/runs/<runId>/` containing **one SQLite
database** and the matching on-disk artifacts (stdout/stderr/diff/prompt files).
The DB is the canonical record. A fresh-context agent — a future ralph
iteration, a `verify` step, a human running `sqlite3` — can open `run.db`
and reconstruct the entire run without any in-memory state.

This unlocks the ralph improvements that were impossible without history:
threading the previous failure into the next iteration's prompt, slice
tracking across steps, and per-iter rollback.

## Non-goals

- Cross-run history, leaderboards, "all my factory runs" UI. One DB per run.
- Resume / checkpoint. The DB is read-mostly after a run ends; we'll know
  enough from it to design resume in v1, but not now.
- Replacing OTel. OTel is the live trace tool; SQLite is the durable record.
  Both are kept; `event` table mirrors `FactoryEvent`, OTel mirrors spans.

## Layout

```
.factory/runs/<runId>/
  run.db                         SQLite (primary record, WAL mode)
  README.md                      one-line schema summary + sample queries
  prd.md                         resolved PRD content
  steps/<ord>-<stepId>/
    step.md                      loaded step file (frontmatter + body)
    summary.json                 mirrors `step` row, for grep-ability
    iters/001/
      prompt.md                  full prompt for THIS iter (carries feedback)
      stdout.log                 streamed during run
      stderr.log
      diff.patch                 git diff vs. iter-start tree-ish
.factory/runs/latest -> <runId>  symlink updated at run start
```

The DB rows reference these paths. Files exist for human grep + because
storing 50 MB of stdout in SQLite is the wrong tool. The DB has the
metadata, status, and pointers.

## Schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE run (
  id              TEXT PRIMARY KEY,    -- RunId
  pipeline        TEXT NOT NULL,
  default_harness TEXT,
  cwd             TEXT NOT NULL,
  prd_source      TEXT,                -- original arg (path or inline)
  factory_file    TEXT,                -- which .factory/factory.ts was loaded
  started_at      INTEGER NOT NULL,    -- epoch ms
  ended_at        INTEGER,
  status          TEXT NOT NULL CHECK (status IN ('running','ok','error')),
  error_tag       TEXT,                -- _tag of FactoryError on failure
  error_message   TEXT
);

CREATE TABLE step (
  run_id      TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL,        -- 0-indexed pipeline order
  step_id     TEXT NOT NULL,
  source      TEXT NOT NULL,           -- step file path
  harness     TEXT NOT NULL,
  until_pred  TEXT,
  max_iters   INTEGER NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  status      TEXT NOT NULL CHECK (status IN ('running','ok','failed')),
  PRIMARY KEY (run_id, ord)
);

CREATE TABLE iter (
  run_id        TEXT NOT NULL,
  step_ord      INTEGER NOT NULL,
  n             INTEGER NOT NULL,       -- 1-indexed
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  exit_code     INTEGER,
  until_passed  INTEGER,                -- 0/1, NULL if no `until`
  until_output  TEXT,                   -- short reason from evaluator
  files_changed INTEGER,                -- count, derived from diff.patch
  PRIMARY KEY (run_id, step_ord, n),
  FOREIGN KEY (run_id, step_ord) REFERENCES step(run_id, ord) ON DELETE CASCADE
);

-- mirror of FactoryEvent, append-only
CREATE TABLE event (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id   TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  type     TEXT NOT NULL,               -- 'run.start' | 'step.iter' | ...
  step_id  TEXT,
  iter     INTEGER,
  payload  TEXT NOT NULL                -- JSON of the full event
);
CREATE INDEX event_by_run ON event(run_id, seq);

-- shared ctx.state bag, key-per-row so a fresh agent can SELECT one key
CREATE TABLE state (
  run_id     TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,             -- JSON
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, key)
);

-- slices denormalized — the most useful structured handle in SDD
CREATE TABLE slice (
  run_id TEXT NOT NULL,
  id     TEXT NOT NULL,
  title  TEXT,
  done   INTEGER NOT NULL DEFAULT 0,
  notes  TEXT,
  PRIMARY KEY (run_id, id)
);
```

### Why these shapes

- **One DB per run** — keeps every run self-contained, deletable as a unit,
  no cross-run lock contention. WAL lets a reader (the harness checking
  prior iters) coexist with the orchestrator writer.
- **`event` mirrors `FactoryEvent`** — replaces the spec's `events.jsonl`
  promise. Queryable by `(run_id, seq)`; append-only.
- **`state` is key-per-row, not one blob** — a fresh agent can `SELECT
value FROM state WHERE key='diff'` without parsing 200 KB.
- **`slice` is denormalized** — slices are the load-bearing shape for the
  SDD pipeline; let `verify` and `simplify` query `WHERE done=0` directly.
- **stdout/stderr/diff stay on disk**, paths derivable from
  `(run_id, step_ord, n)` so we don't need to store them in the DB.
- **Multiple writers (orchestrator + harness subprocess)** are supported on
  `state` and `slice`. WAL mode + short transactions handle the contention;
  both writers go through SQLite's normal locking. Harnesses get write access
  via `$FACTORY_RUN_DB` (slice 3); orchestrator uses the service directly.

## Service surface

```ts
// packages/core/src/services/RunWorkspace.ts
export interface RunWorkspaceService {
  readonly runDir: string;
  readonly dbPath: string;

  readonly recordRunStart:  (...) => Effect.Effect<void>;
  readonly recordRunEnd:    (...) => Effect.Effect<void>;
  readonly recordStepStart: (...) => Effect.Effect<void>;
  readonly recordStepEnd:   (...) => Effect.Effect<void>;
  readonly recordIterStart: (...) => Effect.Effect<{ stdoutPath; stderrPath; promptPath; diffBase }>;
  readonly recordIterEnd:   (...) => Effect.Effect<void>;
  readonly appendEvent:     (event: FactoryEvent) => Effect.Effect<void>;

  readonly putState:        (key: string, value: unknown) => Effect.Effect<void>;
  readonly getState:        (key: string) => Effect.Effect<unknown | undefined>;

  readonly upsertSlices:    (slices: ReadonlyArray<Slice>) => Effect.Effect<void>;
  readonly markSliceDone:   (id: string, notes?: string) => Effect.Effect<void>;
  readonly listOpenSlices:  Effect.Effect<ReadonlyArray<Slice>>;
}
```

The service owns the `SqlClient` for this run's DB. Backed by
`@effect/sql-sqlite-node` (`SqliteClient.layer({ filename: dbPath })`), with
migrations run at construction via `SqliteMigrator`.

`EventEmitter` keeps doing what it does (user callbacks); `RunWorkspace` is
a separate sink also receiving events. The orchestrator emits to both.

A test layer `InMemoryRunWorkspace` (`:memory:` SQLite) lets tests assert
on rows without touching the filesystem.

## Streaming + per-iter files

Today `orchestrator.ts:88` calls `harness.exec` (collect-then-return). We
switch to `harness.stream` and tee:

- each `stdout`/`stderr` event → append to `iters/<n>/stdout.log`/`stderr.log`
- each event → `Display.harnessLine` (live console)
- accumulate into the existing `ExecResult` for `until` evaluation

The `harness.exec` function on `Harness` becomes a thin convenience that
calls `stream` internally; the `Harness` interface surface doesn't change.
Both `exec` and `stream` remain on the public interface — this is an
internal refactor only, no breaking change for harness implementers.

## Per-iter diff (cheap form)

Before each iter: `git stash create` (no working-tree mutation) → store as
`diff_base`. After: `git diff <diff_base>` → `iters/<n>/diff.patch`,
update `iter.files_changed`. If the project isn't a git repo, skip silently
and leave `diff_path` NULL.

## Ralph-quality changes that depend on this

These are out of scope for the artifacts MVP but become trivial once it
lands:

1. **Iter feedback in the prompt.** When building `prompts.md` for iter
   N+1, the orchestrator queries the previous `iter` row + tails
   `stdout.log` and prepends a `# Last attempt` section with exit code +
   `until` reason + last 200 lines of stdout. This is the single biggest
   ralph quality win, and it's only possible with the per-iter store.

2. **Slice-aware ralph.** `plan` writes rows into `slice`; `ralph` reads
   `listOpenSlices` and the orchestrator can loop ralph per open slice
   instead of trusting the harness to pick one.

3. **`until` extensions.** New evaluator predicates:
   - `shell: <cmd>` — exit 0 = pass.
   - `typecheck` — `pnpm exec tsc --noEmit`.
   - AND-composition: `tests pass AND typecheck`.
     The `until_output` column captures the failing predicate's reason.

4. **Per-iter timeout** (separate from `idleTimeoutMs`). Recorded in
   `iter.ended_at - started_at` so we can spot creep over a run.

## Implementation steps

Each step is a slice — small, mergeable, individually useful.

### Slice 1 — `RunWorkspace` skeleton + run/step/event rows

- Add `@effect/sql` and `@effect/sql-sqlite-node` deps to
  `packages/core/package.json`.
- New files:
  - `packages/core/src/services/RunWorkspace.ts` — Tag, service iface,
    `LiveRunWorkspace.layer`, `InMemoryRunWorkspace.layer`.
  - `packages/core/src/db/schema.ts` — single inline DDL string with all
    `CREATE TABLE` statements; executed once on DB creation. No migrator
    framework yet — each run gets a fresh DB, and we'll add `SqliteMigrator`
    if/when we change the schema between factory versions.
- Add `.factory/runs/` to `.gitignore` (root + any example projects).
  No automatic rotation; users prune manually when they care.
- Wire into `factory.ts:buildRuntimeLayer` — built lazily per run because
  it needs `runId`. Easiest path: build the layer inside `runFactoryEffect`
  after we mint `runId`, provide it scoped to the run body.
- Orchestrator calls: `recordRunStart`, `recordStepStart`, `appendEvent`
  on every existing emit, `recordRunEnd` on completion (success or via
  `Effect.tapErrorCause`).
- Drop `prd.md`, `step.md` to disk alongside the DB rows.
- **Verify:** integration test runs a 2-step scripted-harness factory,
  asserts `run.db` rows + `prd.md` exist with expected content.

### Slice 2 — Per-iter streaming + files

- Switch `runStep` (orchestrator.ts:65) from `harness.exec` to a new
  helper that consumes `harness.stream`, writing stdout/stderr to the
  per-iter files via `RunWorkspace`, while accumulating `ExecResult`.
- Forward each `HarnessEvent` to `Display.harnessLine` (currently dormant).
- `recordIterStart` / `recordIterEnd` populate the `iter` table.
- **Verify:** scripted harness emitting 5 stdout lines produces matching
  `stdout.log` and `iter` row with correct `started_at`/`ended_at`.

### Slice 3 — `state` + `slice` tables exposed to harnesses

- `RunWorkspace.putState`/`getState` + slice helpers.
- Inject `FACTORY_RUN_DB` env var into the harness subprocess (in
  `Harness.exec`), so harnesses can `sqlite3 $FACTORY_RUN_DB ...` without
  caring about path layout.
- Update `packages/steps-sdd/steps/ralph.md` to reference the DB:
  > "Open `$FACTORY_RUN_DB`. `SELECT id, title FROM slice WHERE done=0
LIMIT 1` to claim a slice; `UPDATE slice SET done=1 WHERE id=?` when
  > finished."
- **Verify:** scripted plan step inserts 3 rows into `slice`; scripted
  ralph step reads `listOpenSlices` and gets them back.

### Slice 4 — Diff capture per iter

- `recordIterStart` runs `git stash create` (via `CommandExecutor`),
  stores the SHA on the iter row in memory.
- `recordIterEnd` runs `git diff <sha>` → `iters/<n>/diff.patch`, counts
  files-changed, writes back to row.
- Fail soft on non-git workspaces; no error, NULL columns.
- **Verify:** real-git fixture test with a one-line edit produces
  matching `diff.patch`.

### Slice 5 — Iter feedback in the next prompt

- New helper `buildIterPrompt(runWorkspace, stepOrd, n)` that reads the
  prior iter row + tails the log, returns the augmented prompt.
- Orchestrator uses it from iter 2+.
- **Verify:** scripted harness, two iters, second prompt contains the
  first iter's stdout tail and exit-code line.

Slices 1–2 are the artifacts MVP. Slices 3–5 are the ralph payoff. Ship
1+2 first; pause for review before 3.

## Open questions

- **Symlink on Windows.** `runs/latest -> <runId>` is convenient on
  macOS/Linux. Skip symlink on win32; offer `factory inspect --latest`
  later that reads from `latest.txt`.
- **Should `step.md` and `prompt.md` be inside the DB as BLOBs?** No —
  agents and humans both want to `cat` them. Paths in DB, content on disk.

## Resolved

- **Migrations:** hand-written DDL in `db/schema.ts`, no migrator framework.
  One DB per run means we can add `SqliteMigrator` later if/when the schema
  evolves between factory versions.
- **State writers:** orchestrator and harness subprocess both write.
  WAL + short transactions; service surface exposes `putState`/`upsertSlices`
  to the orchestrator, harness goes through `$FACTORY_RUN_DB`.
- **Run retention:** `.factory/runs/` is gitignored. No automatic rotation
  in this plan; users prune manually.
- **`harness.exec` refactor:** internal only. Public `Harness` interface
  keeps both `exec` and `stream`.

## Status

**Status:** Draft, awaiting review
**Created:** 2026-05-09
