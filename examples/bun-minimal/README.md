# bun-minimal-quickstart

The whole `factory` orchestrator collapsed into a ~100-line Bun script —
hardcoded `plan → ralph → review` against `claude-code`, no harness
abstraction, no Effect, no run manifests.

```
.
├── run.ts                # the orchestrator
├── run.test.ts           # unit tests + fake-bin smoke test
├── prd.md                # the feature spec the agent works from
├── steps/
│   ├── plan.md           # write IMPLEMENTATION_PLAN.md as a checklist
│   ├── ralph.md          # tick off slices one at a time, signal COMPLETE
│   └── review.md         # behaviour-preserving cleanup
└── tests/fixtures/
    └── fake-claude.ts    # emits stream-json so tests don't need real claude
```

## Run it

You need the `claude` CLI installed.

```bash
cd examples/bun-minimal
bun install            # installs @types/bun
bun run.ts             # plan → ralph → review against ./prd.md
bun run.ts --dry-run   # print prompt sizes without spawning claude
```

The agent writes `IMPLEMENTATION_PLAN.md` next to this README and the
generated code under `./target/`. Both are gitignored.

## Test the wiring

```bash
bun test
```

Tests cover the prompt builder, the stream-json parser, the step config, and
end-to-end `runStep` behaviour against a fake `claude` binary
(`tests/fixtures/fake-claude.ts`) — so they pass with no API spend and no
real `claude` install.

## What this leaves out vs. the real factory

- harness abstraction (only `claude-code`, only `--dangerously-skip-permissions`)
- frontmatter parsing (step config is hardcoded in `STEPS`)
- run manifests, resume, otel
- `until:` shell predicates (only substring checks)
- iter-prompt history (each iter sees a fresh prompt)
- tool-call span recording

If you want any of those, use `@factory/core` instead. This example exists to
show the shape of the inner loop.
