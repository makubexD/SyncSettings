# Windows run sheet for the cut-over

Part 1 of `docs/archive/plan-single-engine-9-cutover.md` ends with one run on a real Windows work machine. The answer settles
the design's real-Windows checklist (`docs/design-layers.md`, "Tests") for work machines. It runs on work #1 first;
work #2 and #3 run the same sheet when you're at them.

**Work machines run `mksync` from the clone,** never the downloaded `mksync.exe`: no program is downloaded, IT isn't
asked, and no unsigned `.exe` lands on a work machine. The clone's launcher runs the same TypeScript source as the
release program with the Node already there, and the installer puts a small `mksync.cmd` on the user `Path`, so
`mksync` works from any PowerShell or cmd window. The only differences: start-up is slower, and `mksync update` says
to use `git pull` instead.

## What it changes on the machine

- `%USERPROFILE%\SyncSettings`: `git pull` (the clone must be on `master` with no changed files; the check stops and
  says so otherwise).
- `%LOCALAPPDATA%\mksync\mksync.cmd`: a 4-line file that calls the clone's launcher, and that folder added to the user
  `Path`. The old launcher `%LOCALAPPDATA%\SyncSettings\bin\mksync.cmd` is removed if it's there.
- `Downloads\mksync-check.txt`: the report.

Nothing else. It never runs `mksync pull`, `push`, `setup` or `export`, installs nothing, and changes no setting.

## Steps

1. On work #1, open **Windows PowerShell** from the Start menu (a normal window, not as administrator).
2. Paste this line and press Enter:

   ```powershell
   irm https://raw.githubusercontent.com/makubexD/SyncSettings/engine/cutover/tools/windows-cutover-check.ps1 | iex
   ```

3. If it prints **STOP**, do what the **Fix** line under it says, then paste the same line again. The checks before
   anything changes: PowerShell 5.1, `git`, Node 22.18 or newer, the clone at `%USERPROFILE%\SyncSettings` (a git
   clone of `makubexD/SyncSettings`, on `master`, no changed files), and no `mksync.exe` in `%LOCALAPPDATA%\mksync`.
4. If it says the installer will ask `Install gh with winget? [Y/n]`, type `n` and press Enter when it asks. That is
   the only question.
5. Wait for **Done.** (about a minute; `mksync shadow` is the slowest part).
6. Open `Downloads\mksync-check.txt` (it is also on the clipboard). User, host, domain and email are already replaced
   with `USER`, `HOST`, `DOMAIN` and `<email>`. Replace any company, product or person name still in it with
   `work-tool-1`, `work-tool-2`…
7. Back here, run `/next` and paste the report.

Afterwards `mksync` works from any **new** PowerShell or cmd window.

## What the report holds

| Section            | What it shows                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| `## 0 before`      | PowerShell, language mode, git, Node, the clone's branch, whether `gh` is there                       |
| `## 1 install`     | the installer's result and `mksync --version`                                                         |
| `## 2 location`    | `mksync.cmd` in `%LOCALAPPDATA%\mksync`, no `mksync.exe`, the folder on the user `Path`, old one gone |
| `## 3 git bash`    | `$HOME` and `~` in Git Bash (the shell Claude Code uses for hooks), and `mksync` from Git Bash        |
| `## 4 home`        | `~` and `$HOME` in PowerShell, `jq`                                                                   |
| `## 5 statusline`  | `mksync statusline` on a sample payload                                                               |
| `## 6 local state` | who can read `.user-values.json`                                                                      |
| `## 7 status`      | `mksync status`, `doctor` and `check` (check exits 3 when the repo has changes to pull: expected)     |
| `## 8 shadow`      | `mksync shadow`: the program against the old engine                                                   |
| `## 9 update`      | `mksync update`: from the clone it says to use `git pull`, exit 2 (expected)                          |
| `## 10 bun`        | Bun's version and the launcher with `MKSYNC_RUNTIME=bun`, if Bun is installed                         |

## Tried in the local Windows VM

2026-11-18, on a fresh clone with Node 22.18 and a dummy `gh`: every section ran. As expected, `check` exited 3 and
`update` exited 2. `mksync` is not found from Git Bash, only `mksync.cmd` is (design, "Open"). The VM's shadow lines
come from a machine that was never set up, so only work #1's count.

## What it doesn't cover

- **The downloaded program** (checklist items 1, 8 and 9 for `mksync.exe`): work machines don't run it. The release
  program is checked on personal Linux, in CI on Windows and macOS, and in the local Windows VM.
- **The synced statusline.** `settings.json` still calls `statusline.sh` until part 2, so section 5 runs the launcher
  by hand with a sample payload.

## Work #2 and #3: the extra checks

The repo is going private (phase 10), so on work #2 and #3 the install goes through a signed-in GitHub CLI. In
**Windows PowerShell**, as your own user:

```powershell
winget install --id GitHub.cli -e
# open a new PowerShell window, then:
gh auth login
$env:SYNCSETTINGS_RUNTIME = 'node'; $env:SYNCSETTINGS_NO_SETUP = '1'
gh api -H 'Accept: application/vnd.github.raw' repos/makubexD/SyncSettings/contents/install.ps1 | Out-String | iex
```

`SYNCSETTINGS_NO_SETUP` keeps setup for later, so check 6 runs on a machine with no record. In a new window, run the
check itself through `gh` too (step 2's `engine/cutover` branch is gone; its section 8 still runs `mksync shadow`,
removed at the cut-over, and prints the usage text with exit 2):

```powershell
gh api -H 'Accept: application/vnd.github.raw' repos/makubexD/SyncSettings/contents/tools/windows-cutover-check.ps1 | Out-String | iex
```

Then run the checks below, one at a time, **from the clone** (`Set-Location "$env:USERPROFILE\SyncSettings"`): every
command but `statusline` looks for the repo in the working folder. Each changes nothing on the machine; check 3 adds a
file to the clone and removes it again. Paste what each prints under its number
in the answer block, with names replaced as in step 6.

1. **Unset `USERPROFILE`.** Should `mksync` stop when it can't tell where home is?

   ```powershell
   $u = $env:USERPROFILE; Remove-Item Env:USERPROFILE; mksync check; "exit $LASTEXITCODE"; $env:USERPROFILE = $u
   ```

   Paste: the first five lines and the `exit` line.

2. **Who can read the values file.**

   ```powershell
   icacls "$env:USERPROFILE\SyncSettings\.user-values.json"
   ```

   Paste: the whole output (a missing file prints an error; paste that).

3. **Command lookup in the repo folder.** Does `mksync` run a `git.exe` that sits in the clone, before the one on
   `PATH`?

   ```powershell
   Copy-Item "$env:WINDIR\System32\whoami.exe" "$env:USERPROFILE\SyncSettings\git.exe"
   mksync status; "exit $LASTEXITCODE"
   Remove-Item "$env:USERPROFILE\SyncSettings\git.exe"
   ```

   Paste: the status output and the `exit` line (a `whoami`-style line or a git error means the clone's file ran).
   From `v1.1.4` the status output must be the same as without the file.

4. **WSL's `bash` before Git Bash.**

   ```powershell
   Get-Command bash -All -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source; mksync doctor
   ```

   Paste: the list of `bash` paths in order, and the doctor's `bash` line.

5. **The OS caption's code page.** Does the status's OS line match Windows's own caption, accents included?

   ```powershell
   (Get-CimInstance Win32_OperatingSystem).Caption; [Console]::OutputEncoding.CodePage; mksync status
   ```

   Paste: the caption, the code page number, and the status's OS line.

6. **Setup with no terminal.** On a machine with no record, first with no flags, then with every flag so only the
   confirm reads end of input:

   ```powershell
   cmd /c "mksync setup < NUL"; "exit $LASTEXITCODE"
   cmd /c "mksync setup --profile eof-test --claude claude --mode push --existing keep < NUL"; "exit $LASTEXITCODE"
   Test-Path "$env:USERPROFILE\SyncSettings\.user-values.json"
   ```

   Paste: the last lines of each and the `Test-Path` answer (`ERROR: missing --profile`, exit 2; then
   `Stopped: nothing was written.`, exit 0; `False`).

## Answer

### Work #1: extra checks

Run 2026-11-26 on `mksync 1.1.3` (downloaded `mksync.exe`), PowerShell 7.6, from the clone (not in the home folder).

1. `ERROR: the home folder is not set (USERPROFILE).`, `exit 1`. The program stops; nothing is written.
2. `icacls` lists one entry, `DOMAIN\USER:(F)`: no inherited access.
3. **The clone's `git.exe` ran.** `mksync status` printed `Origin : not a git clone` and `Unsent : not checked`,
   `exit 0`: the lookup searched the working folder (the clone) before `PATH`.
4. `bash` on `PATH`, in order: `C:\Windows\system32\bash.exe` (WSL), `C:\Program Files\Git\bin\bash.exe`,
   `…\WindowsApps\bash.exe`. `doctor` reads `OK bash`: the program finds Git Bash from `git`, not WSL's first entry.
5. Caption `Microsoft Windows 11 Enterprise`, code page `437`, status `windows (Microsoft Windows 11 Enterprise)`:
   they match (an English caption, no accents to garble).
6. `cmd /c "mksync setup < NUL"` printed the doctor block, then
   `ERROR: this machine is already HOST; use --replace to take over another record.`, `exit 1`, as the contract says
   for a machine with a record. The no-terminal path wasn't reached; it is checked on work #2, which has no record.

### Work #2: extra checks

Run 2026-11-26 on `mksync 1.1.4` from the clone launcher (Node 25.9.0), Windows PowerShell 5.1, from the clone. The
report's sections are in `docs/design-layers.md` ("Real-machine results").

1. `ERROR: the home folder is not set (USERPROFILE).`, `exit 1`.
2. No `.user-values.json` before setup (`icacls`: the file can't be found); checked again at step 9.
3. **The fix holds.** With `whoami.exe` copied to the clone as `git.exe`, `mksync status` printed the same as without
   it (`Origin : up to date`, `Unsent : none`), `exit 0`.
4. No `bash` on `PATH` at all; `git` is `C:\Program Files\Git\cmd\git.exe`, `winget` is
   `~\AppData\Local\Microsoft\WindowsApps\winget.exe`. `doctor` reads
   `WARN bash: needed by the leak scan; install Git for Windows from https://git-scm.com`: it misses both Git Bash
   (found from `git` by the leak scan) and winget (design, "Open", "The doctor's bash and winget lookups").
5. Caption `Microsoft Windows 11 Enterprise`, code page `437`, status `windows (Microsoft Windows 11 Enterprise)`:
   they match.
6. No flags: the doctor block and the scan, then `ERROR: missing --profile`, `exit 2`. Every flag: the summary and
   `Same as:` line, then `Write the record and apply? [Y/n] Stopped: nothing was written.`, `exit 0`. No values file
   either time (`False`).

### Work #3: extra checks

1. (unset `USERPROFILE`)
2. (values file access)
3. (command lookup in the repo folder)
4. (WSL's `bash`)
5. (the OS caption)
