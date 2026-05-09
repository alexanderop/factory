---
name: ci-quality-checks
description: GitHub Actions CI workflow that gates PRs and pushes to main on the same checks `pnpm check` runs locally — typecheck, oxlint, oxfmt, vitest, build — with proper caching, concurrency, and security hardening.
type: plan
---

# Plan: CI quality checks via GitHub Actions

## Goal

Every PR and every push to `main` must pass the same gates a developer runs
locally with `pnpm check`. Today the only `.github/workflows/*.yml` files are
the two Claude wrappers (`claude.yml`, `claude-code-review.yml`) — there is no
test/lint/typecheck CI. Merging a broken `main` is a matter of forgetting to
run `pnpm check` once.

We want:

- A single `ci.yml` workflow that runs on `pull_request` and `push: main`.
- Same gates as `pnpm check` (`build`, `typecheck`, `lint`, `format:check`,
  `test`), parallelised so feedback is fast.
- Cached pnpm store + cached `tsc --incremental` outputs.
- Security-hardened: SHA-pinned actions, least-privilege `permissions:`,
  `cancel-in-progress` for PR pushes only.
- A stable required-status-check name that branch protection on `main` can be
  pinned to.

## Non-goals (this iteration)

- No test sharding, no coverage upload, no Codecov. Ten test files; not worth
  the wiring yet.
- No release / publish pipeline. Packages are `private: true`.
- No Astro `apps/docs` deploy. Deferred to a separate workflow.
- No `repos/effect/` involvement — it is excluded from `tsconfig`, `oxlint`,
  and `pnpm-workspace.yaml`; CI inherits that.
- No matrix over Node versions. `package.json` pins `engines.node: ">=22"` and
  the production target is one Node version. Add later only if we publish.
- No Turborepo / Nx remote cache. Pure `pnpm -r` is fine at this scale.
- No path-filter / selective CI. With ~10 test files and 6 packages the whole
  graph runs in well under a minute; selective CI would be churn before it is
  payoff.

## Workflow shape

One workflow file: `.github/workflows/ci.yml`.

### Triggers

```yaml
on:
  pull_request:
  push:
    branches: [main]
```

PRs from forks: GitHub fires `pull_request` (read-only `GITHUB_TOKEN`,
no secrets) — sufficient for our gates. We do **not** need
`pull_request_target`; nothing here writes to the repo or needs secrets.

### Concurrency

Cancel superseded PR runs; never cancel a `main` run mid-flight.

```yaml
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

`github.ref` differs per PR (`refs/pull/<n>/merge`) and per push, so each PR
serialises against itself but PRs do not block each other.

### Permissions

Workflow-level least privilege — every job overrides only if it needs more
(none of these do).

```yaml
permissions:
  contents: read
```

### Jobs

Five jobs run in parallel after a shared install step. All depend on the same
`setup` composite action so we only encode the install recipe once.

| Job         | Runs                              | Why a separate job              |
| ----------- | --------------------------------- | ------------------------------- |
| `typecheck` | `pnpm -r typecheck`               | Slowest gate; isolate it        |
| `lint`      | `pnpm lint` (oxlint --type-aware) | Type-aware lint also needs deps |
| `format`    | `pnpm format:check` (oxfmt)       | Cheap; fast feedback            |
| `test`      | `pnpm test` (vitest run)          | Independent failure surface     |
| `build`     | `pnpm -r build`                   | Catches package-graph drift     |

> Note: `build` and `typecheck` overlap because `tsconfig.base.json` has
> `noEmit: true` — both effectively run `tsc`. We keep both because `pnpm -r
build` exercises the `pnpm` topology (workspace deps, `allowBuilds`) and
> `typecheck` runs at the workspace root with `tsconfig.json` that excludes
> `packages/`. They catch different breakages.

All jobs run on `ubuntu-latest`. No matrix.

### Required status check (single rollup)

To make branch protection easy, add an `all-green` job that depends on every
other job and is the only required check:

```yaml
all-green:
  if: always()
  needs: [typecheck, lint, format, test, build]
  runs-on: ubuntu-latest
  steps:
    - if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')
      run: exit 1
```

Why a rollup job: required-check names in branch protection are _literal
strings_. If we required `typecheck` directly and later split it, we'd have
to update branch protection. `all-green` decouples branch-protection config
from the job graph.

## Composite setup action

Create `.github/actions/setup/action.yml`:

```yaml
name: Setup
description: Install pnpm + Node + workspace deps with caching.
runs:
  using: composite
  steps:
    - uses: pnpm/action-setup@<sha> # v4.x
      # version omitted — read from package.json#packageManager
    - uses: actions/setup-node@<sha> # v4.x
      with:
        node-version-file: package.json # reads engines.node ">=22" — pin if flaky
        cache: pnpm
    - shell: bash
      run: pnpm install --frozen-lockfile
```

Notes:

- `pnpm/action-setup` reads the version from `packageManager` in
  `package.json` when no `version:` is given — so updating pnpm in the repo
  also updates CI.
- `cache: pnpm` on `setup-node@v4` keys on `pnpm-lock.yaml` and caches the
  pnpm store. No manual `actions/cache` needed.
- `--frozen-lockfile` is the CI default for pnpm but we set it explicitly so
  this stays correct if the repo `.npmrc` ever changes.
- `better-sqlite3` is in `pnpm-workspace.yaml#allowBuilds`, so its postinstall
  runs without prompt. `ubuntu-latest` ships with the build toolchain it
  needs.

## Security hardening

- **Pin every external action by full 40-char SHA**, with the version as a
  trailing comment (`uses: actions/checkout@<40-char> # v4.2.2`). Mutable
  tags have been hijacked multiple times in 2025–2026 (tj-actions,
  trivy-action). SHA-pin is the only immutable reference today.
- **No secrets in this workflow.** `GITHUB_TOKEN` defaults to read-only via
  the workflow-level `permissions:` block.
- **No `pull_request_target`.** PRs from forks still run; they just can't
  reach secrets — exactly what we want for a quality-gate workflow.
- **No script injection surfaces.** No `${{ github.event.* }}` substituted
  into `run:` blocks.

## Caching

`setup-node@v4` with `cache: 'pnpm'` covers the pnpm store. We do **not**
cache `node_modules` directly — pnpm's content-addressed store + the lockfile
hash makes that redundant and occasionally wrong.

Optional follow-up (not in v1): cache `**/*.tsbuildinfo` keyed on
`pnpm-lock.yaml + tsconfig*.json` hash. `tsconfig.base.json` already sets
`incremental: true`. Skip until typecheck times become a problem.

## Vitest reporting

Vitest 1.3+ auto-enables the `github-actions` reporter when
`process.env.GITHUB_ACTIONS === 'true'`, so failures surface as inline PR
annotations with no config change. We must **not** override `reporters` in
`vitest.config.ts` without re-adding `github-actions`. Current config does
not set `reporters`, so we are fine.

## Migration / rollout

1. Add `.github/actions/setup/action.yml` and `.github/workflows/ci.yml`.
2. Open the PR for this plan; the workflow will gate itself on first run.
3. Once green on `main`, set branch protection on `main`:
   - Require `all-green` to pass before merge.
   - Require branches to be up to date.
   - Disable force-push, deletion.
4. Optionally remove `lefthook.yml` lint/format hooks later; keeping them is
   fine — they're a developer convenience, CI is the gate.

## Risks & open questions

- **`pnpm -r build` with Astro.** `apps/docs` has its own `build` script that
  runs `astro build`. On the first CI run we'll see whether that succeeds in
  a clean environment without the content bridge state. If it doesn't, two
  options: (a) run `pnpm -r --filter '!@factory/docs' build` in CI for now,
  (b) fix the bridge to be CI-safe. Decide on first red.
- **Native module compile failures.** `better-sqlite3` builds from source on
  Node 22 + ubuntu-latest. If install gets slow, we can switch to a
  prebuilt-binary mirror; not a v1 concern.
- **First-run flakiness on action SHAs.** Pin SHAs from each action's latest
  v4 tag at write time and add a comment with the tag for human readers.
  Dependabot can keep them current (`.github/dependabot.yml` for
  `package-ecosystem: github-actions` is a small follow-up).

## Implementation checklist

- [ ] `.github/actions/setup/action.yml` — composite install action.
- [ ] `.github/workflows/ci.yml` — five parallel jobs + `all-green` rollup.
- [ ] Pin all `uses:` to SHAs with version comments.
- [ ] Verify locally: `act` or push a draft PR.
- [ ] Update branch protection on `main` to require `all-green`.
- [ ] (Optional) `.github/dependabot.yml` for `github-actions` ecosystem.
