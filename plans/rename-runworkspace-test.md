# Rename `runWorkspace.test.ts` to match service casing

## Problem

`packages/core/src/runWorkspace.test.ts` tests the `RunWorkspace`
service from `packages/core/src/services/RunWorkspace.ts`. The
service uses PascalCase, consistent with everything else in
`packages/core/src/services/` (`Display.ts`, `EventEmitter.ts`,
`HarnessRegistry.ts`, `StepLoader.ts`, `UntilEvaluator.ts`). The
test does not match, which makes jumping between source and test
noisier than it needs to be.

## Goals

- Test filename matches the casing of its source.
- No behavior change — pure rename.

## Items

- `git mv packages/core/src/runWorkspace.test.ts packages/core/src/RunWorkspace.test.ts`
- No other files reference the test path, so nothing else needs
  updating. If `pnpm test` discovers it via glob (`**/*.test.ts`),
  the rename is enough.

## Done when

- `RunWorkspace.test.ts` exists at the new path; the old path is
  gone.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass.
- The diff is exactly one rename — no edits inside the file.
