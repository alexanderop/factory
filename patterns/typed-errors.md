# Typed errors

Effects in factory have _typed_ error channels. Every failure mode is a
`Data.TaggedError` subclass with structured fields. No generic `Error`, no
`unknown`, no `throw`.

> Source of truth: `packages/core/src/errors.ts` (the canonical set),
> `repos/effect/packages/effect/src/Data.ts` for `Data.TaggedError`.

## Defining a tagged error

```ts
import { Data } from 'effect';
import type { HarnessName, StepId } from './ids.ts';

export class HarnessExecError extends Data.TaggedError('HarnessExecError')<{
  readonly message: string;
  readonly harness: HarnessName;
  readonly exitCode: number;
  readonly stderr: string;
}> {}
```

Conventions:

- **Class name = tag string.** `HarnessExecError` extends
  `Data.TaggedError('HarnessExecError')`. Don't deviate — the agent and
  reader rely on this 1:1 mapping.
- **Always include `message: string`.** It's what `formatErrorMessage`
  renders (`error-handler.ts`). Other fields are diagnostic — IDs, exit
  codes, paths — kept structured so callers can inspect without parsing
  strings.
- **Use branded ID types** (`HarnessName`, `StepId`, ...) for any field
  that's actually an ID. See `patterns/branded-ids.md`.
- **All fields `readonly`.** Errors are values, not records to mutate.
- **One file: `errors.ts`.** Every `Data.TaggedError` lives here, with the
  union `FactoryError` at the bottom. New errors get added to both.

## Constructing

```ts
return (
  yield *
  Effect.fail(
    new HarnessExecError({
      message: `harness '${harnessName}' exited with code ${exitCode}`,
      harness: harnessName,
      exitCode,
      stderr: stderr.trim(),
    }),
  )
);
```

The constructor takes the field bag. `_tag` is set automatically by
`Data.TaggedError`. Don't pass `_tag` yourself.

## The `FactoryError` union

`errors.ts` ends with:

```ts
export type FactoryError =
  | StepLoadError
  | HarnessNotFoundError
  | HarnessExecError
  | HarnessSpawnError
  | StepIdleTimeoutError
  | StepMaxItersError
  | UntilEvalError
  | MissingHarnessError
  | PrdLoadError
  | ConfigLoadError;
```

This is the public error channel of `Factory.runEffect`. Every public Effect
in the orchestrator has `FactoryError` (or a subset) in its E parameter.
**Adding a new tagged error means adding it to this union** — otherwise the
typed-error channel doesn't see it.

## Narrowing

The `_tag` discriminant is automatic and exhaustive:

```ts
.pipe(
  Effect.mapError((e) =>
    e._tag === 'StepIdleTimeoutError'
      ? new StepIdleTimeoutError({ message: e.message, step: stepId, timeoutMs: e.timeoutMs })
      : e,
  ),
)
```

For multi-tag handling, prefer `Effect.catchTag` / `Effect.catchTags`:

```ts
fs.readFileString(resolved).pipe(
  Effect.catchTag('SystemError', (e) =>
    e.reason === 'NotFound'
      ? Effect.succeed(prd)
      : Effect.fail(new PrdLoadError({ message: e.message, path: resolved })),
  ),
  Effect.catchTag('BadArgument', (e) =>
    Effect.fail(new PrdLoadError({ message: e.message, path: resolved })),
  ),
);
```

Don't write `instanceof HarnessExecError`. The `_tag` check is shorter and
also works for plain objects (e.g. errors that crossed a serialization
boundary). `instanceof` is fine in tests where you have the runtime class
in scope, but never in production handler code.

## Catching unknowns at the boundary

When a third-party API throws, wrap the boundary in `Effect.tryPromise` /
`Effect.try` and convert the thrown value to a tagged error:

```ts
Effect.tryPromise({
  try: () => import(candidate),
  catch: (e) =>
    new ConfigLoadError({
      message: `failed to import ${candidate}: ${e instanceof Error ? e.message : String(e)}`,
      cwd,
    }),
});
```

Same shape for `Schema.decodeUnknown` errors — see `patterns/schema-at-the-edge.md`.
The boundary's job is _converting_ exotic failures into the tagged-error
channel; once converted, errors flow through the typed channel and downstream
code never sees `unknown`.

## Tests: structural assertions

```ts
const exit = await Effect.runPromiseExit(program);
expect(Exit.isFailure(exit)).toBe(true);
if (Exit.isFailure(exit)) {
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === 'Some') {
    expect(failure.value._tag).toBe('StepMaxItersError');
  }
}
```

Or `instanceof` if you have the class in scope (e.g. in `loader.test.ts`):

```ts
expect(failure._tag === 'Some' && failure.value instanceof StepLoadError).toBe(true);
```

`failure.value` is already typed as the error union (because
`runFactoryEffect` declares `FactoryError` in its E). No casting needed.

## Don't

- **Don't `throw`.** Use `Effect.fail(new SomeError({...}))`.
- **Don't use `Error` directly** for typed failures. `Error` is a defect
  channel concern — it'll surface as an unhandled cause, not in the typed
  E. Fine for `formatErrorMessage` to fall back on, not for the orchestrator
  to produce.
- **Don't widen `E` to `unknown`.** If a sub-Effect's E doesn't fit the
  parent's, `Effect.mapError` it into one that does — like the orchestrator
  does for `StepIdleTimeoutError` (rebuilding it with the real `stepId`).
- **Don't put non-serialisable values in error fields** (functions, layers).
  Errors get stringified, logged, sent over OTel. Keep fields to ids,
  numbers, strings.
- **Don't add a new error class without adding it to `FactoryError`.** It's
  the union that makes the channel typed.
