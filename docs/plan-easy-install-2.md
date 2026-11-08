# Easy install, phase 2: Windows

Roadmap: `docs/plan-easy-install.md`. Goal: `irm … | iex` installs or updates the tool on Windows, and `mksync` shows
where the machine stands and runs the next step, with the same commands, wording and exit codes as phase 1 on Linux. The
bash side doesn't change in this phase.

The user chose on 2026-11-08 to start this phase before the W0-W6 checks in `TODO.md` ran. They still have to pass on the
real Windows machine, and they come before the real run in step 10.

## Shared rules

- Branch `feat/easy-install-windows`, one commit per step, one PR at the end.
- PowerShell 5.1 rules from `CLAUDE.md`: no `??`, no ternary, `[IO.File]::WriteAllText()` for UTF-8 without BOM,
  `$ErrorActionPreference = 'Stop'`, per-entry `try/catch`.
- Wording, statuses, prompts and exit codes match the Linux front door in `docs/sync-contract.md` unless step 1 lists a
  difference. Every `[Y/n]` prompt takes an empty answer or end of input as yes; every `[y/N]` prompt as no.
- New Pester cases go in `tests/windows/Engine.Tests.ps1`, in their own `Context` blocks, and reuse its helpers
  (`Copy-EngineToRepo`, `New-GitRepo`, `New-CommitRepo`, `New-GhStub`, `Get-TreeHash`, `Copy-SyncWrappers`). A case never
  reaches the real `winget`, `gh`, network or the real user profile: stubs on `PATH`, a bare origin, a temp
  `USERPROFILE`.
- Testing: the Pester suite calls `powershell.exe`, so it only runs in CI. Each step's test is the parse check below
  locally, then push the branch and watch the `engine-windows` job (`gh run watch` on the branch's latest run). A red job
  is a rejection of the step.

  ```bash
  pwsh -NoProfile -c '$f=$args; $bad=0; foreach ($p in $f) { $e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $p), [ref]$null, [ref]$e); if ($e) { $e; $bad=1 } }; exit $bad' <files>
  ```

- Docs stay current: a step that changes behavior updates `docs/sync-contract.md` in the same commit when step 1
  didn't already cover it. Step 9 enriches the user docs.
- The PR touches `.github/workflows/ci.yml` (step 8), so it waits for the user's `reviewed` label.

## Steps

### 1. Contract `[inline: contract design]`

Files: `docs/sync-contract.md`.

- "Import check": drop "bash only until phase 2"; add `Import-Settings.ps1 -Check`. On Windows a missing target folder
  stays `SKIPPED` with the folder warning and is not a change, because an import skips it too. `-Check` with `-User` for
  another profile is an error: `ERROR: -Check works on your own profile only.` exit 1.
- "Front door": `mksync` on Windows is `mksync.cmd` in the install's bin folder, which calls the clone's `sync.cmd`.
  `sync.cmd` with no command shows the status. The doctor checks on Windows: PowerShell 5.1, `git`, `gh` and its sign-in,
  the origin remote, the `mksync` launcher, unset values. No `jq` or `cmp`: the PowerShell engine doesn't use them.
  `setup` has no bootstrap question on Windows.
- `install.ps1`: what it does, and its variables (step 7).
- "One command": drop "On Windows, no command still prints the usage until phase 2".
- Known differences: add the missing-folder row for the check, the `-User` row, and the bootstrap row.

### 2. `Import-Settings.ps1 -Check` `[worker]`

Files: `scripts/windows/Import-Settings.ps1`, `scripts/windows/SyncHelpers.ps1`.

A dry run of import: it reports what import would change and writes nothing.

- New `[switch]$Check`. With `$ResetValues` → `ERROR: -Check cannot be combined with -ResetValues.` exit 1. With a
  `-User` whose profile isn't `$env:USERPROFILE` → `ERROR: -Check works on your own profile only.` exit 1, before the
  elevation code. `-Force` is accepted and does nothing.
- Header `|     SyncSettings -- IMPORT CHECK          |` (same box width) instead of `IMPORT`. `Test-RepoUpToDate` is
  skipped.
- Values: `Get-UserValues`, then the inference loop as today. No `Request-MissingValues` and no `Save-UserValues`. A
  placeholder still with no value takes the rule's `default`, then its `defaultEnv` variable, in memory only, the same
  order `Request-MissingValues` uses for its shown default.
- With `-Check` nothing is written: no `New-Item`, `Copy-Item`, `Write-Utf8File`, `.bak`, `Read-Host`. Add a
  `[bool]$Check = $false` parameter to `Copy-RepoFileToLocal`, `Import-DirEntry` and `Import-LinkedDirectory`; with it,
  they return and print `CREATE` or `UPDATE` instead of copying, and `UNCHANGED`, `EXTRA` and `SKIPPED` as today. The
  linked-folder "Creating linked directory" line isn't printed.
- `CREATE` and `UPDATE` each add 1 to a new `$changed` counter. A sanitized entry with a placeholder still missing a value
  → `Write-StatusLine 'SKIPPED' $label 'needs values: run mksync setup'` and `$changed++`. Every `ERROR` line adds 1 to
  `$errors`. Add `CREATE` and `UPDATE` to `Write-StatusLine`'s colors (Cyan, Yellow).
- Summary with `-Check`: `$errors -gt 0` → `  <n> error(s); see the ERROR lines above.` exit 1. `$changed -eq 0` →
  `  This machine matches the repo.` exit 0. Else `  <n> file(s) would change. Run mksync pull to apply.` exit 3.
- Without `-Check`, behavior and output are byte-for-byte the same as today.

Test: the parse check on both files, then `engine-windows` green (the existing import cases prove nothing changed
without `-Check`).

### 3. Pester cases for `-Check` `[worker]`

Files: `tests/windows/Engine.Tests.ps1`.

Add an `Invoke-ImportCheck` helper (like `Invoke-EnginePiped`, with `-Check` and stdin redirected). `Get-TreeHash` of the
temp profile and repo is the same before and after in every case.

- `import check writes nothing`: local `win.conf` differs and one fixture file is missing locally → exit 3, `UPDATE` for
  the changed one, `CREATE` for the missing one, no `.bak` under the profile, `.user-values.json` byte-identical.
- `import check matches`: `Import-Settings.ps1 -Force` first, then `-Check` → exit 0, `This machine matches the repo.`,
  no `CREATE` or `UPDATE` line.
- `import check sanitized`: after a real import, the sanitized fixture is `UNCHANGED`; edit it locally → `UPDATE`,
  exit 3.
- `import check needs values`: no `.user-values.json` and a rule with no default → the `needs values` line, exit 3, no
  `.user-values.json` created, no prompt text.
- `import check dir`: a dir entry with one local file changed and one local extra file → `UPDATE` and `EXTRA`, exit 3.
- `import check missing folder`: an entry whose target folder is missing → `SKIPPED` with `target folder not found`,
  and exit 0 if nothing else differs.
- `import check reset rejected`: `-Check -ResetValues` → exit 1 with the message.
- `import check other user`: `-Check -User nobody-here` → exit 1, no UAC relaunch (output has no `Requesting
  elevation`).
- `import check error`: the local file is a folder where the entry expects a file → an `ERROR` line,
  `1 error(s); see the ERROR lines above.`, exit 1.

Test: `engine-windows` green; each new case fails if `-Check` is removed from its call (spot-check two by hand in the
diff).

### 4. Front door: status, doctor, help `[worker]`

Files: `sync.cmd`, `scripts/windows/Front.ps1` (new), `tests/windows/Engine.Tests.ps1`.

`sync.cmd`:

- No command, or `status` → `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\windows\Front.ps1 status`.
- `doctor`, `setup`, `pull`, `push` → the same with that command and the remaining arguments. `setup`, `pull`, `push` print
  `Not implemented yet.` with exit 1 from `Front.ps1` until steps 5 and 6.
- `help`/`-h` print the Linux usage text with `mksync` and `Detected: windows`.

`Front.ps1`: `param([Parameter(Position=0)][string]$Command, [switch]$Yes, [string]$Message = '', [switch]$NoFetch)`.
`$repoRoot` is two levels up from `$PSScriptRoot`. `$env:SYNC_OS_NAME` overrides the OS name, else
`(Get-CimInstance Win32_OperatingSystem).Caption`, else `unknown`.

`status` prints exactly:

```

  SyncSettings  windows (<os name>)
  Repo      : <repo root>
  Origin    : <origin>
  Unsent    : <unsent>
  Machine   : <machine>

  Next: <next>
```

The `<origin>`, `<unsent>`, `<machine>` and `<next>` rules are the Linux ones in the contract, with
`$env:GIT_TERMINAL_PROMPT = '0'` and the fetch run as a job with a 15-second timeout. `<machine>` runs
`Import-Settings.ps1 -Check` in a child `powershell.exe` with stdin redirected and reads its exit code and summary line.
Exit 0 always.

`doctor` prints `'  {0,-8} {1}' -f <OK|WARN|MISSING>, <text>`:

- PowerShell: `$PSVersionTable.PSVersion` ≥ 5.1 → `OK PowerShell <version>`, else `MISSING PowerShell 5.1 or newer`.
- git: `OK git`, or `MISSING git: install with winget install --id Git.Git -e` (the hint is
  `install it from https://git-scm.com` when `winget` isn't on `PATH`).
- gh: missing → `WARN gh: needed for push; install with winget install --id GitHub.cli -e`; `gh auth status` fails →
  `WARN gh: not signed in; run gh auth login`; else `OK gh (signed in)`.
- clone: `OK repo clone with origin`, else `WARN repo has no origin remote`.
- launcher: `Get-Command mksync -CommandType Application` finds a `mksync.cmd` whose text contains `<repo root>\sync.cmd`
  → `OK mksync on PATH`, else `WARN mksync not on PATH; run the installer again`.
- values: placeholders of `windows`/`common` entries with no value in `.user-values.json`, no `default` and no
  `defaultEnv` → `WARN <n> value(s) not set; mksync setup asks for them`, else `OK values`.
- No `MISSING` → `  Ready.` exit 0, else `  Fix the MISSING items, then run mksync doctor again.` exit 1.

Cases (`Copy-SyncWrappers` also copies `Front.ps1` via `Copy-EngineToRepo`, which copies every `*.ps1`):

- `sync help` → `usage: mksync [command] [options]` and `Detected: windows`, exit 0.
- `status clean`: engine, fixtures, `New-GitRepo`, a forced import into the temp profile → `Origin    : up to date`,
  `Unsent    : none`, `Machine   : matches the repo`, `Next: nothing to do.`, exit 0.
- `status behind`: a second clone pushes a commit → `Origin    : 1 update(s) waiting`, `Next: mksync pull`.
- `status unsent`: a changed file under `dotfiles\` → `Unsent    : 1 changed file(s) not sent yet`, `Next: mksync push`.
- `status differs`: a changed local file → `Machine   : 1 file(s) differ from the repo`; tree hashes unchanged.
- `status not git`: no `New-GitRepo` → `Origin    : not a git clone`, `Next: run mksync doctor.`, exit 0.
- `status os name`: `SYNC_OS_NAME=Test OS 1` → `SyncSettings  windows (Test OS 1)`.
- `doctor ready`: gh stub signed in, a `mksync.cmd` launcher on the stub `PATH` → `Ready.`, exit 0.
- `doctor gh signed out`: the gh stub exits 1 for `auth status` → the `not signed in` WARN, exit 0.
- `doctor no launcher` → the `mksync not on PATH` WARN, exit 0.

Test: the parse check on `Front.ps1`, then `engine-windows` green.

### 5. Front door: pull and push `[worker]`

Files: `scripts/windows/Front.ps1`, `tests/windows/Engine.Tests.ps1`.

Both need a git clone on `master` with an origin, else
`ERROR: <pull|push> needs the repo clone on master with an origin remote.` exit 1. Same flow and messages as the Linux
contract:

- `pull [-Yes] [-NoFetch]`: unsent changes → the error, exit 1. Without `-NoFetch`: fetch fails →
  `ERROR: could not reach origin.` exit 1; behind → `git pull --ff-only -q` (failure → `ERROR: pull failed; resolve it
  and rerun.` exit 1), `  Pulled <n> commit(s).`, then run `Front.ps1 pull -NoFetch` (with `-Yes` if given) in a new
  `powershell.exe` so the new code runs, and exit with its code. Then the check with its output shown: 0 → exit 0; 1 →
  exit 1; 3 → unless `-Yes`, `Read-Host '  Apply these changes? [Y/n]'`; no → `  Nothing applied.` exit 0; yes →
  `Import-Settings.ps1 -Force` and exit with its code.
- `push [-Yes] [-Message <m>]`: `Export-Settings.ps1`; a failure exits with its code. Nothing in
  `git status --porcelain -- dotfiles packages sync-config.json` → `  Nothing to send: the repo matches this machine.`
  exit 0. Else print `git status --short -- …`, unless `-Yes` ask `  Open a PR with these changes? [Y/n]`; no →
  `  Kept in the repo. Run mksync push again, or git restore dotfiles to drop them.` exit 0; yes →
  `Commit-Settings.ps1` with `-Message` if given, exit with its code.
- `sync.cmd` maps `-m <msg>` / `--yes` to `-Message` / `-Yes`, so the Linux spelling works too.

Cases (`New-CommitRepo`, running `sync.cmd` in the clone):

- `pull applies`: a second clone pushes a change to `dotfiles\windows\win.conf`; `pull -Yes` → exit 0, clone HEAD equals
  origin's, the profile file has the new text, a `.bak` exists, output has `Pulled 1 commit(s).`
- `pull matches` → `This machine matches the repo.`, exit 0.
- `pull declined`: a changed local file, input `n` → `Nothing applied.`, the file unchanged.
- `pull dirty` → exit 1 with the error, HEAD unchanged.
- `pull not master` → exit 1 with the error.
- `push nothing` → `Nothing to send`, exit 0, the gh log missing.
- `push opens pr`: a changed local `win.conf`, `-Yes` → exit 0, the gh log has `pr create`, origin has a `sync/windows-`
  branch.
- `push declined`: input `n` → `Kept in the repo`, gh log missing, the change still in the working tree.

Test: the parse check on `Front.ps1`, then `engine-windows` green.

### 6. Front door: setup `[worker]`

Files: `scripts/windows/Front.ps1`, `tests/windows/Engine.Tests.ps1`.

`setup [-Yes]`: doctor (exit 1 → exit 1), the check with its output (1 → exit 1), on 3 the apply question as in `pull`,
then `  Setup done. Run mksync any time to see where this machine stands.` exit 0. No bootstrap question.

Cases: `setup applies` (a fixture file missing locally, `-Yes` → created, `Setup done.`); `setup doctor fails` (no git on
the stub `PATH` → exit 1, no `IMPORT CHECK` header).

Test: the parse check on `Front.ps1`, then `engine-windows` green.

### 7. `install.ps1` `[worker:high: installer for a system the worker can't run, with PATH and winget edge cases]`

Files: `install.ps1` (new), `tests/windows/Engine.Tests.ps1`.

Run as `irm https://raw.githubusercontent.com/makubexD/SyncSettings/master/install.ps1 | iex`, so it takes no
parameters. The whole script is one function, `Install-SyncSettings`, and its last line calls it, so a cut-off download
runs nothing. Settings from the environment:

| Variable | Default |
|---|---|
| `SYNCSETTINGS_REPO_URL` | `https://github.com/makubexD/SyncSettings.git` |
| `SYNCSETTINGS_DIR` | `$env:USERPROFILE\SyncSettings` |
| `SYNCSETTINGS_REF` | `master` |
| `SYNCSETTINGS_BIN` | `$env:LOCALAPPDATA\SyncSettings\bin` |
| `SYNCSETTINGS_YES` | unset; `1` answers the `[Y/n]` questions |
| `SYNCSETTINGS_NO_SETUP` | unset; `1` skips `mksync setup` |

1. Not Windows (`$env:OS -ne 'Windows_NT'`) → `ERROR: on Linux, run the bash installer from the README.` exit 1, via
   `throw` caught at the top so `iex` doesn't close the user's window. PowerShell below 5.1 → error.
2. Tools: `git` required, `gh` offered. Missing ones with `winget` on `PATH`: unless `SYNCSETTINGS_YES=1`,
   `Read-Host '  Install <names> with winget? [Y/n]'`. Yes → `winget install --id <id> -e --source winget
   --accept-package-agreements --accept-source-agreements` (`Git.Git`, `GitHub.cli`); then reload `$env:Path` from the
   machine and user values. git still missing → `ERROR: install Git, open a new window, and run this again.` A missing
   gh is a warning only. No `winget` and no git → the same error naming https://git-scm.com.
3. The folder: a clone with an origin → `git -C <dir> pull --ff-only -q`, `  Updated <dir>`. Exists, not a clone, not
   empty → `ERROR: <dir> exists and isn't a SyncSettings clone; set SYNCSETTINGS_DIR.` Otherwise
   `git clone -q --branch <ref> <url> <dir>`, `  Cloned into <dir>`. `<dir>\sync.cmd` and `<dir>\sync-config.json` must
   exist, else `ERROR: <dir> doesn't look like SyncSettings.`
4. The launcher: `<bin>\mksync.cmd` exists and its first two lines aren't `@echo off` and `rem SyncSettings launcher` →
   `ERROR: <bin>\mksync.cmd already exists; remove it and run this again.` Else write it (ASCII, CRLF):
   `@echo off`, `rem SyncSettings launcher`, `call "<dir>\sync.cmd" %*`, `exit /b %ERRORLEVEL%`. `<bin>` not in the user
   `Path` → add it with `[Environment]::SetEnvironmentVariable('Path', …, 'User')` and to `$env:Path`, and print
   `  Added <bin> to your PATH. New windows will find mksync.`
5. Unless `SYNCSETTINGS_NO_SETUP=1`: `& "<dir>\sync.cmd" setup` with `-Yes` when `SYNCSETTINGS_YES=1`. A failure →
   `ERROR: setup failed; run mksync setup to see why.`
6. `  Installed. Run mksync any time.`

Cases (origin: a bare repo built from the engine, fixtures, `sync.cmd`, `Front.ps1` and `install.ps1`; `USERPROFILE` and
`LOCALAPPDATA` in the temp folder; the user `Path` saved in `BeforeEach` and restored in `AfterEach`; a `winget.cmd`
stub that logs its arguments):

- `install fresh`: `SYNCSETTINGS_NO_SETUP=1` → `Cloned into`, the launcher with the marker line, the bin on the user
  `Path`, `Installed.`
- `install update`: a second run after a new origin commit → `Updated`, clone HEAD equals origin's.
- `install not a clone`: the folder holds a file → the error, the file untouched.
- `install launcher conflict`: a `mksync.cmd` without the marker → the error, the file untouched.
- `install missing gh yes`: no gh on `PATH`, `SYNCSETTINGS_YES=1` → the winget log has `GitHub.cli`.
- `install partial`: all but the last line of `install.ps1` run through `Invoke-Expression` → no clone folder, no
  launcher.
- `install runs setup`: `SYNCSETTINGS_YES=1` → a fixture file created in the temp profile, `Setup done.` and
  `Installed.`

Test: the parse check on `install.ps1`, then `engine-windows` green.

### 8. Lint `install.ps1` `[inline: tiny edit, CI file]`

Files: `.github/workflows/ci.yml`.

PSScriptAnalyzer runs on `scripts` only. Add a second `Invoke-ScriptAnalyzer -Path install.ps1 -Severity Error` and fail
on either result. This is why the PR needs the user's label.

Test: `pwsh -c 'Install-Module PSScriptAnalyzer -Scope CurrentUser -Force; Invoke-ScriptAnalyzer -Path scripts -Recurse
-Severity Error; Invoke-ScriptAnalyzer -Path install.ps1 -Severity Error'` prints nothing.

### 9. Docs, enriched `[inline: user-facing copy]`

Files: `README.md`, `docs/daily-workflow.md`, `docs/restore.md`, `CLAUDE.md`, `docs/plan-easy-install.md`.

- README Install: the Windows line next to the Linux one, what each installs, where the clone and launcher go, and that
  running it again updates.
- A sample `mksync` status block and a sample `mksync doctor` block for each OS, so a reader knows what good looks like.
- Troubleshooting in `docs/daily-workflow.md`: execution policy (the scripts run with `-ExecutionPolicy Bypass`), no
  `winget`, `gh auth login`, `mksync` not found in an old window, `needs values`, exit 3 from the check.
- `docs/restore.md`: a new Windows machine starts from the one-liner, then the W-checks it replaces.
- `CLAUDE.md`: `install.ps1` and `scripts/windows/Front.ps1` in the entry points and architecture; drop "Linux only"
  from the `mksync` row.
- Roadmap: phase 2 marked done with the date.

### 10. Real run on Windows `[inline: manual, on Windows]`

After W0-W6 in `TODO.md` pass, on the Windows machine with the branch pushed:

```powershell
$env:SYNCSETTINGS_DIR = "$env:TEMP\ss-try"; $env:SYNCSETTINGS_REF = 'feat/easy-install-windows'
$env:SYNCSETTINGS_NO_SETUP = '1'
irm https://raw.githubusercontent.com/makubexD/SyncSettings/feat/easy-install-windows/install.ps1 | iex
mksync doctor
```

| Check | Expected |
|---|---|
| Install | `Cloned into`, the PATH line, `Installed.` |
| Same line again | `Updated` |
| `mksync doctor` | No `MISSING` line |
| `mksync` in the real clone | Exit 0, `Origin` up to date |

This can't run from the Linux machine. If the plan finishes before it runs, the finish moves this table into `TODO.md`
under the W-checks and says so in the PR.
