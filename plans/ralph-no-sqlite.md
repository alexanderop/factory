---
name: ralph-no-sqlite
description: Replace per-run SQLite with plain files (JSON manifests + JSONL events + markdown ledgers). Aligns the factory with the Ralph technique — filesystem is the durable record; no DB, no SQL, no native deps.
type: plan
status: done
created: 2026-05-09
---

# Plan: ralph-no-sqlite (file-only run artifacts)

Supersedes `plans/ralph-and-run-artifacts.md` (v1, SQLite-based; Slices 1–2 shipped).
Keeps the directory layout from v1; deletes the DB layer; promotes `slice` and
`state` from DB tables to project-rooted markdown / JSON files.

## Why

The original Ralph technique is a `while :; do cat PROMPT.md | claude; done`
loop with state held in plain files (`AGENTS.md`, `IMPLEMENTATION_PLAN.md`,
`specs/*`, `src/`). The factory built a SQLite-backed run record alongside the
on-disk artifacts; v1 explicitly mirrors `FactoryEvent` into a table and stores
slices/`ctx.state` only in the DB. Two consequences:

1. **Two sources of truth.** Every `record*` call writes both a file and a SQL
   row (`packages/core/src/services/RunWorkspace.ts:161` onwards). Drift is a
   matter of when, not if.
2. **Harnesses must speak SQL.** v1 Slice 3 plans to inject `$FACTORY_RUN_DB`
   so harnesses can `SELECT id FROM slice WHERE done=0`. That couples the
   harness contract to the orchestrator's storage choice — the opposite of
   Ralph's "the agent edits markdown" discipline.

Cost paid for SQL queryability we don't actually use yet:
`@effect/sql` + `@effect/sql-sqlite-node` + `@effect/experimental` (Reactivity)

- native `better-sqlite3` build, schema migration debt, multi-writer WAL
  plumbing.

## Design choices grounded in `repos/effect/`

Patterns lifted from the Effect source — cited so the rewrite reuses house
shapes instead of reinventing them.

1. **Typed JSON via `Schema.parseJson(Record)`.** `parseJson` composes
   `JSON.parse`/`stringify` with any schema and yields a string ↔ typed
   transformation. The same pattern Effect's own `KeyValueStore.SchemaStore`
   uses (`repos/effect/packages/platform/src/internal/keyValueStore.ts:125`).
   We don't hand-roll JSON.parse + decode.
2. **`writeFile` is not atomic.** Effect's Node FileSystem
   (`repos/effect/packages/platform-node-shared/src/internal/fileSystem.ts:598`)
   wraps `NFS.writeFile` directly — no tmp+rename. We supply our own
   `atomicWriteString` helper (below) using the `rename` operation already
   exposed on `FileSystem` (`packages/platform/src/FileSystem.ts:176`).
3. **No `KeyValueStore.layerFileSystem` for run/step manifests.** It's the
   obvious-looking fit, but the implementation
   (`packages/platform/src/internal/keyValueStore.ts:194`) URL-encodes keys
   into opaque filenames and writes non-atomically — neither of which we
   want for `run.json`/`step.json`. Keep KV in mind if we ever resurrect
   `ctx.state` as a typed bag; reject it for the run record.
4. **Reading JSONL the canonical way:** `fs.stream(path) |
Stream.decodeText() | Stream.splitLines` — used by Multipart parsing in
   the Effect tree (`packages/platform/test/Multipart.test.ts`). Slice 4
   (iter feedback) leans on this.
5. **`Schema.decodeUnknown` boundary discipline.** Hoist the decoder, map
   `ParseError` → `RunRecordingError` at the seam, per
   `patterns/schema-at-the-edge.md`. The current `StepLoader` already
   demonstrates this in this repo.
6. **`Context.Tag` style retained.** `RunWorkspace` is already a
   `Context.Tag` — `patterns/services-and-layers.md` permits it for
   established services. No need to migrate to `Effect.Service`.

## Goal

Every `factory run` produces `.factory/runs/<runId>/` containing:

- `run.json` — top-level run record (mutated atomically via tmp+rename)
- `events.jsonl` — append-only `FactoryEvent` stream
- `steps/<ord>-<stepId>/step.json` — per-step record incl. nested `iters[]`
- `steps/<ord>-<stepId>/iters/<n>/{prompt,stdout,stderr,events,diff,summary}` — same as v1
- `steps/<ord>-<stepId>/step.md`, `prd.md` — verbatim source material

A fresh-context agent — a future ralph iteration, a `verify` step, a human with
`jq` — can read `<runDir>` and reconstruct the entire run. No DB, no native
deps, no schema migrations.

Slices and shared state move out of the run dir entirely:

- **Slices live in `IMPLEMENTATION_PLAN.md`** at the project root. Plan step
  writes it; ralph step picks the next `- [ ]` item and edits it to `- [x]`.
  Survives across runs — which is what users actually want.
- **`ctx.state` is gone.** Steps coordinate by writing project files
  (`PLAN.md`, `specs/*`, `src/`), Ralph-style. If a step truly needs an
  ephemeral key/value bag it can write `<runDir>/state/<key>.json`, but no
  service surface promotes this.

## Non-goals

- Cross-run history, leaderboards, dashboards. Build them outside the run
  (ingest JSONL into duckdb if you ever need it).
- Resume / checkpoint. Same as v1 — out of scope.
- Replacing OTel. Unchanged: OTel is the live trace tool; files are the
  durable record.
- Backwards compatibility with v1 run dirs. The v1 schema shipped to nobody
  outside this repo; we delete `run.db` consumers and move on.

## Layout

```
.factory/runs/<runId>/
  run.json                       # run record, atomic rewrites
  events.jsonl                   # append-only FactoryEvent stream
  prd.md                         # resolved PRD content
  steps/<ord>-<stepId>/
    step.md                      # loaded step file (frontmatter + body)
    step.json                    # step record + iters[]
    iters/<n>/
      prompt.md                  # full prompt for THIS iter (carries feedback)
      stdout.log                 # streamed during run
      stderr.log
      events.jsonl               # iter-scoped FactoryEvent slice
      diff.patch                 # git diff vs. iter-start tree-ish (optional)
      summary.json               # iter record (mirrors steps/.../iters[n])
.factory/runs/latest -> <runId>  # symlink updated at run start (POSIX only)

<projectRoot>/IMPLEMENTATION_PLAN.md   # slice ledger, edited by plan/ralph steps
```

## File schemas

All decoded/encoded at the boundary via `Schema.parseJson(<Record>)` —
follows `patterns/schema-at-the-edge.md` and matches what
`KeyValueStore.SchemaStore` does in the Effect source. No DDL.

```ts
// packages/core/src/services/runManifest.ts
import { Schema } from 'effect';
import { HarnessName, PipelineName, RunId, StepId } from '../ids.ts';

export const RunStatus = Schema.Literal('running', 'ok', 'error');
export const StepStatus = Schema.Literal('running', 'ok', 'failed');

export const IterRecord = Schema.Struct({
  n: Schema.Number,
  startedAt: Schema.Number, // epoch ms
  endedAt: Schema.optional(Schema.Number),
  exitCode: Schema.optional(Schema.Number),
  untilPassed: Schema.optional(Schema.Boolean),
  untilOutput: Schema.optional(Schema.String),
  filesChanged: Schema.optional(Schema.Number),
});

export const StepRecord = Schema.Struct({
  ord: Schema.Number,
  stepId: StepId,
  source: Schema.String,
  harness: HarnessName,
  until: Schema.optional(Schema.String),
  maxIters: Schema.Number,
  startedAt: Schema.Number,
  endedAt: Schema.optional(Schema.Number),
  status: StepStatus,
  iters: Schema.Array(IterRecord),
});

export const RunRecord = Schema.Struct({
  id: RunId,
  pipeline: PipelineName,
  defaultHarness: Schema.optional(HarnessName),
  cwd: Schema.String,
  prdSource: Schema.String,
  factoryFile: Schema.optional(Schema.String),
  startedAt: Schema.Number,
  endedAt: Schema.optional(Schema.Number),
  status: RunStatus,
  errorTag: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
});

// Hoisted decoders/encoders — construction parses the AST.
export const RunRecordJson = Schema.parseJson(RunRecord);
export const StepRecordJson = Schema.parseJson(StepRecord);
export const decodeRun = Schema.decodeUnknown(RunRecordJson);
export const encodeRun = Schema.encode(RunRecordJson);
export const decodeStep = Schema.decodeUnknown(StepRecordJson);
export const encodeStep = Schema.encode(StepRecordJson);
```

`events.jsonl` carries one encoded `FactoryEvent` per line — the same shape
already emitted to `EventEmitter`, no transformation. We add a
`FactoryEventJson = Schema.parseJson(FactoryEvent)` for symmetric
encode/decode (the existing `FactoryEvent` is a discriminated union in
`types.ts`; lifting it to a Schema is a small adjacent change).
Iter-scoped `events.jsonl` is the filtered subset for that iter (kept for
grep ergonomics; orchestrator writes both in one fan-out, same as v1).

## Service surface

```ts
// packages/core/src/services/RunWorkspace.ts (rewritten)
export interface RunWorkspaceService {
  readonly runId: RunId;
  readonly runDir: string;

  readonly recordRunStart: (args: RunStartArgs) => Effect.Effect<void, RunRecordingError>;
  readonly recordRunEnd: (args: RunEndArgs) => Effect.Effect<void, RunRecordingError>;
  readonly recordStepStart: (args: StepStartArgs) => Effect.Effect<void, RunRecordingError>;
  readonly recordStepEnd: (args: StepEndArgs) => Effect.Effect<void, RunRecordingError>;
  readonly recordIterStart: (args: IterStartArgs) => Effect.Effect<IterPaths, RunRecordingError>;
  readonly recordIterEnd: (args: IterEndArgs) => Effect.Effect<void, RunRecordingError>;
  readonly appendEvent: (event: FactoryEvent) => Effect.Effect<void, RunRecordingError>;
  readonly appendStdout: (
    stepOrd: number,
    n: number,
    text: string,
  ) => Effect.Effect<void, RunRecordingError>;
  readonly appendStderr: (
    stepOrd: number,
    n: number,
    text: string,
  ) => Effect.Effect<void, RunRecordingError>;
  readonly appendIterEvent: (
    stepOrd: number,
    n: number,
    event: FactoryEvent,
  ) => Effect.Effect<void, RunRecordingError>;
}
```

The interface barely changes vs. v1 — only `dbPath` is removed and
`putState`/`getState`/slice helpers were never landed in v1's service. The
orchestrator call sites stay identical; only the implementation flips from
SQL writes to manifest mutations.

### Implementation per call

| Call                          | What happens                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `recordRunStart`              | mkdir runDir; write `prd.md`; write `run.json` with `status:'running'`.                                                               |
| `recordRunEnd`                | rewrite `run.json` with `endedAt`, `status`, optional error fields.                                                                   |
| `recordStepStart`             | mkdir step dir; write `step.md`; write `step.json` with `status:'running'`, empty `iters:[]`.                                         |
| `recordStepEnd`               | rewrite `step.json` with `endedAt`, `status`.                                                                                         |
| `recordIterStart`             | mkdir iter dir; write `prompt.md`; rewrite enclosing `step.json` to push a fresh `IterRecord` onto `iters[]`.                         |
| `recordIterEnd`               | rewrite `step.json` updating the matching iter; also write `iters/<n>/summary.json` (a snapshot of the same record, for direct grep). |
| `appendEvent`                 | append one JSON line to `<runDir>/events.jsonl`.                                                                                      |
| `appendIterEvent`             | append one JSON line to `iters/<n>/events.jsonl`.                                                                                     |
| `appendStdout`/`appendStderr` | append to `iters/<n>/{stdout,stderr}.log`.                                                                                            |

### Atomic mutation

Effect's `FileSystem.writeFile` is a thin wrapper around Node's `NFS.writeFile`
(`repos/effect/packages/platform-node-shared/src/internal/fileSystem.ts:598`).
It does **not** do tmp+rename — a crash mid-write leaves a truncated file.
We supply our own helper:

```ts
// packages/core/src/services/runManifest.ts
const atomicWriteString = (path: string, data: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tmp = `${path}.tmp.${process.pid}`;
    yield* fs.writeFileString(tmp, data);
    yield* fs.rename(tmp, path); // POSIX-atomic on the same fs
  });

export const writeRun = (path: string, value: typeof RunRecord.Type) =>
  encodeRun(value).pipe(Effect.flatMap((json) => atomicWriteString(path, json)));
```

Manifests are tiny (a step.json with 20 iters is < 5 KB), so full rewrite
on every mutation is fine.

The orchestrator is the sole writer of `run.json` and `step.json`, so no
inter-fiber locking is required. `recordIterStart` / `recordIterEnd` race
each other only across iters, and the orchestrator runs them sequentially
inside its iter loop.

JSONL appends use `fs.writeFileString(path, line + '\n', { flag: 'a' })`.
On POSIX, `O_APPEND` makes the offset+write pair atomic, regardless of
length; on Windows the equivalent guarantee holds for single-process
appends. `Stream.runForEach` in the orchestrator's harness consumer
serializes per-event callbacks
(`packages/core/src/orchestrator.ts:182`), so consecutive `appendEvent`
calls are already linearized — no semaphore.

## Slice ledger: `IMPLEMENTATION_PLAN.md`

Single project-rooted markdown file. Plan step writes it; ralph step reads,
picks the first `- [ ]` line, implements, edits the line to `- [x]`. Format:

```md
# Implementation plan

- [ ] auth-1: extract auth middleware into Effect service
- [x] auth-2: add login form
- [ ] auth-3: handle session expiry

<!-- ralph: pick the first unchecked item; mark it `- [x]` with a one-line note when complete. -->
```

The harness writes the file directly via its existing edit tool. No service
surface, no env var beyond `FACTORY_PROJECT_PLAN` pointing at the path.
The factory only reads it for `factory inspect` (future); it does not own
the file.

This gives us the actual Ralph property the v1 plan was approximating: the
ledger survives across runs. A second `factory run` resumes by picking the
next unchecked slice, no cross-run DB needed.

## Per-iter feedback (the ralph quality win)

Replaces v1 Slice 5. When building `prompt.md` for iter N+1:

1. Decode `steps/<ord>-<stepId>/iters/<pad(N)>/summary.json` via
   `Schema.decodeUnknown(Schema.parseJson(IterRecord))` →
   `{ exitCode, untilPassed, untilOutput, filesChanged }`.
2. Tail last 200 lines of `iters/<pad(N)>/stdout.log`. Implementation:
   ```ts
   const tail = (path: string, n: number) =>
     fs.stream(path).pipe(
       Stream.decodeText(),
       Stream.splitLines,
       Stream.runCollect,
       Effect.map((chunk) => Chunk.toReadonlyArray(chunk).slice(-n).join('\n')),
     );
   ```
   (`splitLines` from `repos/effect/packages/effect/src/Stream.ts:4751`.) For
   our log sizes — bounded by harness output per iter — `runCollect` is fine.
3. Prepend a `# Last attempt` section to the new prompt.

No DB query. Works because `summary.json` is written at iter-end and is
self-contained.

## Harness env

| v1                        | v2                                                          |
| ------------------------- | ----------------------------------------------------------- |
| `FACTORY_RUN_DB=<dbPath>` | `FACTORY_RUN_DIR=<runDir>`                                  |
| (none)                    | `FACTORY_PROJECT_PLAN=<projectRoot>/IMPLEMENTATION_PLAN.md` |

Harnesses stop knowing SQL. They `cat`/edit files, like Ralph.

## Testing strategy

Goal: every layer of the rewrite is covered by an `@effect/vitest` test, with
the e2e orchestrator test as the contract that pins down what
fresh-context agents (the actual customer of this change) get to read.
Patterns from `patterns/effect-vitest.md` and `patterns/testing-effect.md` —
not reinvented.

### Pyramid

| Level | Test                                                          | Vitest      | Resources |
| ----- | ------------------------------------------------------------- | ----------- | --------- |
| 1     | Schema codec roundtrip                                        | `it.effect` | none      |
| 2     | `atomicWriteString` integrity (success + crash)               | `it.scoped` | tmp dir   |
| 3     | `RunWorkspace` service via real `LiveRunWorkspace`            | `it.scoped` | tmp dir   |
| 4     | **Orchestrator e2e** — scripted pipeline → directory snapshot | `it.scoped` | tmp dir   |
| 5     | Iter-feedback prompt builder (Slice 4)                        | `it.scoped` | tmp dir   |

### House rules in force

- **`it.effect` / `it.scoped` only** — no `Effect.runPromise` in tests.
- **`fs.makeTempDirectoryScoped`** for any test touching the disk; cleanup
  is fiber-bound, no `afterAll(rmSync)` plumbing.
- **`@effect/vitest/utils` assertions** — `assertInstanceOf`, `strictEqual`,
  `deepStrictEqual`. Avoid bare `expect(...).toBe(...)`.
- **No more `InMemoryRunWorkspace`.** Without SQLite there is no "in-memory"
  mode worth distinguishing — the persistence layer _is_ the filesystem.
  Tests use `LiveRunWorkspace.layer({ runId, cwd: tmpDir })` with the tmp
  dir scoped to the test fiber. One layer, one code path.
- **Real `NodeContext`** wherever FileSystem/Path/CommandExecutor is needed.
  Stub only what would otherwise hit the network or spawn real tools:
  harness (`scriptedHarness`), step loader (`InMemoryStepLoader`), until
  evaluator (`scriptedUntilEvaluator`), event emitter
  (`recordingEventEmitter`). All of these already exist in
  `packages/core/src/testing/`.

### Level 1 — Schema codec roundtrip

```ts
it.effect('RunRecord roundtrips through parseJson', () =>
  Effect.gen(function* () {
    const sample: typeof RunRecord.Type = {
      /* … */
    };
    const json = yield* encodeRun(sample);
    const decoded = yield* decodeRun(json);
    deepStrictEqual(decoded, sample);
  }),
);
```

Plus negative tests asserting `decodeRun` rejects malformed JSON with a
`ParseError` (then the boundary maps to `RunRecordingError`).

### Level 2 — `atomicWriteString`

Two tests, both `it.scoped`:

1. **Happy path:** write `foo.json`, assert content equals input and
   `foo.json.tmp.<pid>` does not exist after the call.
2. **Crash path:** simulate a failure between `writeFileString` and `rename`
   by replacing the helper's rename step with `Effect.die('boom')`. Assert
   the _existing_ file is unchanged. (Easiest: factor the helper to take an
   injected `rename` and parameterize in tests; or wrap with
   `Effect.catchAllDefect` and verify the original byte content survives.)

### Level 3 — `RunWorkspace` service

Drive the service directly through its public interface against a real
filesystem:

```ts
it.scoped('records run + step + iter to disk and re-decodes', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-ws-' });
    const runId = RunId.make('ws-test');
    const ws = yield* RunWorkspace;

    yield* ws.recordRunStart({ pipeline: PipelineName.make('p'), … });
    yield* ws.recordStepStart({ ord: 0, stepId: StepId.make('plan'), … });
    yield* ws.recordIterStart({ stepOrd: 0, n: 1, prompt: 'p' });
    yield* ws.recordIterEnd({ stepOrd: 0, n: 1, exitCode: 0, untilPassed: true });
    yield* ws.recordStepEnd({ ord: 0, status: 'ok' });
    yield* ws.recordRunEnd({ status: 'ok' });

    const run = yield* decodeRun(yield* fs.readFileString(`${cwd}/.factory/runs/${runId}/run.json`));
    strictEqual(run.status, 'ok');
    strictEqual(run.pipeline, 'p');

    const step = yield* decodeStep(yield* fs.readFileString(
      `${cwd}/.factory/runs/${runId}/steps/00-plan/step.json`,
    ));
    strictEqual(step.status, 'ok');
    strictEqual(step.iters.length, 1);
    strictEqual(step.iters[0]?.untilPassed, true);
  }).pipe(Effect.provide(LiveRunWorkspace.layer({ runId, cwd })
    .pipe(Layer.provide(NodeContext.layer)))),
);
```

Built against the **real** `LiveRunWorkspace` — no in-memory shortcut. This
is the layer that proves the `record*` functions emit the file shapes the
rest of the system expects.

### Level 4 — Orchestrator e2e (the centerpiece)

The existing `runWorkspace.test.ts` "writes run/step/event rows + prd.md
and step.md to disk" becomes the e2e test, rewritten to:

1. Run `runFactoryEffect` with `LiveRunWorkspace`, `scriptedHarness`,
   `InMemoryStepLoader`, `scriptedUntilEvaluator`,
   `recordingEventEmitter`, `SilentDisplay` — same layer composition as
   today, only `RunWorkspace` flips from in-memory to live.
2. Walk the run dir; assert the **directory shape** as a sorted relative
   path list:
   ```ts
   const tree = yield * listTreeRelative(runDir); // helper, ~10 lines via fs.readDirectory
   deepStrictEqual(tree, [
     'events.jsonl',
     'prd.md',
     'run.json',
     'steps/00-plan/iters/001/events.jsonl',
     'steps/00-plan/iters/001/prompt.md',
     'steps/00-plan/iters/001/stdout.log',
     'steps/00-plan/iters/001/summary.json',
     'steps/00-plan/step.json',
     'steps/00-plan/step.md',
     'steps/01-ralph/iters/001/events.jsonl',
     'steps/01-ralph/iters/001/prompt.md',
     'steps/01-ralph/iters/001/stdout.log',
     'steps/01-ralph/iters/001/summary.json',
     'steps/01-ralph/step.json',
     'steps/01-ralph/step.md',
   ]);
   ```
   This is _the_ contract a fresh-context Ralph agent depends on. Inline
   list, not a vitest snapshot — the diff is readable in PRs and the file
   doesn't need `--update-snapshots` discipline.
3. Decode `run.json` and `step.json` and assert the same fields the v1 test
   asserts on (`pipeline`, `status`, iter counts, exit codes).
4. Read `events.jsonl`, split on newline, decode each line via
   `Schema.parseJson(FactoryEvent)`, assert the type sequence:
   `['run.start', 'step.start', 'step.iter', …, 'run.end']`.

A second e2e test covers the streaming path (existing "streams stdout/stderr
to per-iter log files"): scripted harness yields multi-line output, assert
`stdout.log` and `stderr.log` contents byte-for-byte and that `summary.json`
matches the iter the orchestrator just finished.

### Level 5 — Iter-feedback prompt (Slice 4)

`it.scoped` test with a hand-prepared run dir (write a `summary.json` and a
`stdout.log` for iter 1), call `buildIterPrompt(workspace, 0, 2)`, assert
the result includes a `# Last attempt` heading + the exit code line + the
stdout tail. No orchestrator involved — this is the prompt builder in
isolation.

### What we don't test

- Real harness subprocess behavior — `harness-claude-code` etc. have their
  own `spawnSync` snapshot tests; not relevant here.
- Real `git diff` capture — gated behind a separate `it.scoped` test with a
  real-git fixture if/when the optional diff feature ports forward.
- Cross-run history — there's no surface to test; runs are independent.

### Test-layer helper (reuse)

The existing `buildLayer` helper in `orchestrator.test.ts` becomes the
default for orchestrator tests — only the `RunWorkspace` arg changes from
`InMemoryRunWorkspace.layer({ runId })` to
`LiveRunWorkspace.layer({ runId, cwd })`. Hoisting via `it.layer` is not
needed unless we add five-plus tests that share fixtures; per-test
`Effect.provide(buildLayer(...))` is clearer when the inputs vary.

## Implementation slices

Each slice is small and individually mergeable. Land them in order.

### Slice 1 — Schemas + manifest writer (no orchestrator wiring yet)

- New file `packages/core/src/services/runManifest.ts` defining `RunRecord`,
  `StepRecord`, `IterRecord` schemas + `Schema.parseJson(...)` codecs +
  `atomicWriteString` + `writeRun`/`readRun`/`writeStep`/`readStep` helpers.
- Lift `FactoryEvent` from a TS union in `types.ts` to a `Schema.Union(...)`
  so we can `Schema.parseJson(FactoryEvent)` symmetrically. Existing
  callers that import the type stay source-compatible
  (`typeof FactoryEvent.Type`).
- Unit tests:
  - roundtrip: encode → write → read → decode equals original.
  - atomic-rewrite: a deliberate failure between `writeFileString` and
    `rename` leaves the existing file intact (assert via `Effect.die`
    injection).
  - parse error mapping: a corrupted file returns `RunRecordingError`,
    not a raw `ParseError`.

### Slice 2 — Replace `RunWorkspace` SQL writes with manifest writes

- Rewrite `packages/core/src/services/RunWorkspace.ts`:
  - Drop `SqliteClient.make`, `installSchema`, `Reactivity.layer`.
  - `LiveRunWorkspace.layer` now needs only `FileSystem` + `Path`.
  - Each `record*` call delegates to manifest helpers + file appends as
    listed in the table above.
  - Drop `dbPath` from the interface and `IterPaths`.
- `InMemoryRunWorkspace` becomes a thin tmp-dir layer (no `:memory:`
  SQLite plumbing).
- Delete `packages/core/src/db/schema.ts`.
- Rewrite `packages/core/src/runWorkspace.test.ts`:
  - Drop `readDb`, `RunRow`, `StepRow`, `EventRow`, `IterRow`.
  - Read `run.json`, `step.json`, `events.jsonl` and assert via
    `Schema.decodeUnknown` + jsonl line splits.
- Drop deps from `packages/core/package.json`:
  - `@effect/sql`, `@effect/sql-sqlite-node`, `@effect/experimental`,
    `better-sqlite3`.
- **Verify:** Levels 1, 2, 3, 4 from the testing strategy land green;
  `pnpm check` clean. The Level 4 directory-snapshot test is the
  contract-pin for Slice 2 — if that passes, fresh-context Ralph agents
  can read the new layout.

### Slice 3 — Replace v1's planned slice/state SQL with `IMPLEMENTATION_PLAN.md`

- Update `packages/steps-sdd/steps/plan.md` prompt: write
  `IMPLEMENTATION_PLAN.md` at the project root, format above.
- Update `packages/steps-sdd/steps/ralph.md` prompt: read
  `$FACTORY_PROJECT_PLAN`; pick first `- [ ]`; mark `- [x]` on success.
  Remove any reference to `ctx.state.slices`.
- Inject `FACTORY_RUN_DIR` and `FACTORY_PROJECT_PLAN` env into harness
  subprocesses (in `runStep`'s opts).
- **Verify:** `examples/sdd-quickstart` runs end-to-end with a scripted
  harness that writes/edits the markdown file. New `it.scoped` test:
  scripted plan harness writes 3 unchecked items to
  `IMPLEMENTATION_PLAN.md`; scripted ralph harness flips one to checked;
  assert post-state via `fs.readFileString` + a regex on the line shape.

### Slice 4 — Iter feedback in the next prompt

- Helper `buildIterPrompt(workspace, stepOrd, n)` reads prior
  `summary.json` + tails `stdout.log`, returns augmented prompt.
- Orchestrator uses it from iter 2+.
- **Verify:** Level 5 test from the strategy — scripted-harness test,
  two iters; second `prompt.md` contains the first iter's stdout tail and
  exit-code line. Decode via `Schema.parseJson(IterRecord)` to assert on
  `untilOutput` rather than substring-matching JSON.

Slices 1+2 are the rip-out; ship and let it bake before Slice 3. Slice 4 is
the ralph payoff but depends on nothing in Slice 3.

## Migration from current state

v1 Slices 1–2 are landed. The deletion is concentrated:

- `packages/core/src/db/schema.ts` — delete.
- `packages/core/src/services/RunWorkspace.ts` — rewrite (~150 LOC down).
- `packages/core/src/runWorkspace.test.ts` — rewrite assertions to read
  files instead of DB rows; the test fixtures don't change.
- `packages/core/package.json` — drop four deps + native build.
- `plans/ralph-and-run-artifacts.md` — leave in place as v1 record; this
  file is canonical going forward.

Orchestrator (`packages/core/src/orchestrator.ts`) call sites are unchanged
because the service interface is preserved.

## Tradeoffs

- **Lose ad-hoc SQL.** Replacement: `jq` / `rg` over JSON files. For a
  cross-run dashboard, build outside the run.
- **Schema enforcement moves DDL → TS.** Net win — fits
  `patterns/schema-at-the-edge.md` directly.
- **Manifest rewrites are full-file.** Files stay tiny (a run with 5 steps
  × 20 iters is < 50 KB across all manifests). No concern.
- **JSONL append on Windows.** Guarded by in-process semaphore; the
  orchestrator is single-process so this is belt-and-braces.

## Open questions

- **Should `step.json` carry full `iters[]` or just a count + pointer to
  iter-scoped `summary.json`?** Default: full `iters[]` for grep-ability;
  size is bounded by `maxIters`. Revisit if maxIters ever exceeds ~1000.
- **Does `IMPLEMENTATION_PLAN.md` belong at the project root or under
  `.factory/`?** Lean toward project root — that matches Ralph and makes
  the ledger reviewable in PRs. Final call before Slice 3.

## Resolved

- **No migrator framework.** No DDL, no migrations. Schema lives in
  `runManifest.ts`; if it changes between factory versions, decode failures
  surface at the boundary and we add a versioned shape there.
- **Multi-writer.** Orchestrator owns all manifest writes. Harnesses only
  edit project files (`IMPLEMENTATION_PLAN.md`, `src/`). No locking needed.
- **Run retention.** `.factory/runs/` stays gitignored. No automatic
  rotation in this plan.
- **`run.db` removal.** Yes — v1 callers haven't shipped externally.
  No backwards-compat path.
- **Why not `KeyValueStore.layerFileSystem`?** Considered. Rejected for
  manifests because keys are URL-encoded into filenames (opaque to humans
  doing `cat`/`ls`) and `set` writes non-atomically
  (`packages/platform/src/internal/keyValueStore.ts:194-237`). Worth
  revisiting if `ctx.state` returns as a typed bag.
- **Why not a semaphore on appends?** Single-process orchestrator;
  `Stream.runForEach` serializes per-event callbacks; POSIX `O_APPEND`
  guarantees the offset+write atomicity at the kernel level. Three reasons
  belt and braces, no need for a fourth.

## Status

**Status:** Draft, awaiting review
**Created:** 2026-05-09
**Supersedes:** plans/ralph-and-run-artifacts.md
