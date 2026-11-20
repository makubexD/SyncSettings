# Safe sync: pick files, guard the first sync, explain leaks, keep every backup

Found on 2026-11-09 while syncing this Linux machine for the first time with `mksync diff`. The Antigravity CLI
installer had appended a line with a hard-coded home path to `~/.bashrc` and `~/.profile`. The tool saw it (the leak
scan blocked the push, the diff labeled both files `?`) but couldn't fix it:

1. **No way to pick files.** `mksync pull` asks one `Apply these changes? [Y/n]` and runs `import.sh --force` on every
   file; `mksync push` exports every file. Taking the repo's `.bashrc` and `.profile` while keeping 8 newer Claude
   files took a hand edit.
2. **The first pull is unguarded.** Without a sync point every diff label is `?`, so the pull guard skips itself and
   `mksync pull --yes` overwrites every local edit (each keeps a `.bak`).
3. **A leak hit names no fix.** `home-path` and stop; the fix (write `$HOME`, or add a `<HOME>` sanitize rule) is
   only in the docs.
4. **One backup per file.** Each import replaces `<file>.bak`, so a second pull loses the original.

## Design

**Picking files.** Every engine command that walks entries takes a repeatable `--only <path>` (PowerShell
`-Only <string[]>`). A path is either a repo path (starts with `dotfiles/`) or a local path (`~/…`, absolute, or
relative to the caller's folder). Each one resolves to a repo path:

- a repo path is used as is;
- a local path equal to a file or dconf entry's resolved `localPath` becomes that entry's `repoPath`;
- a local path equal to a dir entry's `localPath`, or inside it, becomes `<repoPath>` or `<repoPath>/<rest>`;
- a dconf entry is matched by its `repoPath` only.

A path that matches no entry for this OS stops the run before it touches any file:
`ERROR: <path> is not synced on this machine.`, exit 1. Then a repo file is selected when there is no `--only`, or its
repo path equals a selected path, or starts with `<selected>/` or `<selected>.linked/`.

With `--only`:

- **import** (and `--check`) handles only the selected files. It never records the sync point, because the machine
  doesn't agree with the whole repo.
- **export** writes only the selected files. It removes a repo file gone from a dir entry's folder only inside the
  selection, and skips the orphan report and the package drift report.
- **`--diff`** prints only the selected paths' labels; the counts and hints cover only those.
- **`--preview`** is not combined with `--only`: error, exit 1.
- **commit** gets `--partial` (`-Partial`) from the front door and then doesn't write the sync point, for the same
  reason as a partial import.

**Front door.** `mksync pull [--force] [--yes] [path…]`, `mksync push [-m msg] [--yes] [path…]` and
`mksync diff [path…]` pass the paths on as `--only` (`-Only`). `sync` keeps the caller's folder in `SYNC_CALLER_PWD`
before it changes into the repo, and the front door makes relative paths absolute against it. The pull guard runs the
diff with the same `--only`, so a picked file that is `OUT` or `BOTH` still needs `--force`.

**The first pull.** With no sync point, and without `--force`:

- `--yes`: refuse. `  ERROR: no sync is recorded on this machine, so a pull can't tell which side changed these
  files.` then `  Run mksync diff, then mksync push, mksync pull <path>, or mksync pull --force (each keeps a
  .bak).`, exit 1.
- interactive: print `  No sync is recorded on this machine: if you changed these files here, a pull overwrites them
  (each keeps a .bak).` above the question, and the question defaults to no: `  Apply these changes? [y/N] `.
- `mksync setup` and `bootstrap/linux.sh` call the engine directly and are unchanged: a new machine is expected to take
  the repo's files.
- When the check finds nothing to change, a pull without paths still records the sync point (a real import with
  nothing to overwrite), so a machine that already matches gets one. Today it exits before that, and its later edits
  stay `?`.

**Leak hints.** After the hit lines, when there was a hit, `leak-scan.sh` prints a blank line and one `  fix <rule>:
<text>` line per rule that hit, in the order of the rules:

| Rule | Text |
|---|---|
| `home-path` | `write $HOME or ~ instead of the full path, or add a <HOME> sanitize rule (defaultEnv HOME) to the file's entry.` |
| `windows-profile` | `write %USERPROFILE% or ~ instead of the full path, or add a sanitize rule to the file's entry.` |
| `email` | `move it behind a sanitize rule placeholder, such as <YOUR_EMAIL>.` |
| `private-key`, `github-token`, `api-key` | `remove it from the file; keep secrets in a file the repo doesn't sync.` |

The hints never print the matched text. Windows runs the same script through Git Bash, so it gets them too.

**Backups.** Each import that overwrites a file still writes `<file>.bak` (or the dconf `.bak`), and also copies the
old version to a folder for that run:

- Linux and macOS: `${XDG_STATE_HOME:-$HOME/.local/state}/sync-settings/backups/<run>/<repoPath>`
- Windows: `%LOCALAPPDATA%\SyncSettings\backups\<run>\<repoPath>`, with `\` separators

`<run>` is `YYYYMMDD-HHMMSS-<pid>` in local time. The folder is created at the first backup of the run, so a run that
overwrites nothing makes none. After the run, the newest 20 run folders are kept and older ones removed (sorted by
name). When the run made backups, the summary adds `  Backups    : <folder>`. A failed dated copy prints a `WARNING`
line and doesn't change the exit code; the `.bak` stays the backup that must succeed.

## Not doing

- `mksync undo` to restore the newest backup folder: worth having once the folders exist. A later plan, if wanted.
- Picking single files inside a linked folder by local path: pick the file entry that owns it.

## Step 1: path selection helper on Linux and macOS `[worker]`

Files: `scripts/linux/sync.sh`, `tests/linux/engine.sh`, `docs/sync-contract.md` (new section "Picking files", after
"Entry selection").

In `sync.sh`, next to `resolve_local`:

- `resolve_only <path>…`: fills the global array `ONLY_PATHS` with the repo paths, as "Picking files" under Design
  says. Local paths: a leading `~/` becomes `$HOME/`; anything not starting with `/` is joined to
  `${SYNC_CALLER_PWD:-$PWD}`; `.` and `..` segments are normalized with `realpath -m`. It reads `platform_entries`.
  A path matching no entry prints the `ERROR` line to stderr and returns 1.
- `only_selected <repo_path>`: returns 0 when `ONLY_PATHS` is empty or the path is selected, else 1.

Tests (source `sync.sh` in a throwaway clone with the fixture config, throwaway `HOME`):

- `only-repo-path`: `resolve_only dotfiles/linux/plain.txt` sets that one path.
- `only-local-tilde`: `~/<fixture plain file>` resolves to its `repoPath`.
- `only-local-relative`: with `SYNC_CALLER_PWD=$HOME`, the relative form resolves the same.
- `only-dir-file`: a file inside the dir entry's folder resolves to `dotfiles/common/dir/<rest>`.
- `only-dir-root`: the dir entry's folder resolves to `dotfiles/common/dir`.
- `only-unknown`: `~/not-synced` returns 1 with `ERROR: ~/not-synced is not synced on this machine.` on stderr.
- `only-other-platform`: the `windows` entry's repo path returns 1.
- `only-selected`: with `ONLY_PATHS=(dotfiles/common/dir)`, `only_selected` is 0 for `dotfiles/common/dir/a/b.txt`
  and 1 for `dotfiles/common/dirx/a`; with `ONLY_PATHS=(dotfiles/linux/plain.txt)` it is 0 for
  `dotfiles/linux/plain.txt.linked/x` and 1 for `dotfiles/linux/plain.txt2`; with no `ONLY_PATHS` it is 0.

Test command: `tests/linux/engine.sh only-` (all pass) and the CI `shellcheck` line.

## Step 2: `import.sh --only` `[worker]`

Files: `import.sh`, `tests/linux/engine.sh`, `docs/sync-contract.md` ("Picking files", "Sync point").

Parse the arguments with a `while`/`shift` loop so `--only <path>` can repeat; `--only` with no path is an error, exit 1.
Call `resolve_only` once before processing entries (exit 1 on failure, before any file is touched). Skip any file for
which `only_selected` fails, in plain, sanitized, dir and dconf entries alike, with no status line for it. With
`ONLY_PATHS` set, don't record the sync point. Update the usage line.

Tests:

- `import-only-one`: two plain files differ; `--force --only <one>` updates only that one, the other is unchanged.
- `import-only-check`: `--check --only <one>` lists only that file and counts 1.
- `import-only-dir-file`: `--only` one file of the dir entry updates only that file.
- `import-only-no-sync-point`: a successful `--force --only` run writes no sync point file.
- `import-only-unknown`: an unknown path exits 1 and changes no local file (`tree_hash` of `HOME` unchanged).
- `import-only-missing-arg`: `--only` as the last argument exits 1.

Test command: `tests/linux/engine.sh import-only` and `tests/linux/engine.sh import` (all pass), and the CI
`shellcheck` line.

## Step 3: `export.sh --only` `[worker]`

Files: `export.sh`, `scripts/linux/sync.sh` (`run_diff`), `tests/linux/engine.sh`, `docs/sync-contract.md` ("Picking
files", "Diff").

Same argument loop as step 2. A plain export with `ONLY_PATHS` set copies only selected files, removes a repo file gone
from a dir entry's folder only when it is selected, and skips `report_orphans` and `report_drift`. `--diff --only`
filters the labeled paths with `only_selected` before counting and printing (the export inside `mine` stays whole).
`--preview --only` is an error, exit 1.

Tests:

- `export-only-one`: two local files changed; `--only <one>` changes only that repo file (`git status --porcelain`).
- `export-only-dir-removed`: a file removed from the dir folder and `--only` another file: the removed file stays in
  the repo.
- `export-only-no-reports`: with `--only`, the output has no `ORPHAN` and no `DRIFT` lines (stubbed drift as in
  `setup_drift_case`).
- `diff-only`: two files `OUT`; `--diff --only <one>` prints one `OUT` line and `1 file(s) differ: 0 in, 1 out, 0
  both.`
- `export-only-preview`: `--preview --only x` exits 1.

Test command: `tests/linux/engine.sh export-only`, `tests/linux/engine.sh diff-` and `tests/linux/engine.sh export`
(all pass), and the CI `shellcheck` line.

## Step 4: partial commit and the front door on Linux and macOS `[worker]`

Files: `commit.sh`, `sync`, `scripts/linux/front.sh`, `tests/linux/engine.sh`.

- `commit.sh`: accept `--partial`; with it, skip `write_last_sync`.
- `sync`: `export SYNC_CALLER_PWD=$PWD` before the `cd`. In `usage`, show `[path…]` on the `pull`, `push` and `diff`
  lines, aligned as today.
- `front.sh`: `front_pull`, `front_push` and `front_diff` take paths after their options (anything not starting with
  `-`), make relative ones absolute against `SYNC_CALLER_PWD`, and pass each as `--only <path>` to `import.sh --check`,
  the guard's `export.sh --diff`, `import.sh --force`, `export.sh` and `export.sh --diff`. When `front_pull` re-execs
  after a `git pull`, it passes the paths on. `front_push` with paths passes `--partial` to `commit.sh`.

Tests (stub `gh`, bare origin, as the existing pull and push cases):

- `front-pull-only`: two files `IN`; `sync pull --yes <one>` updates only that one and writes no sync point.
- `front-pull-only-guard`: the picked file is `OUT`: refused like `front-pull-guard`; with `--force` it is updated.
- `front-push-only`: two local files changed; `sync push --yes <one>` commits only that file, and the sync point is
  unchanged.
- `front-diff-only`: `sync diff <one>` lists only that path.
- `front-only-relative`: run from `$HOME` with a relative path: same result as the `~/` form.
- `front-usage-paths`: `sync help` shows `[path…]` on the three lines.

Test command: `tests/linux/engine.sh front-` and `tests/linux/engine.sh commit` (all pass), and the CI `shellcheck` line.

## Step 5: guard the first pull on Linux and macOS `[worker]`

Files: `scripts/linux/front.sh`, `tests/linux/engine.sh`, `docs/sync-contract.md` (front door: pull).

In `front_pull`, when `front_sync_point` is empty, files differ and `--force` wasn't given: with `--yes`, print the two
`ERROR` lines from "The first pull" and exit 1; without it, print the notice line and ask `  Apply these changes?
[y/N] `, where only an answer starting with `y` or `Y` applies. When the check exits 0 and no paths were given,
run `import.sh --force` anyway (nothing to overwrite) so it records the sync point, instead of exiting at once.

Tests:

- `front-pull-first-yes`: no sync point, a file differs: `sync pull --yes` exits 1 with both lines and changes nothing.
- `front-pull-first-force`: same with `--yes --force`: applied, sync point recorded.
- `front-pull-first-empty`: interactive, empty answer: `Nothing applied.`, nothing changed.
- `front-pull-first-y`: interactive, answer `y`: applied.
- `front-pull-first-match`: no sync point, nothing differs: exit 0 with no question, and the sync point is recorded.
- `front-pull-match-only`: nothing differs, `sync pull <path>`: exit 0, no sync point written.
- `front-pull-recorded`: with a sync point the question stays `[Y/n]` (existing behavior).

Test command: `tests/linux/engine.sh front-pull` (all pass) and the CI `shellcheck` line.

## Step 6: dated backups on Linux and macOS `[worker]`

Files: `scripts/linux/sync.sh`, `import.sh`, `tests/linux/engine.sh`, `docs/sync-contract.md` ("Backups").

In `sync.sh`, add `backup_file <src> <bak> <repo_path>`: `cp -p <src> <bak>` (its failure is the caller's `ERROR`, as
today), then the dated copy to `$(backup_run_dir)/<repo_path>`, creating folders as needed; a failed dated copy prints
`  WARNING: could not keep a dated backup of <repo_path>.` and still returns 0. `backup_run_dir` builds the folder name
once per run (`date +%Y%m%d-%H%M%S`-`$$`) under the state folder. Replace the three `.bak` writes in `import.sh` (plain,
sanitized, dconf) with it. At the end of a run that made a backup, prune to the newest 20 run folders and print
`  Backups    : <folder>` in the summary.

Tests:

- `backup-dated`: an import that overwrites two files leaves both old versions under `backups/<run>/<repoPath>`, and
  the `.bak` files as before.
- `backup-second-run`: a second import, after the local files changed again, keeps the first run's folder.
- `backup-none`: an import with nothing to overwrite makes no `backups` folder and no `Backups` line.
- `backup-prune`: with 20 dummy run folders older by name, one more run leaves 20, and the oldest is gone.
- `backup-xdg`: with `XDG_STATE_HOME` set, the folder is under it.
- `backup-dated-fails`: with the state folder a regular file, the `WARNING` line prints, the `.bak` exists and the
  import exits 0.
- `backup-dconf`: (on the test bus) a dconf `UPDATED` also writes the dated copy.

Test command: `tests/linux/engine.sh backup-` and `tests/linux/engine.sh import` (all pass), and the CI `shellcheck`
line.

## Step 7: leak hints `[worker:low]`

Files: `scripts/ci/leak-scan.sh`, `tests/linux/engine.sh`, `docs/sync-contract.md` ("Checks before pushing").

Record which rules hit; after all rules ran, when `HITS > 0`, print a blank line and the `  fix <rule>: <text>` lines
from the "Leak hints" table, once per rule that hit, in the order the rules run. Exit codes stay the same.

Tests:

- `leak-hint-home`: a file with a `/home/<name>` path: one hit line, then `  fix home-path: write $HOME or ~ …`.
- `leak-hint-once`: two home-path hits print the fix line once.
- `leak-hint-two-rules`: a home path and a `ghp_` token: both fix lines, `home-path` first.
- `leak-hint-no-secret`: the output doesn't contain the token itself.
- `leak-clean-silent`: a clean scan still prints nothing (existing assertion).

Test command: `tests/linux/engine.sh leak` (all pass) and the CI `shellcheck` line.

## Step 8: `-Only` in the Windows engine `[worker:high: PowerShell runs only in CI, so the spec must land first try]`

Files: `scripts/windows/SyncHelpers.ps1`, `scripts/windows/Import-Settings.ps1`, `scripts/windows/Export-Settings.ps1`,
`tests/windows/Engine.Tests.ps1`.

Port steps 1-3: `Resolve-OnlyPaths` and `Test-OnlySelected` in `SyncHelpers.ps1` (local paths: `~\` and `~/` become
the profile folder, relative ones join `$env:SYNC_CALLER_PWD` or the current folder, comparison case-insensitive like
the file system; repo paths compared ordinally). `-Only <string[]>` on Import (no sync point when set) and Export
(`-Diff` filtering, no orphan report, removal only inside the selection, `-Preview -Only` is an error). PS 5.1 rules:
no `??`, no ternary. Pester cases mirroring steps 2 and 3, named the same.

Test command: `pwsh -NoProfile -Command` parse check of the three scripts (0 errors); the Pester cases run in the CI
`engine-windows` job.

## Step 9: the Windows front door and backups `[worker:high: PowerShell runs only in CI, so the spec must land first try]`

Files: `scripts/windows/Commit-Settings.ps1`, `scripts/windows/Front.ps1`, `sync.cmd`, `scripts/windows/Import-Settings.ps1`,
`tests/windows/Engine.Tests.ps1`.

Port steps 4-6: `-Partial` on Commit; `sync.cmd` sets `SYNC_CALLER_PWD` before changing folder; path arguments on
`pull`, `push` and `diff` in `Front.ps1`; the first-pull guard with the same wording; the dated backup copy beside each
`.bak` in Import, the prune to 20 and the `Backups` line. Pester cases mirroring steps 4-6, named the same (no dconf
case).

Test command: `pwsh -NoProfile -Command` parse check of the changed scripts (0 errors); the Pester cases run in the CI
`engine-windows` job.

## Step 10: guides and the Windows check `[inline: user-facing copy]`

Files: `README.md`, `docs/daily-workflow.md`, `docs/sync-contract.md` (front door and "Parity"), `TODO.md`.

- `daily-workflow.md`: a "Take or send only some files" part with `mksync diff`, `mksync pull <path>` and
  `mksync push <path>`; the first-pull guard; where the dated backups are and how to copy one back.
- README: one line on picking files in the command list.
- Contract "Parity": the new flags on both engines.
- `TODO.md`: **W9** on Windows after W8: `mksync pull <path>` on one changed file, a first pull refused with `-Yes`,
  and a dated backup folder after a pull.

Test command: `tests/linux/engine.sh` (full suite, once), and `grep -n` that every command the guides show exists in
`sync usage`.
