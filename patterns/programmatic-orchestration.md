# Programmatic orchestration

The declarative `factory().step().review()` builder is one entrypoint. The
**programmatic** entrypoint — `factory(...).workflow(name, body)` — runs an
arbitrary Effect that calls primitives directly. Both share the same runtime
layer (workspace, events, display, OTel, harness registry, hooks). The builder
is unchanged; this is purely additive.

> Source of truth: `packages/core/src/workflow/*.ts`,
> `packages/core/src/services/AgentSequence.ts`, `examples/workflow-quickstart/`.

## The surface

```ts
factory({ name, harnesses: [claudeCode] })
  .workflow('triage', (ctx) =>
    Effect.gen(function* () {
      yield* ctx.phase('classify');
      const reviews = yield* ctx.parallel(
        files.map(
          (f) => () => ctx.agent(`review ${f}`, { schema: ReviewSchema, label: `review-${f}` }),
        ),
      );
      const kept = reviews.filter(Boolean);
      yield* ctx.phase('summarize');
      yield* ctx.agent(`summarize ${JSON.stringify(kept)}`);
    }),
  )
  .run({ args: { files }, budget: 1_000_000 });
```

`ctx = { agent, parallel, pipeline, phase, log, args, budget }`.

### `agent<A=string>(prompt, opts?)`

`opts: { harness?, schema?: Schema.Schema<A>, permissions?, label?, phase? }`.
Returns `Effect<A, FactoryError, AgentRequirements>`.

- **No `schema`** → returns the **last** assistant message text (`''` if the
  harness emitted none — it never fails for "no message").
- **With `schema`** → sets `$FACTORY_STEP_OUTPUT` to the iter output file,
  decodes it through `readOutput`, returns the typed `A`.

Harness and permission resolution use the frontmatter-free cascade:
`opts.harness ?? ctx default ?? factory({harness})`, and
`opts.permissions ?? ctx default ?? factory.permissions ?? harness.default ?? 'prompt'`.

### `parallel(thunks, { concurrency? })`

Barrier with bounded concurrency. **Failures become `null`** (via
`Effect.option`) so one bad agent doesn't sink the batch — callers
`.filter(Boolean)`. The combinator itself never fails.

### `pipeline(items, stages, { concurrency? })`

**No barrier between stages.** Each item flows through every stage
independently, so stage 2 of item A can run while stage 1 of item B is still
going. Stages share one carried type `T` (`T -> Effect<T>`).

### `phase(title)` / `log(msg)`

`phase` emits a `phase.start` event, records it, opens a `factory.phase` span,
and sets the current phase (attached to subsequent `agent.start` events).
`log` is display-only.

## Identity: `agents/<seq>-<label>/`

Programmatic workflows can't pre-enumerate calls, so they don't use the
`stepOrd` integer. `AgentSequence` (a service holding an atomic `Ref`) hands out
a strictly-monotonic `AgentSeq` per `agent()` call across the **whole** run.
Each agent records under `agents/<pad(seq,3)>-<slug(label)>/` (parallel to
`steps/<ord>-<id>/`), with its own `agent.json` + `iters/<n>/`. `slugify` strips
`/` and whitespace so a label is always a safe directory segment. The agent
layout uses a **dedicated** `agentEntriesRef` — it never touches the declarative
`stepEntriesRef`.

## Budget (soft ceiling)

`budget` is a `Ref<number>` of spent **output** tokens, fed by each iteration's
`result` event. `agent()` checks it **before** starting; an exhausted budget
fails with `BudgetExhaustedError`. Because tokens arrive _after_ the harness
call, the budget can overshoot by one agent's output — there is no mid-stream
rollback. Concurrent agents can also overshoot (read-then-act). Treat it as a
ceiling on _starting_ work, not a hard cap.

## Resume (Strategy B: generalized manifest)

Resume is **replay-by-short-circuit**, not a global plan. On resume the body
re-runs; `AgentSequence` is seeded to `maxRecordedSeq + 1` so it never reuses a
directory. Each `agent()` calls `findResumableAgent(seq, promptHash, optsHash)`:

- recorded `'ok'` **and** hashes match → return the recorded output, skip the
  harness.
- missing / non-`ok` / hash mismatch → run for real and overwrite.

**Determinism contract:** the body must re-execute deterministically up to the
first incomplete agent — same `agent()` call order ⇒ same seq alignment. Bodies
that branch on wall-clock / `Math.random` / changed prior outputs break
alignment. A `promptHash`/`optsHash` mismatch downgrades a silent wrong-replay
into a safe re-run rather than returning stale output. The output **schema** is
part of `optsHash` (its canonical AST JSON), so changing the schema forces a
re-run.

## Events

The `FactoryEvent` union is widened with `phase.start`, `agent.start`,
`agent.end` (carrying `seq`/`label`, **not** `step`). Consumers that narrow on
`'step' in event` stay correct; exhaustive switches need new arms.
`BudgetExhaustedError` joins the `FactoryError` union (new `_tag`).

## Testing

- Build the rig with `makeWorkflowRig({ harnesses, runDir, cwd, defaultHarness, budget })`
  — `makeTestRig` plus the `AgentSequence` + `WorkflowContext` layers.
- **Use `routedHarness` (responder keyed by prompt/label), not `cycledHarness`,**
  for `parallel()`/`pipeline()`: concurrent fan-out has non-deterministic call
  order. Assert on the call **set**, not the sequence.
- Provide a real `runDir` under a temp dir so you can read `agents/<seq>-<label>/agent.json`
  off disk, exactly like the step tests read `steps/<ord>-<id>/step.json`.
- Narrow failures with `assertExitFailedWith(exit, BudgetExhaustedError)` etc.
