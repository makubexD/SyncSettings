# Shared cases

Cases that test the [contract](../../docs/sync-contract.md) through the command line only, so a case runs against
the compiled program: `dist/mksync` on Linux and macOS, `dist\mksync.exe` on Windows. `run.sh` runs them on Linux and
macOS; `run.ps1` runs them on Windows PowerShell 5.1. CI runs them in `program-build` (Linux), `program-macos` and
`program-windows`, against the program `program-build` compiles.

```bash
tests/parity/run.sh                                          # every case, against dist/mksync
tests/parity/run.sh only-                                    # cases whose name contains "only-"
tests/parity/run.sh --engine dist/mksync export-unchanged    # another build
```

Cases run at once, one per processor; `PARITY_JOBS=<n>` sets another number (both runners). The program stays out of
each case's git repo: committing its 100 MB took seconds a case.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/parity/run.ps1 [-Engine <path>] [case-name-filter]
```

## Running a build

`--engine <path>` (`-Engine <path>`) picks the program; the default is `dist/mksync` (`dist\mksync.exe`). It is
copied into the temp repo as `mksync` (`mksync.exe`), the commands are spelled `./mksync export …` with the same
options (and `./mksync status …`, `diff`, `check` and `preview` for `front-diff`, `front-check` and
`front-preview`), and it is stripped before the repo is compared. `expect.<os>/` is used only when the case's
`differences` name `Entry selection`, `Shared files without rules` or `Exclude patterns`; every other case uses
`expect/` on every OS. `import-eof-no-force` runs on every OS.

### The clone launcher

`--engine ./mksync` runs the clone's launcher, which is linked into the temp repo rather than copied so it still finds
`src/main.ts` next to itself. `MKSYNC_RUNTIME=bun` or `MKSYNC_RUNTIME=node` from the caller's environment picks the
runtime; unset, the launcher takes the first installed of Bun then Node.

## Adding a case

1. Find the rule in the contract. A behavior the contract doesn't state yet goes into the contract first.
2. Copy the closest case under `cases/`, rename it, and write `description` with the contract section in brackets.
3. Write `expect/` from the contract text, not from what the program prints. If the program disagrees, the program or
   the contract is wrong; don't record the program's output.
4. Run the case on Linux. Push and read the macOS and Windows jobs.
5. A case that differs on purpose per OS gets an `expect.<os>/` folder, but only for a row of the contract's
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
  origin/          repo files committed on top of master in a second clone, so origin is ahead (optional)
  unsent/          repo-relative files copied over the working tree after the commit, left uncommitted (optional)
  dconf/           the dumps the dconf stub answers, one .ini per path (optional)
  tools/           what the packages stub prints, one <tool>.txt per manager tool (optional)
  expect/
    exit           one exit code per command, one per line
    output.txt     the status lines of every command, in order
    home/          the whole home folder after the last command
    repo/          the whole repo after the last command, besides sync-config.json
    values.json    optional: .user-values.json after the last command
    state/         optional: files the engine's state folder must hold
    gh.log         optional: the gh calls, when the case stubs gh
    dconf.log      optional: the dconf loads, when the case stubs dconf
    lines.txt      optional: lines the output must hold, for text the status lines drop
  expect.<os>/     optional: only what differs from expect/ on linux, macos or windows
```

`case.json`:

| Field              | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description`      | One sentence: the behavior and the contract section it checks                                                                                                                                                                                                                                                                                                                                                                                        |
| `os`               | Where it runs: a list of `linux`, `macos`, `windows`. Omit for all three                                                                                                                                                                                                                                                                                                                                                                             |
| `configV2`         | Required. The case's config (schema 2), written to the file `configName` names. Every case holds `configV2` only: a v1 `config` key is a runner error (`case.json has a v1 config`), and a case that needs a v1 file (`config-v1-refused`) gives that JSON as its `configV2`, which the runner writes unchecked                                                                                                                                      |
| `configName`       | Optional. The file the case's config is written to in the temp repo: `sync-config.json` or `sync-config.v2.json`; absent, `sync-config.json` (a case that simulates an old clone names `sync-config.v2.json`). Any other value is a runner error.                                                                                                                                                                                                    |
| `values`           | Optional. Written as `.user-values.json` in the repo; omit to have none                                                                                                                                                                                                                                                                                                                                                                              |
| `env`              | Optional. Variables set for every command: a string sets it, `null` unsets it. Applied after `HOME`/`USERPROFILE`, so `{"HOME": null}` unsets it. `CTX_WINDOW_DIR` is a path relative to the case's temp home (`.claude/state/ctx-window` reaches the command as `<home>/.claude/state/ctx-window`); an absolute path or one with a `..` segment is a runner error                                                                                   |
| `emptyDirs`        | Optional. Paths relative to the case's temp home of empty folders to create, with their parents, after `home/` is copied and before the first command; git can't store an empty folder, so this is how `home/` holds one. An absolute path or one with a `..` segment, a non-list, or an item that isn't a string is a runner error. The runner adds them to its copy of `expect/home/` before the tree compare, so that tree needs nothing for them |
| `commands`         | The commands, run in order in the same folders. Each is `{ "command": …, "options": {…}, "stdin": …, "stderr": true }`, the last two optional                                                                                                                                                                                                                                                                                                        |
| `git`              | Optional. `"none"` (default): the temp repo is a plain folder. `"committed"`: a git repo with everything committed on `master`. `"remote"`: that, plus a local bare `origin` it was pushed to, with `master` tracking it                                                                                                                                                                                                                             |
| `syncPoint`        | Optional. `true` writes the repo's `HEAD` after the initial commit and push to the engine's `last-sync` file (`~/.local/state/sync-settings/last-sync`, `%LOCALAPPDATA%\SyncSettings\last-sync`), before `state/` is copied, so a case can override it there. Needs `"git": "remote"`; a non-boolean, or no `remote`, is a runner error                                                                                                              |
| `originUrl`        | Optional. Needs `"git": "remote"`. After the setup, `git remote set-url origin` gives the clone this address (`https://github.com/parity-owner/SyncSettings.git`), so a source that reads `origin` sees it. The case runs with `GIT_ALLOW_PROTOCOL=file`, so a fetch or push to it fails at once, offline, and the up-to-date check prints its could-not-reach note                                                                                  |
| `gitConfigLocal`   | Optional. A list of `[key, value]` string pairs (`[["credential.https://github.com.helper", ""]]`), keys of letters, digits and `. : / _ -`, values any string, empty included. After the git setup and before the first command each pair runs as `git config --local --add <key> <value>` in the case's clone, in order, so a key twice is a multi-valued entry. Needs `"git": "committed"` or `"remote"`; anything else is a runner error         |
| `stubs`            | Optional. Any of `gh`, `dconf`, `getent`, `bootstrap` and `packages`, as a list: each names a stub put first on `PATH`; see [The stubs](#the-stubs) below                                                                                                                                                                                                                                                                                            |
| `ghAccounts`       | Optional. A list of gh account names (`["owner", "bot"]`, each non-empty, letters, digits and dashes), first = the active one. Needs `"stubs": ["gh"]`; anything else is a runner error. The stub then answers `gh auth token` with `tok-<first>` and `gh auth token --user <name>` with `tok-<name>` for a listed name; otherwise both print nothing and exit 1                                                                                     |
| `origin/` (folder) | Optional. A tree of repo-relative files committed on top of `master` in a second clone and pushed to the bare origin, then `git fetch origin` in the repo: `origin/master` is one commit ahead, while the repo's `master` and working tree stay unchanged. Needs `"git": "remote"`; without it, a runner error                                                                                                                                       |
| `unsent/` (folder) | Optional. A tree of repo-relative files copied over the repo's working tree after the initial commit, the push and `origin/`, and left uncommitted, so `git status --porcelain` shows them. They are compared like any other repo file, so `expect/repo/` must hold them. Needs `"git": "committed"` or `"remote"`; without one, a runner error                                                                                                      |
| `differences`      | Required when the case has an `expect.<os>/` folder, and only then: the names of the rows it records                                                                                                                                                                                                                                                                                                                                                 |

`home/`, `repo/` and `state/` are copied into the case's temp folders before the first command. `state/` goes into
the engine's state folder (`~/.local/state/sync-settings` on Linux and macOS, `%LOCALAPPDATA%\SyncSettings` on
Windows), so a case can start from a recorded sync point; its files are compared like any the engine wrote. The
record (`machine.json`) and profiles (`profiles/*.json`) go in with mode 600, as the program writes them, and the
bash runner wants 600 for them in `expect/state/`, since git can't store that mode.

`command` is one of `export`, `import`, `check` (`import --check`), `preview` (`export --preview`), `diff`
(`export --diff`) and `commit`, the front door's `status`, `doctor`, `pull`, `push`, `front-diff`, `front-check` and
`front-preview`, plus `setup`, `statusline`, `machine-show` (`machine show`), `machine-retire`
(`machine retire <target>`) and `profile-retire` (`profile retire <target>`). Every command runs `./mksync <cmd>`,
with `front-diff`, `front-check` and `front-preview` spelled `diff`, `check` and `preview`.
`options` uses neutral names that the runner spells for the program: `force: true` is `--force`, `only: [paths]` is
`--only`, and `resetValues`, a boolean, is `--reset-values`, allowed on `import` and `check` only. `name`, `profile`,
`replace`, `claude`, `mode` and `existing` are strings spelled `--<key> <value>` and allowed on `setup` only;
`yes: true` adds `--yes` on `setup`, `export`, `preview`, `machine-retire`, `profile-retire`, `status`, `doctor`,
`pull`, `push` and `front-diff`; `bootstrap: true` adds `--bootstrap` on `setup` only; and `target`, a string, is the
name argument of `machine-retire` and `profile-retire`, required there and refused elsewhere. On `commit` only,
`partial: true` adds `--partial`; `message`, a string, adds `-m <msg>` on `commit` and `push`. On the six front door
commands (`status`, `doctor`, `pull`, `push`, `front-diff` and `front-check`), `paths`, a list of strings, appends each
path as a positional argument after the options. Every command runs with no terminal, as CI does, and with stdin empty unless the command has `stdin`: a
string sent as its stdin, such as `"n\n"` for a prompt answer. Its
stderr is merged into its output unless the command has `stderr: true`: then its stderr lines follow its stdout status
lines in `output.txt`, for the warnings the program prints there. A command's output is read as status lines (below)
except for `setup`, `statusline`, `machine-show`, `machine-retire` and `profile-retire`, and any command with
`"output": "all"`:
those keep their whole stdout instead, so the `machine show` fields, the scan block and the `ERROR:`, `held` and
`refused:` lines reach `output.txt`. `statusline` keeps its ANSI color codes in `output.txt`, as the contract writes
them; every other whole-stdout command has them removed. `output` may only be `"all"`; anything else is a runner
error.

### Per-OS expectations

`expect.<os>/` (`linux`, `macos`, `windows`) holds only what differs on that OS. Each entry replaces its twin in
`expect/`: `exit` and `output.txt` as files, `home/` and `repo/` as whole trees, `values.json`, `state/`, `gh.log` and
`dconf.log` the same way. Use it only for a row of the contract's
[Known differences](../../docs/sync-contract.md#known-differences), named in `differences`. The one other allowed
name is `"Entry selection"`, for a case where each OS picks its own entries by design.

### The stubs

With `"stubs": ["gh"]`, every `gh` call appends its arguments, joined by spaces, as one line to a log outside both
trees and exits 0. It prints `parity-user` for `api user --jq .login` and `config get -h github.com user` (the
`gh-login` and `gh-hosts-login` suggestion sources) and nothing for any other call, except the accounts below. With `ghAccounts`, `gh auth token` (also `--hostname github.com`) prints `tok-<first name>` and
`gh auth token --user <name>` (also with `--hostname github.com` before it) prints `tok-<name>` for a listed name, both exit 0; with no `ghAccounts`, or for an unlisted
name, they print nothing and exit 1. When the stub's environment has a non-empty `GH_TOKEN` (a case sets it through
`env`), the logged line starts with `GH_TOKEN=<value> `. Each logged line is cut to its first two words (`pr create`;
the `GH_TOKEN=<value>` prefix is kept and not counted, so `GH_TOKEN=tok-a pr create --base x` becomes
`GH_TOKEN=tok-a pr create`), so branch
names and titles don't matter, and the result must equal `expect/gh.log` line for line. No `expect/gh.log` with the
stub on means `gh` must not be called.

With `"stubs": ["dconf"]`, a `dconf` first on `PATH` stands in for the session's dconf. `dconf dump <path>` prints the
case's `dconf/<name>.ini`, where `<name>` is the path without its leading and trailing `/` and with the remaining `/`
turned to `-` (`/org/gnome/desktop/` is `dconf/org-gnome-desktop.ini`); a missing file prints nothing. Either way it
exits 0.
`dconf load <path>` appends the line `load <path>` and then its stdin verbatim to a log outside both trees; there is no
cut, so the result must equal `expect/dconf.log` byte for byte. No `expect/dconf.log` with the stub on means dconf must
not be loaded. Any other `dconf` call prints a message on stderr and exits 1.

With `"stubs": ["getent"]`, `getent passwd <key>` (the program asks by uid) answers with the case's temp home in the
home field (`<key>:x:1000:1000::<home>:/bin/bash`) and exits 0; any other call exits 2, as getent does for an unknown
key. `getent` needs `dconf` in the same list: `run.sh` refuses a case that stubs it alone, since the lookup only guards
a dconf load.

With `"stubs": ["packages"]`, `dpkg-query`, `apt-mark`, `snap`, `pipx` and `code` first on `PATH` stand in for the
package managers of the [drift report](../../docs/sync-contract.md#package-drift): each prints the case's
`tools/<name>.txt` (`tools/dpkg-query.txt`), nothing when it's missing, and exits 0 whatever its arguments. `npm`,
fonts and GNOME extensions are folders under the case's `home/`, so they need no stub. `DRIFT_ROOT` points at an empty
folder in the case, so the apt-source and apt-key rows never read the machine's `/etc/apt`. Both runners refuse a case
whose `repo/` holds `packages/` without this stub, since export and preview would ask the real managers; so does a
`packages/` in `unsent/` or `origin/`, unless every command is a `commit`, which never reads them.

`dconf`, `getent`, `bootstrap` and `packages` are Linux only: `run.ps1` skips a case whose `os` leaves out Windows
before it looks at the stubs, and fails one that would run on Windows with them.

## How the runner checks it

1. Copy the program into a temp repo, write `configV2` and `values`, copy `repo/`, `home/` and `state/`.
2. Run each command with the home folder as `HOME` (Linux, macOS) or `USERPROFILE` (Windows). `GH`,
   `XDG_STATE_HOME`, `XDG_CONFIG_HOME`, `VIRTUAL_ENV` and `CONDA_DEFAULT_ENV` are cleared first, so the caller's
   shell can't change a case's output (a Python env would otherwise add a statusline section). So are
   `DBUS_SESSION_BUS_ADDRESS`, `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GH_TOKEN` and `GITHUB_TOKEN`, and
   `GIT_CEILING_DIRECTORIES` is the case's temp folder, so a case can't reach the real session bus, the caller's repo
   or a GitHub account (both runners). A case's own `env` is applied after, so it may still set them. Copied `home/`
   files get the current time, so git's stat cache can't call a changed repo twin clean.
3. Compare:
   - **Exit codes** with `expect/exit`.
   - **Status lines.** Each output line that is a status line becomes `WORD label`: the word without brackets or
     color, then the label. Notes and every other line are dropped. A line starting `Next` is kept whole and without its indent
     (`Next: mksync pull`), so a `status` case is compared on it; so is a line starting `Linked folder not synced:`. With `stderr: true` on the command, its stderr
     lines are kept whole (color dropped too) and come after its stdout status lines. A whole-stdout command (above)
     keeps every line of its stdout instead, in order, with color codes and a trailing `\r` removed and a final line
     without a newline kept; `statusline` keeps its color codes. An empty stdout adds no line, and a whole-stdout
     command's stderr is left out unless `stderr: true`. The result must equal `expect/output.txt`, line for line.
   - **Trees**, byte for byte, file list and content. The runner leaves out what the program keeps for itself:
     `.user-values.json`, the state folder (`~/.local/state/sync-settings`, `%LOCALAPPDATA%\SyncSettings`), and `.git`
     (the bare `origin` lives outside the repo). File modes are compared only where the file system keeps them.
   - **Values**, when `expect/values.json` exists: the repo's `.user-values.json` after the run, as JSON with key
     order ignored.
   - **State**, when `expect/state/` exists: each file in it must be in the state folder with the same bytes; other
     state files, such as the sync point, whose SHA changes per run, are ignored. A run's dated backup folder
     `backups/<run>/` is read as `backups/RUN/`, and there must be exactly one, so the time and pid don't matter. An
     expected state file may hold `<START_HEAD>`: the runner replaces it with the repo's `HEAD`, recorded right after
     setup (the commit the case starts from), before comparing; without a git repo it is a case error.
   - **Placeholders** in a whole-stdout command's output (above), after every command ran: the case's temp home folder
     becomes `<HOME>` (`/` separators on Windows too); `backups/<name>` (`backups\<name>` on Windows), where `<name>` is
     the one backup run folder in the state folder, becomes `backups/RUN`; and in a line `  Sync point : <sha>`, a
     `<sha>` that begins the repo's `HEAD` after the run becomes `<HEAD>`. Status-line output is left alone.
   - **Lines**, when `expect/lines.txt` exists: notes, `ERROR:` and `WARNING:` lines and summaries the status-line
     check drops. Each command's output is read with color removed and each line trimmed, and a status line in
     either layout is read as `WORD label note`, single spaces between. A line `# <n>` starts the expected lines of
     command `n` (1-based); lines before any `#` belong to command 1. Each expected line must appear in that
     command's output, in the file's order, other lines allowed between them. A line `! <text>` means no line of that
     command's output contains `<text>`. A failure names the first missing (or present `!`) line and prints the
     command's normalized output. `output.txt` stays the exact check of status lines.
   - **gh calls**, when the case stubs `gh` (above).
   - **dconf loads**, when the case stubs `dconf` (above).

Each file is taken from `expect.<os>/` when it's there for the OS the runner is on, else from `expect/`.

## What fits

A case fits when the behavior shows in exit code, status lines and files. A git remote (`git`), `gh`, `dconf` and
`getent` and the package managers (`stubs`), a prompt answer (`stdin`) and an empty folder in `home/` (`emptyDirs`)
are covered. Each manager's parsing is covered by the program's unit tests, as is a dconf case that needs a real
session bus rather than the stub. Text the status-line check drops (notes, `ERROR:` and `WARNING:` lines, summaries,
the `Offline:` line) goes in `expect/lines.txt`, per command with `# <n>`; a line that must not appear (no `ORPHAN`
under `--only`) is a `! <text>` line there. An unreachable origin is an `env` that rewrites every remote URL
(`diff-offline`). A check of one function from the inside goes in the program's unit tests. A write failure (other than a folder in the way, `dconf-export-in-the-way`) and a symlink in `home/` can't be
set up yet; the program's unit tests cover those ([design, "Open"](../../docs/design-layers.md#open)).

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

| Prefix                                                                                                                                    | Meaning                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `exit:`, `exit line N:`                                                                                                                   | the exit code of command N                                                       |
| `output line N:`                                                                                                                          | status line N, across all commands, as `WORD label`                              |
| `Files expect/home/… and home/… differ`, `Only in …` (bash); `home: differs: …`, `repo: only in want: …`, `… only in got: …` (PowerShell) | the home or repo tree: a file different, missing or extra                        |
| `mode <path>:`                                                                                                                            | the file is right but its mode isn't (bash runner only)                          |
| `values.json:`, `state …:`                                                                                                                | `expect/values.json` or `expect/state/`                                          |
| `gh line N:`                                                                                                                              | gh call N, cut to its first two words                                            |
| `gh: want no call`                                                                                                                        | the case has no `expect/gh.log`, so gh must not be called, and it was            |
| `dconf line N:`                                                                                                                           | line N of the dconf log                                                          |
| `dconf.log:`, `dconf: want a load`, `dconf: want no load`                                                                                 | the dconf log against `expect/dconf.log`                                         |
| anything else                                                                                                                             | the case itself is malformed: `case.json`, `differences`, an `expect.<os>/` name |

Only the first difference prints. Fix it and run the case again with its name as the filter. The filter is a
substring of the case name, or several joined by `|` (`setup-guess|setup-yes-guess`); a case runs when any one matches.

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
  with a `commit` command must stub gh (`"stubs": ["gh"]`); the runners clear any `GH` and `GH_TOKEN` variable the caller set, so
  no case can reach a real `gh` or a real token.
- **A diff label never shows in `output.txt`.** The runners read `IN`, `OUT`, `BOTH` and `?` as status words. A new
  status word goes into `STATUS_WORDS` in `run.sh` and `$StatusWords` in `run.ps1` together.

## Moved from

The old bash and Pester suites were deleted at the cut-over (tag `two-engines-final`). Where each of their cases went,
a shared case, a unit test or dropped, is in [design-test-moves.md](../../docs/archive/design-test-moves.md) and
[port-inventory.tsv](../../docs/archive/port-inventory.tsv).
