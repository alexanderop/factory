---
title: '@factory/steps-sdd'
description: Reference SDD step bundle — plan, ralph, verify, qa, simplify.
sidebar:
  order: 6
editUrl: https://github.com/alexanderop/factory/edit/main/apps/docs/src/content/docs/packages/steps-sdd.md
---

The reference markdown bundle for the spec-driven-development pipeline. Each
file is a step prompt with frontmatter — drop them into your `.factory/steps/`
or import them from this package.

- **Source:** [`packages/steps-sdd`](https://github.com/alexanderop/factory/tree/main/packages/steps-sdd)
- **Steps:**
  - `plan` — read the PRD, produce vertical slices.
  - `ralph` — iterate on a slice until an exit condition holds.
  - `verify` — confirm the resulting diff satisfies the PRD.
  - `qa` — typecheck + tests + optional browser QA.
  - `simplify` — remove smells introduced during ralph.

See the [feature spec](/feature-specs/factory/) for the full SDD arc.
