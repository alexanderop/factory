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
