---
paths:
  - "**/cli/**/*.ts"
  - "**/cli/**/*.js"
  - "**/cli/**/*.mjs"
  - "**/cli/**/*.py"
  - "**/cli/**/*.go"
  - "**/cli/**/*.rs"
  - "**/cli/**/*.cs"
  - "**/cli.ts"
  - "**/cli.js"
  - "**/cli.mjs"
  - "**/cli.py"
  - "**/cli.go"
  - "**/cli.rs"
  - "**/cli.cs"
  - "**/commands/**/*.ts"
  - "**/commands/**/*.js"
  - "**/commands/**/*.mjs"
  - "**/commands/**/*.py"
  - "**/commands/**/*.go"
  - "**/commands/**/*.rs"
  - "**/commands/**/*.cs"
  - "**/cmd/**/*.go"
  - "**/bin/*"
---

# CLI Rules (Small-Language Grammar)

This project's command-line interface is a public, small language. Apply these rules to any
change in command registration, arguments, options, help, output, or errors.

- **Grammar:** `app <noun> <verb> [<object>] [--modifier value]`. One verb vocabulary
  (`list`, `get`, `create`, `update`, `delete`, plus domain verbs), one spelling per
  operation, nouns all singular or all plural. No operation spelled as a flag.
- **Positionals** are identities only; every other input is a long option. Never a boolean
  positional. Short aliases only for common interactive flags, one meaning tree-wide.
- **Help** is generated from the same declarations the parser uses, at every level, shows
  defaults, and never has side effects.
- **stdout is the payload** only. Errors, warnings, progress, and prompts go to stderr.
  `--format json` prints one valid JSON document and nothing else.
- **Errors** start with `error:`, name the bad input, suggest the fix when there is one.
- **Exit codes:** 0 success, 1 failure or a declined prompt, 2 usage error (including a
  missing `--yes` when there is no terminal to prompt), 130 interrupted (unless this project
  documents a different contract; then keep that one).
- **Color**, decided per stream, first match wins: a `--color`/`--no-color` flag; then
  `FORCE_COLOR` (`0`/`false` off, anything else on); then a non-empty `NO_COLOR` (off); then
  `TERM=dumb` (off); otherwise on only when that stream is a terminal.
- **Prompts** only on a terminal; destructive commands take `--yes`, and changes to shared
  state offer `--dry-run`.
- **Compatibility:** before changing a command or option, search the repository for callers
  and update them in the same change. Keep old syntax with
  `warning: '<old>' is deprecated and will be removed. Use '<new>'.` on stderr unless the
  user approved a hard break.
- **Tests** run the real entry point and cover help, exit codes, the stdout/stderr split,
  and each deprecation path.

For design, audits, and refactors, use the `cli` skill. The path globs that load this rule are
generic defaults; narrow them to this project's layout.
