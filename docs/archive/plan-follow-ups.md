# Follow-ups: tighter picks, one Windows front door, shared line endings

Status: done 2026-11-09. The Windows check W10 in `TODO.md` is left for a real Windows machine.

The "Follow-ups" list in `TODO.md`, left over from `docs/plan-safe-sync.md` and the Windows checks W0-W9:

1. **Loose `--only` picks on bash.** A repo path with a `..` segment (`dotfiles/common/dir/../../x`) passes, because
   it starts with an entry's prefix. A `.linked/` repo path passes too, though linked folders are PowerShell only, so
   it selects nothing. A pick that resolves but reaches no file (a missing file inside a `dir` entry) runs silently.
2. **`Front.ps1` takes any `-x`.** `mksync diff -x` on Windows treats `-x` as a path; `front.sh` says
   `Unknown option: -x` and exits 1.
3. **Empty arrays under `set -u`.** Before bash 4.4, `"${arr[@]}"` on an empty array is an unbound-variable error,
   and several expansions don't guard it. The entry guards only check for bash 4.
4. **CRLF in shared files.** `dotfiles/common/**` is `eol=lf`. A shared file such as `.gitconfig` saved with CRLF on
   Windows hashes differently from the repo's LF copy, so it shows `BOTH` (or `OUT`) after every push.
5. **`sync` runs `sync.cmd` by bare name.** With `NoDefaultCurrentDirectoryInExePath` set, `cmd.exe` doesn't look in
   the current folder and the Git Bash hand-off fails.

## Design

**Picks.** Both engines refuse a repo pick with a `..` segment (split on `/` and `\`; `foo..bar` stays legal) with the
existing `ERROR: <path> is not synced on this machine.`, exit 1. Bash also refuses a repo pick under any
`<repoPath>.linked/`, with the same line. PowerShell keeps accepting `.linked/` picks.

**A pick that reaches nothing.** When `--only` (`-Only`) is given and the run handles no file at all (no status line in
import, export or `--check`, no label in `--diff`), the engine prints `  WARNING: --only matched no file.` after the
file lines, before the summary. The exit code and counts don't change. One line per run, not per pick.

**Unknown options on Windows.** `Front.ps1` `pull`, `push` and `diff` stop on any remaining argument that starts with
`-`: `Unknown option: <arg>` on stderr, exit 1, before any fetch or child step, as `front.sh` does.

**bash 4.4.** The engine needs bash 4.4 or newer, instead of guarding every empty array. Ubuntu, Debian and Homebrew
ship bash 5. The re-exec guard at the top of `sync`, `export.sh`, `import.sh` and `commit.sh` checks
`BASH_VERSINFO[0] -lt 4`, or `= 4` with `BASH_VERSINFO[1] -lt 4`, still in bash 3.2 syntax, and its error says
`bash 4.4 or newer`. `install.sh`'s bash probe and `mksync doctor` use the same test (`MISSING bash 4.4 or newer (this
is <version>)`).

**Shared line endings.** The Windows engine treats a file whose repo path starts with `dotfiles/common/` as LF text,
unless it holds a NUL byte (binary: compared and copied byte for byte, as now):

- Compare: both sides with CRLF folded to LF, then byte for byte. Only line endings are folded; no trimming.
- Export: writes the local file to the repo with CRLF folded to LF (UTF-8, no BOM, bytes otherwise unchanged).
- Import and `--check`: unchanged. The repo's LF copy is written as is, and a local CRLF copy with the same lines
  counts as `UNCHANGED`, so nothing is written.
- `-Diff` compares through the same helper, so a CRLF copy with the repo's lines is not `OUT`.

Files with sanitize rules already fold CRLF. `dotfiles/windows/**` stays byte for byte (`-text`). Bash is unchanged.

**`sync` on Windows shells.** The hand-off runs `cmd.exe //c "<repo>\sync.cmd"`, the path made with `cygpath -w`
(the plain path if `cygpath` fails), so it no longer depends on `cmd.exe` searching the current folder.

## Not doing

- One warning per pick: one line per run says enough; the pick list is on the same command line.
- Folding line endings on Linux and macOS: their files are LF, and `dotfiles/linux/**` is `eol=lf`.
- macOS M1-M4 and the auto-approval rollback in `TODO.md`: they need a real Mac and the user's call.

## Step 1: refuse `..` and `.linked/` repo picks on bash `[worker:low]`

Files: `scripts/linux/sync.sh`, `tests/linux/engine.sh`, `docs/sync-contract.md` ("Picking files").

In `resolve_only`, for a repo pick (after dropping trailing slashes), print the `ERROR` line to stderr and return 1
when any `/`-separated segment is `..`, or when the path contains `.linked/` right after some entry's `repoPath`
(simplest: the path contains the substring `.linked/`). Remove the `file` + `.linked/` branch from the repo-pick
match. Leave `only_selected` and `entry_selected` alone. Contract: the repo-path bullet says a `..` segment is refused
on both engines and a `.linked/` path on bash.

Tests (add to the case list next to the other `only-` cases):

- `only-repo-dotdot`: `resolve_only dotfiles/common/dir/../../secret` returns 1 with
  `ERROR: dotfiles/common/dir/../../secret is not synced on this machine.` on stderr; `ONLY_PATHS` is empty.
- `only-repo-dotdot-name`: a dir-entry pick `dotfiles/common/dir/foo..bar` is accepted.
- `only-repo-linked`: `resolve_only <fixture plain file repoPath>.linked/x` returns 1 with the `ERROR` line.

Test command: `tests/linux/engine.sh only-` (all pass) and the CI `shellcheck` line.

## Step 2: refuse `..` repo picks in PowerShell `[worker:high: PowerShell runs only in CI, so the spec must land first try]`

Files: `scripts/windows/SyncHelpers.ps1`, `tests/windows/Engine.Tests.ps1`.

In `Resolve-OnlyPaths`, after a repo pick has its `\` turned into `/`, throw `'{0} is not synced on this machine.' -f
$arg` when any segment of `$p -split '/'` is `..`. `.linked/` picks stay accepted.

Pester cases, next to the existing `Resolve-OnlyPaths` ones:

- `dotfiles/common/dir/../../secret` throws `... is not synced on this machine.`
- `dotfiles\common\dir\..\x` throws the same.
- `dotfiles/common/dir/foo..bar` resolves to itself.

Test command: `pwsh -NoProfile -Command` parse check of `SyncHelpers.ps1` and `Engine.Tests.ps1` (0 errors); the
Pester cases run in the CI `engine-windows` job.

## Step 3: warn when `--only` reached no file on bash `[worker]`

Files: `scripts/linux/sync.sh`, `import.sh`, `export.sh`, plus `tests/linux/engine.sh` and `docs/sync-contract.md`
("Picking files").

Add a global counter `ONLY_HITS=0` in `sync.sh`. Increment it wherever a selected file gets its status line (import,
export, `--check`) or its label (`--diff`), in the main shell (not inside a `$(…)` or a pipe). At the end of the walk,
before the summary, when `ONLY_PATHS` is not empty and `ONLY_HITS` is 0, print `  WARNING: --only matched no file.`
to stdout. Counts and exit codes don't change.

Tests:

- `only-no-file-import`: `import.sh --force --only ~/<dir entry folder>/missing.txt` (exists on neither side) prints
  the warning once and exits 0.
- `only-no-file-check`: the same pick with `--check` prints it and exits 0.
- `only-no-file-export`: `export.sh --only` the same pick prints it and exits 0.
- `only-no-file-diff`: `export.sh --diff --only` the same pick prints it.
- `only-hit-no-warning`: `import.sh --force --only <one fixture plain file>` doesn't print it.

Test command: `tests/linux/engine.sh only-`, `tests/linux/engine.sh import-only`, `tests/linux/engine.sh export-only`
and `tests/linux/engine.sh diff-only` (all pass), and the CI `shellcheck` line.

## Step 4: warn when `-Only` reached no file in PowerShell `[worker:high: PowerShell runs only in CI, so the spec must land first try]`

Files: `scripts/windows/Import-Settings.ps1`, `scripts/windows/Export-Settings.ps1`, `tests/windows/Engine.Tests.ps1`
(and `SyncHelpers.ps1` only if the counter has to live there).

Same rule as step 3: a script-scope counter, incremented where a selected file gets its status line or its `-Diff`
label; with `-Only` given and the counter at 0, `Write-Host '  WARNING: --only matched no file.'` before the summary.
The wording keeps `--only`, as in the shared contract.

Pester cases: `-Only` a missing file inside the fixture dir entry prints the warning once for `Import-Settings.ps1
-Force`, `-Check`, `Export-Settings.ps1` and `Export-Settings.ps1 -Diff`, each exiting 0; `-Only` one fixture plain
file doesn't print it.

Test command: `pwsh -NoProfile -Command` parse check of the changed scripts (0 errors); Pester runs in CI.

## Step 5: `Front.ps1` rejects unknown options `[worker:high: PowerShell runs only in CI, so the spec must land first try]`

Files: `scripts/windows/Front.ps1`, `tests/windows/Engine.Tests.ps1`, `docs/sync-contract.md` ("Front door").

Before the `switch` dispatch, for `pull`, `push` and `diff`: the first element of `$Paths` that starts with `-` writes
`Unknown option: <arg>` with `[Console]::Error.WriteLine` and exits 1. Nothing runs before it (no fetch, no child
step). `-Yes`, `-Force`, `-NoFetch` and `-Message` are bound parameters, so they never reach `$Paths`.

Pester cases: `Front.ps1 diff -x`, `Front.ps1 pull --bogus` and `Front.ps1 push -x` each exit 1 with
`Unknown option: <arg>` on stderr and no `Offline` line on stdout; `Front.ps1 diff <a fixture path>` still runs.

Test command: `pwsh -NoProfile -Command` parse check of `Front.ps1` (0 errors); Pester runs in CI.

## Step 6: require bash 4.4 `[worker]`

Files: `sync`, `export.sh`, `import.sh`, `commit.sh`, `install.sh`, `scripts/linux/front.sh`, `tests/linux/engine.sh`.

- The re-exec guard (line 4 of each entry script) becomes, in bash 3.2 syntax:
  `if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ] || { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -lt 4 ]; }; then`.
  Every message in the guard that says `bash 4` says `bash 4.4`. The Homebrew re-exec target is still checked the
  same way.
- `install.sh` line 129 probe: `(( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) ))`.
- `front.sh` doctor (around line 561): the same test; the miss line is `MISSING bash 4.4 or newer (this is <version>)`.
- Update any test that matches `bash 4 or newer` to the new text.

Test command: `tests/linux/engine.sh guard-reexec`, `tests/linux/engine.sh sync-doctor`, `tests/linux/engine.sh
install-` and `tests/linux/engine.sh front-macos` (all pass), and the CI `shellcheck` line.

## Step 7: fold line endings when comparing shared files on Windows `[worker:high: PowerShell runs only in CI, so the spec must land first try]`

Files: `scripts/windows/SyncHelpers.ps1`, `scripts/windows/Export-Settings.ps1`, `tests/windows/Engine.Tests.ps1`.

Add `Compare-SyncFiles -PathA -PathB -RepoPath` to `SyncHelpers.ps1`: when `$RepoPath` starts with
`dotfiles/common/` (ordinal) and neither file's bytes contain `0x00`, read both as bytes, drop each `0x0D` that is
directly followed by `0x0A`, and compare the results byte for byte; otherwise call `Compare-FilesByHash`. Missing
files behave as in `Compare-FilesByHash`. Replace the four `Compare-FilesByHash` calls (`Export-Settings.ps1:240`,
`SyncHelpers.ps1:826`, `:1298`, `:1442`) with it, passing the repo-relative path each site already has (for a dir
entry's file, `<repoPath>/<rest>`; in the diff, the path being labeled).

Pester cases (fixture `common` plain file and `common` dir entry):

- local CRLF, repo LF, same lines: import says `UNCHANGED` and writes nothing (no `.bak`); `-Check` lists nothing.
- the same pair: export says `UNCHANGED`; `-Diff` labels it as matching (not `OUT`).
- local CRLF with a changed line: export and import both see it as changed.
- a `windows` plain file, local CRLF and repo LF: still `MODIFIED` (byte for byte).
- a `common` file holding a NUL byte with CRLF vs LF: still `MODIFIED`.
- a file inside a `common` dir entry, CRLF vs LF: `UNCHANGED`.

Test command: `pwsh -NoProfile -Command` parse check of the changed scripts (0 errors); Pester runs in CI.

## Step 8: export shared text files as LF on Windows `[worker:high: PowerShell runs only in CI, so the spec must land first try]`

Files: `scripts/windows/Export-Settings.ps1`, `scripts/windows/SyncHelpers.ps1` (dir-entry export near line 826),
`tests/windows/Engine.Tests.ps1`, `docs/sync-contract.md` ("Compare").

When export copies a file without sanitize rules whose repo path starts with `dotfiles/common/` and that holds no
`0x00`, it writes the bytes with each CRLF turned into LF (`[IO.File]::WriteAllBytes`), instead of `Copy-Item`.
Everything else is copied as now. Contract "Compare": a new bullet for shared files on Windows (CRLF folded to LF in
the compare and on export, binary files excluded, import writes the repo's bytes).

Pester cases:

- a `common` file with CRLF, new to the repo: the repo copy has LF only and otherwise the same bytes.
- a `common` file with a changed line and CRLF: the repo copy is updated and has LF only.
- a `windows` file with CRLF: the repo copy keeps CRLF.
- a `common` file holding a NUL byte: copied byte for byte.

Test command: `pwsh -NoProfile -Command` parse check of the changed scripts (0 errors); Pester runs in CI.

## Step 9: `sync` calls `sync.cmd` by its full path `[worker:low]`

Files: `sync`, `tests/linux/engine.sh`, `docs/sync-contract.md` ("Front door").

In the `MINGW*|MSYS*|CYGWIN*` branch: `cmd_path=$(cygpath -w "$REPO_ROOT/sync.cmd" 2>/dev/null || printf '%s'
"$REPO_ROOT/sync.cmd")` (`REPO_ROOT` is already set near the top of `sync`), then
`exec cmd.exe //c "$cmd_path" "$@"`.

Test `sync-windows-handoff`: `PATH` holds stubs for `uname` (prints `MINGW64_NT-10.0`), `cygpath` (prints
`C:\repo\` plus the rest of its last argument after the repo root) and `cmd.exe` (prints its arguments one per line);
`./sync diff x` prints `//c`, `C:\repo\sync.cmd`, `diff`, `x`. A second run with a `cygpath` stub that exits 1 prints
the plain `<repo>/sync.cmd` path instead.

Test command: `tests/linux/engine.sh sync-` (all pass) and the CI `shellcheck` line.

## Step 10: docs and `TODO.md` `[inline: user-facing copy]`

Files: `README.md`, `CLAUDE.md`, `docs/sync-contract.md`, `docs/macos-research.md`, `docs/configuration.md` or the
guides if they name a bash version, `TODO.md`.

- Every `bash 4+` / `bash 4 or newer` becomes `bash 4.4+` / `bash 4.4 or newer`; `docs/macos-research.md` notes the
  `set -u` row is settled by requiring 4.4.
- Check the contract sections touched in steps 1-9 read as one text (Picking files, Front door, Compare).
- `TODO.md`: remove the three Follow-ups; add a Windows check `W10`: on Windows, save a shared `.gitconfig` with CRLF,
  `mksync push`, then `mksync diff` shows it matching, and `mksync pull` writes nothing.

Test command: `tests/linux/engine.sh` (full suite, once), and `grep -rn "bash 4[^.]" README.md CLAUDE.md docs/*.md`
prints nothing outside `docs/archive/`.
