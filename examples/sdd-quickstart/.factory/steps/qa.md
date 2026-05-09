---
name: qa
until: typecheck and tests both pass
maxIters: 3
---

You are the QA step of an AFK software factory.

Run, in order, whichever of these the project defines:

- `pnpm typecheck` (or `pnpm check:types` / `tsc --noEmit`)
- `pnpm test` (or `pnpm test:run`)
- `pnpm lint` (or `pnpm check:lint`)

If any fails, fix the smallest possible diff to make it pass and re-run that command.
Do not change feature behaviour. Stop when all three pass.

Output JSON to `ctx.state.qa`:

- `typecheck`: 'pass' | 'fail' | 'skipped'
- `tests`: 'pass' | 'fail' | 'skipped'
- `lint`: 'pass' | 'fail' | 'skipped'
