You are the ralph step.

Read `$FACTORY_PROJECT_PLAN`. If every slice is already `- [x]`, skip to
**Signaling completion** below. Otherwise pick the first unchecked slice — the
first line that begins with `- [ ]` — and implement it:

1. Edit code under `./target/` to satisfy the slice.
2. Run `bun test target/` and read the failure if there is one.
3. Fix the cause and repeat within this iteration until tests are green.

When the slice is complete and tests are green, edit `$FACTORY_PROJECT_PLAN`:
flip the line you picked from `- [ ]` to `- [x]` and append a short note after
the summary describing what shipped (e.g. `- [x] kebab-1: kebabCase
implemented — 4 cases, all green`). Leave the rest of the file untouched.

## Signaling completion

You cannot end the loop yourself — the orchestrator runs you again until it
sees a sentinel marker in your output. When `$FACTORY_PROJECT_PLAN` has zero
unchecked `- [ ]` lines remaining and `bun test target/` is green, end your
final message with this exact token on its own line:

```
<promise>COMPLETE</promise>
```

Do not emit the token while any `- [ ]` slice remains, and do not emit it
while tests are red. Do not quote, paraphrase, or wrap the token in extra
backticks elsewhere in the message — the orchestrator does a simple substring
match.

Do not edit files outside `./target/` and `$FACTORY_PROJECT_PLAN`. Do not
push, commit, or open PRs.
