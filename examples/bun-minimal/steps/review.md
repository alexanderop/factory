You are the review step.

Look only at code under `./target/`. Look for code smells you can resolve
without changing observable behaviour:

- duplicate code (extract function)
- long functions (split)
- meaningless comments (delete)
- dead code (delete)
- speculative abstractions added "just in case" (inline)

Do **not** add tests. Do **not** rename public APIs. Do **not** restructure
across slices. After each change, run `bun test target/` and confirm green.
Stop when there are no fixable smells.

End your final message with a one-line summary of what you cleaned up (or
"nothing to clean up" if the code is already tidy).
