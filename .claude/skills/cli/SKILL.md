---
name: cli
description: "Design, build, audit, or refactor a command-line interface as a small language with a git-inspired grammar (app NOUN VERB OBJECT --modifiers) that composes through pipes and structured output. Covers command tree, arguments, options, help, stdout/stderr, errors, exit codes, configuration, tests, migration with deprecation, and stack-specific parsers (Node/TypeScript, Python, Go, Rust, .NET). Runs read-only in audit and design modes."
when_to_use: "Use when creating a new CLI, adding or renaming commands or flags, reviewing CLI UX, making a CLI predictable, scriptable or git-like, or refactoring a legacy CLI — or when the user asks to \"design the command tree\", \"add --format json to\", \"rename this command\", \"audit this CLI\", or \"make this CLI git-like\". Not for interactive setup wizards."
---

## Boundary

See also:
- **Setup Wizard Design (Front End over CLI Flags)** (`wizard`) — interactive setup wizards layered over a CLI

# CLI

Treat the CLI as a small language. Its commands, arguments, options, aliases, help, output,
errors, and exit codes are a public interface: someone who has not read the implementation
should be able to predict the next command from help alone. Preserve the domain behavior
and the parser a repository already uses unless a finding the user approved says otherwise.

The rules live in `references/`. Load only what the mode below lists; do not restate them in
reports, apply them.

## Decide the engagement

Before any edit:

**Narrow change.** The user named the exact delta ("rename `users show-all` to `users list`",
"add `--format json` to `release list`"). Load grammar, contract, testing, migration,
findings, and the matching stack file. Naming the exact delta is the explicit yes for it, even when it is `BREAKING`, but
keep the deprecation path from [`references/migration.md`](references/migration.md) unless the user asked for a hard
break. Before editing, run a scoped audit: search for callers, write the current command's
card, and state the delta's class, its callers, and its impact. Then write the contract test
first, make the change, migrate the callers, and update help. Report in the "build and the end
of refactor" shape from [`references/findings.md`](references/findings.md), ending with the validation list, the command
reference, and "Not verified". The audit stays scoped to the delta.

**Open-ended work.** Pick one mode. With no mode given, choose `audit` when a CLI exists and
`design` when none does. If the user says both "review" and "fix", run `audit` and stop:
their approval of finding ids starts the work.

| Mode | When | Load | Edits |
|---|---|---|---|
| `design` | No CLI yet, or a grammar is wanted before code | grammar, contract, findings | none |
| `build` | Create a CLI, or add a command group | grammar, contract, architecture, testing, findings, one stack file; auditor and migration too when a CLI already exists | yes, test-first |
| `audit` | Review or explain an existing CLI | auditor (it loads the rest) | none |
| `refactor` | Change an existing CLI without an exact delta | auditor, then testing, migration, architecture as needed | only approved ids |

For open-ended work on an existing CLI, always audit before modifying it. That includes
`build` when it adds a group to an existing CLI: audit the surrounding commands first so the
new group matches them.

## design

1. Restate the domain in one line per resource: its nouns, the operations on each, and who
   calls it (people, scripts, CI).
2. Draft the tree with [`references/grammar.md`](references/grammar.md): top-level verbs for the daily workflow, noun
   groups for the rest, one verb vocabulary, positionals only for identities.
3. Fix the contract with [`references/contract.md`](references/contract.md): formats, streams, exit codes,
   environment variables, config location, destructive-operation safety.
4. Report in the design shape from [`references/findings.md`](references/findings.md) and stop. No code.

## build

1. Run `design` first unless the user already approved a grammar. Wait for approval.
2. Pick the `references/stack-*.md` file that matches the repository (or the user's
   choice). If none matches, map [`references/architecture.md`](references/architecture.md) to the stack yourself and say
   the guidance is unverified for that stack.
3. Build in the slices from [`references/architecture.md`](references/architecture.md). For each slice: write the contract
   test from [`references/testing.md`](references/testing.md), run it and see it fail for the expected reason,
   implement, and run the whole suite. One slice at a time: never write a slice's code before
   its test has failed.
4. Generate help (and completion, if the stack supports it) from the declarations.
5. Finish with the validation list and the command reference from [`references/findings.md`](references/findings.md).
   If a fresh-context reviewer is available (the `cli-auditor` agent, a subagent, or a second
   session), give it the full path of this skill's [`references/auditor.md`](references/auditor.md) for an independent
   pass; otherwise run that brief yourself as a separate step.

## audit

Follow [`references/auditor.md`](references/auditor.md). It is self-contained, so prefer handing it to a
fresh-context reviewer (the `cli-auditor` agent when it is installed) along with that file's full
path, and review its report
against the evidence before presenting it. Present the report and stop the turn. Make no edits.

## refactor

1. Run `audit` and stop at its approval block. Wait for the user's answer.
2. Write characterization tests for the current surface ([`references/testing.md`](references/testing.md)) and run
   them green against the unchanged code before the first edit.
3. Implement the approved ids one at a time (never several ids in one rewrite), following [`references/migration.md`](references/migration.md). Leave
   unapproved `BREAKING` and `COMPATIBILITY` items untouched. For `MAINTAINABILITY` items,
   use [`references/architecture.md`](references/architecture.md).
4. After each id: update the affected expectations (naming the id), migrate in-repo callers,
   run the suite.
5. Finish with the validation list, the command reference, and what you could not run.

Never apply a breaking change without an explicit yes on its finding id.

## Stacks

| Stack | File |
|---|---|
| .NET: System.CommandLine | [`references/stack-dotnet.md`](references/stack-dotnet.md) |
| Go: cobra | [`references/stack-go.md`](references/stack-go.md) |
| Node.js / TypeScript: node:util parseArgs, commander | [`references/stack-node-ts.md`](references/stack-node-ts.md) |
| Python: argparse, click, typer | [`references/stack-python.md`](references/stack-python.md) |
| Rust: clap | [`references/stack-rust.md`](references/stack-rust.md) |

Stack files map the rules to the parser's features and list its pitfalls; they do not
override the grammar or the contract. When a stack's default differs from the contract
(for example an exit code), say so and configure the parser to follow the contract. A
question about one stack, with no project to change, cites the stack file's source links for
every library fact so the reader can check them against their version.

## Gates

- `audit` and `design` never edit files.
- `BREAKING` and `COMPATIBILITY` findings wait for an explicit yes on their ids. A general
  "looks good" is not a yes.
- End every mode, and every narrow change, with "Not verified": what you could not run or check, and why.
