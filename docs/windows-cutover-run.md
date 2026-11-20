# Windows run sheet for the cut-over

Part 1 of `docs/plan-single-engine-9-cutover.md` ends with one run on a real Windows work machine. The answer settles
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

## Answer
