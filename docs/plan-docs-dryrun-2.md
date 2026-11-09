# Phase 2: which side is newer (`mksync diff`)

Phase 2 of [the docs and dry-run roadmap](plan-docs-dryrun.md). The findings and the design sketch are there; this
file has the steps. Some details differ from the roadmap's sketch, for the reasons given under "Design".

## Design

**The sync point.** A per-machine file holds one line, the full SHA of the repo commit this machine last agreed with:

- Linux and macOS: `${XDG_STATE_HOME:-$HOME/.local/state}/sync-settings/last-sync`
- Windows: `%LOCALAPPDATA%\SyncSettings\last-sync`

It is read only when the line is 40 hex characters and the commit exists in this clone; anything else counts as "no
sync point". It is written:

- by a real import (not a check), with `HEAD`, when the run had no `ERROR` line, no `user skipped` line, and
  `git status --porcelain -- dotfiles sync-config.json` is empty (so `HEAD` is what was imported). A Windows import for
  another user (`-User`) never writes it.
- by the commit step, after the PR opens, with the sync commit's parent (`HEAD^`, the master commit the branch starts
  from). Not the sync commit itself: until the PR merges, `origin/master` still has the old files, and with the sync
  commit as the base they would read as `IN` and a pull would undo the push. With the parent as the base the pushed
  files read `OUT` until the merge, then drop out because the machine and `origin/master` agree.
- Export alone writes nothing: the exported files aren't in any commit yet.
- A failed write prints a `WARNING` line and never changes the exit code.

**The diff.** `export.sh --diff` (`Export-Settings.ps1 -Diff`) builds three trees of `dotfiles/` in a temp folder:

- `base`: `git archive` of the sync point. With no sync point, `theirs` is used as `base`.
- `theirs`: `git archive` of `origin/master` when that ref exists, else `HEAD`. The engine never fetches; `mksync diff`
  fetches first.
- `mine`: a copy of `base` plus the current `sync-config.json`, `export.sh`, `scripts/`, `packages/` and
  `.user-values.json`, with a preview export run inside it (`SYNC_PREVIEW=1`, stdin from `/dev/null`, output to a log in
  the temp folder). Starting from `base` means any file export doesn't touch equals `base`.

Only files this OS's entries own are compared: a file or dconf entry owns its `repoPath`, a file entry also owns the
`<repoPath>.linked/` prefix, and a dir entry owns the `<repoPath>/` prefix. A missing file counts as a version. Each
owned path in the union of the three trees gets at most one label:

| `mine` vs `base` | `theirs` vs `base` | Label |
|---|---|---|
| same | same | none |
| same | differs | `IN`: only the repo changed, a pull takes it |
| differs | same | `OUT`: only this machine changed, a push sends it |
| differs | differs, `mine` = `theirs` | none: both made the same change |
| differs | differs, `mine` ≠ `theirs` | `BOTH`: merge by hand |
| no sync point, `mine` ≠ `theirs` | | `?` |

The roadmap's `NEW` label is dropped: a file that exists on one side only is `IN` or `OUT` like any other change.
Lines are printed with `status` (`Write-StatusLine`), paths sorted with `LC_ALL=C sort` (ordinal on Windows). The diff
writes nothing: no repo file, no sync point, no `.user-values.json`, and the temp folder is removed on every exit.

Output:

```text
  SyncSettings -- DIFF (linux)

  Last sync  : 1a2b3c4 (2026-11-01)        or: none recorded on this machine
  Repo       : origin/master 5d6e7f8       or: HEAD 5d6e7f8

  OUT        dotfiles/linux/shell/.bashrc
  IN         dotfiles/common/git/.gitconfig

  --------------------------------------------------

  2 file(s) differ: 1 in, 1 out, 0 both.
  IN: mksync pull takes them. OUT: mksync push sends them.
```

- The hint line names only the labels present; `BOTH` adds `BOTH: changed on both sides; merge by hand.`
- With no sync point: `  N file(s) differ. No sync is recorded on this machine, so the newer side is unknown.` then
  `  Run mksync pull or mksync push once to record one.`
- Nothing differs: `  This machine and the repo agree.`
- Exit 0 when nothing differs, 3 when something does, 1 on an error (the export failed: print its log and
  `  ERROR: the export for the diff failed; see above.`; or `git archive` failed).
- `--diff` can't be combined with `--preview` or `--reset-values` (`-Diff` with `-Preview` or `-ResetValues`): error,
  exit 1.

**The front door.** `mksync diff` fetches `origin master` (same timeout as status; offline prints
`  Offline: comparing with the last fetch.` and carries on), then runs the engine diff. `mksync pull` runs the diff
after the check finds changes and refuses when it lists `OUT` or `BOTH`, unless `--force`. `mksync` status runs the
diff only when the check says the machine differs and a sync point exists, and uses its counts for the Machine and
Next lines.

## Shared rules

- Branch `feat/mksync-diff`, one commit per step, one PR at the end (auto-merged when every check is green).
- Bash cases go in `tests/linux/engine.sh` as `case_<name>` functions, added to the case list, using its helpers
  (`new_tmp`, `fail`, `make_git_repo`, `tree_hash`, `run_engine`, and the clone-with-origin setup the `sync-pull-*`
  cases use). Pester cases go in `tests/windows/Engine.Tests.ps1`. On Linux, Pester can only be parsed (`pwsh`); the
  `engine-windows` CI job runs it.
- Every changed bash file passes CI's `shellcheck -x` line (from `.github/workflows/ci.yml`), test files included.
- Every step updates `docs/sync-contract.md` for what it changes.
- No case may touch the real sync point: `tests/linux/engine.sh` unsets `XDG_STATE_HOME` at the top (step 1), so
  every case's throwaway `HOME` holds it; Pester cases set `$env:LOCALAPPDATA` to a temp folder.
- The check's summary line `N file(s) would change.` stays as it is: `front.sh` and `Front.ps1` parse it.

## Step 1: the sync point on Linux and macOS: helpers and import `[worker]`

Files: `scripts/linux/sync.sh`, `import.sh`, `tests/linux/engine.sh`, `docs/sync-contract.md` (new section "Sync
point", after "Import check").

In `sync.sh`:

- `last_sync_file`: prints `${XDG_STATE_HOME:-$HOME/.local/state}/sync-settings/last-sync`.
- `read_last_sync`: prints the SHA and returns 0 when the file's first line matches `^[0-9a-f]{40}$` and
  `git -C "$REPO_ROOT" cat-file -e "$sha^{commit}"` succeeds; otherwise prints nothing and returns 1.
- `write_last_sync <sha>`: `mkdir -p` the folder, write `<sha>\n` to a temp file next to it, `mv` it into place. On any
  failure print `  WARNING: could not record the sync point in <file>.` and return 0.
- `status`: also count `SKIPPED` lines whose note is exactly `user skipped` in a new `STATUS_USER_SKIPS` (initialised
  next to `STATUS_ERRORS`).

In `import.sh`, after the entry loop and only when not `--check`: if `STATUS_ERRORS == 0`, `STATUS_USER_SKIPS == 0`,
`git -C "$REPO_ROOT" rev-parse -q --verify HEAD` succeeds and `git -C "$REPO_ROOT" status --porcelain -- dotfiles
sync-config.json` prints nothing, call `write_last_sync` with `HEAD` and print `  Sync point : <first 7 of the SHA>`
in the summary, after the `file(s) applied` line. Otherwise print nothing about it.

At the top of `tests/linux/engine.sh` (next to the other environment setup): `unset XDG_STATE_HOME`.

Tests (each in a throwaway clone with a throwaway `HOME`):

- `sync-point-import-records`: `import.sh --force` writes `$HOME/.local/state/sync-settings/last-sync` holding
  `git rev-parse HEAD` plus a newline, and the output has `Sync point : <short>`.
- `sync-point-xdg`: with `XDG_STATE_HOME=<tmp>/state` the file is `<tmp>/state/sync-settings/last-sync`, and nothing is
  under `$HOME/.local/state`.
- `sync-point-check-none`: `import.sh --check` writes no file.
- `sync-point-user-skip`: answering `n` to one overwrite prompt writes no file.
- `sync-point-error`: an entry that errors (local parent folder not writable, `chmod 500`) writes no file.
- `sync-point-dirty`: an uncommitted edit to a file under `dotfiles/` writes no file.
- `sync-point-read`: sourcing `sync.sh` in the clone, `read_last_sync` returns 1 for a missing file, for `abc`, and for
  a 40-hex SHA that isn't in the clone, and returns 0 printing the SHA for `HEAD`'s SHA.
- `sync-point-write-fails`: with `$HOME/.local/state` a regular file, import prints the `WARNING` line and exits 0.

Test command: `tests/linux/engine.sh sync-point` (all pass), `tests/linux/engine.sh import` (no regressions), and the CI
`shellcheck` line.

## Step 2: the sync point on Linux and macOS: commit `[worker]`

Files: `commit.sh`, `tests/linux/engine.sh`, `docs/sync-contract.md` (the "Sync point" section: the commit step).

In `commit.sh`, right after `git commit` succeeds, keep `parent=$(git rev-parse HEAD^)`. After the PR opens and
`git switch master` runs, call `write_last_sync "$parent"` (it already sources `sync.sh`). An earlier failure (commit,
push or PR) writes nothing.

Tests (next to `commit-happy`, with its stub `gh` and bare origin):

- `sync-point-commit-records`: after a successful `commit.sh`, the sync point holds the master SHA from before the
  commit, which is the sync branch's parent.
- `sync-point-commit-pr-fails`: with the stub `gh pr create` failing, no sync point is written.

Test command: `tests/linux/engine.sh commit` and `tests/linux/engine.sh sync-point` (all pass), and the CI `shellcheck`
line.

## Step 3: `export.sh --diff` `[worker]`

Files: `scripts/linux/sync.sh` (`run_diff`, next to `run_preview`), `export.sh`, `tests/linux/engine.sh`,
`docs/sync-contract.md` (new section "Diff", after "Sync point").

Implement the diff exactly as "The diff" under Design: `export.sh --diff` calls `run_diff` and exits with its code.
Reuse `run_preview`'s temp-folder and trap pattern. The owned-path filter reads `platform_entries`. `Last sync` shows
`git log -1 --format='%h (%cs)'` of the sync point. The export inside `mine` runs with `< /dev/null > "$tmp/export.log"
2>&1`.

Tests (throwaway clone with a bare origin and a throwaway `HOME`; set the sync point by writing the file directly):

- `diff-clean`: sync point = `HEAD`, machine imported: prints `This machine and the repo agree.`, exit 0.
- `diff-out`: sync point = `HEAD`, a local file edited: `OUT` line for it, the summary `1 file(s) differ: 0 in, 1 out, 0 both.`,
  exit 3.
- `diff-in`: sync point = `HEAD~1`, `HEAD` changed a file, machine has the old one: `IN`, exit 3.
- `diff-both`: sync point = `HEAD~1`, `HEAD` changed a file, the machine changed it differently: `BOTH`, and the
  `BOTH: changed on both sides; merge by hand.` line, exit 3.
- `diff-same-change`: both sides made the same change: no label, exit 0.
- `diff-origin`: `origin/master` is one commit ahead of `HEAD` with a changed file, sync point = `HEAD`: `IN` and
  `Repo       : origin/master`.
- `diff-no-origin`: a clone with no `origin`: `Repo       : HEAD`.
- `diff-no-record`: no sync point, a local file edited: `?` line, both no-record lines, exit 3.
- `diff-bad-record`: sync point holds a SHA not in the clone: same output as `diff-no-record`.
- `diff-sanitized`: an entry with `sanitizeRules` whose local file holds the hydrated value: no label.
- `diff-dir-removed`: a dir entry whose local folder lost one file: `OUT` for that path.
- `diff-other-platform`: a `windows` entry's file changed in `HEAD` since the sync point: not listed.
- `diff-writes-nothing`: `tree_hash` of the clone, the sync point file and `.user-values.json` are unchanged, and no
  temp folder is left (same check as `preview-cleans-up`).
- `diff-export-fails`: a value missing with no default (stdin closed): the export log and the `ERROR` line, exit 1.
- `diff-flags`: `--diff --preview` and `--diff --reset-values` exit 1 with an error.

Test command: `tests/linux/engine.sh diff-` and `tests/linux/engine.sh preview` (all pass), and the CI `shellcheck`
line.

## Step 4: `mksync diff` on Linux and macOS `[worker]`

Files: `sync`, `scripts/linux/front.sh`, `tests/linux/engine.sh`, `docs/sync-contract.md` (front door).

- `front.sh`: `front_diff` fetches `origin master` with `run_with_timeout "${SYNC_FETCH_TIMEOUT:-15}"` when `origin`
  exists; when the fetch fails it prints `  Offline: comparing with the last fetch.` and carries on. Then
  `exec "$REPO_ROOT/export.sh" --diff "$@"`.
- `sync`: `diff` joins the allowed commands and routes to `front_diff "$@"` (sourcing `front.sh`, like `pull`). In
  `usage`, add the line `  diff                                        which side changed each file, after a fetch`
  under the `pull`/`push` lines, aligned with them.

Tests:

- `sync-diff-routes`: `./sync diff < /dev/null` exits like `./export.sh --diff` and prints the `DIFF` header.
- `sync-diff-fetches`: origin one commit ahead with a changed file, local `origin/master` not yet fetched: the output
  has `IN` for that file.
- `sync-diff-offline`: origin unreachable (remote URL pointing to a missing folder): prints the `Offline:` line and
  still prints the `DIFF` header.
- `sync-help-lists-diff`: `./sync help` lists `diff`.

Test command: `tests/linux/engine.sh sync-` (all pass) and the CI `shellcheck` line.

## Step 5: `mksync pull` refuses to overwrite local edits `[worker]`

Files: `scripts/linux/front.sh`, `tests/linux/engine.sh`, `docs/sync-contract.md` (front door: pull).

In `front_pull`: accept `--force`, and pass it on in both `exec "$REPO_ROOT/sync" pull --no-fetch …` lines. After the
check exits 3 and before the apply question, unless `--force`: run `"$REPO_ROOT/export.sh" --diff < /dev/null` into a
temp file and keep its exit code.

- 1: print `  ERROR: could not tell which side is newer; run mksync diff to see why, or mksync pull --force.` to
  stderr and exit 1.
- 0 or 3: count lines matching `^  (OUT|BOTH) `. When there are any, print those lines, then
  `  ERROR: N file(s) changed on this machine since the last sync, and a pull would overwrite them.` and
  `  Run mksync push first, or mksync pull --force to overwrite them (each keeps a .bak).` to stderr and exit 1.
  `IN` and `?` lines never block.

`--force` skips the diff and keeps the apply question (`--yes` still answers it).

Tests:

- `sync-pull-blocks-out`: sync point = `HEAD`, a local edit, origin ahead with another file: exit 1, the `OUT` line and
  both error lines, and the local edit is untouched.
- `sync-pull-blocks-both`: same with `BOTH`.
- `sync-pull-force`: the `sync-pull-blocks-out` setup with `--force --yes`: applies, the edited file gets a `.bak`.
- `sync-pull-in-only`: only `IN` files: applies as before.
- `sync-pull-no-record`: no sync point, a local edit: applies as before (`?` doesn't block).
- The existing `sync-pull-*` cases still pass.

Test command: `tests/linux/engine.sh sync-pull` (all pass) and the CI `shellcheck` line.

## Step 6: `mksync` status uses the labels `[worker]`

Files: `scripts/linux/front.sh`, `tests/linux/engine.sh`, `docs/sync-contract.md` (front door: status).

In `front_status`, when the check says `differ` and `read_last_sync` succeeds, run `"$REPO_ROOT/export.sh" --diff <
/dev/null` into a temp file and parse the summary line `^  [0-9]+ file\(s\) differ: ([0-9]+) in, ([0-9]+) out, ([0-9]+)
both\.`. When it parses:

- Machine line: `N file(s) differ: I in, O out, B both`.
- Next, replacing the current `differ` text (the `updates` and `unsent` branches keep priority): only `in` →
  `mksync pull`; only `out` → `mksync push`; any `both`, or both `in` and `out` → `mksync diff, then push or pull
  file by file.`
- Exit 0 from the diff (the check and the diff disagree, e.g. the same change on both sides): keep today's text.

When there's no sync point or the diff fails, keep today's Machine and Next text.

Tests:

- `sync-status-out`: sync point = `HEAD`, a local edit: Machine `1 file(s) differ: 0 in, 1 out, 0 both`, Next
  `mksync push`.
- `sync-status-in`: sync point = `HEAD~1`, `HEAD` changed a file: Next `mksync pull`.
- `sync-status-both`: Next starts with `mksync diff`.
- `sync-status-no-record`: Machine and Next as today.
- `sync-status-writes-nothing` still passes.

Test command: `tests/linux/engine.sh sync-status` (all pass) and the CI `shellcheck` line.

## Step 7: the sync point on Windows `[worker]`

Files: `scripts/windows/SyncHelpers.ps1`, `scripts/windows/Import-Settings.ps1`, `scripts/windows/Commit-Settings.ps1`,
`tests/windows/Engine.Tests.ps1` (and the contract's "Sync point" section names the Windows path).

- `SyncHelpers.ps1`: `Get-LastSyncFile` (`Join-Path $env:LOCALAPPDATA 'SyncSettings\last-sync'`), `Read-LastSync
  -RepoRoot` (same rules as `read_last_sync`; returns the SHA or `$null`), `Write-LastSync -Sha` (create the folder,
  write `<sha>` plus `\n` with `[IO.File]::WriteAllText` to a temp file, then `Move-Item -Force`; on failure print the
  same `WARNING` line, never throw). `Write-StatusLine` counts `SKIPPED` with note `user skipped` in
  `$script:UserSkips`.
- `Import-Settings.ps1`: after the entry loop, not `-Check`, not another user's profile, `$errors -eq 0`,
  `$script:UserSkips -eq 0`, `HEAD` resolves and `git status --porcelain -- dotfiles sync-config.json` is empty:
  `Write-LastSync` with `HEAD` and print `  Sync point : <short>` after the applied line.
- `Commit-Settings.ps1`: keep `git rev-parse HEAD^` after the commit; `Write-LastSync` with it after the PR opens and
  `git switch master` runs.

Tests (Pester, `$env:LOCALAPPDATA` set to a temp folder in `BeforeEach`, restored in `AfterEach`): the Windows
versions of `sync-point-import-records`, `sync-point-check-none`, `sync-point-user-skip`, `sync-point-dirty`,
`sync-point-read`, `sync-point-other-user` (`-User` writes nothing) and `sync-point-commit-records`.

Test command: the `pwsh` parse of the three changed scripts and of `tests/windows/Engine.Tests.ps1` (all parse);
`engine-windows` runs the cases in CI.

## Step 8: `Export-Settings.ps1 -Diff` `[worker]`

Files: `scripts/windows/SyncHelpers.ps1` (`Invoke-ExportDiff`, next to `Invoke-ExportPreview`),
`scripts/windows/Export-Settings.ps1`, `tests/windows/Engine.Tests.ps1` (and the contract's "Diff" section notes any
Windows difference).

Implement the diff as "The diff" under Design, reusing `Invoke-ExportPreview`'s temp-folder, `git archive` and
`System32\tar.exe` pattern and its `Start-Process` child (with `-RedirectStandardOutput` to the log and stdin from an
empty file). The owned-path filter reads `Select-WindowsEntries`; compare files with `Compare-FilesByHash` (both
present) or presence. Paths are printed with `/` separators, like the repo paths in `sync-config.json`. Same output
text and exit codes as bash.

Tests (Pester): the Windows versions of `diff-clean`, `diff-out`, `diff-in`, `diff-both`, `diff-same-change`,
`diff-origin`, `diff-no-record`, `diff-other-platform`, `diff-writes-nothing` and `diff-flags`.

Test command: the `pwsh` parse of the two changed scripts and the test file (all parse); `engine-windows` runs them in
CI.

## Step 9: `mksync diff`, the pull guard and status on Windows `[worker]`

Files: `sync.cmd`, `scripts/windows/Front.ps1`, `tests/windows/Engine.Tests.ps1` (and the contract's front door section
covers both systems).

- `sync.cmd`: `diff` routes to `Front.ps1` like `pull` and `push`; the help lists it with the bash wording.
- `Front.ps1`: `Invoke-Diff` (fetch with `Invoke-GitFetch`, the `Offline:` line on failure, then
  `Export-Settings.ps1 -Diff`), the pull guard and `-Force` as in step 5, and the status Machine and Next lines as in
  step 6. Same wording and exit codes as bash.

Tests (Pester): `sync-cmd-diff`, `sync-cmd-help-lists-diff`, `pull-blocks-out`, `pull-force`, `pull-no-record`,
`status-out`, `status-no-record`.

Test command: the `pwsh` parse of `Front.ps1` and the test file (all parse); `engine-windows` runs them in CI.

## Step 10: guides `[inline: user-facing copy]`

Files: `README.md`, `docs/daily-workflow.md`, `docs/sync-contract.md`, `TODO.md`.

- README dry-run table: add `mksync diff` (which side changed each file, after a fetch; writes nothing), and replace
  "The check can't tell which side is newer yet…" with one sentence pointing at `mksync diff` and the pull guard.
- `docs/daily-workflow.md`: where it says to check before pulling, use `mksync diff`, and say what `IN`, `OUT`, `BOTH`
  and `?` mean and that the first pull or push records the sync point.
- `docs/sync-contract.md`: read the "Sync point" and "Diff" sections end to end against the code; fix drift between
  the bash and Windows wording; add the diff to "Parity" and the front door table.
- `TODO.md`: add the Windows real-run checks for `mksync diff` and the pull guard next to W0-W6.

Test command: the link check from [phase 1's shared rules](plan-docs-dryrun-1.md) prints nothing, and
`tests/linux/engine.sh sync-` passes.
