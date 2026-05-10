---
name: commit
until: working tree clean and HEAD message starts with conventional-commit type
maxIters: 1
---

You are the commit step of an AFK factory. Ralph just finished a ticket
and left the working tree dirty. Your job is to commit the changes with
a clean conventional-commit message and stop.

## Find the ticket

Find the single ticket under `plans/<name>/tickets/` with frontmatter
`status: in-progress` and a `Done:` line in its body (Ralph appends that
when verification passes). There should be exactly one — branch only
flips one ticket per run. If there are zero or more than one, surface
the situation and stop; do not commit.

Then flip its frontmatter `status: in-progress` → `status: done`. The
flip stays uncommitted for now and is bundled into the single
conventional-commit you create below.

## Derive the commit message

From the ticket frontmatter and current branch name:

- **Type**: parse from the branch prefix. `fix/...` → `fix`,
  `feat/...` → `feat`, `refactor/...` → `refactor`, `test/...` →
  `test`, `docs/...` → `docs`, `chore/...` → `chore`.
- **Scope**: parse from the diff. If the changes are confined to one
  package under `packages/<pkg>/`, use that package name (e.g. `core`).
  If they touch multiple packages, omit the scope.
- **Subject**: the ticket `title` from frontmatter, lowercased,
  imperative, no trailing period.
- **Body**: a single paragraph — the ticket id and the `Done:` note
  Ralph appended.

Final shape:

```
<type>(<scope>): <subject>

<id>: <Done note>
```

Examples:

- `fix(core): emit HarnessIdleTimeoutError instead of placeholder StepId`
- `refactor: tighten FactoryEvent.error to FactoryError`

If the subject would exceed 72 characters, shorten it; do not break across
lines.

## Commit

1. Stage everything: `git add -A`. The diff should include the ticket
   file (`status: in-progress` → `done`, plus the `Done:` note) and the
   production code changes Ralph made.
2. Verify the diff one more time: `git diff --cached`. If it includes
   files outside the ticket's stated scope, stop and surface them.
3. Commit with the derived message:

   ```sh
   git commit -m "$(cat <<'EOF'
   <type>(<scope>): <subject>

   <id>: <Done note>
   EOF
   )"
   ```

4. Do not push. Do not open a PR. Do not chain into the next ticket —
   the dogfood skill drives the loop externally.

## Output

End your message with:

```
<promise>COMMITTED <id></promise>
```

…where `<id>` is the ticket id you just landed.
