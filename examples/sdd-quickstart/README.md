# sdd-quickstart

Minimal example of the reference SDD pipeline.

```bash
pnpm install
pnpm factory run sdd --prd ./feature.md
```

The pipeline is defined in `.factory/factory.ts` and step prompts live under `.factory/steps/`.

> Note: `factory` itself is a v0 scaffold — running this currently throws "step runner not implemented yet" from each step. The harness wiring is real; the orchestrator is the next milestone.
