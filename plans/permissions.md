---
name: permissions
description: Configurable permission model so coding harnesses default to autonomous (no prompts), with per-pipeline / per-step / CLI overrides for finer control.
type: plan
---

# Plan: harness permissions

## Goal

A factory user should never see the SDD example hang because Claude Code is
waiting for a permission prompt that nobody can answer. Coding harnesses
(`claude-code`, future `codex`, `copilot`) run autonomously by default, and
the user can tighten the permission scope per pipeline, per step, or for a
single `factory run` invocation.

The current `claude-code` harness invokes `claude -p <prompt>` with no
permission flags. In headless mode every Edit/Write/Bash request is denied
and Claude eventually idles. See
`examples/sdd-quickstart/.factory/runs/5f18873c-…/steps/01-ralph/iters/001/stdout.log`
for the failure mode.

## Non-goals

- Per-tool / per-path allow-deny lists. We may add `{ allow, deny }` arrays
  later; for now a single mode covers the SDD example and any agent run.
- Replacing each harness's native permission system. Factory exposes an
  abstract mode; each harness translates to its own flags.
- Sandboxing. Permissions are about whether prompts appear and what the
  agent is allowed to do — not about OS-level isolation.

## The mode enum

```ts
export type PermissionMode =
  | 'skip' // autonomous, no prompts (Claude: --dangerously-skip-permissions)
  | 'accept-edits' // auto-accept edits, prompt shell (Claude: --permission-mode acceptEdits)
  | 'read-only' // no writes, planning only      (Claude: --permission-mode plan)
  | 'prompt'; // interactive default — useless headless, included for symmetry
```

Each harness maps its own flags. Modes that a harness can't express map to
the closest match (e.g. a future harness with no `read-only` option could
treat it as `prompt`).

## Resolution order

Highest precedence first:

1. CLI flag — `--permissions <mode>` on `factory run`
2. Step option — `factory.step('ralph', src, { permissions: 'accept-edits' })`
3. Step frontmatter — `permissions: read-only` in the step `.md`
4. Pipeline default — `factory({ name, permissions: 'accept-edits' })`
5. Harness default — `claudeCode` declares `defaultPermissions: 'skip'`
6. Built-in fallback — `'prompt'` (safest; surfaces missing config rather
   than silently auto-applying edits)

Why `'prompt'` as the floor and not `'skip'`: a future non-coding harness
that forgets to set `defaultPermissions` should not silently get write
access. Coding harnesses opt into `'skip'` explicitly.

## Surface area

### `packages/core/src/types.ts`

```ts
export type PermissionMode = 'skip' | 'accept-edits' | 'read-only' | 'prompt';

export interface ExecOpts {
  // … existing fields …
  readonly permissions: PermissionMode; // resolved by orchestrator, required
}

export interface StepOptions<Names extends string = string> {
  // … existing fields …
  readonly permissions?: PermissionMode;
}

export interface FactoryOptions<Names extends string = string> {
  // … existing fields …
  readonly permissions?: PermissionMode;
}

export const StepFrontmatter = Schema.Struct({
  // … existing fields …
  permissions: Schema.optional(Schema.Literal('skip', 'accept-edits', 'read-only', 'prompt')),
});
```

`ExecOpts.permissions` is **required** so the harness contract is explicit
— the orchestrator always resolves to a definite value before calling
`harness.exec`.

### `packages/core/src/subprocess.ts`

```ts
export interface SubprocessHarnessConfig<Name extends string = string> {
  readonly name: Name;
  readonly bin: string;
  readonly buildArgs: (
    prompt: string,
    ctx: { readonly permissions: PermissionMode },
  ) => ReadonlyArray<string>;
  readonly defaultPermissions?: PermissionMode;
}
```

`buildArgs` gains a context object (room to grow without further breakage).
`defaultPermissions` is read by the orchestrator during resolution, not by
the subprocess wrapper itself — the wrapper just passes the resolved mode
in.

### `packages/core/src/orchestrator.ts`

Add a single helper:

```ts
const resolvePermissions = (
  cliMode: PermissionMode | undefined,
  step: LoadedStep,
  stepOpts: StepOptions,
  pipeline: FactoryOptions,
  harness: Harness & { readonly defaultPermissions?: PermissionMode },
): PermissionMode =>
  cliMode ??
  stepOpts.permissions ??
  step.frontmatter.permissions ??
  pipeline.permissions ??
  harness.defaultPermissions ??
  'prompt';
```

The CLI passes its mode down through `RunOptions`. To keep the harness
contract narrow, expose `defaultPermissions` on the `Harness` interface:

```ts
export interface Harness<Name extends string = string> {
  readonly name: Name;
  readonly defaultPermissions?: PermissionMode;
  readonly exec: …;
  readonly stream: …;
}
```

`createSubprocessHarness` propagates it from config to interface.

### `packages/harness-claude-code/src/index.ts`

```ts
export const claudeCode = createSubprocessHarness({
  name: 'claude-code',
  bin: 'claude',
  defaultPermissions: 'skip',
  buildArgs: (prompt, { permissions }) => [...claudePermissionFlags(permissions), '-p', prompt],
});

const claudePermissionFlags = (mode: PermissionMode): readonly string[] => {
  switch (mode) {
    case 'skip':
      return ['--dangerously-skip-permissions'];
    case 'accept-edits':
      return ['--permission-mode', 'acceptEdits'];
    case 'read-only':
      return ['--permission-mode', 'plan'];
    case 'prompt':
      return [];
  }
};
```

### `packages/harness-codex/src/index.ts`, `packages/harness-copilot/src/index.ts`

Update to the new `buildArgs` signature. For now, no-op the mode (best-effort
mapping can come later when those harnesses are actually exercised). Set
`defaultPermissions: 'skip'` for both, mirroring claude-code.

### `packages/cli/src/cli.ts`

```ts
const permissionsOption = Options.choice('permissions', [
  'skip',
  'accept-edits',
  'read-only',
  'prompt',
]).pipe(
  Options.withDescription('Override permission mode for this run (top of precedence)'),
  Options.optional,
);
```

Thread through `RunOptions.permissions` → orchestrator → `resolvePermissions`.

### `RunOptions`

```ts
export interface RunOptions {
  // … existing …
  readonly permissions?: PermissionMode;
}
```

## Tests

- `orchestrator.test.ts` — precedence: CLI > step option > frontmatter >
  pipeline > harness default > 'prompt'. Use a scripted harness that
  records the `permissions` it received.
- `loader.test.ts` — `permissions: read-only` in frontmatter parses; an
  invalid value rejects with a schema error.
- `subprocess.ts` — verify `buildArgs` receives the resolved mode (small
  unit test over a fake config).

No live `claude` invocation needed; the integration cost lands at the
example level.

## Verification

After landing, re-run the SDD quickstart:

```sh
pnpm example
```

Expected: ralph step actually edits files, no "I'm blocked" message in
`stdout.log`, no "no stdin data" warning (already fixed separately by
closing stdin in `subprocess.ts`).

## Out of scope, on the radar

- `--permission-prompt-tool` integration (route prompts through an MCP
  server) — useful when a step wants finer human-in-the-loop than
  `accept-edits` allows, but adds a whole MCP plumbing story.
- Per-tool allow/deny lists. The discriminated-union shape was considered
  and parked; revisit when a real use case shows up.
- Mapping `'read-only'` to actual sandboxing. Today it's just "tell the
  agent not to write" — a cooperative, not enforced, contract.
