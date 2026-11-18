# Windows run sheet for the cut-over

Part 1 of `docs/plan-single-engine-9-cutover.md` ends with one run on a real Windows work machine. The answer settles
the design's real-Windows checklist (`docs/design-layers.md`, "Tests"), and with it "The unsigned program" in "Open".
It runs on work #1 first; work #2 and #3 run the same sheet when you're at them.

## Before you start

1. **Ask IT first.** The release program, `mksync.exe`, is an unsigned download from GitHub. If IT says no, or you'd
   rather not wait, say so when the prompt asks: it skips the program items and tries the Node and Bun fallbacks.
   Write down IT's answer in your own words, without names.
2. **Keep the clone you have.** The run updates `%USERPROFILE%\SyncSettings` with `git pull` (through the installer)
   and changes nothing else in it. Nothing is pulled into your settings or pushed: `mksync check` is the only sync
   command it runs, and it writes nothing.
3. Open Claude Code in an empty folder, for example `%USERPROFILE%\Downloads\mksync-run\`, and paste the prompt below.
   Answer its questions (IT, SmartScreen) when it asks.
4. Read the answer before it leaves the machine. It should hold versions, yes/no and short messages only. Replace any
   employer, product, person or host name still in it with `work-tool-1`, `work-tool-2`… Then paste it into the
   cut-over session (plan step 8).

## The prompt

```text
Run a checklist for a settings-sync program on this Windows machine and report the results.

Rules for everything you print:
- Never print a file's contents, a setting's value, a token, an email, a host name or a user name.
- Write my Windows user name as USER, and any company, product or person name as work-tool-1, work-tool-2...
- Paths: C:\Users\USER\... at most; shorten anything else to its file name.
- Change nothing outside what each item says. Never run `mksync pull`, `mksync push`, `mksync setup` or `mksync export`.
- If an item can't run, write "unknown: <why>" for it and go on. Never retry an install another way than written.
- PowerShell commands run as `powershell -NoProfile -Command "..."` unless the item says otherwise.

First ask me: "Did IT allow the downloaded mksync.exe (yes / no / not asked), and what did they say?" If the answer is
no, skip items 1, 7, 8 and 9 (write "skipped: IT") and go on with item 10.

Items:
1. Program: run `irm https://raw.githubusercontent.com/makubexD/SyncSettings/master/install.ps1 | iex` with
   SYNCSETTINGS_NO_SETUP=1 set in the same PowerShell session. Report its last 3 lines. Then, in a new
   PowerShell window (ask me to open it if you can't), `mksync --version`. Report the line it printed or the exact
   error, and ask me whether a SmartScreen prompt, Defender alert or policy block showed.
2. Statusline: which shell runs your Bash tool, and which shell Claude Code uses for hooks and the statusLine command
   (show how you know). Then run `Get-Content "$env:USERPROFILE\SyncSettings\tools\statusline-payloads\full.json"
   -Raw | mksync statusline` and report: exit code, number of lines printed, the text with the color codes removed
   and the folder shortened to its last name.
3. Home in commands: through your Bash tool, `echo ~` and `echo $HOME`; through PowerShell, `echo ~` and
   `echo $HOME`. For each, does it name C:\Users\USER (yes/no)? Is it the same folder for both shells?
4. Tools: `git --version`; where Git Bash is (path shortened); `jq --version`, or "not on PATH".
5. Run-from-clone fallback: only if item 1 was blocked. Otherwise write "not needed".
6. Local state: run `icacls "$env:USERPROFILE\SyncSettings\.user-values.json"`. Report each grant as
   <who>:<rights>, with my account written as USER. Is USER the only account with access (yes/no)? If the file
   doesn't exist, say so.
7. Shadow: in %USERPROFILE%\SyncSettings, `mksync shadow`. Report the exit code and every line it printed, with
   names redacted. It writes nothing in the repo or home.
8. Install location: is mksync.exe in %LOCALAPPDATA%\mksync (yes/no), is %LOCALAPPDATA%\mksync on the user Path
   (`[Environment]::GetEnvironmentVariable('Path','User')`, yes/no only), and is
   %LOCALAPPDATA%\SyncSettings\bin\mksync.cmd gone (yes/no)?
9. Update: `mksync update`. Report the line it printed and the exit code. Is there an mksync.old.exe in
   %LOCALAPPDATA%\mksync (yes/no)?
10. Node fallback: `node --version`. Then run the installer again with SYNCSETTINGS_RUNTIME=node and
    SYNCSETTINGS_NO_SETUP=1 set in the same PowerShell session. In a new PowerShell window: `mksync --version`,
    `mksync status` and, in %USERPROFILE%\SyncSettings, `mksync check`. Report each command's exit code, its first
    line and its last line, redacted.
11. Bun launcher: `bun --version`. Then in %USERPROFILE%\SyncSettings, with MKSYNC_RUNTIME=bun set,
    `.\mksync.cmd --version`. Report the line it printed or the exact error.

Last: if item 1 installed the program, run the installer once more in a new PowerShell session with only
SYNCSETTINGS_NO_SETUP=1 set (no SYNCSETTINGS_RUNTIME), so mksync is the downloaded program again, and report
`mksync --version`. If item 1 was skipped or blocked, leave the Node install from item 10 in place.

Answer in one fenced block with exactly these headings, in this order, nothing outside the block:
## 0 IT
## 1 program
## 2 statusline
## 3 home
## 4 tools
## 5 fallback
## 6 local state
## 7 shadow
## 8 install
## 9 update
## 10 node
## 11 bun
## last
```

## What it doesn't cover

- **The update from an older program** (checklist item 9, second half). Every program with `mksync update` is version
  0.9.0, so there is no older one to put back. It runs when v1.0.0 is out: the v0.9.0 program installed here updates to
  it with `mksync updated: 0.9.0 -> 1.0.0.`, and no `mksync.old.exe` is left after the next start.
- **The research probe** (checklist item 1). Its workflow uploads reports, not the program, so there is nothing to
  download. `mksync.exe` is built by the same compiler (Bun 1.4.4 `--compile`), so item 1 answers the same question.
- **The synced statusline.** `settings.json` still calls `statusline.sh` until part 2, so item 2 runs the program by
  hand with a sample payload.

## Answer
