# Per-machine alias in sync branch names

Today `commit.sh` names branches `sync/linux-$(hostname -s)-…` and writes `Host: <hostname>` into the PR body;
`Commit-Settings.ps1` does the same with `$env:COMPUTERNAME`. On this laptop that is `makubexd-GE72-6QF`: the
username and laptop model end up in public branch names and PR bodies. Replace the hostname with an alias the
user picks once per machine.

## Design

- The alias is stored in the clone's local git config: `git config syncsettings.machine <alias>`. Per clone,
  never committed, read the same way from bash and PowerShell, no new file.
- Valid alias: `^[a-z0-9][a-z0-9-]{0,23}$` (lowercase letters, digits, dashes; 1–24 chars; no leading dash).
- Resolution, right after the "Nothing to commit" exit and before the master/fetch checks:
  1. `git config --get syncsettings.machine` set and valid → use it.
  2. Set but invalid → `ERROR: invalid machine alias '<value>' in git config syncsettings.machine (use a-z, 0-9, -).` exit 1.
  3. Unset and stdin is a terminal → prompt `  Machine alias for branch names (e.g. laptop, desktop): `, read one
     line, trim spaces. Invalid or empty → `ERROR: invalid machine alias '<value>' (use a-z, 0-9, -).` exit 1.
     Valid → `git config syncsettings.machine <alias>`, print `  Saved machine alias: <alias>`.
  4. Unset and no terminal → `ERROR: no machine alias set. Run: git config syncsettings.machine <alias>` exit 1.
- Branch: `sync/<platform>-<alias>-<stamp>`. PR body line: `Platform: <platform> · Machine: <alias>`.
- The hostname is not used anywhere else.

## Steps

### 1. `commit.sh` alias `[worker]`

File: `commit.sh` only. Add a `resolve_machine_alias` helper in the Helpers section that prints the alias or
exits per the design (terminal check: `[[ -t 0 ]]`; prompt with `printf` then `read -r`; errors to stderr).
Call it as `machine=$(resolve_machine_alias)` right after the "Nothing to commit" block, so the prompt's
`printf` must go to stderr (stdout is captured) and `Saved machine alias` too. Replace `host=$(hostname -s)` and
both uses of `$host` with `$machine`; the body line becomes `Platform: linux · Machine: %s`.

Tests (throwaway setup as in `docs/plan-restructure-1.md` step 5: bare remote, clone, stub `gh` logging to `$t/gh.log`;
each case starts from a fresh clone):
- clean tree, no alias set, `< /dev/null` → "Nothing to commit", exit 0, no prompt, no alias error.
- dotfiles change, `git config syncsettings.machine laptop`, `< /dev/null` → exit 0; remote has one branch
  `sync/linux-laptop-<yyyymmdd-hhmm>`; the `--body-file` passed to the stub contains `Machine: laptop`
  (make the stub `cat` the file after `--body-file` into `$t/body.log`); no output or file contains `$(hostname -s)`.
- dotfiles change, no alias, `< /dev/null` → exit 1 "no machine alias set", no branch created.
- dotfiles change, `git config syncsettings.machine Bad_Name` → exit 1 "invalid machine alias 'Bad_Name'".
- dotfiles change, no alias, via a pty: `printf 'desktop\n' | script -qec "GH=$t/gh ./commit.sh" /dev/null`
  → exit 0, output has `Saved machine alias: desktop`, `git config --get syncsettings.machine` = `desktop`,
  branch `sync/linux-desktop-…`.
- same via pty with input `-bad` → exit 1 "invalid machine alias '-bad'", config still unset.
- `shellcheck -x commit.sh` → clean.

### 2. `Commit-Settings.ps1` alias `[worker]`

File: `scripts/Commit-Settings.ps1` only. Same design, messages and placement as step 1, PowerShell style
(PS 5.1, `$LASTEXITCODE` after every git call, errors via `throw` like the rest of the script). Terminal check:
`-not [Console]::IsInputRedirected`; prompt with `Read-Host`. Validate with `-cmatch` (case-sensitive). Replace
`$env:COMPUTERNAME.ToLower()` in the branch name and `Host: $env:COMPUTERNAME` in the body with the alias;
body line `Platform: windows · Machine: <alias>`.

Tests: no `pwsh` here; PSScriptAnalyzer runs in CI. Review side by side with step 1 for matching messages and
order. Live check on Windows together with phase 1 step 8.5.

### 3. Docs `[inline: user-facing copy]`

Files: `docs/daily-workflow.md` (branch names use `<alias>`; first run asks for the alias; how to change it:
`git config syncsettings.machine <alias>`; new rows in the "When commit.sh stops" table for the two alias
errors), `README.md` (one sentence in the Linux table row / Windows commit paragraph that the first run asks
for a machine alias).

Test: read through; every command copy-pasteable.

### 4. PR + gate `[inline: GitHub]`

Push `feat/machine-alias`, open the PR; review-gate red until the user adds `reviewed`; the user merges.

## Done when

- No branch name or PR body produced by `commit.sh` / `commit.bat` contains the hostname.
- The alias is asked once per clone and reused after that.
