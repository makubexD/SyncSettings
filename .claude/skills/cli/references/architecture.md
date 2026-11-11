# Architecture: building a CLI that stays consistent

Load this in `build` mode, and in `refactor` when the finding is `MAINTAINABILITY`. It is
language-neutral; the matching `references/stack-*.md` file maps it to a parser.

## Layers

```
entry point      parse argv, pick the command, print help, map results to exit codes
declarations     one object per command: name, summary, positionals, options, examples
commands         thin: validate inputs, call the domain, hand results to the output layer
domain           the actual work; no argv, no printing, no process exit
output           formats results as text or JSON; owns stdout/stderr and color
boundary         the only place that spawns processes, touches the network, or reads env
```

Dependencies point down this list. The domain never imports the parser or the output layer,
so a second front end (tests, a library, an API) can reuse it untouched.

## Declarations are the single source

Each command declares itself once. The parser, help, shell completion, and docs checks all
read that same declaration, so help can never promise an option the parser rejects:

```
command "release deploy":
  summary     "Deploy a release to an environment"
  positionals <version> (1..1)
  options     --environment <name>  choices: staging|production  default: staging
              --dry-run             boolean
  examples    "app release deploy 1.4.0 --environment production"
  run         (inputs) -> Result
```

- Groups declare their actions and an optional default action.
- Global options are declared once and parsed before the command's own.
- If the parser library generates help, feed it from these declarations; do not maintain a
  second hand-written help list.

## Entry point

The entry point only dispatches:

1. Intercept `--help`, `-h`, `help <cmd>`, and `--version` before any command runs, so help
   never has side effects.
2. Resolve the command path; on an unknown name, print the error with a suggestion and exit 2.
3. Parse options strictly against the declaration; unknown options exit 2.
4. Call `run`; map its `Result` to output and an exit code in one place.
5. Catch everything else at the top: print `error: <message>` to stderr, exit 1, and print a
   stack trace only with `--verbose` or a debug variable.
6. Handle interrupt (SIGINT / Ctrl-C) in one place: stop cleanly and exit 130.

## Results, not exceptions, for expected failures

Commands return a discriminated result (`ok` with a value, or `error` with a message and a
kind such as `usage`, `failed`, `refused`). Expected failures are values; exceptions are for
bugs. The entry point maps `usage` to 2 and `failed`/`refused` to 1. A skipped check is its
own state, never reported as a pass.

## Output layer

- One module decides color per stream (references/contract.md), formats tables, and serializes JSON.
- Commands hand it data, not strings, so `--format json` and text come from the same result.
- Payload functions write stdout; `warn`, `error`, progress, and prompts write stderr.

## Boundary

All process spawning, network, and environment reads go through one module. It never uses a
shell to run commands (pass argument arrays), never prints secrets it received, and returns
a result for non-zero exits instead of throwing. Tests replace this module, not the domain.

## Build order (vertical slices)

1. Entry point, declarations, help, `--version`, exit-code mapping, and the contract tests
   for them (references/testing.md), with one trivial command.
2. One real command end to end: declaration, domain, text and JSON output, tests.
3. The remaining commands one at a time, each with its tests and help example.
4. Completion and docs checks generated from declarations, if the stack supports them.

Stop after each slice with the suite green. When adding a group to an existing CLI, skip
slice 1 if its entry point already meets this file; otherwise plan that gap as its own
approved finding instead of rewriting the entry point silently.

## Zero-dependency or library

Prefer the language's standard parser when it can express the grammar (subcommands via a
small dispatch table, strict unknown-option errors, `--` handling). Use a library when you
need generated completion, nested groups, or rich validation it already provides. Either
way, the declarations stay the source; see the stack file for how to wire them.
