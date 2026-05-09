# Branded IDs

Strings that mean different things — `runId`, `stepId`, `harnessName`,
`pipelineName` — are distinct _types_, not just distinct _names_. The agent
will pass a `harnessName` where a `stepId` was wanted unless the type system
stops it.

> Source of truth: `packages/core/src/ids.ts` (the four brands),
> `packages/core/src/orchestrator.ts` (the branding boundary),
> `repos/effect/packages/effect/src/Brand.ts` for `Brand.nominal`,
> `repos/effect/packages/effect/src/Schema.ts` (`Schema.brand` ~line 3197).

## The four brands

`packages/core/src/ids.ts` is the single source. Each brand is a `Schema` so
it integrates with `StepFrontmatter` decoding _and_ exposes a `.make()`
constructor for runtime branding.

```ts
import { Schema } from 'effect';

export const RunId = Schema.String.pipe(Schema.brand('RunId'));
export type RunId = typeof RunId.Type;

export const StepId = Schema.String.pipe(Schema.brand('StepId'));
export type StepId = typeof StepId.Type;

export const HarnessName = Schema.String.pipe(Schema.brand('HarnessName'));
export type HarnessName = typeof HarnessName.Type;

export const PipelineName = Schema.String.pipe(Schema.brand('PipelineName'));
export type PipelineName = typeof PipelineName.Type;
```

Two surfaces from one definition:

- **The schema** — used in `Schema.Struct` (e.g. `StepFrontmatter`) so decoded
  values come out branded.
- **`.make()`** — the runtime constructor: `HarnessName.make('claude-code')`.

At runtime, branded values are strings. `=== 'claude-code'`, `.toLowerCase()`,
`.includes(...)` — all still work. The brand is a TypeScript phantom that
disappears at compile.

## Public API stays `string`

The DSL (`factory()`, `.step()`, frontmatter, `Harness.name`) accepts
`string` from the user. **Brand at the orchestrator boundary, not the API
boundary.** Compare:

```ts
// Good — the user writes plain strings
factory({ name: 'sdd', harness: 'claude-code' }).step('plan', './plan.md');

// Wrong — never make the user do this
factory({
  name: PipelineName.make('sdd'),
  harness: HarnessName.make('claude-code'),
}).step(StepId.make('plan'), './plan.md');
```

The branding happens once, inside the orchestrator. After that, internal code
gets full type safety without the user paying for it.

## The branding boundary

`packages/core/src/orchestrator.ts` is where strings become brands. Once.

```ts
const runId = RunId.make(randomUUID());
const pipeline = PipelineName.make(factoryOpts.name);
// ...
for (const entry of steps) {
  const stepId = StepId.make(entry.id);
  const harnessName =
    (entry.options.harness ? HarnessName.make(entry.options.harness) : undefined) ??
    loaded.frontmatter.harness ?? // already HarnessName from Schema
    (factoryOpts.harness ? HarnessName.make(factoryOpts.harness) : undefined);
  // ...everything below is fully typed
}
```

Note: `loaded.frontmatter.harness` is already `HarnessName | undefined`
because `StepFrontmatter` schema declares it that way. **Decoding through
Schema is the cheapest way to brand**: no manual `.make()` calls, just trust
the decode.

## Other branding sites

- **`createSubprocessHarness`** (`subprocess.ts`): brands `config.name` once
  at the top: `const harnessName = HarnessName.make(config.name)`. All
  errors raised from the harness use `harnessName`, not `config.name`.
- **`scriptedHarness`** (`testing/scriptedHarness.ts`): same pattern, brands
  in the `HarnessExecError` construction.
- **`HarnessRegistry`** (`services/HarnessRegistry.ts`): brands harness
  names at registry construction, so the internal `Map<HarnessName, Harness>`
  is fully typed.
- **`StepLoader`** (`services/StepLoader.ts`): when frontmatter has no
  `name`, falls back to the file path: `frontmatter.name ?? StepId.make(path)`.

## Don't

- **Don't brand at the user-facing API.** `factory.step(id: string, ...)` —
  the parameter is `string`. Brand inside the implementation.
- **Don't import brands at random points.** The branding boundary should be
  obvious: `orchestrator.ts`, `subprocess.ts`, the registry. If a service
  deep in the orchestrator is calling `.make()`, something further out
  forgot to brand.
- **Don't use `as` to brand.** Lint forbids it (and the brand types are
  designed so `as` would be the wrong tool anyway). Use `.make()` or
  Schema decoding.
- **Don't add a brand without a constructor site.** A brand that's never
  built is a dead type. Every brand in `ids.ts` has at least one `.make()`
  call somewhere in the codebase — keep it that way.

## Adding a new brand

1. Define it in `packages/core/src/ids.ts`.
2. Update the type that should carry it (in `types.ts` or `errors.ts`).
3. Either: include the brand schema in a `Schema.Struct` (cheap — no
   `.make()` needed), or call `.make()` at the boundary where the raw
   string enters.
4. Run `pnpm check`. The TypeScript errors are the to-do list — every
   string-typed call site that _should_ be branded surfaces here.
