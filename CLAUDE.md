# Agent guide

This repo is built on [Effect](https://effect.website). When you need to know
how Effect works, read source code — not your training data.

## Reference material: `repos/effect/`

`repos/effect/` is a vendored copy of the Effect monorepo, added as a squashed
`git subtree`. Treat it as read-only reference material. It contains:

- `repos/effect/packages/effect` — core (`Effect`, `Layer`, `Schema`, `Data`, `Match`, ...)
- `repos/effect/packages/platform` — `HttpApi`, `HttpClient`, `FileSystem`, `Path`, ...
- `repos/effect/packages/sql` — typed SQL with `SqlClient` / `SqlSchema`
- `repos/effect/packages/cluster`, `packages/workflow` — durable workflows
- `repos/effect/packages/vitest` — `@effect/vitest` test helpers
- `repos/effect/packages/*/examples` and `**/test` — copy these patterns

When you need a pattern (HTTP API, SQL, schema-at-the-edge, workflow, service +
layer wiring, error handling), grep `repos/effect/` first.

To refresh:

```sh
git subtree pull --prefix=repos/effect \
  https://github.com/Effect-TS/effect.git main --squash
```

`repos/` is excluded from `tsconfig`, `oxlint`, and not picked up by
`pnpm-workspace`. Don't import from it — it exists for the agent to read.

## Project patterns: `patterns/*.md`

Distilled, _factory-specific_ subsets of Effect live in `patterns/*.md`. Prefer
those over re-reading `repos/effect/` every turn:

- They lock in the Effect-subset this project has chosen (services, error
  shapes, schema conventions). Effect is huge — without this, you'll end up
  using every feature.
- They are cheap context: a 200-line pattern file beats half the monorepo.

Current patterns:

- `services-and-layers.md` — `Context.Tag` + `Effect.Service` conventions, when
  to use which, layer composition.
- `schema-at-the-edge.md` — `Schema.decodeUnknown` for data, `Predicate.isRecord`
  for behaviour and error sniffing. Lint forbids `as` casts.
- `branded-ids.md` — `RunId`, `StepId`, `HarnessName`, `PipelineName` defined
  in `packages/core/src/ids.ts`; brand at the orchestrator boundary.
- `typed-errors.md` — `Data.TaggedError` shape, `_tag` narrowing, the
  `FactoryError` union.
- `testing-effect.md` — `it.effect` vs plain vitest, the `testing/` test
  doubles, `Ref`-based capture, asserting on `Exit`.

If a pattern is missing for the task at hand:

1. Research `repos/effect/` for the relevant package.
2. Propose `patterns/<topic>.md` with the _factory_ subset.
3. Get it reviewed before implementing against it.

## Testing

The harness is the **only** mockable seam. Workspace, step loader, until evaluator
all use real-ish in-memory impls. Tests assert on user-visible side effects (Exit
shape, event types in order, call sequence, file contents) — never on display
strings or implementation details.

Full pattern in `patterns/testing-effect.md` (canonical shape, factory table,
garbage-output guidance). Short version:

- **Pick a harness factory by intent**, not the bare `scriptedHarness` god-fake:
  - `cycledHarness(name, [r1, r2])` — N sequential calls in known order.
  - `routedHarness(name, responder)` — concurrent fan-out (review roles).
  - `echoHarness(name)` — verify what was _sent_ (cwd / env / permissions).
  - `silentHarness(name)` — verify orchestrator reached this step at all.
  - `flakeyHarness(name, { failAfter: N })` — resume / retry / partial-failure.
  - Wrap any of the above in `capturingScripted(...)` to also capture inbound
    `ExecOpts` for end-of-test assertion.
- **Build the rig in one line:** `const { layer, events } = makeTestRig({ harnesses: [h] })`.
  Don't allocate `displayRef` / `eventsRef` by hand.
- **Narrow failures:** `assertExitFailedWith(exit, ErrorClass)` — collapses the
  `Exit.isFailure` + `Cause.failureOption` + `_tag` + `assertInstanceOf` dance.
- **Review role findings:** `reviewRoleFindings({ roleId, findings })` —
  encapsulates the `steps/<ord>-<stepId>/roles/<id>/findings.json` convention.
  Don't hard-code that path in tests.
- **Per-response options on every `ScriptedResponse`:** `delay` (interruption
  tests), `events` (custom event sequence ending with non-zero exit to simulate
  mid-stream crash), `writes` (materialise files), `exhaust: 'error'` (catch
  over-iteration silently).
- **Garbage-output coverage** lives in `packages/core/src/orchestrator-malformed.test.ts`
  — deliberately feeds malformed JSON / mid-stream crashes / partial writes.
  This is uniquely the scripted layer's job; real-harness e2e can't reproduce
  these reliably.

Three test tiers (vitest projects):

| Tier        | Pattern               | Speed   | What lives here                               |
| ----------- | --------------------- | ------- | --------------------------------------------- |
| unit        | `**/*.unit.test.ts`   | <1s     | pure-data, plain `vitest`, no Effect body     |
| integration | `**/*.test.ts` (rest) | <30s    | scripted harness + in-memory workspace — 99%  |
| e2e         | `tests/e2e/**`        | minutes | real harness on a fixture repo, API-key-gated |

Run with `pnpm test:unit` / `pnpm test:integration` / `pnpm test:e2e`. Plain
`pnpm test` runs all three.

The gold-standard test is `runWorkspace.test.ts:319-419` (e2e crash-and-resume
with a real workspace + scripted harness). When in doubt, mirror its shape.

## Workflow

1. **Fresh agent context per task.** Avoid long sessions that accrete failed
   attempts and biased priors.
2. **Don't bypass diagnostics.** TypeScript errors, oxlint errors, and failing
   tests are the playpen. If a rule blocks you, fix the code or argue for
   removing the rule — don't disable it inline.

## Conventions in this repo

- Effect services use `Effect.Service` (recent commit moved core to this).
- Errors are `Data.TaggedError` with `_tag` discriminants.
- Tests use `@effect/vitest` (`it.effect`, `it.scoped`).
- Package manager is `pnpm`; workspaces are `packages/*` and `examples/*`.
- Lint/format: `oxlint` and `oxfmt`. Both run via `pnpm check`.
