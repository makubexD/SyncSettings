# Windows run sheet for the cut-over

Part 1 of `docs/plan-single-engine-9-cutover.md` ends with one run on a real Windows work machine. The answer settles
the design's real-Windows checklist (`docs/design-layers.md`, "Tests") for work machines. It runs on work #1 first;
work #2 and #3 run the same sheet when you're at them.

**Work machines run `mksync` from the clone,** never the downloaded `mksync.exe`: nothing new is downloaded or
installed, IT isn't asked, and no unsigned program lands on a work machine. The clone's launcher runs the same
TypeScript source as the release program with the Node already there, and the installer puts a small `mksync.cmd` on
the user `Path`, so `mksync` works from any terminal as the program would. The only differences: start-up is slower,
and `mksync update` says to use `git pull` instead.

## Before you start

1. **Keep the clone you have.** The run updates `%USERPROFILE%\SyncSettings` with `git pull` (through the installer)
   and changes nothing else in it. Nothing is pulled into your settings or pushed: `mksync check` is the only sync
   command it runs, and it writes nothing.
2. Open Claude Code in an empty folder, for example `%USERPROFILE%\Downloads\mksync-run\`, and paste the prompt below.
3. Read the answer before it leaves the machine. It should hold versions, yes/no and short messages only. Replace any
   employer, product, person or host name still in it with `work-tool-1`, `work-tool-2`… Then paste it into the
   cut-over session (plan step 8).

## The prompt

```text
Run a checklist for a settings-sync tool on this Windows machine and report the results.

Rules for everything you print:
- Never print a file's contents, a setting's value, a token, an email, a host name or a user name.
- Write my Windows user name as USER, and any company, product or person name as work-tool-1, work-tool-2...
- Paths: C:\Users\USER\... at most; shorten anything else to its file name.
- Change nothing outside what each item says. Never run `mksync pull`, `mksync push`, `mksync setup` or
  `mksync export`, and never download or install anything except through item 1.
- If an item can't run, write "unknown: <why>" for it and go on. Never retry another way than written.
- PowerShell commands run as `powershell -NoProfile -Command "..."` unless the item says otherwise.

Items:
1. Install from the clone: `node --version`. Then, in one PowerShell session with SYNCSETTINGS_RUNTIME=node and
   SYNCSETTINGS_NO_SETUP=1 set, run
   `irm https://raw.githubusercontent.com/makubexD/SyncSettings/master/install.ps1 | iex`. Report its last 3 lines.
   Then, in a new PowerShell window (ask me to open it if you can't), `mksync --version`: the line it printed or the
   exact error.
2. Install location: is %LOCALAPPDATA%\mksync\mksync.cmd there (yes/no), is there no mksync.exe in that folder
   (yes/no), is %LOCALAPPDATA%\mksync on the user Path (`[Environment]::GetEnvironmentVariable('Path','User')`,
   yes/no only), and is %LOCALAPPDATA%\SyncSettings\bin\mksync.cmd gone (yes/no)?
3. Shells: which shell runs your Bash tool, and which shell Claude Code uses for hooks and the statusLine command
   (show how you know). Does `mksync --version` also work from your Bash tool (yes/no, or the error)?
4. Home in commands: through your Bash tool, `echo ~` and `echo $HOME`; through PowerShell, `echo ~` and
   `echo $HOME`. For each, does it name C:\Users\USER (yes/no)? Is it the same folder for both shells?
5. Tools: `git --version`; where Git Bash is (path shortened); `jq --version`, or "not on PATH".
6. Statusline: `Get-Content "$env:USERPROFILE\SyncSettings\tools\statusline-payloads\full.json" -Raw |
   mksync statusline`. Report: exit code, number of lines printed, the text with the color codes removed and the
   folder shortened to its last name.
7. Local state: `icacls "$env:USERPROFILE\SyncSettings\.user-values.json"`. Report each grant as <who>:<rights>, with
   my account written as USER. Is USER the only account with access (yes/no)? If the file doesn't exist, say so.
8. Status: in %USERPROFILE%\SyncSettings, `mksync status`, `mksync doctor` and `mksync check`. Report each command's
   exit code and every line, redacted.
9. Shadow: in %USERPROFILE%\SyncSettings, `mksync shadow`. Report the exit code and every line it printed, redacted.
   It writes nothing in the repo or home.
10. Update: `mksync update`. Report the line it printed and the exit code.
11. Bun: `bun --version`, or "not installed". If installed, in %USERPROFILE%\SyncSettings with MKSYNC_RUNTIME=bun set,
    `.\mksync.cmd --version`: the line it printed or the exact error.

Answer in one fenced block with exactly these headings, in this order, nothing outside the block:
## 1 install
## 2 location
## 3 shells
## 4 home
## 5 tools
## 6 statusline
## 7 local state
## 8 status
## 9 shadow
## 10 update
## 11 bun
```

## What it doesn't cover

- **The downloaded program** (checklist items 1, 8 and 9 for `mksync.exe`): work machines don't run it. The release
  program is checked on personal Linux, in CI on Windows and macOS, and in the local Windows VM.
- **The synced statusline.** `settings.json` still calls `statusline.sh` until part 2, so item 6 runs the launcher by
  hand with a sample payload.

## Answer
