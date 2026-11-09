# Sync engine contract

SyncSettings has two engines: PowerShell 5.1 on Windows (`scripts/windows/`) and bash on Linux and macOS
(`scripts/linux/sync.sh` plus `export.sh`, `import.sh`, `commit.sh`). They share no code. They share
`sync-config.json`, the `.user-values.json` format, and the rules on this page.

This page is for contributors. If you change how an engine behaves, change this page in the same PR, and add a
fixture case to `tests/linux/engine.sh` or `tests/windows/Engine.Tests.ps1` (or both) that proves the rule. A rule
listed under [Known differences](#known-differences) applies to one engine only. Every other rule applies to both.

To add or change an entry in `sync-config.json`, see [configuration.md](configuration.md).

## Flow

```mermaid
flowchart LR
    L[Local files] -->|export: compare, sanitize, copy changed| R[dotfiles/ in repo]
    R -->|commit: branch + PR| G[GitHub master]
    G -->|git pull| R
    R -->|import: compare, prompt, .bak, hydrate| L
```

- **Export** reads every selected entry's local file. It compares the file with the repo copy by content (never by
  date), sanitizes it, and writes only the files that changed. It ends with the [orphan report](#orphan-report) and, in
  bash, the [drift report](#package-drift).
- **Commit** runs the [checks before pushing](#checks-before-pushing), stages `dotfiles/`, `sync-config.json` and
  `packages/` (if it exists), commits on a `sync/<os>-<machine>-…` branch (`sync/linux-…` on Linux, `sync/macos-…` on a
  Mac) and opens a PR. It never pushes to `master`. See [review-gate.md](review-gate.md).
- **Import** reads every selected entry's repo file and hydrates its placeholders. If the local file differs, import
  asks before overwriting it (unless forced) and keeps a `.bak` copy of the old file.

A [dconf entry](#dconf-entries-type-dconf) follows the same flow with a dconf folder in place of the local file.

## Entry selection

Each entry in `files` has a required `platform`: one of `"common"`, `"windows"`, `"linux"`, `"macos"`, or a list of
the last three, such as `["linux", "macos"]`:

| `platform` | Windows engine | bash on Linux | bash on macOS |
|---|---|---|---|
| `windows` | yes | no | no |
| `linux` | no | yes | no |
| `macos` | no | no | yes |
| `common` | yes | yes | yes |
| a list | if it holds `windows` | if it holds `linux` | if it holds `macos` |

`common` means all three systems. A file shared by Linux and macOS but not Windows uses the list `["linux", "macos"]`.

If any entry has no `platform`, a value outside these, an empty list, a list with a repeat, or a list holding `common`,
the engine stops with exit code 1 before it touches a file:

```text
ERROR: sync-config.json: entry <repoPath> needs "platform": "common", "windows", "linux", "macos" or a list of the last three.
```

The check covers every entry, not only the ones the engine would select, so a bad Linux entry also stops the Windows
engine. CI lint catches the same mistake earlier.

Entries run in the order they appear in `sync-config.json`.

### Which system

The bash engine picks its system with `sync_os`: `SYNC_OS` when it's set, else `uname -s` (`Linux` is `linux`, `Darwin`
is `macos`). Tests set `SYNC_OS=macos` on Linux to cover macOS behavior. Any other value stops the run with exit code 1:

```text
ERROR: SyncSettings runs on Linux, macOS and Windows; this is <value>.
```

The PowerShell engine is always `windows`.

`os.sh` also defines `PLATFORM_SELECT_JQ`, the jq filter that picks the entries for a system. It's internal: a value
inherited from the environment is overwritten, and only a second `source` in the same shell, where the variable is
already `readonly`, keeps it.

## Path safety

Right after the `platform` check, each engine checks every entry, on any platform, and stops with exit code 1 before it
touches a file:

- `repoPath` starts with `dotfiles/` and has no `..` segment.
- `localPath` starts with `~/` or `~\` and has no `..` segment.
- Each [`localPaths`](#localpath) value follows the same rule, and its keys are `linux`, `macos` or `windows`.
- Nothing under `dotfiles/` is a symlink.

CI lint (`scripts/ci/check-config.sh`) is stricter: every `common` entry, every list entry, and every non-dconf
`linux` or `macos` entry needs a `localPath` in the `~/` form.

```text
ERROR: sync-config.json: entry <repoPath> has an unsafe path.
ERROR: sync-config.json: entry <repoPath> has an unknown localPaths key <key>.
```

A dconf entry has no `localPath`. Instead its `platform` must be the string `linux` (a list, even `["linux"]`, stops
both engines), and its `path` must start and end with `/`, hold
at least one segment of letters, digits, `.`, `_` or `-`, and have no `..` segment. So `/` alone is refused, and nobody
dumps the whole database by accident.

```text
ERROR: sync-config.json: entry <repoPath> needs "platform": "linux" and a dconf path like /org/gnome/shell/.
```

The bash engine also checks that `defaultEnv` matches `^[A-Za-z_][A-Za-z0-9_]*$`, because it uses the name to look up a
variable. PowerShell reads the name as plain data, so it has no such check.

```text
ERROR: sync-config.json: entry <repoPath> has an invalid defaultEnv.
```

## `localPath`

| Form | Example | Works on |
|---|---|---|
| `~/` + forward slashes | `~/.config/git/ignore` | both. PowerShell turns `/` into `\` after expanding `~` |
| `~\` + backslashes | `~\.gitconfig.local` | Windows only |

`~` is the user's home: `$HOME` on Linux, the profile folder on Windows (`$env:USERPROFILE`, or the target user's
profile with `-User`). A `common` entry, and any entry the bash engine runs (`linux`, `macos` or a list holding them), must
use the `~/` form. Every `localPath` must use one of these two forms: an absolute path stops the run
([Path safety](#path-safety)).

`localPaths` (optional) is an object keyed by system, for a file whose content is shared but whose folder differs, such
as VS Code's `~/.config/Code/User` on Linux and `~/Library/Application Support/Code/User` on macOS. On a system named in
it, its value replaces `localPath`; elsewhere `localPath` applies. A key for a system the entry's `platform` doesn't
select is allowed and never used. The bash engine swaps the path when it selects the entry, so every later rule sees one
`localPath`.

## Statuses

Each file gets one status line: the status word, its label (the `repoPath`, or `<repoPath>/<rel>` inside a
directory entry) and sometimes a note in parentheses. The layout is up to each engine (PowerShell puts the word in
brackets and colors it), but the word, the label and the notes listed below are the contract, and tests match on
them.

### Export

| Case | Status | Note |
|---|---|---|
| Local path matches an exclude pattern | `SKIPPED` | `matches exclude pattern` |
| Local file missing | `SKIPPED` | `local file not found: <path>` |
| Repo file missing | `ADDED` | `sanitized` if the entry has rules |
| Same content | `UNCHANGED` | |
| Different content | `MODIFIED` | `sanitized` if the entry has rules |
| `type: dir`: repo file no longer present locally | `REMOVED` | `no longer in source` |
| `type: dconf`: `dconf` isn't installed | `SKIPPED` | `dconf not installed` |
| `type: dconf`: nothing left after `keys` | `SKIPPED` | `no settings under <path>`; a repo file stays as it is |
| `type: dconf`: `dconf dump` failed | `ERROR` | `dconf dump failed` |
| Read, write or copy failed | `ERROR` | the reason |

### Import

| Case | Status | Note |
|---|---|---|
| Local path matches an exclude pattern | `SKIPPED` | `matches exclude pattern` |
| Repo file missing | `SKIPPED` | `not found in repo` |
| Local file missing | `CREATED` | |
| Same content | `UNCHANGED` | |
| Different content, overwrite accepted | `UPDATED` | `backup saved as <name>.bak` |
| Different content, user answered no | `SKIPPED` | `user skipped` |
| `type: dir` or linked folder: local file not in the repo | `EXTRA` | `not in repo; kept` |
| `type: dconf`: `dconf` isn't installed | `SKIPPED` | `dconf not installed` |
| `type: dconf`: `HOME` isn't the login home | `SKIPPED` | `HOME is not the login home; dconf left alone` |
| `type: dconf`: `${XDG_CONFIG_HOME:-$HOME/.config}` isn't `$HOME/.config` | `SKIPPED` | `XDG_CONFIG_HOME is not ~/.config; dconf left alone` |
| `type: dconf`: nothing set under `path` yet | `CREATED` | no prompt, no backup |
| `type: dconf`: every repo key already has that value | `UNCHANGED` | nothing is loaded |
| `type: dconf`: dump, backup or load failed | `ERROR` | `dconf dump failed`, `cannot create backup`, `dconf load failed` |
| Read, write or copy failed | `ERROR` | the reason |

### Both

| Case | Status | Note |
|---|---|---|
| File under `dotfiles/` that no entry owns | `ORPHAN` | `no entry in sync-config.json; git rm it or add an entry` |
| Bash, export: a package list and the machine disagree | `DRIFT` | see [Package drift](#package-drift); the label is `<manager>/<name>` |

An `ERROR` affects only its own file. The engine moves on to the next entry, and the run still exits 0. Exit code 1
is reserved for problems that stop the whole run: invalid config, a missing placeholder value, a failed `git pull`, or a
failed [check before pushing](#checks-before-pushing).

## Overwrite prompt

Unless `--force` (bash) or `-Force` (PowerShell) is given, import asks `Overwrite <file>? [Y/n]` before it replaces a
local file whose content differs. An empty answer means yes. In bash, end of input (for example `< /dev/null`) also
counts as an empty answer, so a non-interactive run without `--force` overwrites. The `.bak` copy is still written.
Force skips only the prompt, never the `.bak`. For a dconf entry, `<file>` is the entry's `path`.

## Sanitize and hydrate

`sanitizeRules` hold the placeholders for one entry's file. On export, sanitizing replaces real values with
placeholders. On import, hydrating puts the values back.

**Where values come from**, in this order:

1. `.user-values.json` next to `sync-config.json` (gitignored, keys are placeholders).
2. Import only: values inferred from the existing local file (below). They are never used for a placeholder that
   already has a cached value.
3. A prompt, offering a default taken from the first of these that exists: the cached value, the rule's `default`,
   the environment variable named by `defaultEnv`. An empty answer takes the default. With no default it stops the run
   (see below).

`--reset-values` (bash) or `-ResetValues` (PowerShell) prompts again for every placeholder and skips inference.
New values are saved back to `.user-values.json`. Each save leaves the file readable by the current user only: mode 600
on Linux, also tightening an existing file, and no inherited access on Windows.

**Inference on import.** For each entry with rules whose local and repo files both exist, the engine compares the
two files line by line, up to the shorter one, with `\r` stripped. Take a repo line that contains a placeholder,
paired with a local line that doesn't. If the local line starts with the text before the placeholder and ends with
the text after it, the text in between is the value. Empty results are ignored. For a rule with
`escapeBackslashes: true`, each `\\` in the inferred value becomes `\`, because the file holds the doubled form.

**Sanitize (export).** Values are replaced longest first, so a value that contains a shorter one is replaced whole.
For each value that contains `\`, its backslash-doubled form (`C:\\Tools`) is replaced before the plain form
(`C:\Tools`), so files that escape backslashes sanitize too.

**Hydrate (import).** Each placeholder gets its value. If the rule has `escapeBackslashes: true` and the value
contains `\`, the placeholder gets the backslash-doubled value instead.

**Missing value.** If a placeholder has no value after all of the above, with or without a terminal, the engine prints
`missing value for <PLACEHOLDER>: add it to .user-values.json` and exits 1 before writing any file. Output names the
placeholder, never its value.

## Compare

- Files without rules: byte for byte (`cmp` in bash, SHA256 in PowerShell).
- Files with rules: the sanitized local text (export) or the hydrated repo text (import) against the other side,
  after turning CRLF into LF and trimming whitespace at the end of the file. A file that differs only in line
  endings or trailing blank lines counts as `UNCHANGED`, and nothing is written. The compare is case-sensitive, so a
  change of case counts as `MODIFIED`.

Text is written byte for byte: no BOM, and trailing newlines are kept.

## Backups

Import copies the old local file to `<file>.bak` before overwriting it, replacing any older `.bak`, in every entry type.
`*.bak` is in `excludePatterns`, so a `.bak` inside a synced directory is never exported.

A dconf entry has no local file to sit next to, so its backup is `~/.local/state/sync-settings/dconf/<file>.bak`, where
`<file>` is the name of the repo file. It holds the raw dump of `path`, written before each `UPDATED`. Loading it back
restores the old values, but a key that had no value before keeps the repo's value, because a load never removes a key.

## Exclude patterns

`excludePatterns` are globs matched against the local path's file name, or the end of the path. A match is skipped
on export and import, and inside directory entries too.

## Directory entries (`type: dir`)

An entry with `"type": "dir"` syncs a whole folder, recursively.

- Only regular files are synced. Symlinks are `SKIPPED` with the note `symlink`. A symlink at the folder's own
  path is followed.
- `excludePatterns` apply to every file. `sanitizeRules` and `detectLinkedPaths` are not allowed on a `dir`
  entry (lint fails).
- No entry may have its `repoPath` inside a `dir` entry's `repoPath`, including another `dir` entry (lint fails).
- If the local folder is missing on export, the entry is `SKIPPED` with the note `local folder not found: <path>`.
- If no local file passes the symlink and exclude checks (an empty folder, or one holding only symlinks or excluded
  files) while the repo folder still holds at least one file, the entry is `SKIPPED` with the note
  `local folder is empty; repo files kept` and no repo file is removed.
- Export deletes repo files that are gone locally or are now excluded (`REMOVED`; git keeps the history), then
  removes empty folders under the entry's `repoPath`.
- Import never deletes. A local file that the repo doesn't have is reported as `EXTRA` and kept, so a file you
  haven't exported yet survives an import.
- Each file inside follows the same compare, prompt and `.bak` rules as a plain entry.

## Linked folders (`detectLinkedPaths`)

PowerShell only. A folder detected in an entry's file is stored under `<repoPath>.linked/<folder>/`.

- Export deletes repo files that are gone from the folder, like a `dir` entry.
- An empty folder keeps its repo files, like a `dir` entry.
- Import never deletes. A local file that the repo doesn't have is reported as `EXTRA` and kept.
- Each file inside follows the same compare, prompt and `.bak` rules as a plain entry on import, and `excludePatterns`
  apply to it.

## dconf entries (`type: dconf`)

Bash only. An entry with `"type": "dconf"` syncs one dconf folder with one `.ini` file. The Windows engine validates these
entries and never runs them.

- **Repo file.** Export owns it, so it is byte for byte what `dconf dump` prints, filtered by `keys`.
- **`keys`.** An allowlist of shell globs matched against a key's name relative to `path`, such as `font-name` or
  `Profiles/abc/label`. `*` also matches `/`. Without `keys`, the whole subtree goes. A section left with no keys is
  dropped. A key nobody named stays out on purpose, because the repo is public and the leak scan can't recognize
  coordinates or shell history.
- **Export.** Compares bytes with the repo file. An empty result is `SKIPPED` and never touches the repo file. A failed
  repo write is an `ERROR` for that entry, and the run moves on.
- **Import merges; it never resets.** `dconf load` leaves keys the file doesn't name, so a key only the machine has
  doesn't count as a difference. A key reset to its default on one machine disappears from the repo file, and another
  machine keeps its old value.
- **Login-home guard.** Import won't load when `$HOME` isn't the home in `getent passwd`. dconf writes go over the session
  bus to a service that keeps the login session's `HOME`, so `HOME=$(mktemp -d) ./import.sh` would otherwise change the
  real desktop. Export needs no guard: `dconf dump` reads the file under `$XDG_CONFIG_HOME`.
- **Session bus.** Import needs the graphical session. From a text console, each entry that has to load reports `ERROR`
  with `dconf load failed`. Export works without a bus.
- **Bad repo file.** One invalid value fails the whole load, so no key of that entry is written.
- **No `sanitizeRules` or `detectLinkedPaths`.** Lint fails on them, and on a `localPath`. A home path in a dump stops at
  the leak scan.
- **Leak scan.** An extension UUID has the shape of an address, so the `enabled-extensions` and `disabled-extensions` lines
  of an `.ini` under `dotfiles/linux/gnome/dconf/` are exempt from the email rule. Every other line, file and suffix isn't.

## Checks before pushing

Commit runs these after the check for changes outside the sync paths, and before it creates a branch or a commit. A
failure exits 1 and leaves no branch, no commit and no PR.

**Leak scan.** `scripts/ci/leak-scan.sh` runs on the sync paths. Skipping it is not an option: a scan that cannot run stops
the commit the same way a hit does.

| Scan result | Message |
|---|---|
| Exit 1 | `ERROR: the leak scan found the lines above; nothing was committed.` |
| Script or bash missing, or any other exit code | `ERROR: leak scan could not run; nothing was committed.` |

**Cached values.** The changed sync files are searched for each value in `.user-values.json`, ignoring case and including
the backslash-doubled form. A placeholder on its own passes. The value never appears in arguments or output.

```text
ERROR: a cached value for <PLACEHOLDER> is in <file>; nothing was committed.
```

A search that cannot finish stops the commit too, with `ERROR: could not search for cached values; nothing was committed.`

## Orphan report

At the end of an export, each engine lists every file under `dotfiles/` that no entry owns, as `ORPHAN`. A file is
owned if it is the `repoPath` of a file or dconf entry, lies under a `dir` entry's `repoPath/`, or lies under `<repoPath>.linked/` of
an entry with `detectLinkedPaths`. Entries for all platforms count, so both engines print the same list. The report
never deletes anything, and never changes the change count or the exit code.

## Package drift

Bash on Linux only, until the Windows engine has a list to compare; on macOS the report prints nothing. Right after the orphan report, in an export and in a preview, the
engine compares `packages/linux/` with the machine. With no such folder it prints nothing. An import never reports drift.

The report never writes a file, never changes a count and never changes the exit code. It runs no install command. `DRIFT` isn't
counted, and neither are its `SKIPPED` lines, so the "file(s) skipped" note keeps counting files only.

| Manager | Present: is a listed name installed? | Chosen: is an installed name listed? |
|---|---|---|
| `apt` | `dpkg-query`, status `installed`, for `apt.txt` and `deb.txt` | `apt-mark showmanual`, against both lists |
| `snap` | `snap list`, without rows whose `Notes` has `base` or `snapd` | Same |
| `npm` | Folders in the newest `$HOME/.nvm/versions/node/*/lib/node_modules` by `sort -V`, with `@scope/name` as one package | Same |
| `pipx` | `pipx list --short`, first field | Same |
| `vscode` | `code --list-extensions` | Same |
| `font` | Folders in `$HOME/.local/share/fonts/NerdFonts/` | Same |
| `extension` | Folders in `$HOME/.local/share/gnome-shell/extensions/` | Same |
| `apt-source` | Files in `<root>/etc/apt/sources.list.d/`, compared by content | Same |
| `apt-key` | `<root>/usr/share/keyrings/<name>`, or else `<root>/etc/apt/keyrings/<name>`, compared by content | None: system keyrings hold plenty of stock keys, so only listed keys are checked |

- **Two sources for apt.** "Present" and "chosen" differ on purpose. A listed package marked auto, such as `dconf-cli`, stays
  quiet, and a dependency never counts as extra. `apt-mark` names lose any `:arch` suffix.
- **npm reads folders.** `npm` isn't called, because which `npm` runs depends on the shell, and the wrong one lists a
  different tree with no error.
- **`drift-ignore.txt`.** `<manager> <name>` lines. They take a name out of the "chosen" check for that manager only. Lint
  fails on a name that is both listed and ignored.
- **`DRIFT_ROOT`.** `<root>` is `${DRIFT_ROOT:-}`, a test-only variable that moves the `apt-source` and `apt-key` lookups, which
  are read-only.

| Case | Status | Label | Note |
|---|---|---|---|
| Listed, not present | `DRIFT` | `<manager>/<name>` | `in packages/linux/<file>, not installed` |
| Chosen, not listed or ignored | `DRIFT` | `<manager>/<name>` | `installed, not in packages/linux/<file>` |
| Source or key differs | `DRIFT` | `<manager>/<name>` | `differs from packages/linux/apt-sources` |
| Tool missing | `SKIPPED` | The list | `<tool> not installed` |
| Tool fails | `SKIPPED` | The list | `<tool> failed` |
| nvm folder missing | `SKIPPED` | `packages/linux/npm.txt` | `nvm not installed` |

For `apt-source` and `apt-key`, `<file>` is `apt-sources`, and a listed source or key that can't be read counts as not
installed. A failing tool never stops the rest of the report. A missing font or extension folder means nothing is present, so
it isn't `SKIPPED`.

**Leak scan.** An extension UUID has the shape of an address, so a whole well-formed line of
`packages/linux/gnome-extensions.txt` is exempt from the email rule. An address anywhere else in that file still fails, and so
does the same line in any other file.

## Up-to-date check

Export and import start by checking whether the repo is behind `origin/master`:

- Not a git repo, no `origin` remote, or a branch other than `master`: no check, no message.
- `git fetch` fails: `NOTE: could not reach origin; skipping the up-to-date check.` and the run continues.
- Up to date: no message.
- Behind, with a terminal: `Repo is <n> commit(s) behind origin/master. Pull now (git pull --ff-only)? [Y/n]`. Yes
  pulls, prints `Pulled <n> commit(s); run the command again.` and exits 0, so the next run uses the
  pulled config and scripts. If the pull fails: `ERROR: pull failed; resolve it and rerun.` and exit 1.
  No continues without pulling.
- Behind, without a terminal: `WARNING: repo is <n> commit(s) behind origin/master; run git pull --ff-only.` and the
  run continues.

## Export preview

`--preview` (bash) or `-Preview` (PowerShell) shows exactly what a commit would send, and writes nothing to the repo or
the machine.

- The engine copies `dotfiles/`, `sync-config.json`, `.user-values.json` and itself to a temp folder, runs a normal
  export there, and compares the result with `HEAD`. Changes exported earlier but not yet committed therefore show too.
- The bash engine also copies `packages/`, so the [drift report](#package-drift) runs. The diff and the leak scan cover
  `dotfiles/` and `sync-config.json` only, so a hand edit to `packages/` doesn't show.
- Status lines are the same as in a real export, followed by a `--stat` summary and the full diff. Text is sanitized,
  so the diff holds placeholders, not real values.
- The temp folder is removed at the end, also after a failure. A placeholder value answered during a preview is not
  saved.
- The leak scan runs on the result before any diff prints. A hit prints `WARNING: the leak scan found the lines above.
  Fix them before committing.`, leaves the diff out so the leaked text stays off the screen, and the preview exits 1.
  A scan that cannot run prints `ERROR: leak scan could not run; nothing was committed.`, prints no diff and exits 1.
- With no differences: `Nothing would be sent: the repo matches HEAD.`
- `--preview` with `--reset-values` is an error, and a preview outside a git repo with a commit is an error. Both exit 1.
- The up-to-date check does not run.
- A preview ends with `Nothing was written. Run mksync push to send it.` on Linux and macOS (`Run export.bat to apply.` on Windows).

## One command

`./sync <preview|export|commit|import> [options]` on Linux and Git Bash, `.\sync` in PowerShell, `sync` in cmd. The name
resolves to the right script for the OS, so `sync` and `sync.cmd` are the two front doors, and Git Bash on Windows hands
over to `sync.cmd`. Options pass through unchanged. The `.sh` and `.bat` entry points still work.
`./sync check` runs `./import.sh --check`, and `sync.cmd check` runs `Import-Settings.ps1 -Check`: each lists what an
import would change, writes nothing, and exits 3 when something differs.

`help` prints the usage and the detected OS and exits 0, and no command shows the [status](#front-door), on both
systems. An unknown command, or a missing `git`, `jq` or `gh` on Linux, exits 1 and names what's wrong. `doctor` runs
before the tool checks, so it works with tools missing. On Windows, `sync.cmd` hands `status`, `doctor`, `setup`, `pull`
and `push` to `scripts/windows/Front.ps1`, and maps `--yes` and `-m <msg>` to `-Yes` and `-Message <msg>`, so the Linux
spelling works too.

## Import check

`import.sh --check` and `Import-Settings.ps1 -Check` report what an import would change and write nothing: no file,
folder, backup, mode, `.user-values.json` or dconf key, and no prompt.

- The header says `IMPORT CHECK`. The up-to-date check doesn't run.
- Values come from `.user-values.json` and inference from the local files, as in an import. A placeholder still
  without a value takes the rule's `default`, then its `defaultEnv` value, in memory only. An entry with a placeholder
  that still has no value is `SKIPPED` with `needs values: run mksync setup`, and counts as a change.
- A file import would create is `CREATE`, one it would overwrite is `UPDATE`; both count as changes. A file in a
  missing folder is a `CREATE`. `UNCHANGED`, `SKIPPED` and `EXTRA` are as in an import.
- dconf runs the import's checks and `dconf dump`, which only reads. An empty dump is `CREATE`, keys the repo would
  change are `UPDATE`.
- No changes: `This machine matches the repo.` and exit 0. Changes: `<n> file(s) would change. mksync pull
  overwrites them (each keeps a .bak).` then `If you changed them on this machine, run mksync push first.` and
  exit 3. Any `ERROR` line ends with `<n> error(s); see the ERROR lines above.` and exit 1, so an entry that
  couldn't be checked never reads as a match.
- `--check` with `--reset-values` is an error, exit 1. `--force` is accepted and does nothing. The PowerShell spellings
  are `-Check`, `-ResetValues` and `-Force`.
- Windows only: a target folder that's missing stays `SKIPPED` with `WARNING: target folder not found: <dir>` and is not
  a change, because an import skips it too. `-Check` with `-User` naming another profile stops before the elevation
  code with `ERROR: -Check works on your own profile only.` and exit 1.

## Front door

On Linux, `mksync` is a link on `PATH` to the repo's `sync`, which resolves the link to find the repo. It's named
`mksync` so it doesn't hide coreutils `sync`. On Windows, `mksync` is `mksync.cmd` in the installer's bin folder, a
four-line launcher that calls the clone's `sync.cmd`; its second line, `rem SyncSettings launcher`, marks it as ours.
Every `[Y/n]` prompt takes an empty answer or end of input as yes, every `[y/N]` prompt as no. Commands, wording and exit
codes are the same on both systems, except where this section says otherwise.

| Command | Does | Exit |
|---|---|---|
| `mksync`, `mksync status` | Prints OS, repo, origin, unsent, machine, and the next command. Writes nothing in the repo or home; it fetches `origin master` | 0 |
| `mksync doctor` | One `OK`, `WARN` or `MISSING` line per check. macOS: as Linux, plus `brew` and the macOS version ([macOS](#macos)). Linux: bash 4, `git`, `jq`, `cmp`, `gh` and its sign-in, the origin remote, the `mksync` link, unset values. Windows: PowerShell 5.1, `git`, `gh` and its sign-in, the origin remote, the `mksync.cmd` launcher, unset values (no `jq` or `cmp`: the PowerShell engine doesn't use them). A `MISSING` line names the install command (`winget install --id …` on Windows when `winget` is there) | 0, or 1 with a `MISSING` line |
| `mksync pull [--yes]` | Refuses with exported changes not sent. Fetches, fast-forwards, re-runs itself so new code runs, then the import check, then asks `Apply these changes? [Y/n]` and runs `import.sh --force` | 0, or 1 on an error |
| `mksync push [--yes] [-m <msg>]` | Runs `export.sh`. Nothing changed: `Nothing to send`. Otherwise shows `git status --short`, asks `Open a PR with these changes? [Y/n]`, then runs `commit.sh` | 0, or the failing script's code |
| `mksync setup [--yes] [--bootstrap]` | Doctor, the import check, on Ubuntu `Also restore apps and packages … [y/N]` (bootstrap), then applies like `pull`. Windows has no bootstrap question and no `--bootstrap` | 0, or 1 on an error |

`pull` and `push` need the clone on `master` with an `origin` remote. On Windows, `pull` re-runs itself in a new
`powershell.exe` after a fast-forward, since PowerShell has no `exec`, and the status fetch has a 15-second timeout as on
Linux. The status's OS name comes from `SYNC_OS_NAME` if set, else the Windows caption. `--yes` answers the `[Y/n]` questions. It never
answers the bootstrap question, because bootstrap uses `sudo`; `--bootstrap` does.

Status lines and the next command, in this order of precedence:

| State | Next |
|---|---|
| Not a git clone, or no origin | `run mksync doctor.` |
| Origin has updates | `mksync pull` |
| Exported changes not sent | `mksync push` |
| The machine differs from the repo | `mksync pull to take the repo's version, or mksync push to send this machine's.` |
| Otherwise | `nothing to do.` |

`install.sh`, run as `curl -fsSL https://raw.githubusercontent.com/makubexD/SyncSettings/master/install.sh | bash`:

- Linux and macOS ([macOS](#macos) has its own rules); Windows shells and other systems stop with a message, exit 1.
- Missing `git`, `jq` or `cmp`: offers `sudo apt-get install` where `apt-get` exists. Otherwise it names the packages
  and exits 1. Unlike the `[Y/n]` rule below, end of input at this question is no: nobody is there to answer, so it
  installs nothing and exits 1.
- Clones the repo, or fast-forwards an existing clone, so running it again updates. A folder that isn't a clone, or a
  `mksync` that isn't its link, stops it without touching either.
- Links `mksync`, prints the `PATH` line if needed, then runs `mksync setup` unless `--no-setup`.
- The script is functions with `main "$@"` as its last line, so a cut-off download runs nothing.
- Answers come from the terminal (`/dev/tty`) when stdin is the piped script.

| Variable | Default |
|---|---|
| `SYNCSETTINGS_REPO_URL` | `https://github.com/makubexD/SyncSettings.git` |
| `SYNCSETTINGS_DIR` | `$HOME/SyncSettings` |
| `SYNCSETTINGS_REF` | `master` |
| `SYNCSETTINGS_BIN` | `$HOME/.local/bin` |
| `SYNCSETTINGS_TTY` | stdin if it's a terminal, else `/dev/tty` if readable, else `/dev/null` |
| `SYNC_OS_RELEASE` (status, setup) | `/etc/os-release` |

`install.ps1`, run in PowerShell as
`irm https://raw.githubusercontent.com/makubexD/SyncSettings/master/install.ps1 | iex`:

- Windows only; elsewhere it points to the bash installer, exit 1. It needs PowerShell 5.1. Errors are thrown and caught
  at the top, so `iex` never closes the user's window.
- Missing `git` (required) or `gh` (for push): offers `winget install --id Git.Git` / `GitHub.cli` where `winget` exists,
  then reloads `Path` for the session. Git still missing stops it; gh missing is a warning.
- Clones the repo, or fast-forwards an existing clone, so running it again updates. A folder that isn't a clone, or a
  `mksync.cmd` without the launcher marker, stops it without touching either.
- Writes `mksync.cmd`, adds the bin folder to the user `Path` if missing (new windows pick it up), then runs
  `mksync setup` unless `SYNCSETTINGS_NO_SETUP=1`.
- The script is one function called on its last line, so a cut-off download runs nothing. It takes no parameters, since
  `iex` can't pass any; settings come from the environment.

| Variable | Default |
|---|---|
| `SYNCSETTINGS_REPO_URL` | `https://github.com/makubexD/SyncSettings.git` |
| `SYNCSETTINGS_DIR` | `%USERPROFILE%\SyncSettings` |
| `SYNCSETTINGS_REF` | `master` |
| `SYNCSETTINGS_BIN` | `%LOCALAPPDATA%\SyncSettings\bin` |
| `SYNCSETTINGS_YES` | unset; `1` answers the `[Y/n]` questions |
| `SYNCSETTINGS_NO_SETUP` | unset; `1` skips `mksync setup` |
| `SYNC_OS_NAME` (status) | the Windows caption |

## macOS

The bash engine runs on macOS with Homebrew's bash and `jq`. macOS ships bash 3.2 and no `jq`; everything else the engine
uses is there. The reasons and the options weighed are in [macos-research.md](macos-research.md).

- **Minimum**: macOS 13. `readlink -f` arrived in 12.3, and Homebrew supports the three newest releases. `mksync doctor`
  prints `WARN macOS <version> is older than 13` below that and carries on.
- **Bash 4 guard**: `sync`, `export.sh`, `import.sh` and `commit.sh` check the bash version before any bash 4 line. Below
  4, they re-run themselves once under `/opt/homebrew/bin/bash` or `/usr/local/bin/bash` (Apple silicon, Intel), whichever
  exists. With neither:

  ```text
  ERROR: SyncSettings needs bash 4 or newer (this is <version>). On macOS: brew install bash
  ```

  exit 1. Everything past the guard needs bash 4 only.
- **No GNU-only flags** on a path macOS runs. `chmod --reference` and `timeout` go through `copy_mode` and
  `run_with_timeout`, which use the GNU tool when it's there. `SYNC_FETCH_TIMEOUT` sets the status fetch limit
  (15 seconds by default).
- **Skipped**: dconf entries (their `linux` platform keeps them off macOS), the [package drift](#package-drift) report, and
  `bootstrap/linux.sh`.
- **Front door**: the status's OS is `macos <version>` from `sw_vers -productVersion`. `doctor` checks bash 4 (hint
  `brew install bash`), `git`, `jq` (hint `brew install jq`), `cmp`, `brew` (`MISSING brew: install from
  https://brew.sh`), `gh` and its sign-in, the origin remote, the `mksync` link and unset values. `setup` has no
  bootstrap question, and `--bootstrap` stops with `ERROR: --bootstrap is Ubuntu only.`, exit 1.
- **`install.sh`**: without `brew`, it stops with `ERROR: install Homebrew first: https://brew.sh`, exit 1. A missing `jq`
  or Homebrew bash 4 gets `Install with Homebrew: brew install bash jq [Y/n]`, never `sudo`. End of input is no, as at the apt question: it
  installs nothing and exits 1. The
  link, the `PATH` hint and `mksync setup` work as on Linux, under Homebrew's bash. It reads `SYNC_OS` like `sync_os`.
- **Layout**: `dotfiles/macos/<tool>/` holds macOS-only files. Files shared with Linux live in `dotfiles/common/<tool>/`
  with `"platform": ["linux", "macos"]` ([layout.md](layout.md)).

## Known differences

| Behavior | Windows (PowerShell) | Linux (bash) |
|---|---|---|
| Export, local file missing | the note starts with `WARNING:`, and is `WARNING: folder not found: <dir>` if its folder is missing too | the note in the [Export](#export) table |
| Import, target folder missing | `SKIPPED` with `WARNING: target folder not found: <dir>`; the app is probably not installed. For a `dir` entry this checks the folder's parent | creates the folder (`mkdir -p`) |
| Exclude patterns | case-insensitive (`-like`) | case-sensitive |
| End of input at the overwrite prompt | depends on the host; run with `-Force` | counts as yes |
| `detectLinkedPaths` | supported | not supported |
| `type: dconf` | validated, never run | supported |
| [Package drift](#package-drift) | not yet: phase 8 adds a list to compare | supported |
| `-User <name>` (import into another profile, elevated) | supported | not supported |
| File modes | not kept | kept (`cp -p`; mode copied for written text) |
| Status line layout | `[WORD      ] label`, colored | `WORD       label` |
| Sanitized text that isn't valid UTF-8 | invalid bytes are replaced when read | bytes are kept |
| `defaultEnv` name check | none needed | stops the run on an invalid name |
| Import check, target folder missing | `SKIPPED`, not a change | `CREATE` |
| Import check for another profile | `-Check -User <other>` is an error | not supported |
| `mksync setup` | no bootstrap question | offers `bootstrap/linux.sh` on Ubuntu |
| `mksync` on `PATH` | `mksync.cmd` launcher in `%LOCALAPPDATA%\SyncSettings\bin` | symlink in `~/.local/bin` |
| Installer | `install.ps1`, `irm … \| iex`, winget | `install.sh`, `curl … \| bash`, apt-get |

macOS runs the bash engine, so it has the Linux column's behavior except for these rows:

| Behavior | macOS (bash) | Linux (bash) |
|---|---|---|
| bash | Homebrew bash 4+, re-run by the guard | the system's |
| `type: dconf` | not selected (`linux` platform) | supported |
| Package drift | prints nothing | supported |
| `mksync setup` | no bootstrap question; `--bootstrap` is an error | offers `bootstrap/linux.sh` on Ubuntu |
| `mksync doctor` | adds `brew` and the macOS version | |
| Installer | `brew install bash jq` | `sudo apt-get install` for the missing tools |

## Parity

Every gap listed in [plan-restructure.md](plan-restructure.md) is closed. A step number is the step of
[plan-restructure-2.md](plan-restructure-2.md) that closed the gap in that engine, and `yes` means the engine already
had the behavior.

| Behavior | Windows | Linux | Note |
|---|---|---|---|
| Required `platform` with `common` | step 6 | step 5 | lint: step 7 |
| `defaultEnv` | step 8 | yes | |
| `escapeBackslashes` | yes | step 9 | |
| Infer values from the local file on import | yes | step 10 | |
| Inference undoes `escapeBackslashes` | step 10b | step 10a | |
| `type: dir` export | step 13 | step 11 | |
| `type: dir` import | step 14 | step 12 | |
| Missing value without a terminal stops the run | step 8a | yes | |
| Missing target folder on import | | | kept as a known difference |
| Orphan report | step 16 | step 15 | |
| Up-to-date check | step 18 | step 17 | |
| Stop after a pull | step 18b | step 18a | |
| Commit: branch + PR, stages `dotfiles/ packages/ sync-config.json` | yes | yes | phase 1 |
| `type: dconf` | validates only | phase 5 | kept as a known difference |
| Package drift | phase 8 | phase 6 | a known difference until then |
