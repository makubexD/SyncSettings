---
paths:
  - "**/wizard/**/*.ts"
  - "**/wizard/**/*.js"
  - "**/wizard/**/*.mjs"
  - "**/wizard/**/*.py"
  - "**/wizard/**/*.go"
  - "**/wizard/**/*.rs"
  - "**/wizard/**/*.cs"
  - "**/*wizard*.ts"
  - "**/*wizard*.js"
  - "**/*wizard*.mjs"
  - "**/*wizard*.py"
  - "**/*wizard*.go"
  - "**/*wizard*.rs"
  - "**/*wizard*.cs"
  - "**/onboarding/**/*.ts"
  - "**/onboarding/**/*.js"
  - "**/onboarding/**/*.mjs"
  - "**/onboarding/**/*.py"
  - "**/onboarding/**/*.go"
  - "**/onboarding/**/*.rs"
  - "**/onboarding/**/*.cs"
  - "**/commands/init.ts"
  - "**/commands/init.js"
  - "**/commands/init.mjs"
  - "**/commands/init.py"
  - "**/commands/init.go"
  - "**/commands/init.rs"
  - "**/commands/init.cs"
  - "**/commands/setup.ts"
  - "**/commands/setup.js"
  - "**/commands/setup.mjs"
  - "**/commands/setup.py"
  - "**/commands/setup.go"
  - "**/commands/setup.rs"
  - "**/commands/setup.cs"
---

# Wizard Rules (Front End over CLI Flags)

This project's setup wizard is a guided front end over its real commands. Apply these rules to any
change in the wizard, its entry point, or the commands and validators it uses.

- **Nothing wizard-only:** every question maps to one flag or positional of a real command. A new
  input gets its flag first. Flags given on the command line skip their questions.
- **One code path:** the wizard runs the commands' own functions (or the entry point), never a copy
  of their logic. Validators and choices are imported from the commands, never duplicated.
- **Terminal only:** prompt only when stdin and stderr are terminals and `--no-input` is absent.
  Otherwise never prompt or read answers from a pipe. Without `--no-input`, exit 2 and name the
  flags; with `--no-input`, run the same commands if every required value is given, else exit 2
  naming the missing ones. A destructive or remote command still needs its own `--yes`.
- **Streams:** prompts, hints, review and messages go to stderr; stdout carries only the commands'
  payload.
- **Every step:** a plain-words question, a hint, validation in the command's words, and cancel;
  back wherever the library allows it. The review always offers Back and Change an answer.
- **Review first:** nothing is written, deleted, or sent before a review that shows the summary and
  the equivalent one-line commands. Destructive or remote steps show a dry run (when the command has one) and default to no.
- **Exit codes:** 0 done, 1 declined or a command failed, 2 usage (including no terminal), 130
  cancelled (unless this project documents a different contract; then keep that one).
- **No partial state:** cancelling at any step or at the review leaves files and config
  unchanged; Ctrl-C while the commands run stops before the next one and exits 130.
- **Secrets:** a password prompt, handed over through the command's environment variable or stdin,
  never a flag, never shown in the equivalent command.
- **Structure:** navigation in a small engine; the prompt library behind one adapter file.
- **Tests:** a scripted prompter covers parity (answers → the same argv as flags), back, cancel,
  and validation; a spawned run covers the no-terminal exit and `--help`.

For design, audits, and refactors, use the `wizard` skill. The path globs that load this rule
are generic defaults; narrow them to this project's layout.
