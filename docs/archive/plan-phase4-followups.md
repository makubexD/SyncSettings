# Phase 4 review follow-ups

Source: the "Review follow-ups from phase 4 (PR #44)" list in `TODO.md`. Three small fixes, each with its own test,
then the docs. No behavior change for a valid `sync-config.json`: today's config passes every new check
(`jq` scan on 2026-11-08 found no `linux` or `macos` string entry without a `~/` `localPath`).

## Shared rules

- Branch `fix/phase4-followups`, one commit per step, one PR at the end (auto-merged when every check is green).
- Bash cases go in `tests/linux/engine.sh` next to the cases they extend, and use the existing helpers (`lint_run`,
  `assert_dconf_stop`, `new_tmp`, `fail`). Pester cases go in `tests/windows/Engine.Tests.ps1` next to
  `dconf-platform-common`. On Linux, Pester can only be parsed (`pwsh`); the `engine-windows` CI job runs it.
- Every changed bash file passes `shellcheck`.

## Step 1: PowerShell rejects a dconf platform list `[worker]`

Files: `scripts/windows/SyncHelpers.ps1`, `tests/windows/Engine.Tests.ps1`, `tests/linux/engine.sh`.

In the dconf check of `SyncHelpers.ps1` (the block under `# A dconf entry has no local file`), `[string]$entry.platform`
turns a one-item list `["linux"]` into `linux`, so the entry passes, while bash and `check-config.sh` reject it. Change
the check so an entry whose `platform` is a list (`$entry.platform -is [array]`) is invalid before the string compare:
`$valid` is `$false` for any list, and the error message stays the same.

Tests:

- Pester `dconf-platform-list`, copied from `dconf-platform-common` with `platform = @('linux')`: expects the same
  `Assert-PathStop` message (`... needs "platform": "linux" and a dconf path like /org/gnome/shell/.`).
- Bash `case_dconf_platform_list`: `assert_dconf_stop '.platform = ["linux"]'`. It should already pass (bash rejects
  it today); it pins the behavior both engines share.

Test command: `tests/linux/engine.sh dconf_platform` (all pass), and
`pwsh -NoProfile -Command '$null = [scriptblock]::Create((Get-Content -Raw tests/windows/Engine.Tests.ps1)); $null = [scriptblock]::Create((Get-Content -Raw scripts/windows/SyncHelpers.ps1))'`
(parses).

## Step 2: lint checks `~/` for `linux` and `macos` string entries `[worker]`

Files: `scripts/ci/check-config.sh`, `tests/linux/engine.sh`.

`check-config.sh` requires `localPath` to start with `~/` for `common` entries and for list entries, but not for
entries whose `platform` is the string `linux` or `macos`. Add one rule next to the two existing `startswith("~/")`
rules: an entry with `.platform == "linux"` or `.platform == "macos"` and `.type != "dconf"` whose `.localPath // ""`
does not start with `~/` is invalid (print its `repoPath`, as the other rules do). dconf entries have no `localPath`,
so they stay out of this rule.

Tests (each with `lint_run` on a copy of the real config, as the existing `case_lint_*` cases do):

- `case_lint_linux_local_tilde`: change one `linux` file entry's `localPath` to `/home/x/.bashrc`: exit 1, output names
  that entry's `repoPath`.
- `case_lint_macos_local_tilde`: change one `macos` file entry's `localPath` to `/Users/x/.zshrc`: exit 1, output names
  that entry's `repoPath`.
- `case_lint_dconf_no_local_ok`: the unchanged config (it has `linux` dconf entries with no `localPath`): exit 0.

Test command: `tests/linux/engine.sh lint_` (all pass) and `shellcheck scripts/ci/check-config.sh`.

## Step 3: `os.sh` ignores `PLATFORM_SELECT_JQ` from the environment `[worker]`

Files: `scripts/linux/os.sh`, `tests/linux/engine.sh`.

Today `os.sh` keeps `PLATFORM_SELECT_JQ` when it is already set, so a value exported by the caller's environment
replaces the jq filter that picks entries. Keep the guard only for a second `source` in the same shell (the variable is
`readonly` then): define the filter unless `declare -p PLATFORM_SELECT_JQ 2>/dev/null` starts with `declare -r`. An
inherited, non-readonly value is overwritten. Keep the filter text and the `readonly` exactly as they are.

Tests:

- `case_os_select_env_ignored`: in a subshell, `export PLATFORM_SELECT_JQ='def selected($os): true;'`, source
  `scripts/linux/os.sh`, and compare `$PLATFORM_SELECT_JQ` with the filter line in `os.sh` (read it from the file with
  `grep`, don't copy it into the test): equal.
- `case_os_source_twice`: source `os.sh` twice in one subshell under `set -e`: no error, exit 0, filter unchanged.

Test command: `tests/linux/engine.sh os_` and `tests/linux/engine.sh platform` (all pass), and
`shellcheck scripts/linux/os.sh`.

## Step 4: docs and TODO `[inline: user-facing docs]`

Files: `docs/sync-contract.md`, `docs/configuration.md` (only if it states the rules), `TODO.md`.

- Contract, dconf section: `platform` must be the string `linux`; a list, even `["linux"]`, stops both engines.
- Contract or configuration, wherever the lint rules are listed: every non-dconf `linux` and `macos` string entry needs
  a `~/` `localPath`, like `common` and list entries.
- Contract, OS section: `PLATFORM_SELECT_JQ` is internal; a value in the environment is ignored.
- `TODO.md`: delete the "Review follow-ups from phase 4" list.

Test command: `tests/linux/engine.sh lint_` (the docs lint cases still pass) and `git diff --stat` shows only these
files.
