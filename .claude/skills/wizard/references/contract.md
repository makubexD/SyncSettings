# Contract: what a wizard promises scripts, terminals, and users

A wizard is interactive, but it still lives inside a CLI that scripts and CI call. These rules keep
it from ever hanging a pipeline, corrupting output, or leaving half-done work. An existing project
contract (other exit codes, other prefixes) wins; say so when it differs.

## When it runs

The entry point has two paths, decided before anything else:

- **Interactive**: stdin and stderr are both terminals, and `--no-input` was not given. Check
  both streams before the first prompt.
- **Not interactive**: anything else (a pipe, a redirected stderr, CI). It never prompts and
  never reads answers from stdin, and it acts only when asked to explicitly:
  - without `--no-input` (or the project's own equivalent) → exit **2**, naming `--no-input` and
    the flags. A piped or scripted `app init` never changes anything by accident, even when
    every value has a default;
  - with `--no-input` → values not given take their declared defaults; if every required value
    (one with no default) is present, run the same commands the wizard would, with no questions
    and no review (the explicit flags are the approval). A destructive or remote command still
    needs its own `--yes`, exactly as when typed directly;
  - with `--no-input` and a required value missing → exit **2** with a usage error naming the
    missing flags and the commands that replace the wizard:

  ```
  error: 'acme init' needs a terminal to ask for: --site
  pass it as a flag with --no-input, or run the commands directly:
    acme site create <name> --theme blog
    acme target add pages
  ```

Tests and CI never need a terminal: see references/testing.md.

## Streams

- Prompts, hints, validation messages, the review screen, and the equivalent command lines go
  to **stderr**. A wizard is conversation, not payload.
- **stdout** carries only what the commands themselves print as payload, unchanged.
  `app init > out.txt` must leave exactly what the commands would have printed.

## Exit codes

| Code | When |
|---|---|
| 0 | the reviewed commands ran and succeeded; also "nothing to do" |
| 1 | the user declined at the review, or a command failed (its code, if the project uses others) |
| 2 | usage error: no terminal, a bad flag value, or an unknown flag passed to the entry point |
| 130 | cancelled with Ctrl-C (or Esc) at any step or at the review, or interrupted while the commands run |

Never exit 0 after a cancel or a failure. A cancel is not success.

## No partial state

- Asking changes nothing. Files, config, network calls, and git all wait until after the
  review. The steps before it may only read (detect defaults, list what exists).
- A cancel at any step, or at the review, therefore leaves the system exactly as it was.
- Ctrl-C while the reviewed commands run: nothing after the current command runs; report what
  ran and what remains, and exit 130 (references/architecture.md, "Running the plan").
- A multi-command run that fails halfway reports what did run and prints the rest; it does not
  try to undo commands that have no undo. If the commands support it, prefer ordering them so
  the reversible ones come first.

## Safety

- Destructive or remote actions (delete, overwrite, deploy, push) are never a default and are never
  confirmed by a single keystroke mid-flow. They appear in the review with their dry-run preview and
  a confirmation that defaults to no.
- The wizard never accepts secrets as visible text or passes them as flags (flags land in shell history
  and process lists). Use the library's password prompt, and hand secrets over through the command's
  environment variable or stdin, as its non-interactive form does.
- The equivalent command shown to the user never contains a secret; it shows the variable instead
  (`APP_TOKEN=… app login`).

## Colour and accessibility

- Decide colour per stream in this order: a `--color`/`--no-color` flag if the CLI has one, then
  `FORCE_COLOR` (`0` or `false` disables, anything else enables), then `NO_COLOR` (non-empty disables), then `TERM=dumb` (disables), then whether the
  stream is a terminal. Your own text follows this. A prompt library that decides from a different
  stream is an accepted exception when its stack file documents it, since prompts run only when
  stderr is a terminal anyway; say so in the report instead of ticking per-stream colour.
- Meaning never rests on colour or symbols alone: an error still says `error:`, and a selected item is
  still marked in plain text.
- Every step works with the keyboard only, and arrow keys have a typed alternative where the library
  offers one. In a terminal that cannot draw widgets (`TERM=dumb`), fall back to plain line prompts,
  or exit 2 and name the flags if the library can't do that.
- Keep text short and literal; no jargon the user has not seen yet, and no emoji-only status.

## Help

- The entry point appears in top-level help with one line, and `--help` on it prints its own help
  (its flags, and one line saying it asks for anything left out) and exits 0 without prompting.
- Help lists the non-interactive equivalent: "Scripts: pass every value as a flag, with `--no-input`."
