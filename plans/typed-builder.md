---
name: typed-builder
description: Make `factory()` carry compile-time information about registered harnesses and declared steps so misspellings and references to undeclared things are TypeScript errors instead of runtime errors. Types-only; runtime unchanged.
type: plan
status: done
created: 2026-05-09
---

# Typed factory builder

Make `factory()` carry compile-time information about registered harnesses and
declared steps, so that misspellings and references to undeclared things are
TypeScript errors instead of runtime errors.

This spec is **types-only**. Runtime behaviour is unchanged. Any change that
touches runtime is out of scope and goes in a follow-up spec.

## Problem

Today the public API in `packages/core/src/types.ts` is fully stringly-typed:

```ts
factory({
  name: 'demo',
  harnesses: [claudeCode, codex], // Harness.name is `string`
})
  .step('plan', 'plan.md', { harness: 'claude-cod' }) // typo, runtime fail
  .step('build', 'build.md', { harness: 'gpt' }); // not registered, runtime fail
```

Symptoms:

- `Harness.name: string` — literal name is lost the moment the harness is
  constructed.
- `factory({ harness, harnesses })` — no type-level link between the default
  `harness` and the names in `harnesses`.
- `.step(id, source, { harness })` — `harness` accepts any string. Step `id`
  is a bare string with no record of previously declared IDs.
- `Factory` is a single non-generic type, so it can't accumulate either set.

The runtime already brands these into `HarnessName` / `StepId` at the
orchestrator boundary (`orchestrator.ts:170,173`), but the public surface
never benefits.

## Goals

1. `harnesses: [...]` infers a literal-string union of harness names without
   requiring the user to write `as const`.
2. `factory({ harnesses, harness })` constrains the default `harness` to that
   union.
3. `.step(id, source, { harness })` constrains `harness` to that union.
4. Step IDs accumulate in the `Factory` type so future features (cross-step
   references, typed `until` context) can build on them.
5. No runtime change. No breaking change for users who pass plain strings —
   they just get fewer type errors caught.

## Non-goals (future specs)

- Typing the `until` expression or its evaluation context.
- Typing `RunState` / step outputs.
- Generating types from `StepFrontmatter` parsed at build time.

## Sketch

### 1. Carry the literal name on `Harness`

```ts
// types.ts
export interface Harness<Name extends string = string> {
  readonly name: Name;
  readonly exec: (...) => Effect.Effect<...>;
  readonly stream: (...) => Stream.Stream<...>;
}
```

```ts
// subprocess.ts
export interface SubprocessHarnessConfig<Name extends string = string> {
  readonly name: Name;
  readonly bin: string;
  readonly buildArgs: (prompt: string) => ReadonlyArray<string>;
}

export const createSubprocessHarness = <Name extends string>(
  config: SubprocessHarnessConfig<Name>,
): Harness<Name> => {
  /* unchanged */
};
```

Then `claudeCode` in `harness-claude-code/src/index.ts` infers as
`Harness<'claude-code'>` automatically — no source change needed there.

### 2. Generic `Factory` accumulating harness + step names

```ts
// Phantom params: Names = registered harness names, StepIds = declared step ids.
export interface Factory<Names extends string = string, StepIds extends string = never> {
  readonly name: string;

  step<Id extends string>(
    id: Exclude<Id, StepIds>, // forbid duplicate ids at compile time
    source: string,
    options?: StepOptions<Names>,
  ): Factory<Names, StepIds | Id>;

  run(options: RunOptions): Promise<void>;
  runEffect(options: RunOptions): Effect.Effect<void, FactoryError>;
}

export interface StepOptions<Names extends string = string> {
  readonly harness?: Names;
  readonly until?: string;
  readonly maxIters?: number;
}
```

### 3. `factory()` infers `Names` from the harnesses array

```ts
export interface FactoryOptions<Names extends string = string> {
  readonly name: string;
  readonly harness?: Names;
  readonly harnesses?: ReadonlyArray<Harness<Names>>;
}

export function factory<const Hs extends ReadonlyArray<Harness>>(
  opts: FactoryOptions<Hs[number]['name']> & { harnesses?: Hs },
): Factory<Hs[number]['name'], never>;
```

The `const` modifier on the type parameter makes literal inference work
without users writing `as const`. If `harnesses` is omitted, `Hs[number]['name']`
collapses to `never`, which means `harness` and `step({harness})` reject any
string — that matches the runtime contract that a harness must come from
_somewhere_ (factory option, step option, or frontmatter), so this is fine for
the explicit-harness path. Frontmatter-driven harnesses still work at runtime;
we just can't validate them at compile time.

### 4. Forbid duplicate step IDs

`Exclude<Id, StepIds>` makes the second `.step('plan', ...)` a type error:
the parameter type narrows to `never`. This is a strict-mode bonus; if it's
too aggressive in practice we drop it and keep just the harness constraints.

## What end-user code looks like after

```ts
const f = factory({
  name: 'sdd',
  harnesses: [claudeCode, codex],
  // harness: 'claude-cod' // ✗ Type '"claude-cod"' is not assignable to '"claude-code" | "codex"'
})
  .step('plan', 'plan.md', { harness: 'claude-code' }) // ✓
  .step('build', 'build.md', { harness: 'gpt' }); // ✗ caught at compile time
```

Errors users hit today (typos, missing harness registration) become red
squigglies in the editor.

## Implementation order

1. `Harness<Name>` + `createSubprocessHarness` generic. Verify
   `claudeCode`/`codex` infer correctly. No call-site changes.
2. `StepOptions<Names>` + `Factory<Names, StepIds>` + generic `factory()`.
   Update `factory.ts` impl signature; runtime body unchanged.
3. Smoke-test with `examples/sdd-quickstart` and any internal callers.
4. Add a `*.test-d.ts` (or `expectTypeOf` in an existing test) that locks in:
   - valid harness names accepted,
   - invalid harness name rejected,
   - duplicate step id rejected,
   - omitting `harnesses` falls back to `string`-permissive (or `never`,
     depending on what we choose in §3).

## Risks

- **Inference noise.** Generic chains can produce ugly hover types. Mitigation:
  keep the public `Factory` interface named (not anonymous), and avoid
  conditional types in user-facing positions where possible.
- **`const` type parameter requires TS ≥ 5.0.** The repo is on TS 5.9 (per
  `examples/sdd-quickstart/package.json`), so we're fine.
- **Duplicate-id check may be too strict.** If users dynamically build steps
  in a loop, `Id` widens to `string` and the check becomes a no-op anyway.
  Worst case it does nothing; it shouldn't break valid code.
- **Frontmatter harness path.** Steps that resolve harness via frontmatter
  bypass compile-time checks. Acceptable for v1; document it.

## Out of scope, but worth noting

- Tests in harness packages (`harness-claude-code`, `harness-codex`,
  `harness-copilot`), `cli`, and `steps-sdd` are absent. Worth a separate
  "test coverage" spec — the typed-builder change above adds type-level
  tests but doesn't address runtime coverage of the harnesses.
