# sdd-quickstart

Minimal example of the reference SDD pipeline. The target codebase is a small
Vue 3 + Vite + Nuxt UI to-do app under [`./app`](./app), and `feature.md` asks
the pipeline to add dark mode to it.

## Quick start (from repo root)

```bash
pnpm install
pnpm aspire:up    # start Aspire Dashboard (Docker) → http://localhost:18888
pnpm example      # run the sdd pipeline against ./feature.md
pnpm aspire:down  # stop the dashboard when you're done
```

`pnpm aspire:logs` tails the dashboard container if you need it.

The pipeline is defined in `.factory/factory.ts` and step prompts live under
`.factory/steps/`. The pipeline runs from this directory, so `feature.md`
points the agents at `./app` for the actual code changes.

## Run the to-do app

To see what the pipeline is editing, run the app directly:

```bash
pnpm --filter sdd-quickstart-app dev      # http://localhost:5173
pnpm --filter sdd-quickstart-app build    # production build
pnpm --filter sdd-quickstart-app typecheck
```

Out of the box it ships with light mode only — adding dark mode is the
pipeline's job.

## Running directly

If you'd rather run the CLI yourself:

```bash
cd examples/sdd-quickstart
pnpm factory run sdd --prd ./feature.md
```

Useful flags:

- `--cwd <dir>` — run the pipeline against a different repo
- `--idle-timeout <seconds>` — bound each step
- `--no-otel` — disable OpenTelemetry export

## Viewing traces with Aspire Dashboard

Factory exports OTLP/gRPC traces to `localhost:4317` by default, which matches the
[Aspire Dashboard](https://learn.microsoft.com/dotnet/aspire/fundamentals/dashboard/standalone)
out of the box. You don't need a .NET Aspire app — the dashboard ships as a standalone
Docker image.

`pnpm aspire:up` runs the equivalent of:

```bash
docker run -d --rm --name factory-aspire \
  -p 18888:18888 \
  -p 4317:18889 \
  -e DASHBOARD__OTLP__AUTHMODE=Unsecured \
  -e DASHBOARD__FRONTEND__AUTHMODE=Unsecured \
  mcr.microsoft.com/dotnet/aspire-dashboard:9.0
```

- `18888` — web UI at http://localhost:18888
- `4317` (host) → `18889` (container OTLP/gRPC)
- `Unsecured` skips the login-token dance for local dev; drop those envs for auth.

To point at a different collector, set `OTEL_EXPORTER_OTLP_ENDPOINT`:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://my-collector:4317 pnpm example
```

### What you'll see

Service `factory` with a span tree per run:

```
factory.run                  (factory.pipeline=sdd)
├── factory.step             (factory.step=plan, factory.harness=claude-code, factory.run.id=…)
├── factory.step             (… step=ralph …)
├── factory.step             (… step=verify …)
├── factory.step             (… step=qa …)
└── factory.step             (… step=simplify …)
```

Each `factory.step` span wraps the harness subprocess call, so its duration is the
wall-clock time the LLM took. Use `factory.run.id` to correlate spans with the
`run.start` / `step.*` / `run.end` events emitted by the orchestrator.

**Disabling**: `--no-otel` flag, or `OTEL_SDK_DISABLED=true` env var.
