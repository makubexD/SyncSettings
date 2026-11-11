# Testing: lock the contract, not the implementation

The CLI's contract is what a script sees: arguments in; stdout, stderr and exit code out.
Test that surface by running the real entry point in a child process. Unit tests on the
domain are welcome but do not replace these.

## Contract tests (every CLI)

Spawn the real entry point with an argument array and a controlled environment:

```
run(["release", "deploy", "1.4.0", "--environment", "production"], env={NO_COLOR: "1"})
  -> { code, stdout, stderr }
```

Cover, per command:

- **Help:** `--help` at each level exits 0, lists every declared option and default, and runs
  nothing (assert no side effect, e.g. no file written).
- **Usage errors:** unknown command, unknown option, bad value, missing positional: exit 2,
  message on stderr naming the input, stdout empty.
- **Success:** exit 0, payload on stdout, stderr empty unless a warning is expected.
- **Failure:** exit 1, `error:` on stderr, stdout empty.
- **Machine output:** `--format json` stdout parses as JSON with no other bytes.
- **Color:** no escape codes when not a terminal or with `NO_COLOR=1`; escape codes with
  `FORCE_COLOR=1` even when not a terminal and even with `NO_COLOR=1` (precedence);
  none with `FORCE_COLOR=0`.
- **Non-interactive:** with no terminal, a command that would prompt fails fast with exit 2
  and names `--yes`; it never hangs. A declined prompt exits 1 (test it with fake terminal
  streams where the stack allows). Put a timeout on these tests. Feed stdin from an empty
  pipe (empty input), not the null device: on Windows `NUL` reports itself as a terminal.
- Assert on what you own (exit code, stream, `error:` prefix, the named input), not on a
  parser library's exact wording.
- **Deprecation:** each old spelling still works, produces the same stdout, and prints the
  deprecation line on stderr.

Isolate the environment in every test: a temp working directory, a temp config and home
directory, and a cleared set of the CLI's own variables, so the developer's machine and
the shell running the tests never leak in.

## Characterization tests (before any refactor)

Before the first edit of an existing CLI, record what it does today:

1. For each command in the audit's command tree, capture stdout, stderr, and exit code for
   one normal invocation, one error, and `--help`.
2. Save them as expectations (inline or snapshot files) and run them green against the
   unchanged code. They are allowed to encode bad behavior; that is the point.
3. During the refactor, change an expectation only in the same step as the approved finding
   that changes that behavior, and say which finding id it belongs to.

A characterization test that was never green against the old code proves nothing.

## Docs drift tests

When the repository documents commands (README, docs, examples), add a test that extracts
every `app ...` invocation from the docs and checks it against the declarations: the command
exists, every option is declared, and hidden aliases do not appear. Help cannot drift if it
is generated; docs can, and this test catches it.

## Order of work (TDD)

For each slice in `references/architecture.md`'s build order: write the contract test, run it and see it
fail for the expected reason, implement, run the full suite, then re-read `--help` for the
commands you touched.

## Harness notes

Use the repository's existing test runner. Spawn the same way users do (the package's bin
or `python -m app`), not by importing the command function, and on Windows remember that
`.cmd` shims and path separators differ. Where an ecosystem has an in-process runner, its stack
file names it for fast tests; keep a few real-process tests on top of them. A stack without one
uses real-process tests only, and its stack file says so.
