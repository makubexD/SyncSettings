# Readiness: is the CLI solid enough to carry a wizard?

A wizard is only as good as the commands under it: it collects answers and hands them to
commands that already exist. Run this scan before designing, building, or auditing a wizard.
It is deliberately short. It checks what the wizard depends on, not the whole CLI.

## The scan

Read the entry point, the command registration, help, and tests. For each item, record
**yes**, **no**, or **unknown**, with evidence (a file and line, or a command's actual output).

| # | Check | Why the wizard needs it |
|---|---|---|
| R1 | Commands are declared in one place (a table, decorators, a builder) that both the parser and help read | the wizard reads the same declarations to know its steps |
| R2 | Every input a user can decide has a flag or positional; nothing is read only from prompts | each wizard answer must map to a flag, or the wizard becomes wizard-only |
| R3 | Validation lives in functions a caller can import (not inlined in the parser) | the wizard reuses them per step instead of copying them |
| R4 | Each command's action is a function you can call with parsed values, and importing it runs nothing | the wizard calls the same code path the flags reach |
| R5 | Exit codes are documented or consistent: 0 success, 1 failure, 2 usage error | the wizard's own exits (not a terminal, cancel) must fit the contract |
| R6 | stdout carries only the payload; errors and messages go to stderr | wizard prompts go to stderr and must not corrupt the payload |
| R7 | Destructive or remote commands have `--yes` and, where possible, `--dry-run` | the review step previews with the dry run; a non-interactive run of a destructive command still needs its `--yes` |
| R8 | Help is generated and side-effect free | the wizard's entry point must appear there, and `--help` must never start it |

## Verdict

- **Ready**: R1–R4 are yes. Gaps in R5–R8 become findings, fixed alongside the wizard.
- **Ready with prerequisites**: R1, R2, R3, or R4 is no. List the smallest CLI changes that make
  them yes (collect the declarations in one table, add the missing flag, export the validator,
  split the action from parsing) as
  the first tasks, before any wizard code. They are prerequisites, not a CLI redesign.
- **Not ready**: there is no command layer to speak of (a script that only prompts, or
  one monolithic function). Propose building the minimal CLI first (below), and say so.

A wizard over a CLI that fails R2 is a second, unscriptable interface. Do not build it.

## Minimal CLI for a new app

When `build` starts from nothing, create only what the wizard needs, in this order:

1. One declaration per command: its path (`project create`), summary, positionals, and options
   with type, default, choices, and help.
2. Validators as exported functions that return an error message or nothing.
3. Actions as exported functions: `run(values, positionals, io) → exit code`, where `io`
   carries stdout and stderr writers and the working directory, so tests capture them.
4. A thin entry point that parses argv against the declarations, prints generated help,
   maps usage errors to exit 2 on stderr, and calls the action. It does nothing when imported.
5. Tests that spawn the entry point: help, one success, one usage error (exit 2, stderr only).

Keep the grammar git-like and boring: `app <group> <verb> [<name>] [--option value]`, long
options for everything, positionals only for identities. The wizard is the friendly layer;
the commands stay precise.

## Report it

Every row, with evidence, then the verdict. For example, for an imaginary `acme`:

```
### Readiness
R1 yes  src/commands.ts:12 one COMMANDS table drives the parser and help
R2 no   `acme site create` reads the theme only from an interactive question (src/site.ts:40);
        prerequisite: add --theme
R3 yes  validateSiteName, validateFeature exported from src/validate.ts
R4 yes  every action is run(values, positionals, io); importing src/commands.ts runs nothing
R5 yes  help: "Exit codes: 0 ok, 1 failed, 2 usage"
R6 yes  payload via io.out; messages via io.err
R7 part target remove has --yes but no --dry-run
R8 yes  help generated from COMMANDS; --help handled before any action
Verdict: ready with prerequisites (P1: add --theme to site create)
```
