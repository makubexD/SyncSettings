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

## Picking files

Every command that walks entries takes a repeatable `--only <path>` (PowerShell: `-Only <string[]>`). A path is
either a repo path or a local path:

- A path starting with `dotfiles/` is a repo path. It is accepted when an entry selected for this OS owns it: the path
  equals its `repoPath`, starts with `<repoPath>/` for a `dir` entry, or starts with `<repoPath>.linked/` for a file
  entry. A trailing `/` is dropped.
- Any other path is a local path. A leading `~/` becomes `$HOME/` (a lone `~` becomes `$HOME`), a path that doesn't
  start with `/` is joined to the caller's folder (`$SYNC_CALLER_PWD`, else `$PWD`), and `.` and `..` segments are
  folded lexically, without following links. A relative pick is relative to the caller's folder on direct engine
  calls too: `import.sh` and `export.sh` record `$PWD` before they `cd` to the repo root.

A local path resolves to a repo path by comparing it with each selected entry's resolved `localPath`, folded
the same way: equal to a file entry gives its `repoPath`; equal to a `dir` entry's folder gives its `repoPath`, and
inside that folder gives `<repoPath>/<rest>`. A `dconf` entry has no local path and is matched by its `repoPath` only.

A path that matches no entry for this OS stops the run before it touches any file:

```text
ERROR: <path> is not synced on this machine.
```

Then a repo file is selected when there is no `--only`, or its repo path equals a selected path, or starts with
`<selected>/` or `<selected>.linked/`. Selecting a whole entry is looser: an entry is walked when that file rule
selects it, or when a pick lies under the entry's own path or `.linked/` folder, so the picked file inside it is
still reached.

`import.sh --only` handles only the selected files: every other entry and file gets no status line and no count, and
`--check --only` lists only the selected files. With `--only` only the picked entries' values are requested, so a
missing value that only an unpicked entry needs does not stop the run. A run with `--only` never records the sync
point, because the machine agrees with only part of the repo. `--only` with no path after it is an error, exit 1.

`export.sh --only` writes only the selected files. It removes a repo file gone from a `dir` entry's folder only when
that file is selected, and skips the orphan and package drift reports: a partial run doesn't see the whole repo.
`--diff --only` labels only the selected paths, and its counts and hints cover only them. `--preview` with `--only` is
an error, exit 1.

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
on Linux, also tightening an existing file, and no inherited access on Windows. The Windows save doesn't need a domain
controller, so it works on a domain laptop that's off the network.

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

Git keeps the bytes too. `.gitattributes` marks `dotfiles/windows/**` as `-text`, so a Windows file with CRLF lines
comes back from git as export wrote it, and `mksync diff` agrees with the machine after a push. `dotfiles/common/**`
and `dotfiles/linux/**` stay LF.

## Backups

Import copies the old local file to `<file>.bak` before overwriting it, replacing any older `.bak`, in every entry type.
`*.bak` is in `excludePatterns`, so a `.bak` inside a synced directory is never exported.

A dconf entry has no local file to sit next to, so its backup is `~/.local/state/sync-settings/dconf/<file>.bak`, where
`<file>` is the name of the repo file. It holds the raw dump of `path`, written before each `UPDATED`. Loading it back
restores the old values, but a key that had no value before keeps the repo's value, because a load never removes a key.

Every import that overwrites a file also copies the old version into a folder for that run:

- Linux and macOS: `${XDG_STATE_HOME:-$HOME/.local/state}/sync-settings/backups/<run>/<repoPath>`
- Windows: `%LOCALAPPDATA%\SyncSettings\backups\<run>\<repoPath>`, with `\` separators

`<run>` is `YYYYMMDD-HHMMSS-<pid>` in local time. The folder is created at the first backup of the run, so a run that
overwrites nothing makes none, and a `--check` run never makes one. After the run the newest 20 run folders are kept
and older ones removed, sorted by name. When the run made a dated copy, the summary adds `  Backups    : <folder>`. A
failed dated copy prints a `WARNING` line and doesn't change the exit code; the `.bak` stays the backup that must
succeed.

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

When a rule hits, the scan prints its hit lines, then a blank line, then one hint for each rule that hit, once per
rule and in the order the rules run. A hint never repeats the matched text.

| Rule | Hint |
|---|---|
| `home-path` | `write $HOME or ~ instead of the full path, or add a <HOME> sanitize rule (defaultEnv HOME) to the file's entry.` |
| `windows-profile` | `write %USERPROFILE% or ~ instead of the full path, or add a sanitize rule to the file's entry.` |
| `email` | `move it behind a sanitize rule placeholder, such as <YOUR_EMAIL>.` |
| `private-key`, `github-token`, `api-key` | `remove it from the file; keep secrets in a file the repo doesn't sync.` |

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
- A preview ends with `Nothing was written. Run mksync push to send it.` on every system.

## One command

`./sync <preview|check|export|commit|import> [options]` on Linux and Git Bash, `.\sync` in PowerShell, `sync` in cmd. The name
resolves to the right script for the OS, so `sync` and `sync.cmd` are the two front doors, and Git Bash on Windows hands
over to `sync.cmd`. Options pass through unchanged. The `.sh` entry points still work.
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

## Sync point

A per-machine file remembers the repo commit the machine last agreed with: on Linux and macOS,
`${XDG_STATE_HOME:-$HOME/.local/state}/sync-settings/last-sync`; on Windows,
`%LOCALAPPDATA%\SyncSettings\last-sync`. It holds one line, the full SHA.

It is read only when that line is 40 hex characters and the commit exists in the clone; anything else counts as no
sync point.

A real import writes it, with `HEAD`, when the run had no `ERROR` line, no `SKIPPED` line noted `user skipped`, `HEAD`
resolves, and `git status --porcelain -- dotfiles sync-config.json` is empty (so `HEAD` is what was imported). The
summary then prints `Sync point : <first 7 of the SHA>` after the `file(s) applied` line. A check (`--check`) writes
nothing, and neither does an import that skipped a prompt, hit an error, or ran on a dirty tree. A run with `--only`
writes nothing either, because the machine agrees with only part of the repo.

`commit.sh` writes it after the PR opens and the clone is back on `master`, with the sync commit's parent (the
`master` commit the branch starts from), not the sync commit itself: until the PR merges, `origin/master` still has
the old files, and with the sync commit as the base they would read as `IN` and a pull would undo the push. A run
that failed before that (commit, push or PR) writes nothing. A partial commit (`commit.sh --partial`, which the front
door uses when `mksync push` is given paths) writes nothing either, for the same reason as a partial import: part of
the repo only was sent.

On Windows, `Import-Settings.ps1` and `Commit-Settings.ps1` follow the same rules, and an import for another user's
profile (`-User`) never writes it, because the file belongs to whoever runs the script.

A write that fails prints `WARNING: could not record the sync point in <file>.` and never changes the exit code.

## Diff

`export.sh --diff` (`Export-Settings.ps1 -Diff`) says which side changed each file, without writing anything. It
builds three trees of `dotfiles/` in a temp folder:

- `base`: `git archive` of the sync point. With no sync point, `theirs` stands in for `base`.
- `theirs`: `git archive` of `origin/master` when that ref exists, else `HEAD`. The engine never fetches; the front
  door fetches first.
- `mine`: a copy of `base` plus the current `sync-config.json`, `export.sh`, `scripts/`, `packages/` and
  `.user-values.json`, with a preview export run inside it (`SYNC_PREVIEW=1`, stdin from `/dev/null`, output to a log
  in the temp folder). Starting from `base` means any file export doesn't touch still equals `base`.

Only paths this OS's entries own are compared: a file or dconf entry owns its `repoPath`, a file entry also owns the
`<repoPath>.linked/` prefix, and a dir entry owns the `<repoPath>/` prefix. With `--only`, only the selected paths are
labeled and counted. A missing file counts as a version, and each owned path in the union of the three trees gets at
most one label:

| `mine` vs `base` | `theirs` vs `base` | Label |
|---|---|---|
| same | same | none |
| same | differs | `IN`: only the repo changed, a pull takes it |
| differs | same | `OUT`: only this machine changed, a push sends it |
| differs | differs, `mine` = `theirs` | none: both made the same change |
| differs | differs, `mine` ≠ `theirs` | `BOTH`: merge by hand |
| no sync point, `mine` ≠ `theirs` | | `?` |

The lines print through the normal status formatter (`OUT        dotfiles/…`) and are sorted with `LC_ALL=C sort`.
The header names the sync point (`Last sync  : <short> (<date>)`, or `none recorded on this machine`) and the ref
compared (`Repo       : origin/master <short>` or `Repo       : HEAD <short>`).

```text
  SyncSettings -- DIFF (linux)

  Last sync  : 1a2b3c4 (2026-11-01)
  Repo       : origin/master 5d6e7f8

  OUT        dotfiles/linux/shell/.bashrc
  IN         dotfiles/common/git/.gitconfig

  --------------------------------------------------

  2 file(s) differ: 1 in, 1 out, 0 both.
  IN: mksync pull takes them. OUT: mksync push sends them.
```

The hint line names only the labels present; `BOTH` adds `BOTH: changed on both sides; merge by hand.` With no sync
point the summary reads `N file(s) differ. No sync is recorded on this machine, so the newer side is unknown.` and
`Run mksync pull or mksync push once to record one.` When nothing differs it prints `This machine and the repo agree.`

The exit code is 0 when nothing differs, 3 when something does, and 1 on an error: a failed export prints its log
and `ERROR: the export for the diff failed; see above.`; a failed `git archive` also exits 1. `--diff` cannot be
combined with `--preview` or `--reset-values` (error, exit 1). The diff writes no repo file, no sync point and no
`.user-values.json`, and its temp folder is removed on every exit.

On Windows the rules, labels, text and exit codes are the same, with three mechanical differences: the `mine`
export is a child `powershell.exe` running `scripts\windows\Export-Settings.ps1` (stdout to the log, stderr to a
second log printed after it), `mine` copies `scripts/` in place of `export.sh`, and paths sort with ordinal
comparison instead of `LC_ALL=C sort`. The status lines use the `[OUT      ] path` layout in
[Known differences](#known-differences).

## Front door

On Linux, `mksync` is a link on `PATH` to the repo's `sync`, which resolves the link to find the repo. It's named
`mksync` so it doesn't hide coreutils `sync`. On Windows, `mksync` is `mksync.cmd` in the installer's bin folder, a
four-line launcher that calls the clone's `sync.cmd`; its second line, `rem SyncSettings launcher`, marks it as ours.
Every `[Y/n]` prompt takes an empty answer or end of input as yes, every `[y/N]` prompt as no. Commands, wording and exit
codes are the same on both systems, except where this section says otherwise.

| Command | Does | Exit |
|---|---|---|
| `mksync`, `mksync status` | Prints OS, repo, origin, unsent, machine, and the next command. When the check finds changes and a sync point exists, it runs the diff: the machine line gives its summary (`N file(s) differ: I in, O out, B both`) and the next command is `mksync pull` (in only), `mksync push` (out only), or `mksync diff, then push or pull file by file.` (both, or in and out). No sync point, a failed diff or a diff that agrees keeps the plain machine line and next command. Writes nothing in the repo or home; it fetches `origin master` | 0 |
| `mksync doctor` | One `OK`, `WARN` or `MISSING` line per check. macOS: as Linux, plus `brew` and the macOS version ([macOS](#macos)). Linux: bash 4, `git`, `jq`, `cmp`, `gh` and its sign-in, the origin remote, the `mksync` link, unset values. Windows: PowerShell 5.1, `git`, `gh` and its sign-in, the origin remote, the `mksync.cmd` launcher, unset values (no `jq` or `cmp`: the PowerShell engine doesn't use them). A `MISSING` line names the install command (`winget install --id …` on Windows when `winget` is there) | 0, or 1 with a `MISSING` line |
| `mksync pull [--yes] [--force] [path…]` | Refuses with exported changes not sent. Fetches, fast-forwards, re-runs itself so new code runs, then the import check. Nothing to change: a pull without paths still runs `import.sh --force` to record the sync point. Changes with no sync point: `--yes` refuses, interactive warns and asks `Apply these changes? [y/N]`. Otherwise (unless `--force`) the diff stops it on an `OUT` or `BOTH` file; then asks `Apply these changes? [Y/n]` and runs `import.sh --force` (`Import-Settings.ps1 -Force` on Windows). Picked paths go to the check, the diff and the import as `--only`, so a partial pull records no sync point | 0, or 1 on an error |
| `mksync push [--yes] [-m <msg>] [path…]` | Runs `export.sh` (`Export-Settings.ps1` on Windows). Picked paths go to it as `--only`, and any path makes `commit.sh` run with `--partial`, so a partial push records no sync point. Nothing changed: `Nothing to send`. Otherwise shows `git status --short`, asks `Open a PR with these changes? [Y/n]`, then runs `commit.sh` | 0, or the failing script's code |
| `mksync diff [path…]` | Fetches `origin master` with the status's 15-second timeout; offline prints `Offline: comparing with the last fetch.` and carries on. Then runs `export.sh --diff` (`Export-Settings.ps1 -Diff` on Windows) ([Diff](#diff)): one line per changed file saying which side changed it. Picked paths go through as `--only`, so only those are labeled and counted. Writes nothing | 0 when nothing differs, 3 when something does, or 1 on an error |
| `mksync check`, `mksync preview` | The import check ([above](#one-command)) and the export preview, unchanged; neither writes anything | 0, 3 from a check that found changes, or 1 on an error |
| `mksync setup [--yes] [--bootstrap]` | Doctor, the import check, on Ubuntu `Also restore apps and packages … [y/N]` (bootstrap), then applies like `pull`. Windows has no bootstrap question and no `--bootstrap` | 0, or 1 on an error |

`mksync pull` protects this machine's own changes: when the import check finds changes, `--force` isn't given and a
sync point exists, it runs the diff ([Diff](#diff)) first. Any `OUT` or `BOTH` line prints, then `ERROR: <n> file(s) changed on this machine
since the last sync, and a pull would overwrite them.` and `Run mksync push first, or mksync pull --force to overwrite
them (each keeps a .bak).`, and the pull stops with exit 1 before anything is applied. `IN` lines never block.
A diff that fails (exit 1) stops the pull with `ERROR: could not tell which side is newer; run mksync diff to see why,
or mksync pull --force.` `--force` skips the diff and still asks the apply question; `--yes` answers it.

Without a sync point every label would be `?`, so the diff doesn't run and the first pull is guarded instead: with
`--yes` it stops with `ERROR: no sync is recorded on this machine, so a pull can't tell which side changed these
files.` and `Run mksync diff, then mksync push, mksync pull <path> without --yes, or mksync pull --force (each keeps a .bak).`,
exit 1; interactive it prints `No sync is recorded on this machine: if you changed these files here, a pull overwrites
them (each keeps a .bak).` and asks `Apply these changes? [y/N]`, so only an answer starting with `y` or `Y` applies.
When nothing differs, a pull without paths still runs the import, which records the sync point. `mksync setup` and
`bootstrap/linux.sh` call the engine directly, so a new machine takes the repo's files unchanged.
On Windows the guard recognises the same labels in the `[OUT      ]` status-line layout ([Known differences](#known-differences)).

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

Every gap listed in [plan-restructure.md](archive/plan-restructure.md) is closed. A step number is the step of
[plan-restructure-2.md](archive/plan-restructure-2.md) that closed the gap in that engine, and `yes` means the engine already
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
| Sync point (import, commit) | docs-dryrun-2 step 7 | steps 1-2 | |
| `--diff` / `-Diff` | step 8 | step 3 | |
| `mksync diff`, pull guard, status labels | step 9 | steps 4-6 | |
| `--only` / `-Only` on import, export and `--diff` | safe-sync step 8 | safe-sync steps 1-3 | |
| Paths on `mksync pull`, `push`, `diff`; `commit --partial` / `-Partial` | safe-sync step 9 | safe-sync step 4 | |
| First-pull guard | safe-sync step 9 | safe-sync step 5 | |
| Dated backups, kept for 20 runs | safe-sync step 9 | safe-sync step 6 | no dconf on Windows |
