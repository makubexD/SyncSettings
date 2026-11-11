# Contract: output, errors, exit codes, configuration

These are the behaviors scripts depend on. Once released, treat each as a public API.

## Streams

- **stdout is the payload**: the data the user asked for, and nothing else.
- **stderr** carries progress, warnings, prompts, errors, and deprecation notices.
- A command that succeeds with nothing to report prints nothing on stdout.
- `app x > out.json` must leave a valid file; `app x 2>/dev/null` must still carry the data.

## Human and machine output

- Human output (the default on a terminal) may use alignment and color. No needless
  decoration: no banners, spinners on stdout, emoji status, or "Fetching..." lines.
- Machine output is selected explicitly with `--format json` (or `tsv`, `csv`, whatever the
  project already uses). Never infer it from "stdout is not a terminal".
- JSON output is one document: an array for lists, an object for single resources, stable
  field names in camelCase or snake_case (pick one), no color codes, no log lines.
- A stable human format for scripts (like git's `--porcelain`) is allowed only with a
  documented promise that it will not change.
- Adding a JSON field is compatible; renaming or removing one is breaking.

## Composability

Output must be consumable by `jq`, `grep`, `awk`, `cut`, `xargs`, and scripts:

- one record per line in text lists; tab-separated when there are several fields;
- ids printed raw, without quotes or decoration;
- no pagers or interactive widgets unless stdout is a terminal;
- no truncation to terminal width when stdout is not a terminal.

## Color and terminal

Decide color per stream, in this order:

1. `--no-color` or `--color never|always|auto` if the CLI has it;
2. `FORCE_COLOR` set: `0` or `false` disables, anything else enables (the common convention;
   force-color.org treats any non-empty value as on, so say which one you follow);
3. `NO_COLOR` set and non-empty disables;
4. `TERM=dumb` disables;
5. otherwise color only when that stream is a terminal.

Color never carries meaning on its own: a failure is also spelled `error:`.

## Interaction

- Prompt only when stdin and stderr are terminals. Otherwise fail with a usage error (exit 2)
  naming the flag or variable that supplies the answer (`--yes`, `APP_TOKEN`).
- A user who declines a prompt on a terminal has refused: exit 1, `error: aborted` (or a
  more specific message) on stderr.
- Destructive operations need confirmation on a terminal and `--yes` in scripts. Spell it
  `--yes` everywhere; `--force` means "override a safety check" (overwrite, skip a
  precondition), not "skip the prompt". Offer `--dry-run` (`-n`) for anything that changes
  remote or shared state.
- `--quiet` (`-q`) removes non-essential stderr; `--verbose` (`-v`, repeatable) adds detail.
  Neither changes stdout.
- Long operations show progress on stderr, and only when stderr is a terminal.
- Ctrl-C stops cleanly, leaves no partial state it can avoid, and exits 130.

## Errors

An error message says what failed, which input caused it, and the fix when there is one:

```
error: unknown command 'depoly'
did you mean 'deploy'?
run 'app --help' for the list of commands
```

- Prefix with `error:` (and `warning:`), lowercase, on stderr, one problem per line. The
  deprecation line in references/migration.md follows the same rule.
- Name the bad value and where it came from (flag, env var, config file, line).
- Suggest the closest command or option ("did you mean") when the edit distance is small.
- No stack traces unless `--verbose` or a debug variable is set.
- Never exit 0 after printing an error.

## Exit codes

Read the existing contract from help, docs, and tests and keep it. When none exists:

| Code | Meaning |
|---|---|
| 0 | success (including "nothing to do"), help, version, and `app` with no arguments |
| 1 | the operation failed, or the user declined a prompt |
| 2 | usage error: unknown command or option, bad value, missing argument, or a missing `--yes` when no terminal can be prompted |
| 130 | interrupted (Ctrl-C) |

Code 2 for a usage error follows bash builtins and the common parsers of every stack. Add
more codes only for a distinction scripts actually branch on, and document every code in
top-level help.

## Configuration and environment

- Precedence: flag, then environment variable, then project config, then user config, then
  default. Help and `--verbose` say where a value came from when that matters.
- Environment variables share one prefix (`APP_`), and every one appears in help.
- User config lives in the platform's config directory: `$XDG_CONFIG_HOME/app` (default
  `~/.config/app`) on Linux, `~/Library/Application Support/app` on macOS, `%APPDATA%\app`
  on Windows. One override variable (`APP_CONFIG_DIR`) points elsewhere.
- Secrets come from environment, files, or a credential store; never from a flag value, which
  lands in shell history and process listings.
