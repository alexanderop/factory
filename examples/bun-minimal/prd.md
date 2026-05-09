# Feature: tiny string utility library

Build a small TypeScript utility module under `./target/`.

The module should export three pure functions from `target/strings.ts`:

- `kebabCase(input: string): string` — lowercase, words separated by single
  hyphens, no leading/trailing hyphens (e.g. `"Hello World"` → `"hello-world"`,
  `"  foo   BAR  "` → `"foo-bar"`).
- `pascalCase(input: string): string` — each word capitalised, no separators
  (e.g. `"hello world"` → `"HelloWorld"`, `"foo-bar_baz"` → `"FooBarBaz"`).
- `slugify(input: string): string` — lowercase, ASCII-safe URL slug; strip
  diacritics, replace non-alphanumerics with single hyphens, trim hyphens
  (e.g. `"Crème Brûlée!"` → `"creme-brulee"`).

## Acceptance

- All three functions live in `target/strings.ts`.
- Tests live in `target/strings.test.ts` using Bun's built-in test runner
  (`import { test, expect } from "bun:test"`).
- `bun test target/` passes.
- Each function has at least three test cases covering edge cases (empty
  string, multiple separators, mixed case).
- No external dependencies — only the standard library and `bun:test`.
