---
name: effect-review-red
description: Concrete fixes for the seven high-severity findings from the per-module Effect code review. Each item is independently shippable; ordering groups changes that share a file.
type: plan
status: not-started
created: 2026-05-09
---

# Effect review — high-severity fixes

Owner: @alex.

Concrete fixes for the seven high-severity findings from the per-module
Effect code review. Each item is independently shippable; suggested order
groups changes that share a file so we don't re-touch the same lines twice.

## Problem

The recent orchestrator + run-workspace + resume work introduced seven
issues that violate the project's Effect conventions in ways that affect
correctness, not just style:

- A run interrupted with SIGINT leaves `RunRecord.status === 'running'`
  forever and pollutes resume.
- The `tapError` chain in run/resume can replace the real failure cause
  with a recording-side failure, hiding the actual harness error.
- `subprocess.ts` throws a raw `Error` and constructs a placeholder
  branded `StepId.make('')`, both forbidden by `patterns/typed-errors.md`
  and `patterns/branded-ids.md`.
- `FactoryEvent.error` is typed `unknown` even though the orchestrator
  only ever emits `FactoryError`, forcing consumers to `as`-cast.
- One test reaches into the Effect runtime via `Effect.runSync` from
  inside `it.scoped`, and one mega-test asserts four behaviours at
  once — both reduce signal when something regresses.

## Goals

1. Run lifecycle bookkeeping (`run.json` status + run metrics) is
   resource-safe — runs on success, typed failure, **and** interrupt.
2. Original failure cause is never replaced by a recording-side failure;
   recording problems are logged, not propagated.
3. No raw `throw` and no placeholder-branded IDs in production code.
4. `FactoryEvent` is fully typed — `onError` consumers narrow on `_tag`
   without `as`.
5. Test suite uses one Effect runtime per `it.scoped`/`it.effect`; each
   test asserts one behaviour.

## Non-goals

- Refactoring the run/resume flow beyond what these fixes require.
- Changing the on-disk `run.json` schema (status enum stays
  `running | ok | error`; we only add `interrupted`).
- Splitting `ResumeUnavailableError` (covered in the medium plan).

## Items

### R1. `Effect.onExit` for run finalization (orchestrator)

Files: `packages/core/src/orchestrator.ts:736-763`, `:900-927`,
`packages/core/src/types.ts` (status enum).

Today both `runFactoryEffect` and `resumeFactoryEffect` wrap `runStepLoop`
in a chain of three `Effect.tapError` calls plus a tail `Effect.tap` for
the success path. Two consequences:

- `tapError` widens `E` with the tap's own `E2`. If the step loop fails
  with `HarnessExecError` and _then_ `recordRunEnd` fails (disk full,
  permission flip), the user sees `RunRecordingError` and loses the
  original cause.
- Neither tap fires on interrupt. SIGINT during a long step leaves
  `run.json` in `status: 'running'`. `planResume` then treats the run as
  resumable, but `loadRecordedSteps` walks a partial directory — the
  failure mode is confusing and recoverable only by deleting the run.

Fix shape:

```ts
const finalize = (
  args: { pipeline: PipelineName; runStartedAt: number; resumed: boolean },
) =>
  Effect.onExit((exit: Exit.Exit<RunCompletion, FactoryError>) =>
    Exit.match(exit, {
      onSuccess: () =>
        Effect.all([
          emitAndRecord(emitter, workspace, { type: 'run-end', runId, status: 'ok' }),
          workspace.recordRunEnd({ status: 'ok' }),
          recordRunMetrics('ok', args),
        ], { discard: true }).pipe(Effect.ignoreLogged),
      onFailure: (cause) =>
        // structured tag if a typed error reached here, otherwise 'interrupted'
        Cause.failureOption(cause).pipe(
          Option.match({
            onNone: () => writeInterrupted(emitter, workspace, args),
            onSome: (error) => writeError(emitter, workspace, error, args),
          }),
        ),
    }),
  );

return runStepLoop(...).pipe(finalize({ pipeline, runStartedAt, resumed: false }));
```

Steps:

1. Add `'interrupted'` to the `RunRecord.status` Schema literal (and the
   Json codec). Update `planResume` to treat interrupted as
   non-resumable for now (covered in M-side cleanup if we want resume).
2. Extract `withRunFinalizer({ pipeline, runStartedAt, resumed })` so
   `runFactoryEffect` and `resumeFactoryEffect` share it.
3. Move `recordRunMetrics`/`emitAndRecord`/`recordRunEnd` calls inside
   the finalizer; on the recording-side, wrap with `Effect.ignoreLogged`
   so a bookkeeping failure shows up in logs but does not replace the
   user's error.
4. Delete the three `tapError` calls and the success `tap`.

Tests:

- New `runWorkspace.test.ts` case: simulate interrupt via
  `Fiber.interrupt` after `recordStepStart` but before `recordStepEnd`;
  assert `run.json` reads `status: 'interrupted'`.
- New `orchestrator.test.ts` case: stub `recordRunEnd` to fail; assert
  the original `HarnessExecError` propagates and the recording failure
  appears in the log capture.

### R2. `subprocess.buildCommand` typed error path

File: `packages/core/src/subprocess.ts:39-42`.

`throw new Error('unsupported permission mode')` violates
`patterns/typed-errors.md`. The orchestrator does validate permissions
upstream, but the subprocess function is exported and could be reached
through other call sites; an unhandled defect there is worse than a
typed failure.

Fix:

1. Define `UnsupportedPermissionError extends Data.TaggedError(...)` in
   `errors.ts`, with `permission: PermissionMode` and the harness name.
   Add to the `FactoryError` union.
2. Lift `buildCommand` from `(...) => Command.Command` to
   `Effect.Effect<Command.Command, UnsupportedPermissionError>`. Use
   `Effect.fail` instead of `throw`.
3. Update call sites in `subprocess.ts` to `yield*` the result.
4. Confirm `runHarness` already has the new error in its `E` channel
   (it composes through `Effect.gen`, so the union widens automatically;
   one mapError or catchTag at the orchestrator boundary).

### R3. Drop `StepId.make('')` placeholder

File: `packages/core/src/subprocess.ts:133-137`.

`StepIdleTimeoutError` requires a `step: StepId`. Subprocess does not
know the step id (only the orchestrator does), so it currently
constructs `StepId.make('')` as a stand-in. The orchestrator
`mapError`s it back to the real id later, but the empty brand exists in
the error channel for the duration — defeats the point of branding.

Pick (b): split the error tag.

1. Add `HarnessIdleTimeoutError extends Data.TaggedError(...)` (no `step`
   field, has `harness`, `idleMs`, `lastActivityAt`).
2. Subprocess emits `HarnessIdleTimeoutError`. Drop the `StepId.make('')`
   line.
3. Orchestrator already has the step id in scope; `Effect.catchTag(
'HarnessIdleTimeoutError', e => Effect.fail(new
StepIdleTimeoutError({ ...e, step: stepId })))` at the harness-call
   boundary.
4. Both errors join `FactoryError`. Public `onError` consumers
   discriminate on `_tag` as before.

Tests: existing `runHarness` idle-timeout test stays valid; add one in
the orchestrator that asserts the resulting error has the correct
`step: StepId`.

### R4. Type `FactoryEvent.error` as `FactoryError`

File: `packages/core/src/types.ts:182,198,208`,
`packages/core/src/orchestrator.ts` (emit sites).

The error event currently carries `error: unknown`. The only emit sites
are `Effect.tapError((error: FactoryError) => ...)` blocks (orchestrator
`:748`, `:912`), so the runtime value is always a `FactoryError`.

Fix:

1. Change `FactoryEvent` `error` variant to
   `readonly error: FactoryError`. With R3 done, `FactoryError` is
   exhaustive.
2. Tighten `RunOptions.onError` and `ResumeOptions.onError` to
   `(event: Extract<FactoryEvent, { type: 'error' }>) => void`.
3. Run `pnpm check`. Any consumer that was doing `as FactoryError`
   should now compile cleanly. The CLI's onError handler in `cli.ts`
   may need a one-line tweak.

No new tests; type checking is the assertion.

### R5. Remove `Effect.runSync` inside `it.scoped`

File: `packages/core/src/runWorkspace.test.ts:336-339`.

```ts
const recordCall = (label: string) =>
  Effect.sync(() => Effect.runSync(Ref.update(callsRef, (xs) => [...xs, label])));
```

The `onCall` callback is sync; capture into a plain array.

```ts
const calls: string[] = [];
const onCall = (label: string) => calls.push(label);
// ... assertions: assert.deepStrictEqual(calls, [...])
```

No `Ref`, no nested runtime, no risk of swallowed defects.

### R6. Split the resume mega-test

File: `packages/core/src/runWorkspace.test.ts:323-424`.

The current `it.scoped` test asserts (a) phase-1 produces the expected
on-disk records, (b) resume reuses ok steps, (c) resume re-runs the
failed step, (d) `plan` is not invoked twice. When any of these breaks,
the others mask the signal.

Fix: split into three `it.scoped` cases sharing the same `seedRunDir`
fixture and `scriptedHarness`:

1. `'phase-1 records run + step state on failure'` — run once with a
   harness that fails on step 2; assert `run.json` and `step-2/step.json`.
2. `'resume reuses ok steps without re-invoking plan'` — seed a
   half-finished run via `seedRunDir`; assert plan call count is zero
   for steps 1..k.
3. `'resume re-executes the failed step'` — same seed; assert the
   harness was called for the failed step and the run completes.

Each test fails independently and points at the specific behaviour
that broke.

### R7. (Bundled with R5/R6) — coverage check

After R5/R6, run `pnpm test --coverage` and confirm the new
orchestrator interrupt path (R1) and the typed error path (R2/R3) are
exercised. If coverage drops on the resume path because of the
mega-test split, add a fourth case asserting the harness call sequence
explicitly via the `onCall` array from R5.

## Sequencing

Order minimises file thrash and lets each PR ship behind its own diff:

1. **R3** (`subprocess.ts` + `errors.ts`) — adds `HarnessIdleTimeoutError`.
2. **R2** (`subprocess.ts` + `errors.ts`) — adds
   `UnsupportedPermissionError`. Same file as R3, ship together.
3. **R4** (`types.ts` + `orchestrator.ts` + `cli.ts`) — type tightening.
   Pure type-level once R3 is in.
4. **R1** (`orchestrator.ts` + `types.ts` + `services/runManifest.ts`)
   — the substantive behavioural change. Adds `'interrupted'` status and
   `withRunFinalizer`.
5. **R5** + **R6** (`runWorkspace.test.ts`) — test cleanup, depends on
   R1 for the new interrupted-status assertion. Ship as one PR.

## Verification

- `pnpm check` (oxlint + tsc) passes after each step.
- `pnpm test` passes after each step.
- Manual: kill `factory run` mid-step with SIGINT, restart with
  `factory resume <runId>`; expect a clear "interrupted" message,
  not a corrupt-resume failure.
