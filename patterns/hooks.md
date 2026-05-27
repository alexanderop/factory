# Hooks

A single uniform hook API across every harness factory drives (`claude-code`,
`codex`, `copilot`). Users write hook handlers once; factory translates them
into each harness's native hook config and serves the requests in-process.

> Source of truth: this file. Per-harness hook surfaces:
> [Claude Code](https://docs.claude.com/en/docs/claude-code/hooks),
> [Codex](https://developers.openai.com/codex/hooks),
> [Copilot](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference).
> All three converged on the same vocabulary (PreToolUse / PostToolUse /
> SessionStart / Stop) — this spec leans on that overlap.

## Status

Implemented and wired end-to-end:

- The 7-event vocabulary, `HookConfig`, matcher, and decision merge.
- In-process **Effect handlers** — the default and the only handler type that
  runs today.
- The orchestrator dispatching events while it streams the harness, plus the
  run-scoped unix-socket server that lets a real CLI call back synchronously.
- All three harness adapters (claude-code / codex / copilot) + the codex
  `factory-hook` shim.

Not yet implemented (no-op → allow, tracked):

- `command` / `http` / `prompt` handler types (parity shims for users porting
  existing hooks). The Effect handler covers the in-process case.
- The per-harness escape hatch (`harnessHooks` / `PerHarnessHookConfig`).
- Decision **enforcement** beyond the socket control path (see "How it works").

## Goal

One `HookConfig` per step, dispatched to user handlers, regardless of which
harness runs the step. Plus a capability-gated escape hatch for harness-native
events (Claude's `PreCompact`, Copilot's `subagentStart`, …).

## Non-goals

- Pretending every harness emits every event. The factory event vocabulary is
  the 7-event common subset. Per-harness extras live behind `harnessHooks`.
- Reproducing Claude Code's matcher DSL byte-for-byte. We borrow the JSON I/O
  shape, not the matcher grammar.

## Architecture: factory is the hook server

The live hooks layer (`hooksLayer`, injected via `FactoryOptions.hooks`) opens
an HTTP server on a per-run unix socket under `os.tmpdir()`. Per iteration the
`HookTransport` writes that harness's native hook config, pointing every
configured event at a context-carrying callback URL on the socket:

```
POST /hook/:harness/:runId/:stepId/:iter/:event
```

The run context lives in the URL because the CLI's native payload only carries
the tool/input — never factory's `runId`/`stepId`/`iter`. When the harness
fires a hook, factory recovers the context from the URL, normalises the native
body into a `FactoryHookEvent`, dispatches it to the user's handlers, and
replies with the harness's native decision JSON.

Codex only supports `command` handlers natively. The Codex adapter installs a
shim binary (`factory-hook`, `packages/harness-codex/src/factory-hook.ts`) that
reads stdin, POSTs it to the socket, and writes the response to stdout — so
Codex's `command` hook becomes the same HTTP request the other harnesses make
directly. From the user's view this is invisible.

### Two dispatch sources, one handler run (the gating rule)

Two things can produce a hook event, both routed through the same
`HookRunner.dispatch`:

1. **The orchestrator**, while it streams the harness, synthesises events it can
   observe from the stream + iter boundaries (`sessionStart` before the stream,
   `preToolUse`/`postToolUse`/`postToolUseFailure` from tool events, `stop`
   after). This path is **observe-only** — the stream events are post-hoc, so a
   decision can't change what the harness already did.
2. **The socket server**, when a real CLI calls back. This path **can block**:
   the CLI waits for the decision and obeys it.

To run each user handler exactly once, the transport reports which events it
delivers natively (`nativeEvents`), and the orchestrator dispatches only the
complement. With a real claude-code (all 7 native) the socket drives everything;
with no transport (scripted integration tests) the orchestrator drives
everything; codex's synthesised `postToolUseFailure` always comes from the
stream. See `D1` in the implementation plan.

### Seams (why core never imports `@factory/hooks`)

Core defines two structural `Context.Tag`s in
`packages/core/src/services/HookRunner.ts` and depends only on them:

- **`HookRunner`** — `dispatch(event) => Effect<HookDecision>`. `noopHookRunner`
  / `recordingHookRunner` (tests) live in core; `liveHookRunner` (runs the
  user's `HookConfig`) lives in `@factory/hooks`.
- **`HookTransport`** — `prepareStep({ runId, stepId, harnessName, iter })`
  writes the per-iter native config and returns `{ env, extraArgs, nativeEvents }`
  the orchestrator merges into the harness spawn. `noopHookTransport` is the
  default; the live socket server is in `@factory/hooks`.

The live implementations are composed by `hooksLayer({ config, adapters })` and
injected at the top via `FactoryOptions.hooks`, so the dependency direction
stays harness/hooks → core, never the reverse.

## Common event vocabulary

The seven events factory dispatches uniformly. Names mirror Claude Code's
(they're the most established, Codex/Copilot already follow them).

| Event                | Fires                             | Can block? | Native on                              |
| -------------------- | --------------------------------- | ---------- | -------------------------------------- |
| `sessionStart`       | Harness session begins (per iter) | no         | all 3                                  |
| `userPromptSubmit`   | Iter prompt sent to the model     | yes        | all 3                                  |
| `preToolUse`         | Before a tool call                | yes        | all 3                                  |
| `postToolUse`        | After a tool call succeeds        | no         | all 3                                  |
| `postToolUseFailure` | After a tool call fails           | no         | Claude, Copilot (synthesized on Codex) |
| `stop`               | Assistant turn finishes           | yes        | all 3                                  |
| `permissionRequest`  | Permission dialog about to appear | yes        | all 3                                  |

## `FactoryHookEvent` payload (Schema)

The payload every handler receives, after factory normalises the harness's
native shape:

```ts
type FactoryHookEvent =
  | {
      readonly _tag: 'sessionStart';
      readonly runId: RunId;
      readonly stepId: StepId;
      readonly iter: number;
      readonly harness: HarnessName;
      readonly source: 'startup' | 'resume';
    }
  | {
      readonly _tag: 'userPromptSubmit';
      readonly runId: RunId;
      readonly stepId: StepId;
      readonly iter: number;
      readonly harness: HarnessName;
      readonly prompt: string;
    }
  | {
      readonly _tag: 'preToolUse';
      readonly runId: RunId;
      readonly stepId: StepId;
      readonly iter: number;
      readonly harness: HarnessName;
      readonly tool: string;
      readonly input: Record<string, unknown>;
      readonly toolCallId: string;
    }
  | {
      readonly _tag: 'postToolUse';
      readonly runId: RunId;
      readonly stepId: StepId;
      readonly iter: number;
      readonly harness: HarnessName;
      readonly tool: string;
      readonly input: Record<string, unknown>;
      readonly output: Record<string, unknown>;
      readonly toolCallId: string;
      readonly durationMs: number;
    }
  | {
      readonly _tag: 'postToolUseFailure';
      readonly runId: RunId;
      readonly stepId: StepId;
      readonly iter: number;
      readonly harness: HarnessName;
      readonly tool: string;
      readonly input: Record<string, unknown>;
      readonly error: string;
      readonly toolCallId: string;
    }
  | {
      readonly _tag: 'stop';
      readonly runId: RunId;
      readonly stepId: StepId;
      readonly iter: number;
      readonly harness: HarnessName;
      readonly lastAssistantMessage: string;
    }
  | {
      readonly _tag: 'permissionRequest';
      readonly runId: RunId;
      readonly stepId: StepId;
      readonly iter: number;
      readonly harness: HarnessName;
      readonly tool: string;
      readonly input: Record<string, unknown>;
    };
```

Definition lives in `packages/hooks/src/events.ts`, declared with
`Schema.TaggedStruct` (see `patterns/schema-at-the-edge.md`).

## `HookDecision` (handler return shape)

```ts
type HookDecision =
  | { readonly action: 'allow' }
  | { readonly action: 'allow'; readonly updatedInput: Record<string, unknown> }
  | { readonly action: 'allow'; readonly additionalContext: string }
  | { readonly action: 'deny'; readonly reason: string }
  | { readonly action: 'ask'; readonly reason: string }
  | { readonly action: 'block'; readonly reason: string }; // stop-event only
```

Handler returns `undefined` → treated as `{ action: 'allow' }`. Merging rules
when multiple handlers fire for the same event:

1. **Deny short-circuits.** First `deny` wins; later handlers don't run.
2. **`ask` beats `allow`.** Lowest-trust wins.
3. **`additionalContext` strings concatenate** (`\n\n` joined).
4. **`updatedInput` is replaced** (last writer wins; warn in debug).
5. **`block` (stop event only) collects reasons** joined with `\n`.

## Handler types

Four shapes, mirroring Claude Code's set minus `mcp_tool` and `agent` (both
Claude-only — surface them under `harnessHooks` if needed):

```ts
type HookHandler =
  | EffectHandler // (event) => Effect<HookDecision | void>
  | CommandHandler // exec a process, JSON in stdin, JSON out stdout
  | HttpHandler // POST to URL, JSON in, JSON out
  | PromptHandler; // send to a Claude model, returns {ok, reason}
```

`EffectHandler` is the default — typed, in-process, the obvious choice in an
Effect-native runtime, and **the only handler type wired today**. The other
three are accepted by `HookConfig` but currently no-op (allow); they're parity
shims for users porting existing hooks and will land with their own transports.

Failure policy: an Effect handler that **defects** (throws) is a bug and crashes
the run (fail-stop) rather than being silently swallowed — the repo lint forbids
`catchAllCause`. `EffectHandler`'s signature has no error channel, so there are
no "expected" failures to catch here; the fail-closed-for-blockable policy
belongs to the command/http/prompt transports once they exist.

## `HookConfig` (user-facing)

```ts
interface HookConfig {
  readonly sessionStart?: ReadonlyArray<HookEntry<'sessionStart'>>;
  readonly userPromptSubmit?: ReadonlyArray<HookEntry<'userPromptSubmit'>>;
  readonly preToolUse?: ReadonlyArray<HookEntry<'preToolUse'>>;
  readonly postToolUse?: ReadonlyArray<HookEntry<'postToolUse'>>;
  readonly postToolUseFailure?: ReadonlyArray<HookEntry<'postToolUseFailure'>>;
  readonly stop?: ReadonlyArray<HookEntry<'stop'>>;
  readonly permissionRequest?: ReadonlyArray<HookEntry<'permissionRequest'>>;
}

interface HookEntry<E extends FactoryHookEvent['_tag']> {
  readonly match?: HookMatcher; // optional filter; omitted = match all
  readonly handler: HookHandler; // function | { type: 'command' | 'http' | 'prompt' }
}

type HookMatcher =
  | string // exact tool name, e.g. 'Bash'
  | { readonly tool?: string | RegExp } // structured
  | ((event: FactoryHookEvent) => boolean);
```

Per-harness escape hatch (capability-gated at builder time) — **not yet
implemented**:

```ts
interface PerHarnessHookConfig {
  readonly 'claude-code'?: ClaudeNativeHooks;
  readonly codex?: CodexNativeHooks;
  readonly copilot?: CopilotNativeHooks;
}
```

## Using hooks

Build the live layer with `hooksLayer({ config, adapters })` and pass it as
`FactoryOptions.hooks`. Each harness exports its adapter alongside the harness:

```ts
import { factory } from '@factory/core';
import { claudeCode, claudeHooksAdapter } from '@factory/harness-claude-code';
import { hooksLayer } from '@factory/hooks';
import { Effect } from 'effect';

const pipeline = factory({
  name: 'my-pipeline',
  harness: 'claude-code',
  harnesses: [claudeCode],
  hooks: hooksLayer({
    config: {
      // deny any Bash hook that tries to run `rm -rf`
      preToolUse: [
        {
          match: 'Bash',
          handler: (event) =>
            String(event.input.command ?? '').includes('rm -rf')
              ? Effect.succeed({ action: 'deny', reason: 'destructive command blocked' })
              : Effect.succeed({ action: 'allow' }),
        },
      ],
      // observe-only: a Stop handler can't block, but it sees every turn
      stop: [{ handler: (event) => Effect.log(`turn done: ${event.lastAssistantMessage}`) }],
    },
    adapters: [claudeHooksAdapter],
  }),
}).step('build', 'steps/build.md');

await pipeline.run({ prd: './feature.md' });
```

Omit `hooks` entirely and the orchestrator runs with the no-op runner/transport
— zero overhead, no socket. The adapters list only needs the harnesses you
actually run; `hooksLayer` routes callbacks to the right adapter by name.

## Harness adapter contract

Each `harness-*` package exports an adapter (built with `makeJsonAdapter`):

```ts
interface HarnessHookAdapter {
  readonly name: HarnessName;
  readonly supportedEvents: ReadonlySet<HookEventType>;
  // writes the per-iter native config; `runId`/`stepId`/`iter` are baked into
  // the callback URL so the server can recover the run context
  readonly writeConfig: (args: {
    readonly socketPath: string;
    readonly events: ReadonlyArray<HookEventType>;
    readonly outDir: string;
    readonly runId: RunId;
    readonly stepId: StepId;
    readonly iter: number;
  }) => Effect.Effect<
    { env?: Record<string, string>; extraArgs?: ReadonlyArray<string> },
    ConfigLoadError,
    FileSystem | Path
  >;
  // native callback body → event-specific fields (merged with run context)
  readonly decodeRequest: (a: { event: HookEventType; body: unknown }) => Record<string, unknown>;
  // dispatched decision → harness-native response JSON
  readonly encodeDecision: (a: { event: HookEventType; decision: HookDecision }) => unknown;
}
```

`writeConfig` runs per iteration via `HookTransport.prepareStep`; it returns the
env vars / extra args the harness needs to pick up the config (e.g.
`--settings <path>` for Claude, `-c hooks_path=…` for Codex). The three adapters
share a best-effort `decodeNativeRequest` / `encodeNativeDecision` codec
(`packages/hooks/src/native.ts`) that aliases the common field names; a harness
overrides them only if its native shape diverges. A field the codec can't find
degrades to a default, and the runner re-validates via `Schema` and fails open
on a bad decode — so a missing field never wedges the harness.

### Per-harness support matrix

| Event                | claude-code | codex       | copilot |
| -------------------- | ----------- | ----------- | ------- |
| `sessionStart`       | native      | native      | native  |
| `userPromptSubmit`   | native      | native      | native  |
| `preToolUse`         | native      | native      | native  |
| `postToolUse`        | native      | native      | native  |
| `postToolUseFailure` | native      | synthesized | native  |
| `stop`               | native      | native      | native  |
| `permissionRequest`  | native      | native      | native  |

"synthesized" = factory observes `tool.end ok:false` from the harness event
stream and runs the handler client-side. Decision shape: handler runs, but
the result can't be fed back to the harness (no native control point) — used
for observability only.

## Errors

```ts
class HookCapabilityError extends Data.TaggedError('HookCapabilityError')<{
  readonly message: string;
  readonly harness: HarnessName;
  readonly event: string;
}> {}
```

`HookCapabilityError` (in `packages/hooks/src/adapter.ts`) is thrown by
`assertSupports` when a harness is asked to deliver an event it doesn't support,
so misconfig surfaces while building the native config rather than at dispatch.

`HookDispatchError` (a wrapper for handler/transport failures) is **planned but
not yet defined** — it lands with the command/http/prompt transports, where
expected, typed errors actually exist. Today: handler defects crash (fail-stop)
and a bad native decode fails open.

## Testing

Tier conventions from `patterns/testing-effect.md` apply unchanged:

- **Unit** (`*.unit.test.ts`): dispatcher + matcher + adapter file-shape
  snapshots. Pure data. No HTTP, no Effect runtime.
- **Integration** (`*.test.ts`): hooks-in-orchestrator with scripted harness +
  in-memory workspace. Mirrors `runWorkspace.test.ts` shape. Assert on event
  sequence, handler call log, and Exit shape.
- **E2E** (`tests/e2e/hooks/`): one real-CLI smoke per harness, API-key-gated.

Test helpers:

- `recordingHookRunner` (in `@factory/core`) — capture dispatched events into a
  `Ref` for end-of-test assertion (mirrors `recordingEventEmitter`). Wired via
  `makeTestRig({ hookEventsRef })`.
- `noopHookRunner` / `noopHookTransport` — the defaults; hand-built test layers
  must include them since both seams are required.
- `assertAdapterContract` (`@factory/hooks/testing`) — the shared adapter
  file-shape suite.

## File layout

```
packages/core/src/services/HookRunner.ts   # HookRunner + HookTransport seams (Tags),
                                            # noop/recording runners, noopHookTransport
packages/hooks/src/
  events.ts         # FactoryHookEvent Schema + tag union (_tag discriminant)
  decision.ts       # HookDecision Schema + merge logic
  config.ts         # HookConfig user-facing type
  matcher.ts        # match() pure fn
  dispatcher.ts     # dispatch(config, event) -> Effect<HookDecision>
  adapter.ts        # HarnessHookAdapter contract + buildHookEvent + HookCapabilityError
  adapterHelpers.ts # makeJsonAdapter
  native.ts         # decodeNativeRequest / encodeNativeDecision (shared codec)
  runtime/
    HookRunner.ts   # liveHookRunner (runs the user's HookConfig)
    server.ts       # hooksLayer: unix-socket server + live HookTransport
  testing/
    adapterContract.ts
```

Per-harness adapters + the codex shim live in their packages:
`packages/harness-{claude-code,codex,copilot}/src/hooksAdapter.ts` and
`packages/harness-codex/src/factory-hook.ts`.
