# Phase 1: docs and wording

Phase 1 of [the docs and dry-run roadmap](plan-docs-dryrun.md). The findings are there; this file has the steps.

## Shared rules

- Branch `docs/plan-readme-dryrun`, one commit per step, one PR at the end (auto-merged when every check is green).
- Bash cases go in `tests/linux/engine.sh` and use its helpers (`new_tmp`, `fail`, `$out`, `rc`). Pester cases go in
  `tests/windows/Engine.Tests.ps1`. On Linux, Pester can only be parsed (`pwsh`); the `engine-windows` CI job runs it.
- Every changed bash file passes CI's `shellcheck -x` line (from `.github/workflows/ci.yml`), test files included.
- The text `N file(s) would change.` must still start the check's summary line, because `front.sh` and `Front.ps1`
  parse it with `^  ([0-9]+) file\(s\) would change\.`.
- There is no docs lint. A docs step checks its links with this command, which prints every relative Markdown link
  in the root guides and the `docs/` guides (plans skipped) that points at a missing file (it must print nothing):

  ```bash
  for f in README.md CLAUDE.md TODO.md $(ls docs/*.md | grep -v '/plan-'); do d=$(dirname "$f"); grep -oE '\]\([^)# ]+' "$f" | cut -c3- | grep -v '://' | while read -r l; do [[ -e $d/$l ]] || echo "$f -> $l"; done; done
  ```

## Step 1: `mksync check` on Linux and macOS `[worker]`

Files: `sync`, `tests/linux/engine.sh`.

Add `check` to `sync`: `./sync check [options]` runs `exec ./import.sh --check "$@"`. Put it in the allowed-commands
`case` next to `preview|export|import|commit|pull|push`, and in `usage` change the last line to
`  preview | check | export | commit | import   the single steps`.

Tests:

- `sync-check-routes`: in a throwaway clone with `HOME=$(mktemp -d)`, `./sync check < /dev/null` exits with the same
  code as `./import.sh --check < /dev/null` (0 or 3) and prints the `IMPORT CHECK` header.
- `sync-help-lists-check`: `./sync help` output contains `preview | check | export | commit | import`.

Test command: `tests/linux/engine.sh sync-` (all pass) and the CI `shellcheck` line.

## Step 2: `mksync check` on Windows `[worker]`

Files: `sync.cmd`, `tests/windows/Engine.Tests.ps1`.

Add `check` to `sync.cmd`: it runs `Import-Settings.ps1` with `-Check` in front of the other arguments, the way
`preview` runs `Export-Settings.ps1` with `-Preview` (`if /i "%COMMAND%"=="check" set "SCRIPT=Import-Settings.ps1"` and
`set "REST=-Check %REST%"`). Change the help line to `preview ^| check ^| export ^| commit ^| import   the single steps`.

Tests (Pester, next to the existing `sync.cmd` routing cases):

- `sync-cmd-check`: `sync.cmd check` in the fixture repo prints the `IMPORT CHECK` header and exits like
  `Import-Settings.ps1 -Check`.
- `sync-cmd-help-lists-check`: `sync.cmd help` output contains `check`.

Test command: the `pwsh` parse of `tests/windows/Engine.Tests.ps1` (parses); `engine-windows` runs it in CI.

## Step 3: the check warns before a pull overwrites local edits `[worker]`

Files: `import.sh`, `scripts/windows/Import-Settings.ps1`, `tests/linux/engine.sh`, `tests/windows/Engine.Tests.ps1`.

Replace the check's summary line `  N file(s) would change. Run mksync pull to apply.` in both engines with two lines:

```text
  N file(s) would change. mksync pull overwrites them (each keeps a .bak).
  If you changed them on this machine, run mksync push first.
```

Update the cases that match the old text: `tests/linux/engine.sh` lines ~819 and ~921, and
`tests/windows/Engine.Tests.ps1` line ~2065. They check both new lines.

Test command: `tests/linux/engine.sh check` and `tests/linux/engine.sh sync-` (all pass), and the `pwsh` parse of
both changed PowerShell files.

## Step 4: bash hints name `mksync` `[worker]`

Files: `export.sh`, `scripts/linux/sync.sh`, `tests/linux/engine.sh`.

- `export.sh` (~313): `Review the changes, then run  ./commit.sh` becomes `Review the changes, then run  mksync push`.
- `scripts/linux/sync.sh` (~939, end of a preview): `Nothing was written. Run ./export.sh to apply.` becomes
  `Nothing was written. Run mksync push to send it.`
- Update any case that matches the old text (grep both strings in `tests/linux/engine.sh`).

Test command: `tests/linux/engine.sh export` and `tests/linux/engine.sh preview` (all pass), and the CI `shellcheck`
line.

## Step 5: PowerShell hints name `mksync` `[worker]`

Files: `scripts/windows/Export-Settings.ps1`, `scripts/windows/Commit-Settings.ps1`, `scripts/windows/SyncHelpers.ps1`,
plus `tests/windows/Engine.Tests.ps1` if a case matches the old text.

- `Export-Settings.ps1` (~232): `Review the changes, then run  commit.bat  to commit and push.` becomes
  `Review the changes, then run  mksync push`.
- `Export-Settings.ps1` (~239): `If this is a new machine, run  import.bat  to apply repo settings first.` becomes
  `If this is a new machine, run  mksync pull  to apply repo settings first.`
- `Commit-Settings.ps1` (~218): `run commit.bat from master` becomes `run mksync push from master`.
- `SyncHelpers.ps1` (~931): `Nothing was written. Run export.bat to apply.` becomes
  `Nothing was written. Run mksync push to send it.`

Test command: the `pwsh` parse of every changed file, and `grep -rn '\.bat' scripts/windows/*.ps1` shows only the
`SyncHelpers.ps1` comment about `/*.bat` patterns.

## Step 6: move finished plans to `docs/archive/` `[worker:low]`

Files: the plans below, `TODO.md`, `docs/sync-contract.md`, `docs/macos-research.md`.

`git mv` these 17 finished plans into `docs/archive/` with the same names: `plan-restructure.md`,
`plan-restructure-1.md` … `plan-restructure-7.md`, `plan-linux.md`, `plan-machine-alias.md`, `plan-export-preview.md`,
`plan-safety-fixes.md`, `plan-easy-install-1.md` … `plan-easy-install-4.md`, `plan-phase4-followups.md`.

Keep in `docs/`: `plan-easy-install.md` (its phase 5 is still open), `plan-windows-checks.md` and `plan-bootstrap-vm.md`
(their runs are still pending), and `plan-docs-dryrun*.md`.

Fix the links that point at a moved file: `TODO.md` (`plan-safety-fixes.md`, `plan-restructure-2.md`,
`plan-easy-install-2.md`), `docs/sync-contract.md` (~588, `plan-restructure.md`, `plan-restructure-2.md`),
`docs/macos-research.md` (line 3, `plan-easy-install-3.md`). Don't edit the archived files themselves: links between
them still work, because they move together.

Test command: the link check from the shared rules prints nothing, and
`grep -rnE 'docs/plan-(restructure|linux|machine-alias|export-preview|safety-fixes|easy-install-[0-9]|phase4)' TODO.md CLAUDE.md docs/*.md`
prints nothing.

## Step 7: a short README `[inline: user-facing copy]`

File: `README.md`. Target: under 170 lines, task first. Sections, in order:

1. **Title and one sentence**: what it syncs and how (a git repo, a PR for every change, a reviewed merge).
2. **Install**: one block per system (Linux and macOS share the `curl` line; macOS gets one line about Homebrew first),
   then one line for updating and one for the `SYNCSETTINGS_*` overrides, linking to the contract for the rest.
3. **Every day**: `mksync`, `mksync pull`, `mksync push`, `mksync setup`, `mksync doctor` in one table, and the
   good-status sample for Linux only.
4. **See before you change anything**: `mksync` (counts), `mksync check` (repo → machine), `mksync preview`
   (machine → repo). Say that both write nothing, and what `UPDATE`, `CREATE`, `EXTRA` and `MODIFIED` mean. Warn that
   the check can't tell which side is newer yet: if you edited a listed file here, push first.
5. **Run from a clone**, without the installer: `git clone`, `cd`, `./sync setup` (`.\sync setup` on Windows), and
   that `./sync <command>` takes every `mksync` command. Contributors: the two test commands from `CLAUDE.md`.
6. **What gets synced**: one table with a Systems column instead of five tables, the "Never synced" line, and a link
   to `docs/configuration.md` for adding a file.
7. **Requirements**, then **Read next** (the guides in `docs/`, with `docs/archive/` named once as history).

Remove: "Usage" (scenarios 1-3), the Linux and macOS sections (the macOS troubleshooting table moves to the macOS
section of `docs/restore.md`), "Linked Paths", "Sanitization", "Configuration" and "Repository structure". Before
deleting each, check that `docs/configuration.md`, `docs/layout.md` or `docs/restore.md` already says the same, and
move any fact that is only in the README (for example `-User` and the UAC prompt, into `docs/daily-workflow.md`).

Test command: the link check from the shared rules prints nothing, and `wc -l README.md` is under 170.

## Step 8: the rest of the docs `[inline: user-facing docs]`

Files: `CLAUDE.md`, `docs/sync-contract.md`, `docs/daily-workflow.md`, `TODO.md`.

- `CLAUDE.md`: the entry-points table gets `./sync check`; the `.bat` rows say they're kept only until the Windows
  checks pass.
- `docs/sync-contract.md`, front door section: `check` and the two-line check summary.
- `docs/daily-workflow.md`: a short "Before you pull or push" section with `mksync check` and `mksync preview`, and the
  rule "edited here: push first".
- `TODO.md`: add "Delete `export.bat`, `import.bat` and `commit.bat`, and their mentions, once W0-W6 pass".

Test command: the link check from the shared rules prints nothing.
