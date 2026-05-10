# @factory/hooks

Write hooks once; factory compiles them for every harness (Claude Code, Codex CLI, GitHub Copilot).

## Install

`packages/hooks` is a workspace package — no manual install needed inside the monorepo. For standalone use:

```sh
pnpm add @factory/hooks
```

## Quick start

Create `.factory/hooks.ts` in your project root:

```ts
import { Effect } from 'effect';
import { Hook } from '@factory/hooks';

export default [
  // Deny reads/writes to secrets
  Hook.denyPaths(['**/.env*', '**/*.pem', '**/secrets/**']),

  // Deny shell commands that could destroy history
  Hook.denyCommands(['rm -rf', 'git push --force']),

  // Format files after every write
  Hook.formatOnWrite({ run: 'prettier --write' }),

  // Audit every tool call to a local log
  Hook.auditLog({ to: '.factory/audit.log' }),

  // Custom logic via an Effect handler
  Hook.effect({
    on: 'preToolUse',
    handler: (event) =>
      event.toolName === 'Bash' && event.command?.includes('sudo')
        ? Effect.succeed(Hook.deny('sudo is not allowed'))
        : Effect.succeed(Hook.allow),
  }),
];
```

Then run your pipeline normally — `factory run` detects `.factory/hooks.ts` and compiles it automatically:

```sh
factory run my-pipeline --prd ./PRD.md
```

## Builder API

### Rule builders (declarative)

| Builder                          | Event         | Effect                                         |
| -------------------------------- | ------------- | ---------------------------------------------- |
| `Hook.denyPaths(patterns)`       | `preToolUse`  | Deny tool calls that read/write matching paths |
| `Hook.denyCommands(patterns)`    | `preToolUse`  | Deny Bash commands matching patterns           |
| `Hook.formatOnWrite({ run })`    | `postToolUse` | Run a format command after file writes         |
| `Hook.auditLog({ to })`          | `preToolUse`  | Log all tool calls to a file                   |
| `Hook.rule({ on, decide, ... })` | any           | Generic rule with full option set              |

### Effect handler

```ts
Hook.effect({
  on: 'preToolUse' | 'postToolUse' | 'sessionStart' | 'stop' | 'permissionRequest',
  handler: (event: HookEvent) => Effect.Effect<HookDecision, HookRuntimeError>,
});
```

### Decision constructors

| Constructor          | Meaning                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `Hook.allow`         | Permit the tool call                                               |
| `Hook.deny(reason?)` | Block the tool call                                                |
| `Hook.ask(prompt)`   | Ask user (Claude Code only; falls back to deny on other harnesses) |
| `Hook.modify(args)`  | Rewrite tool arguments (preToolUse only)                           |

## CLI commands

```sh
# List all specs from .factory/hooks.ts
factory hooks list

# Compile hooks for a specific harness to a given directory
factory hooks compile --harness claude-code --run-dir .factory

# Check what decision a hook would produce for a given event
factory hooks check '{"_tag":"PreToolUseEvent","toolName":"Bash","command":"echo hi"}'
```

## Supported harnesses

| Harness       | `ask` support           | Config format   | Env var set                                    |
| ------------- | ----------------------- | --------------- | ---------------------------------------------- |
| `claude-code` | Yes (prompt)            | `settings.json` | `FACTORY_HOOK_HARNESS=claude-code`             |
| `codex`       | No (falls back to deny) | `config.toml`   | `FACTORY_HOOK_HARNESS=codex`, `CODEX_HOME=...` |
| `copilot`     | No (falls back to deny) | `config.json`   | `FACTORY_HOOK_HARNESS=copilot`                 |

### Codex prerequisite

Codex hooks require `[features] codex_hooks = true` in `~/.codex/config.toml` or `.codex/config.toml`. If the flag is absent, `factory run` (and `factory hooks compile --harness codex`) will refuse with a message explaining how to add it.

## How it works

1. `factory run` loads `.factory/hooks.ts` via dynamic import and compiles it to a per-harness config file (e.g. `settings.json` for Claude Code).
2. The harness config tells the harness to call `factory-hook <event> --hook <id>` before/after each tool use.
3. `factory-hook` re-imports `.factory/hooks.ts`, looks up the spec by id, runs the handler, and writes the decision as JSON to stdout.
4. The harness reads the decision and allows, denies, or modifies the tool call accordingly.
