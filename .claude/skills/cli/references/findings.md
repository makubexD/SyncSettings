# Findings, reports, and validation

## Classes

Every finding gets exactly one class, and the class describes the recommended **change**, not
the defect: it decides what needs an explicit yes. A fix that changes any observable output,
exit code, or accepted syntax for existing users is `BREAKING`, however bad the current
behavior is. Higher in this table outranks lower; order reports by this severity, then by
who is affected.

| Class | Meaning |
|---|---|
| `BREAKING` | Existing command syntax or behavior changes for its users. |
| `COMPATIBILITY` | Only in-repo callers (scripts, CI, docs) must change, and the change is invisible to anyone else. |
| `UX` | A newcomer can discover or understand the command more reliably. |
| `CONSISTENCY` | The same concept gets one name and one shape. |
| `MAINTAINABILITY` | The interface layer becomes easier to change without touching domain logic. |
| `COSMETIC` | Wording or layout only. |

If consumers outside the repository cannot be checked, any syntax change is `BREAKING`.
Findings are not equally important: one `BREAKING` item outweighs ten cosmetic ones, and the
report says so.

## Finding template

```
CLI-4  BREAKING
What:     `users list --format json` prints "Fetching users..." before the JSON.
Evidence: shipit.mjs:18; scripts/ci.sh:3 writes this output to users.json.
Affects:  every script that parses the JSON (stdout changes, so this is BREAKING).
Change:   move the progress line to stderr, or drop it.
```

**Finding ids.** Each finding gets an id `CLI-<n>`, numbered in report order starting at 1. Once
a report is shown, ids never change: later turns, fixes, and approvals quote the same ids, and a
new finding takes the next free number.

Every finding needs evidence a reader can open: a file and line, a help line, a test, or a
command with its actual output. Drop a finding you cannot point at. Cite a line number only
from a numbered read of that one file, and check that the line says what you claim.

## Report: audit (also the first turn of refactor)

```
### Command tree
### Command cards
### Findings            (ordered by severity)
### CURRENT → TARGET    (only recommended changes)
### Approval
### Not verified        (what you could not run or check, and why)
```

A **command card** records one command as it is today: purpose, positionals, options with
defaults, aliases, output (which stream, and its shape: human text, JSON, TSV, which fields),
exit behavior, and one example taken from help or the repository. Narrow changes write the card
for the command they touch.

CURRENT → TARGET shows one line per change:

```
app releases                    →  app release list
app release --deploy production →  app release deploy <version> --environment production
```

After the diff, show the full target command tree so the result reads as one grammar.
For each `BREAKING` or `COMPATIBILITY` row, name the in-repo callers and the migration
(`references/migration.md`). State when a hard break is justified, and leave the decision to the user.

The approval block ends the report:

```
Hold for an explicit yes:
- CLI-3 (BREAKING) deploy takes <version> and options instead of four positionals
Ready when you say to implement:
- CLI-1 (UX) help at every level
```

## Report: design

```
### Proposed grammar     (command tree with usage lines)
### Contract             (streams, formats, exit codes, env vars, config)
### Decisions            (each non-obvious choice and the rejected alternative)
### Open questions
### Not verified
```

## Report: build and the end of refactor

```
### What changed         (files, and the finding ids implemented for refactor)
### Validation list      (below, ticked)
### Command reference    (below)
### Not verified
```

## Validation list

Run it on every command a change touched, and on the whole tree after a build:

- [ ] Hierarchy and names follow references/grammar.md: noun groups, one verb vocabulary, justified depth.
- [ ] Positionals are identities; modifiers are options; no booleans as positionals.
- [ ] Help at each level lists subcommands or options, defaults, and one example when usage
      is not obvious; `--help` has no side effects.
- [ ] Unknown commands and options fail with exit 2 and a suggestion when one is close.
- [ ] Errors go to stderr, name the bad input, and never exit 0.
- [ ] stdout carries only payload; `--format json` output parses with `jq`.
- [ ] Text output composes: one record per line, tab-separated fields, raw ids, and `get`
      (or any command taking an id) accepts what `list` prints.
- [ ] Color follows the terminal, `NO_COLOR`, and `FORCE_COLOR`.
- [ ] Prompts appear only on a terminal; destructive commands take `--yes`.
- [ ] Old syntax still works with the deprecation warning, or was removed under an approved
      `BREAKING` id.
- [ ] Tests cover help, exit codes, the stream split, and each deprecation path.
- [ ] Docs, examples, completion, CI, and scripts use the new syntax.

## Command reference

Close build, refactor, and narrow-change work with a command reference: representative
commands across the whole tree (every changed command, plus at least one per group), each
with its usage line and one real invocation with its output.

Then apply the final test. Hand the help output, and nothing else, to someone unfamiliar
with the implementation, or reason as that person would. Can they predict the command for
a task they have not seen yet, guess what a flag does from its name, and tell success from
failure by the exit code? "It runs" is not evidence that it is well designed.
