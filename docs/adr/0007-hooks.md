# ADR 0007 — Unified hook authoring across harnesses

## Status

Accepted

## Context

Factory runs AI agents (Claude Code, Codex CLI, GitHub Copilot) via per-harness CLI invocations. Each harness has its own hook/extension mechanism with different configuration formats, different event names, and different capability levels (e.g. Codex lacks prompt-style approval hooks). Users who want to enforce policies (deny dangerous paths, audit tool calls, format files post-write) had to duplicate config for each harness they use.

## Decision

Introduce `packages/hooks` — a TypeScript-first hook authoring layer that:

1. **TypeScript-only authoring.** Hook specs are written in `.factory/hooks.ts` using the `Hook` builder DSL. No JSON/YAML config files authored by hand. Rationale: type safety, composability, and the ability to use arbitrary logic in `Hook.effect` handlers without needing a separate scripting language.

2. **Both tiers desugar to the same execution path.** `Hook.rule` (declarative) and `Hook.effect` (escape hatch) both produce a `HookSpec` with a stable `HookId`. The per-harness config file always invokes `factory-hook <event> --hook <id>`, which re-imports `.factory/hooks.ts` at runtime and runs the handler. This avoids a two-tier system where simple rules are handled by the harness natively and complex rules require a separate runtime.

3. **`Hook.ask` deny-fallback on harnesses that lack prompt support.** Codex CLI and GitHub Copilot CLI do not support interactive approval prompts. When an `ask` spec is emitted for these harnesses, the emitter logs a warning and substitutes `deny`. Claude Code supports `ask` natively.

4. **`Hook.modify` is PreToolUse-only.** The `ModifyDecision` type (which lets a hook rewrite tool arguments) only makes sense before a tool call executes. The type system enforces this: `Hook.modify` is not in scope for `PostToolUse` handlers.

5. **Errors live in `FactoryError`.** `HookCompileError`, `HookRuntimeError`, and `HookConfigError` are `Data.TaggedError` subclasses added to the `FactoryError` union in `packages/core`. This keeps the error taxonomy centralized without requiring `packages/core` to import `packages/hooks` (which would create a circular dependency).

6. **Codex flag refuse-with-fix-it.** Codex hooks require `[features] codex_hooks = true` in `~/.codex/config.toml` or `.codex/config.toml`. `HookCompiler.compile` with `checkCodexFlag: true` reads both locations and fails with `HookConfigError` including a copy-pasteable fix when the flag is absent.

7. **Per-pipeline compile target.** Hook config files are written to `${runDir}/.hooks/<harness>/` (or `${cwd}/.factory/.hooks/<harness>/` for project-level pre-compilation). Each run gets its own compiled config so that concurrent runs don't interfere.

## Consequences

- Users write `.factory/hooks.ts` once; `factory run` compiles it automatically for the configured harness before each run.
- Adding a new harness requires implementing `HookEmitterService` (one method: `emit(specs, runDir)`). The rest of the pipeline (compile, runtime) is harness-agnostic.
- `Hook.effect` handlers run in a child process (`factory-hook`), not in the harness process. This means handlers can use arbitrary Node.js APIs but cannot share in-process state with the harness.
- Circular dependency between `packages/hooks` and `packages/core` is avoided: `packages/hooks` imports error types from `packages/core`; `packages/core` does not import from `packages/hooks`. Hook compilation happens at the CLI layer, which depends on both.
