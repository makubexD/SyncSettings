# Testing a wizard without a terminal

Nearly all of a wizard's behaviour sits in the engine and the flow, which are pure.
Test them with a scripted prompter; spawn the real entry point only for the terminal
check and help. Write each test before the code it covers and watch it fail for the
expected reason first.

## The scripted prompter

A test double for the Prompter port. It takes a list of scripted replies and records
what it was asked:

```ts
const prompter = scripted([
  ['site', 'field-notes'],
  ['theme', BACK],          // back from theme → site is asked again, with 'field-notes' as the default
  ['site', 'notes'],
  ['theme', 'docs'],
  ['review', 'run'],
]);
```

- Each `ask` pops the next `[stepId, reply]` pair and fails the test if the step asked isn't the
  one the script expects. The review and "Change an answer" are scripted the same way.
- It records the `initial` it was given, so a test can check that defaults are carried over.
- Running out of replies is an error, never a hang.

## The tests every wizard has

| Test | Asserts |
|---|---|
| **parity** | for each path through the tree, `plan(answers)` equals the commands a user would type with flags; and running those argv through the real parser succeeds (no drift). Secret steps are covered by the secrets test instead |
| **same validators** | each step's `validate` *is* the command's exported validator (identity or a shared import), and an invalid scripted answer is asked again with the command's message |
| **back** | `BACK` re-asks the previous *asked* step with the previous answer as the default; back from the first step asks it again; review → Back returns to the last asked step |
| **nothing asked** | every value given as a flag: review → Back and review → Change an answer both show a note and return to the review, never crash or run anything |
| **branching** | a `when` that turns false after Back or Change an answer removes that answer from the plan |
| **given flags skip steps** | `init --theme docs` never asks `theme`, and the plan still contains `--theme docs` (given values are keyed by step id) |
| **cancel** | `CANCEL` at any step → exit 130, and a snapshot of the working directory, and of any config the flow touches, is unchanged |
| **decline** | review → `decline` → exit 1, nothing changed |
| **no terminal** | spawn the entry point with stdin piped from an empty string: exit 2, stderr names the missing flags, stdout is empty, no prompt text appears, it doesn't hang (use a timeout). Also inject "stdin is a terminal, stderr is not" (`app init 2>log`) and expect the same |
| **non-interactive run** | no terminal and no `--no-input`: exit 2 and nothing changes, even in a state where every value has a default; `--no-input` with every required flag: runs the same commands with no questions, same result as typing them |
| **help is safe** | `init --help` exits 0, prints help, prompts nothing, and changes nothing |
| **streams** | in a full scripted run, prompts and the review went to the prompter or stderr, and stdout holds only the commands' payload |
| **run failure** | a command failing halfway reports what ran, prints the remaining commands, and exits non-zero |
| **secrets** | a secret step's value reaches the command through its environment variable, never argv, and `format` shows `NAME=…`. Where the contract allows stdin instead, the value arrives on stdin, never argv |

The parity and cancel tests are the ones that catch real bugs. Never skip them.

## Driving the command in-process

Give the `init` command's action its dependencies through the same `io` object every action
takes (references/readiness.md: `run(values, positionals, io)`), with production defaults for the extra
fields, so a test can call `init.run(values, [], { ...io, prompter, isInteractive: () => true })`
directly. That covers the
whole flow, including the run step against a temporary directory, without a child process.

## Not a terminal: be careful on Windows

The null device (`NUL`, `/dev/null`) may be reported as a terminal on Windows. For the no-terminal
test, feed stdin from an empty *pipe* (for example spawn with `input: ''`). Also unset `FORCE_COLOR`,
`NO_COLOR`, and `CI` in the child's environment so the test sees the defaults, not the
developer's shell.

## A real terminal

One manual check stays manual: run the entry point in a real terminal and try back, Ctrl-C, and
the review. A pseudo-terminal harness can automate this where the project already has one, but
don't add a native dependency just for this. Otherwise list it under "Not verified" with the exact
command to try.
