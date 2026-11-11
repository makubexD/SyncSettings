---
name: wizard
description: "Design, build, audit, or refactor an interactive setup wizard (app init / app setup) that guides newcomers through a command-line app with questions, hints, validation, back navigation, and a review step, then runs the app's real commands and shows the equivalent one-line command. The wizard is a front end over flags, never a second interface. Covers a readiness scan of the CLI underneath, flow and decision-tree design, the terminal contract, a testable flow engine, and prompt libraries per stack (Node/TypeScript, Python, Go, Rust, .NET). Design and audit never edit project files."
when_to_use: "Use when adding an init/setup/onboarding wizard or interactive mode, making a CLI friendlier for beginners, reviewing an existing wizard, or starting a new app that needs one — or when the user asks to \"add an init wizard\", \"make setup interactive\", \"review our onboarding flow\", or \"guide new users through setup\". Not for the non-interactive command grammar itself."
---

## Boundary

See also:
- **CLI Design (Small-Language Grammar)** (`cli`) — the non-interactive command grammar and contract the wizard runs underneath

# Wizard

A wizard turns "I don't know which command to run" into a few questions. It is a friendly front
end over commands that already exist: every answer becomes a flag or argument, the user
reviews the result, and the wizard then runs those same commands and shows the one-line
equivalent so the user can skip the wizard next time. Nothing is wizard-only, and nothing
prompts in scripts or CI.

The rules live in `references/`. Load only what the mode below lists; apply them, do not restate
them in reports.

## Decide the engagement

Before any edit, pick one mode from what the user asked: "design"/"plan" → `design`;
"add"/"create"/"build"/"new app" → `build`; "review"/"audit"/"explain" → `audit`; "fix"/"improve"/
"refactor" an existing wizard → `refactor`. With no such verb:
`audit` when the project has a wizard, `design` when it doesn't. If the user says both "review"
and "fix" without approving anything, run `audit` and stop: their approval starts the work.

| Mode | When | Load | Edits |
|---|---|---|---|
| `design` | A wizard is wanted and none exists, the flow should be agreed before code, or a question about one stack (see below) | readiness, flow, contract, findings | none |
| `build` | Create the wizard, or a new app with basic CLI support plus a wizard | readiness, flow, contract, architecture, testing, findings, one stack file | yes, test-first |
| `audit` | Review or explain an existing wizard | auditor (it loads the rest) | none |
| `refactor` | Fix an existing wizard | auditor (it loads the rest) | only approved ids |

Every mode starts with the readiness scan ([`references/readiness.md`](references/readiness.md)). A CLI that
fails it gets its prerequisites listed as the first tasks (or, with no command layer at all, the
minimal CLI described there). Only `build` and `refactor` carry them out.

## design

1. Run the readiness scan and report it.
2. Following [`references/flow.md`](references/flow.md): choose the entry point, list the commands the wizard will run,
   write the step table (every row names its flag and validator), and draw the decision tree.
3. Fix the behaviour with [`references/contract.md`](references/contract.md): no-terminal exit, streams, exit codes, cancel,
   review for destructive steps, secrets.
4. Report in the design shape from [`references/findings.md`](references/findings.md) and stop. No code.

## build

1. Unless the user already approved a flow, run design steps 1–3, present the design, and wait
   for approval. "Whatever you recommend" counts as approval of your design: state that in the
   report and continue. For a new app, build the minimal CLI from [`references/readiness.md`](references/readiness.md)
   first, with its tests.
2. Pick the `references/stack-*.md` file that matches the repository. Use the project's
   prompt library if it has one; otherwise the stack file's. If no stack file matches, map
   [`references/architecture.md`](references/architecture.md) to the stack yourself and say that guidance is unverified.
3. Build in this order, each slice test-first ([`references/testing.md`](references/testing.md)): write the test, run it
   and see it fail for the expected reason, implement, run the whole suite. One slice at a time:
   never write a slice's code before its test has failed.
   1. the terminal check and `--help` for the entry point (no-terminal → exit 2 naming flags);
   2. the engine with a scripted prompter: steps, skip given flags, back, cancel, validation;
   3. the flow: steps from the table, `plan`, and `format`, plus the parity test against the parser;
   4. the review and run step, calling the commands' own functions;
   5. the library adapter, last, as the only file that imports the prompt library.
4. Add the entry point to the app's help and README.
5. Finish with the report from [`references/findings.md`](references/findings.md): the validation list ticked, a transcript
   of one scripted run (questions, review, equivalent command), and "Not verified" (at least:
   the manual check in a real terminal, with the exact command). If a fresh-context reviewer
   is available (the `wizard-auditor` agent, a subagent, or a second session), hand it the full
   path of this skill's [`references/auditor.md`](references/auditor.md) for an independent pass.

## audit

Follow [`references/auditor.md`](references/auditor.md). It is self-contained within this skill, so prefer handing it to a
fresh-context reviewer (the `wizard-auditor` agent when it is installed) along with that file's full
path, and check its report
against the evidence before presenting it. Present the report and stop the turn. Make no edits.

## refactor

1. Run `audit` and stop at its approval block. Wait for the user's answer (a prompt that
   already approves every finding counts; say so).
2. Write characterization tests for the wizard's current behaviour that matter to keep (the
   commands it ends up running, the files it produces) and run them green before the first edit.
   Behaviour that a finding changes gets a new test instead.
3. Implement the approved ids one at a time, usually by moving the wizard onto the engine
   from [`references/architecture.md`](references/architecture.md). After each id: update expectations (naming the id), run the suite.
4. Finish with the build report, listing the ids implemented and any left untouched.

## Stacks

| Stack | File |
|---|---|
| .NET: Spectre.Console | [`references/stack-dotnet.md`](references/stack-dotnet.md) |
| Go: huh (charmbracelet) | [`references/stack-go.md`](references/stack-go.md) |
| Node.js / TypeScript: @clack/prompts | [`references/stack-node-ts.md`](references/stack-node-ts.md) |
| Python: questionary (prompt_toolkit) | [`references/stack-python.md`](references/stack-python.md) |
| Rust: inquire | [`references/stack-rust.md`](references/stack-rust.md) |

Stack files map the architecture onto a library and list its pitfalls; they never override
the contract. Where a library's default breaks the contract (prompts on stdout, cancel exiting 0),
the stack file says how to configure it.

A question about one stack, with no project to change, is `design` work answered from its stack file,
[`references/architecture.md`](references/architecture.md), and [`references/contract.md`](references/contract.md) (the exit codes and streams apply
there too). Say what the library lacks, show the adapter and the tests, and cite the stack
file's source links for every library fact so the reader can check them against their version.

## Gates

- `design` and `audit` never edit project files (the auditor may run the wizard in a temporary
  directory, as its brief says).
- Approval: a finding classed `BREAKING` waits for an explicit yes on its id; "looks good" is not a
  yes. The one exception is a request that already approves every finding ("all findings
  approved, breaking included"): say in the report that you relied on it. Other findings are
  implemented when the user says to implement them (the approval block's second list).
- Readiness prerequisites that only add something (a flag, an exported validator) are not
  breaking; list them in the report. One that renames, removes, or changes a flag or an exit
  code is `BREAKING` and needs its own yes.
- Never build a wizard over a CLI that fails readiness R2 (an input with no flag): fix R2 first.
- End every mode with "Not verified": what you could not run or check, and why.
