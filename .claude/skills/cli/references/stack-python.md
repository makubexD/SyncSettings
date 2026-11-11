# Python: argparse, click, typer

Sources: [argparse](https://docs.python.org/3/library/argparse.html) ·
[click exceptions and exit codes](https://click.palletsprojects.com/en/stable/exceptions/) ·
[click testing](https://click.palletsprojects.com/en/stable/testing/) ·
[typer terminating](https://typer.tiangolo.com/tutorial/terminating/) ·
[typer release notes](https://typer.tiangolo.com/release-notes/)

## Choosing

- **argparse** (standard library): subcommands via `add_subparsers`, generated help, usage
  errors exit 2. No dependency.
- **click**: decorators, nested groups, the best testing story (`CliRunner`), shell completion.
- **typer**: driven by type hints. Before 0.26 it ran on the `click` package, so click's exit
  codes and testing applied. From 0.26 (May 2026) it bundles its own copy of Click and no longer
  supports Click-specific extensions, so the click-only fixes below don't carry over. Check the
  installed version first; its own section says what applies.

## Wiring the grammar

### argparse

- `parser.error()` and every invalid argument list print usage plus the message to stderr and
  exit **2**. The code matches the contract, but the line reads `PROG: error: msg`, not
  `error: msg`: subclass `ArgumentParser` and override `error()` to print `error: <msg>` (plus
  the usage line, if you keep it) to stderr and `sys.exit(2)`.
- Pass `allow_abbrev=False`. The default accepts unambiguous prefixes (`--form` for
  `--format`), so adding any option that shares a prefix silently breaks a caller.
- Subcommands: `sub = parser.add_subparsers(dest="command", required=True)`; one parser per
  noun, then one per verb for a two-level grammar. Each `add_parser(..., help=...)` feeds help.
- `exit_on_error=False` (3.9+) raises `argparse.ArgumentError` instead of exiting, for custom
  handling. Keep the default unless you need that.
- `suggest_on_error=True` (3.14+; on by default from 3.15) adds "did you mean" for mistyped
  choices and subcommand names.
- Since 3.14, help and errors are colored by default (`color=True`). Its own detection lets
  `NO_COLOR` win over `FORCE_COLOR` and treats any non-empty `FORCE_COLOR` (even `0`) as on,
  which differs from the contract's precedence. Decide color once with the contract's rules
  (`references/contract.md`) and pass the result as `color=`.
- Booleans: `action="store_true"`, or `argparse.BooleanOptionalAction` for `--x/--no-x`.
- Repeated options: `action="append"`. Choices: `choices=[...]`. Defaults show in help with
  `formatter_class=argparse.ArgumentDefaultsHelpFormatter`.
- Operational failures: print `error: ...` to `sys.stderr` and `sys.exit(1)`.

### click

- Exit codes: `UsageError` and `BadParameter` exit **2** (and a help page shown because of
  bad input also returns 2); a `ClickException` exits with its `exit_code`, **1** by default;
  `Abort` (and Ctrl-C, Ctrl-D, or EOF anywhere) exits 1 with "Aborted!". Raise `click.ClickException`
  (or a subclass) for operational failures and `click.UsageError` / `click.BadParameter` for
  input problems.
- stderr: `click.echo(message, err=True)`; `ClickException.show()` already writes to stderr.
- Where click's defaults differ from the contract (observed on click 8.4, still true in 8.5): errors print as `Error:` (capitalized); Ctrl-C becomes `Abort` and exits 1, not
  130; other exceptions print a traceback and exit 1; a group run with no arguments raises
  `NoArgsIsHelpError` (a `UsageError`, click 8.2+, defined in `click/exceptions.py`) and
  exits 2, where the contract wants help on stdout and 0.
- Fix all of them in one place: subclass the root `click.Group`, override `main()` to call
  `super().main(..., standalone_mode=False)`, then `sys.exit` the resulting code. With
  `standalone_mode=False` click neither prints exceptions nor exits, and `--help` returns
  its code instead of exiting, so you must: print the message yourself (`error: ...` via
  `click.echo(..., err=True)`, or `e.show()`), map `UsageError` → 2 (catch it before
  `ClickException`, its base), `ClickException` → `e.exit_code`, `Abort` caused by
  `KeyboardInterrupt` → 130, anything else → 1, and treat an int return (help) as that code.
  Because the mapping lives in `main()`, `CliRunner` tests exercise it too.
- Groups: `@click.group()` per noun, `@group.command()` per verb.
  `invoke_without_command=True` plus `ctx.invoked_subcommand` implements a default action.
- Suggestions for mistyped commands are built in.
- Prompts: `click.prompt` / `click.confirm` read stdin even when it is not a terminal; check
  `sys.stdin.isatty() and sys.stderr.isatty()` first and raise `UsageError("... pass --yes")`
  otherwise. Prompt with `err=True` so the prompt goes to stderr.
- Color: `click.echo` strips ANSI codes when the stream is not a terminal; still honor
  `NO_COLOR` / `FORCE_COLOR` yourself (for example via `click.style` only when enabled).

### typer

- `raise typer.Exit(code=1)` for operational failures; `typer.BadParameter` for bad input
  (exit 2); `typer.Abort()` prints "Aborted!" and exits 1.
- Contract mismatches (`Error:` prefix, Ctrl-C → 1, no-args exit code) need the same mapping as
  click, but from 0.26 you can't subclass a click `Group`. Wrap the call instead: in `main()`,
  call `app(standalone_mode=False)` inside `try`/`except` and map the exceptions and return
  code as in the click section. This is unverified against every 0.26+ release; test it.
- Sub-apps (`app.add_typer(users_app, name="users")`) give the noun-verb tree.
- Rich tracebacks can be verbose; keep them behind `--verbose` or disable
  `pretty_exceptions_enable` for end users.

## Exit codes and streams

- argparse already exits 2 on usage errors; click and typer need the `main()` mapping above
  (usage error → 2, operational failure → 1, Ctrl-C → 130, `app` with no arguments → help on
  stdout and 0).
- Payload to `sys.stdout` (`print`, or `click.echo`), diagnostics and prompts to `sys.stderr`
  (`print(..., file=sys.stderr)`, or `click.echo(..., err=True)`). Decide color once with the
  contract's precedence (`references/contract.md`) and pass it to the library.

## Version

`--version`: argparse's `action="version"` prints whatever `version=` holds, so set it to
`"%(prog)s 1.4.0"`. click's `@click.version_option` prints `%(prog)s, version %(version)s`; pass
`message="%(prog)s %(version)s"`. typer has no built-in; add an eager `--version` callback that
prints `<name> <version>`.

## Tests

- click: `click.testing.CliRunner().invoke(cli, ["users", "list", "--format", "json"])` returns
  `exit_code`, `output`, and separate `stdout`/`stderr` in current click; in click < 8.2 use
  `CliRunner(mix_stderr=False)` to separate stderr (the parameter was removed in 8.2:
  [changelog](https://click.palletsprojects.com/en/stable/changes/#version-8-2-0)).
  `env={...}` isolates environment.
- typer: use `typer.testing.CliRunner` (the same interface); from 0.26 `click.testing` is the
  wrong import.
- argparse: call `main(argv)` and catch `SystemExit` to read the code, and add a few
  real-process tests with `subprocess.run([sys.executable, "-m", "app", ...],
  capture_output=True, text=True)`.

## Packaging

`[project.scripts]` in `pyproject.toml` maps the command name to `package.module:main`;
also support `python -m app` with a `__main__.py`.
