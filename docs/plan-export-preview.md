# Export preview and one command

Goal: see exactly what would reach the repo before sending it, and use one command on any OS. Import does not change.
No hooks and no git configuration. After this PR merges, the whole solution is inspected and a move to Node is
evaluated; that work has its own report and is not part of this plan.

## Shared rules

- Branch `feat/export-preview`, one commit per step, one PR at the end.
- Bash and PowerShell rules from `docs/plan-restructure-2.md` apply. Every behavior change adds fixture cases.
- PowerShell steps are checked by the `engine-windows` CI job: open the PR as a draft at step 3, and a red job counts as
  a rejection.

## Steps

### 1. Contract `[inline: contract design]`

Files: `docs/sync-contract.md`.

Add an "Export preview" section with the rules in steps 2 and 3, and a "One command" section with the rules in steps 4
and 5.

### 2. Preview, bash `[worker:high]`

Files: `scripts/linux/sync.sh`, `export.sh`, `tests/linux/engine.sh`.

`export.sh`: new flag `--preview`, added to the usage line. `--preview` with `--reset-values` →
`ERROR: --preview cannot be combined with --reset-values.` exit 1. With `--preview`, call `run_preview` right after
argument parsing, then `exit`.

`export.sh` summary: if `SYNC_PREVIEW` is set, and `CHANGED > 0`, print `  %d file(s) would change.` instead of the
"copied" and "Review the changes" lines. The "up to date" branch stays.

`run_preview` in `sync.sh`, under a new `# -- Export preview` heading:

1. `git -C "$REPO_ROOT" rev-parse --verify -q HEAD` fails → `ERROR: --preview needs a git repo with a commit.` exit 1.
2. `PREVIEW_TMP=$(mktemp -d)` (a global, so the trap sees it), `trap 'rm -rf "$PREVIEW_TMP"' EXIT`, `trap 'exit 130' INT
   TERM`. Make `before/` and `after/` inside it.
3. `git -C "$REPO_ROOT" archive -o "$PREVIEW_TMP/before.tar" HEAD -- dotfiles sync-config.json`, then
   `tar -xf "$PREVIEW_TMP/before.tar" -C "$PREVIEW_TMP/before"`.
4. `cp -a` into `after/`: `dotfiles`, `sync-config.json`, `export.sh`, `scripts`, and `.user-values.json` if it exists.
5. `(cd "$PREVIEW_TMP/after" && SYNC_PREVIEW=1 ./export.sh)`, keeping stdin. A failure exits with its code. `after/` is
   not a git repo, so the up-to-date check stays silent.
6. `cd "$PREVIEW_TMP"`. For each of `dotfiles` and `sync-config.json`, run `git --no-pager diff --no-index --stat
   before/<path> after/<path>`, then if any path differed, `git diff --no-index` on each. Exit 1 from git means
   "differs"; anything above 1 is `ERROR: git diff failed.` exit 1. With no differences print
   `  Nothing would be sent: the repo matches HEAD.`
7. If `$REPO_ROOT/scripts/ci/leak-scan.sh` is executable, run it on `after/dotfiles` and `after/sync-config.json`.
   Exit 0 → `  Leak scan: clean.` Exit 1 → `  WARNING: the leak scan found the lines above. Fix them before committing.`
   and the preview exits 1 at the end.
8. `  Nothing was written. Run ./export.sh to apply.`

Cases. Each copies `$REPO/scripts/ci` into `$t/repo/scripts/` and calls `make_git_repo`, unless noted. Each changes local
`plain.txt`, adds `dir/new.txt` and deletes `dir/c.txt`, unless noted. Helper `tree_hash <dir>`: sorted SHA256 and mode of
every file under it, `.git` excluded.

- `preview-writes-nothing`: `tree_hash` of `$t/repo` and `$t/home` same before and after, `git status --short` empty,
  exit 0, output has `MODIFIED`, `ADDED`, `REMOVED` and `Nothing was written.`
- `preview-shows-diff`: output contains the new text of `plain.txt` as a `+` line, and `before/dotfiles/linux/plain.txt`.
- `preview-matches-export`: the set of changed paths in the preview equals `git status --short -- dotfiles` after a real
  export that follows.
- `preview-includes-uncommitted`: real export first, no commit, then preview → the change still appears.
- `preview-no-changes`: nothing changed → `Nothing would be sent`, exit 0.
- `preview-sanitized`: change `named.conf` locally → output has `<NAME>`, and never `Fixture User`.
- `preview-leak-found`: local `plain.txt` contains `/home/someone/x` → output has `WARNING: the leak scan`, exit 1, and
  never the text `/home/someone`.
- `preview-cleans-up`: run with `TMPDIR=$t/tmp` (an empty folder) → it is empty afterward, on both a passing run and
  `preview-leak-found`'s failing run.
- `preview-reset-rejected`: `--preview --reset-values` → exit 1, `tree_hash` same.
- `preview-not-a-repo`: no `make_git_repo` → exit 1 with the `needs a git repo` message.

### 3. Preview, PowerShell `[worker:high]`

Files: `scripts/windows/SyncHelpers.ps1`, `scripts/windows/Export-Settings.ps1`, `tests/windows/Engine.Tests.ps1`.

`Export-Settings.ps1`: new `[switch]$Preview`, documented in the header. `-Preview` with `-ResetValues` throws the same
message. With `-Preview`, call `Invoke-ExportPreview -RepoRoot $repoRoot -User $User` right after `$repoRoot` is set and
`exit` with its result. Summary: with `$env:SYNC_PREVIEW` set and `$changed -gt 0`, print `  $changed file(s) would
change.` instead of the copied and review lines.

`Invoke-ExportPreview` follows `run_preview` in `scripts/linux/sync.sh` as built, in the same order, with the same
messages. That means the leak scan runs before the diff and a hit leaves the diff out, because the diff would print the
leaked text. Exceptions:

- Temp folder under `[IO.Path]::GetTempPath()` named with a GUID, removed in `finally`.
- Runs `& powershell.exe -NoProfile -ExecutionPolicy Bypass -File <after>\scripts\windows\Export-Settings.ps1 -User
  $User` with `$env:SYNC_PREVIEW = '1'`, restored in `finally`.
- Uses `tar.exe` from Windows. Native git calls run with `$ErrorActionPreference = 'Continue'`, as in
  `Test-RepoUpToDate`, and check `$LASTEXITCODE`.
- Leak scan: `bash.exe` from the Git install (`<git folder>\bin\bash.exe`, from `(Get-Command git).Source`). Missing →
  `  NOTE: bash not found; skipping the leak scan.`

Cases, same names and expectations as step 2 except `preview-leak-found`, which needs the Git Bash path available on the
CI runner, and `preview-cleans-up`, which sets `$env:TEMP`. Copy `scripts\ci` into the temp repo. `git init` and commit
there. CI `engine-windows` green.

### 4. `sync` command `[worker]`

Files: `sync` (new, mode 755), `tests/linux/engine.sh`. Leave `ci.yml` alone, so the PR stays out of the gated paths;
`sync` is shellchecked by hand at step 7.

```text
usage: ./sync <preview|export|commit|import> [options]
```

- `set -euo pipefail`, `cd "$(dirname "$0")"`.
- `uname -s` matching `MINGW*|MSYS*|CYGWIN*` → `exec cmd.exe //c sync.cmd "$@"`.
- No arguments → usage plus `  Detected: linux`, exit 0. `help` and `-h` do the same.
- Prerequisites: `git` and `jq` for every command, `gh` for `commit`. Missing →
  `ERROR: <tool> is not installed. Install it and run the command again.` exit 1.
- `preview` → `exec ./export.sh --preview "$@"` (arguments after the command). `export`, `import`, `commit` → their
  script. Anything else → `Unknown command: <x>` plus usage, exit 1.

Cases: `sync-usage` (exit 0, prints `Detected: linux`), `sync-unknown` (exit 1), `sync-routes-export`,
`sync-routes-import` (`--force` passes through), `sync-routes-preview` (prints `Nothing was written.`),
`sync-missing-tool` (a `PATH` with a stub folder that has `git` and `bash` but no `jq` → exit 1 naming `jq`). Copy `sync`
into the temp repo in these cases.

### 5. `sync.cmd` command `[worker]`

Files: `sync.cmd` (new, same line endings as `export.bat`), `tests/windows/Engine.Tests.ps1`.

`pushd "%~dp0"`, take `%~1` as the command, gather the rest with a `shift` loop that keeps quotes, and call
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\windows\<script>.ps1 <rest>`. `preview` adds `-Preview`.
`popd`, then `exit /b` with the PowerShell exit code. No `pause`. No arguments → usage plus `Detected: windows`, exit 0.
Unknown command → exit 1.

Cases, run with `cmd /c`: `sync-cmd-usage`, `sync-cmd-unknown`, `sync-cmd-export`, `sync-cmd-import-force`,
`sync-cmd-preview`, `sync-cmd-message-quotes` (a quoted argument with a space reaches the script as one value). CI green.

### 6. Docs `[inline: user-facing copy]`

Files: `README.md`, `docs/daily-workflow.md`. `./sync preview` before export in the daily flow, the commands table,
the `CLAUDE.md` entry points table. Say plainly that import always keeps a `.bak`.

### 7. Verify and PR `[inline: final review]`

1. `tests/linux/engine.sh` green; shellcheck clean, including `sync`.
2. Throwaway clone with the real `HOME`: `./sync preview`; `git status` clean afterward, no local file changed.
3. Mark the PR ready. CI green. `/agent-skills:review`.
4. The PR touches none of the gated paths, so auto-approval applies.
