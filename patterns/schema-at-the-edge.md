# Schema at the edge

Lint enforces `typescript/consistent-type-assertions: never` — `as` casts are a
build error. Anywhere unknown data enters the system (file I/O, dynamic
imports, parsed frontmatter, error objects from third-party libs), validate it
at the boundary. Inside the boundary, types are real.

> Source of truth: `repos/effect/packages/effect/src/Schema.ts`,
> `repos/effect/packages/effect/src/Predicate.ts`. Real refactor in this repo:
> `packages/core/src/services/StepLoader.ts`,
> `packages/core/src/error-handler.ts`, `packages/cli/src/cli.ts`.

## Rule of thumb

- **Data-shaped values** (parsed JSON, YAML, frontmatter, env, HTTP bodies) →
  `Schema.decodeUnknown` produces a typed value or a `ParseError`.
- **Behavior-shaped values** (objects with methods — modules, plugins,
  user-supplied callbacks) → structural type guard built from
  `Predicate.isRecord` + `typeof` checks. Schema can't decode methods.
- **Error sniffing** (Node error codes, third-party library errors) →
  `Predicate.isRecord` + property check. Don't reach for `instanceof` unless
  the class is yours.

`Schema` and `Predicate` together replace every `as` cast we used to write.

## Pattern: data at the edge with `Schema`

Define the schema as a runtime const, infer the type from it. One source of
truth. This is exactly what `StepFrontmatter` does in
`packages/core/src/types.ts`:

```ts
import { Schema } from 'effect';

export const StepFrontmatter = Schema.Struct({
  name: Schema.optional(Schema.String),
  harness: Schema.optional(Schema.String),
  until: Schema.optional(Schema.String),
  maxIters: Schema.optional(Schema.Number),
});
export type StepFrontmatter = typeof StepFrontmatter.Type;
```

Decode at the boundary; map parse errors into one of your tagged errors so
they flow through the typed-error channel:

```ts
import { Effect, Schema } from 'effect';
import { StepFrontmatter } from '../types.ts';
import { StepLoadError } from '../errors.ts';

const decodeFrontmatter = Schema.decodeUnknown(StepFrontmatter);

const parseStep = (path: string, raw: string) =>
  Effect.gen(function* () {
    const parsed = matter(raw);
    const frontmatter = yield* decodeFrontmatter(parsed.data).pipe(
      Effect.mapError(
        (e) =>
          new StepLoadError({
            message: `invalid frontmatter in ${path}: ${e.message}`,
            path,
          }),
      ),
    );
    return { ...frontmatter, path };
  });
```

Two things matter:

1. **Hoist the decoder** (`const decodeFrontmatter = Schema.decodeUnknown(StepFrontmatter)`) instead of constructing it inside the hot path. Decoder construction parses the AST.
2. **`mapError` into a project tagged error.** Don't let `ParseError` escape
   beyond the boundary — your callers shouldn't have to know about Schema's
   error type. Convert it to a `Data.TaggedError` from `errors.ts`.

## Pattern: behavior at the edge with `Predicate.isRecord`

Schema can't decode methods. For module loading, plugin registration, or any
"this should look like a `Foo` with these methods" check, write a structural
type guard using `Predicate.isRecord`:

```ts
import { Predicate } from 'effect';
import type { Factory } from '@factory/core';

const isFactory = (v: unknown): v is Factory =>
  Predicate.isRecord(v) &&
  typeof v.name === 'string' &&
  typeof v.step === 'function' &&
  typeof v.run === 'function' &&
  typeof v.runEffect === 'function';
```

`Predicate.isRecord(v)` narrows `v` from `unknown` to
`{ [x: string | symbol]: unknown }`. Inside the rest of the `&&` chain, `v.foo`
type-checks (it's `unknown`, narrowed by the `typeof` checks). No `as`, no
`'foo' in v` boilerplate.

Use the guard at the boundary:

```ts
const mod = result.right;        // unknown — from Effect.tryPromise(import(...))
if (!Predicate.isRecord(mod)) {
  return yield* Effect.fail(new ConfigLoadError({ ... }));
}
const def = mod.default ?? mod[name];   // unknown
if (!isFactory(def)) {
  return yield* Effect.fail(new ConfigLoadError({ ... }));
}
return def;                       // Factory — narrowed
```

## Pattern: error sniffing with `Predicate.isRecord`

Node errors, third-party library errors, anything coming back from
`Effect.tryPromise(... catch: (e) => e)` — all `unknown`. Don't `instanceof
Error` unless that gives you the discriminant you need. Sniff the property:

```ts
const isModuleNotFound = (e: unknown): boolean =>
  Predicate.isRecord(e) && e.code === 'ERR_MODULE_NOT_FOUND';

const isTagged = (e: unknown): e is { readonly _tag: string; readonly message?: string } =>
  Predicate.isRecord(e) && typeof e._tag === 'string';
```

After `Predicate.isRecord(e)`, `e.code` is `unknown`. `=== 'ERR_MODULE_NOT_FOUND'` works (`unknown === string` is a valid comparison and narrows). For more elaborate shape checks, chain `typeof` checks; the predicate's return type is the narrowed shape.

## When a value comes from your own code

If you're in a private module and the call site already has a typed value,
**don't decode**. Schema and `isFactory` are for _boundaries_. Inside the
boundary, types are real and `as` was never needed in the first place. The
lint rule that bans `as` is what stops this drift.

## Don't

- Don't `as`. Anywhere. The lint rule is the moat.
- Don't catch `ParseError` from Schema and re-throw — `Effect.mapError` it
  into a project tagged error so callers stay on the typed-error channel.
- Don't define the same schema in two places. If `StepFrontmatter` exists in
  `types.ts`, import it; don't re-declare a near-identical struct in a
  service file.
- Don't use `Predicate.hasProperty` / `'foo' in obj` chains when
  `Predicate.isRecord` + a follow-up `typeof` would be tighter.
- Don't decode behavior. If the value has methods, structural-guard it.
