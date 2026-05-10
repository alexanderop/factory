---
name: pr
until: 'output contains: <promise>PR-OPENED</promise>'
maxIters: 1
---

You are the PR step of a factory pipeline. Ralph has finished — the
current branch holds one commit per ticket and all gates are green.
Your job is to push the branch and open a pull request.

## Inputs

- `$FACTORY_RUN_DIR/plan.md` — for the PR title (`title:` frontmatter)
  and the ticket list to summarise in the body.
- `git log main..HEAD --oneline` — the actual commits on the branch.
- The current branch name (`git rev-parse --abbrev-ref HEAD`).

## Push

```sh
git push -u origin <current-branch>
```

If the remote rejects the push, surface the error and stop — do not
force-push. (Branch names are scoped per-PRD and shouldn't collide in
practice.)

## Open the PR

Use `gh pr create` with:

- `--title` from `plan.md`'s `title:` frontmatter, verbatim.
- `--body` containing:
  - A 1–3 sentence summary derived from the plan's `## Approach`.
  - A `## Tickets` section listing each `Tn — <subject>` from the plan
    with a checkbox (`- [x] T1 — …`) since they're all landed.
  - A `## Test plan` section listing the gates that passed
    (`pnpm typecheck`, `pnpm lint`, `pnpm test`) plus any new tests
    the plan called out.

Pass the body via a HEREDOC so formatting is preserved:

```sh
gh pr create --title "<title>" --body "$(cat <<'EOF'
<body markdown>
EOF
)"
```

## Constraints

- Do **not** force-push.
- Do **not** modify the working tree, the PRD, or the plan.
- Do **not** open the PR against anything other than `main`.
- Do not retry on transient `gh` failures more than once — surface and
  stop.

## Signaling completion

After `gh pr create` succeeds and prints the PR URL, end your final
message with this exact token on its own line:

```
<promise>PR-OPENED</promise>
```
