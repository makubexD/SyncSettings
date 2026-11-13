# Shared cases

Cases that test the [contract](../../docs/sync-contract.md) through the command line only, so one case runs against
any engine: bash, PowerShell, or a future compiled one. `run.sh` runs them against the bash engine (Linux, and macOS
under Homebrew's bash); `run.ps1` runs them against the PowerShell engine on Windows PowerShell 5.1. CI runs them in
`engine-linux`, `engine-macos` and `engine-windows`, each next to that engine's own suite.

```bash
tests/parity/run.sh                                          # every case
tests/parity/run.sh only-                                    # cases whose name contains "only-"
tests/parity/run.sh --engine dist/mksync export-unchanged    # the new program
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/parity/run.ps1 [-Engine <path>] [case-name-filter]
```

## Running another engine

`--engine <path>` (`-Engine <path>`) runs the cases against one program instead of the OS's engine: it is copied into
the temp repo as `mksync` (`mksync.exe`) in place of the engine scripts, the commands are spelled
`./mksync export …` with the same options, and it is stripped before the repo is compared. With a program:

- a case with a `diff` or `commit` command prints `SKIP <case>: <command> comes in phase 8` and is not a failure;
- a case with a `setup`, `machine-show`, `machine-retire` or `profile-retire` command prints
  `SKIP <case>: <command> is program only` against an engine other than the program, and counts as skipped;
- a `configV2` case prints `SKIP <case>: v2 only` against an engine other than the program and counts as skipped, not
  passed or failed; the summary shows the skipped count only when it is non-zero
  (`41 passed, 0 failed, 1 skipped`);
- `expect.<os>/` is used only when the case's `differences` name `Entry selection`, `Shared files without rules` or
  `Exclude patterns`; every other case uses `expect/` on every OS;
- `import-eof-no-force` runs on every OS.

Without the option the runner is unchanged.

## Adding a case

1. Find the rule in the contract. A behavior the contract doesn't state yet goes into the contract first.
2. Copy the closest case under `cases/`, rename it, and write `description` with the contract section in brackets.
3. Write `expect/` from the contract text, not from what the engine prints. If the engine disagrees, the engine or the
   contract is wrong; don't record the engine's output.
4. Run the case on bash. Push and read the three engine jobs for macOS and Windows.
5. An engine that differs on purpose gets an `expect.<os>/` folder, but only for a row of the contract's
   [Known differences](../../docs/sync-contract.md#known-differences) (see [Per-OS expectations](#per-os-expectations)).
   When the difference is not the point of the case, change the case's input to avoid it instead, as
   `hydrate-escape-backslashes` does by giving its target folder a file.

## A case

Each case is a folder under `cases/`:

```
cases/<name>/
  case.json        what to run
  home/            the home folder before the run (optional; empty when missing)
  repo/            repo files before the run, besides sync-config.json (optional)
  state/           the engine's state folder before the run (optional)
  expect/
    exit           one exit code per command, one per line
    output.txt     the status lines of every command, in order
    home/          the whole home folder after the last command
    repo/          the whole repo after the last command, besides sync-config.json
    values.json    optional: .user-values.json after the last command
    state/         optional: files the engine's state folder must hold
    gh.log         optional: the gh calls, when the case stubs gh
  expect.<os>/     optional: only what differs from expect/ on linux, macos or windows
```

`case.json`:

| Field | Meaning |
|---|---|
| `description` | One sentence: the behavior and the contract section it checks |
| `os` | Where it runs: a list of `linux`, `macos`, `windows`. Omit for all three |
| `config` / `configV2` | Exactly one of the two, never both nor neither. `config` is the whole `sync-config.json`, written into the repo before the run; `configV2` is written as `sync-config.v2.json` with no `sync-config.json`, and only the program can read it |
| `values` | Optional. Written as `.user-values.json` in the repo; omit to have none |
| `env` | Optional. Variables set for every command: a string sets it, `null` unsets it. Applied after `HOME`/`USERPROFILE`, so `{"HOME": null}` unsets it. A `configV2` case may set only `SYNC_PROFILE`, `SYNC_MACHINE`, `SYNC_HOSTNAME`, `SYNC_DOMAIN`, `SYNC_TOOLS` and `MKSYNC_VISIBILITY`; any other key is a runner error |
| `commands` | The commands, run in order in the same folders. Each is `{ "command": …, "options": {…}, "stdin": …, "stderr": true }`, the last two optional |
| `git` | Optional. `"none"` (default): the temp repo is a plain folder. `"committed"`: a git repo with everything committed on `master`. `"remote"`: that, plus a local bare `origin` it was pushed to, with `master` tracking it |
| `stubs` | Optional. `["gh"]` puts a `gh` stub first on `PATH`; see `expect/gh.log` below |
| `differences` | Required when the case has an `expect.<os>/` folder, and only then: the names of the rows it records |

`home/`, `repo/` and `state/` are copied into the case's temp folders before the first command. `state/` goes into
the engine's state folder (`~/.local/state/sync-settings` on Linux and macOS, `%LOCALAPPDATA%\SyncSettings` on
Windows), so a case can start from a recorded sync point; its files are compared like any the engine wrote. The
record (`machine.json`) and profiles (`profiles/*.json`) go in with mode 600, as the program writes them, and the
bash runner wants 600 for them in `expect/state/`, since git can't store that mode.

`command` is one of `export`, `import`, `check` (`import --check`, `-Check`), `preview` (`export --preview`,
`-Preview`), `diff` (`export --diff`, `-Diff`) and `commit`, plus the program-only `setup`, `machine-show`
(`machine show`), `machine-retire` (`machine retire <target>`) and `profile-retire` (`profile retire <target>`).
`options` uses neutral names that the runner spells for each engine: `force: true` is `--force` or `-Force`,
`only: [paths]` is `--only` or `-Only`. For the program, `name`, `profile`, `replace`, `claude`, `mode` and `existing`
are strings spelled `--<key> <value>` and allowed on `setup` only; `yes: true` adds `--yes` on `setup`,
`machine-retire` and `profile-retire`; and `target`, a string, is the name argument of `machine-retire` and
`profile-retire`, required there and refused elsewhere. Every command runs with no terminal, as CI does, and with stdin
empty unless the command has `stdin`: a string sent as its stdin, such as `"n\n"` for a prompt answer. Its stderr is
merged into its output unless the command has `stderr: true`: then its stderr lines follow its stdout status lines in
`output.txt`, for the warnings the program prints there. A command's output is read as status lines (below) except for
`setup`, `machine-show`, `machine-retire` and `profile-retire`, and any command with `"output": "all"`: those keep
their whole stdout instead, so the `machine show` fields, the scan block and the `ERROR:`, `held` and `refused:` lines
reach `output.txt`. `output` may only be `"all"`; anything else is a runner error.

### Per-OS expectations

`expect.<os>/` (`linux`, `macos`, `windows`) holds only what differs on that OS. Each entry replaces its twin in
`expect/`: `exit` and `output.txt` as files, `home/` and `repo/` as whole trees, `values.json`, `state/` and `gh.log`
the same way. Use it only for a row of the contract's
[Known differences](../../docs/sync-contract.md#known-differences), named in `differences`. The one other allowed
name is `"Entry selection"`, for a case where each OS picks its own entries by design.

### The `gh` stub

With `"stubs": ["gh"]`, every `gh` call appends its arguments, joined by spaces, as one line to a log outside both
trees; the stub prints nothing and exits 0. Each logged line is cut to its first two words (`pr create`), so branch
names and titles don't matter, and the result must equal `expect/gh.log` line for line. No `expect/gh.log` with the
stub on means `gh` must not be called.

## How the runner checks it

1. Copy the engine into a temp repo, write `config` or `configV2` and `values`, copy `repo/`, `home/` and `state/`.
2. Run each command with the home folder as `HOME` (Linux, macOS) or `USERPROFILE` (Windows).
3. Compare:
   - **Exit codes** with `expect/exit`.
   - **Status lines.** Each output line that is a status line becomes `WORD label`: the word without brackets or
     color, then the label. Notes and every other line are dropped, so the bash layout and the PowerShell
     `[WORD      ] label` layout read the same. With `stderr: true` on the command, its stderr lines are kept whole
     (color dropped too) and come after its stdout status lines. A whole-stdout command (above) keeps every line of
     its stdout instead, in order, with color codes and a trailing `\r` removed and a final line without a newline
     kept; an empty stdout adds no line, and its stderr is left out unless `stderr: true`. The result must equal
     `expect/output.txt`, line for line.
   - **Trees**, byte for byte, file list and content. The runner leaves out what an engine keeps for itself:
     `.user-values.json`, the state folder (`~/.local/state/sync-settings`, `%LOCALAPPDATA%\SyncSettings`), and `.git`
     (the bare `origin` lives outside the repo). File modes are compared only where the file system keeps them.
   - **Values**, when `expect/values.json` exists: the repo's `.user-values.json` after the run, as JSON with key
     order ignored.
   - **State**, when `expect/state/` exists: each file in it must be in the state folder with the same bytes; other
     state files, such as the sync point, whose SHA changes per run, are ignored. A run's dated backup folder
     `backups/<run>/` is read as `backups/RUN/`, and there must be exactly one, so the time and pid don't matter.
   - **gh calls**, when the case stubs `gh` (above).

Each file is taken from `expect.<os>/` when it's there for the OS the runner is on, else from `expect/`.

## What fits

A case fits when the behavior shows in exit code, status lines and files. A git remote (`git`), `gh` (`stubs`) and a
prompt answer (`stdin`) are covered. `dconf` and the package managers have no stub yet, so those cases stay in
`tests/linux/engine.sh`. Text the runner drops (notes, `ERROR:` messages, summaries) and a check of one function from
the inside stay in that engine's own suite. A write failure, a symlink in `home/` and an uncommitted repo change can't be set up
yet; the program's unit tests cover those ([design, "Open"](../../docs/design-layers.md#open)).

## Reading a failure

Each case prints one line: `ok`, `skip` (its `os` list leaves this OS out), or `FAIL` with the first difference found.
The run ends with the counts and exits 1 if any case failed.

```text
ok export-adds
FAIL diff-no-sync-point: output line 1: want "OUT dotfiles/common/parity/a.conf", got "? dotfiles/common/parity/a.conf"
ok dir-export-removed
...
36 passed, 1 failed
```

The part after the case name says which check failed:

| Prefix | Meaning |
|---|---|
| `exit:`, `exit line N:` | the exit code of command N |
| `output line N:` | status line N, across all commands, as `WORD label` |
| `Files expect/home/… and home/… differ`, `Only in …` (bash); `home: differs: …`, `repo: only in want: …`, `… only in got: …` (PowerShell) | the home or repo tree: a file different, missing or extra |
| `mode <path>:` | the file is right but its mode isn't (bash runner only) |
| `values.json:`, `state …:` | `expect/values.json` or `expect/state/` |
| `gh line N:` | gh call N, cut to its first two words |
| `gh: want no call` | the case has no `expect/gh.log`, so gh must not be called, and it was |
| anything else | the case itself is malformed: `case.json`, `differences`, an `expect.<os>/` name |

Only the first difference prints. Fix it and run the case again with its name as the filter.

## Troubleshooting

- **A file has CRLF line endings after a checkout.** `.gitattributes` marks `tests/parity/cases/**` as `-text`, so git
  keeps the bytes as committed. A case that needs CRLF (`common-crlf`, `sanitized-crlf-unchanged`) commits them; an
  editor that rewrites line endings breaks it. Check with `cat -A <file>`: CRLF lines end in `^M$`.
- **`differences set but no expect.<os>/ folder`**, or **`differences must name the Known differences rows`**.
  `differences` and `expect.<os>/` come together: add both or neither, and `differences` is a non-empty list of
  strings. The runner doesn't check the names, so the review does: each must name a row of the contract's Known
  differences table, or be `"Entry selection"`.
- **`gh line 1: want "pr create", got nothing`.** The commit never reached `gh`; it likely stopped earlier. Run the
  same commands by hand in a throwaway clone and read the output. One trap: `cp -p` overwrites a file in place and keeps
  the source's mtime, so if the home and repo texts have the same size and were written in the same second, git's stat
  cache sees no change and commit reports `Nothing to commit`. Give the two texts different sizes.
- **`gh: want no call, got "pr create"`.** The case has no `expect/gh.log`, which means gh must not be called. A case
  with a `commit` command must stub gh (`"stubs": ["gh"]`); the runners clear any `GH` variable the caller set, so
  no case can reach a real `gh`.
- **`SKIPPED` on Windows where bash says `CREATED`.** The target folder is missing: Windows skips, bash creates it (a
  known difference). Put a file in the folder under `home/` unless the missing folder is the point of the case.
- **A diff label never shows in `output.txt`.** The runners read `IN`, `OUT`, `BOTH` and `?` as status words. A new
  status word goes into `STATUS_WORDS` in `run.sh` and `$StatusWords` in `run.ps1` together.

## Moved from

A bash or Pester case is removed when a shared case tests the same behavior through the same inputs and the old case
checks nothing more. None has been removed yet. Every twin found checks something the runner can't see, or takes
other inputs:

| Shared case | Old cases kept | What they check beyond the shared case |
|---|---|---|
| `dconf-path-no-slash`, `defaultenv-invalid`, `localpaths-bad-key`, `local-path-absolute`, `repo-path-dotdot`, `platform-missing` | `dconf_path_no_slash`, `defaultenv_invalid`, `localpaths_bad_key`, `path_local_absolute`, `path_repo_traversal`, `missing_platform`; Pester `dconf-path-no-slash`, `localpaths-bad-key`, `path-local-absolute`, `path-repo-traversal`, `missing-platform` | the `ERROR:` text |
| `missing-value-stops`, `preview-only-refused`, `preview-no-change` | `noninteractive_missing_value`, `export_only_preview`, `preview_no_changes`; Pester `noninteractive-missing-value-import`, `export-only-preview`, `preview-no-changes` | the message text |
| `dir-import-extra`, `import-updated-backup`, `only-one-file`, `orphan-reported` | `dir_import_extra`, `import_backup`, `import_only_one`, `orphan_reported` and their Pester twins | the note after the label |
| `export-adds`, `hydrate-creates`, `sanitize-round-trip` | `export_adds`, `import_creates`, `roundtrip_unchanged`; Pester `export-adds`, `import-creates`, `roundtrip-unchanged` | the fixture's four files (modes, no trailing newline), the push hint, `dotfiles/windows` with CRLF |
| `sanitize-longest-first` | `sanitize_longest_first`, Pester `sanitize-longest-first` | values with backslashes under `escapeBackslashes` |
| `sanitized-crlf-unchanged` | `crlf_unchanged` | the import half: the local file keeps CRLF |
| `only-dotdot` | `only_repo_dotdot`, Pester `only-repo-dotdot` | `resolve_only` / `Resolve-OnlyPaths` from the inside |
| `diff-no-sync-point` | Pester `diff-in` | an `IN` label from a recorded sync point, and the summary lines |
| `commit-opens-pr` | `commit_happy`, Pester `commit-happy` | `origin/master` unmoved, back on `master`, one `sync/…` branch |
