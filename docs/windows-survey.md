# Windows survey for phase 7

Phase 7 of `docs/plan-single-engine.md` starts with one look at a real Windows work machine. The answer settles the
design's "Confirm on Windows" list (`docs/design-layers.md`) and the Windows overlay of Claude's `settings.json`.

## How to run it

1. On work machine #1, download the program built by CI: the `mksync-<sha>` artifact of the latest green `ci` run on
   `master` (Actions page, or `gh run download <run id> -n mksync-<sha>`). Unzip it into a new empty folder, for
   example `%USERPROFILE%\Downloads\mksync-survey\`. Only `mksync-windows-x64.exe` is needed.
2. Open Claude Code in that folder and paste the prompt below.
3. Read the answer before it leaves the machine. It should hold names and shapes only. Replace any employer, product,
   person or host name still in it with `work-tool-1`, `work-tool-2`… Then paste it into the phase 7 session (or save
   it under "Answer" at the end of this file and commit it on the `engine/push-pull` branch).

## The prompt

```text
Survey this Windows machine for a settings-sync project. Report names and structure only, never values.

Rules for everything you print:
- Never print a file's contents, a setting's value, a token, an email, a host name or a user name.
- Write my Windows user name as USER, and any company, product or person name as work-tool-1, work-tool-2...
- Paths: write the home folder as ~ and use forward slashes.
- Run read-only commands only. Change nothing, install nothing, write no file outside this folder.
- If a check can't run, write "unknown: <why>" for it and go on.

Checks:
1. ~/.claude tree: every file and folder name, 3 levels deep, folders marked with a trailing /. Skip the contents of
   projects/, todos/, shell-snapshots/, statsig/, debug/ and file-history/ (name them only).
2. ~/.claude/settings.json: every key 2 levels deep, each with its JSON type (string, number, boolean, array of N,
   object). For hooks: each event name, and per hook its type, whether it sets "shell", and the command's first word
   (the program, e.g. bash, powershell, node) with any path shortened to its file name.
3. statusLine: its "type", the program its command starts (file name only), and the script it calls (file name and
   extension only). Is that script also in ~/.claude?
4. ~/.claude/CLAUDE.md: does it exist, how many lines, and every line starting with @ (file names only).
5. Shell: which shell runs this session's Bash tool, and which shell Claude Code uses for hooks and the statusline.
   Show how you know (e.g. `echo $0`, `$PSVersionTable.PSVersion`, `claude doctor`).
6. Tools: is Git for Windows installed (git --version, and where Git Bash is: path shortened), is jq on PATH
   (jq --version), is CLAUDE_CODE_GIT_BASH_PATH set (yes/no only), PowerShell versions available (5.1, 7).
7. Home in commands: under Git Bash, do `ls $HOME/.claude` and `ls ~/.claude` list the same folder (yes/no each)?
   Under PowerShell (`powershell -NoProfile -Command ...`), the same for `$HOME/.claude` and `~/.claude`.
8. The program: run `.\mksync-windows-x64.exe --version` in this folder. Report the line it printed, or the exact
   error text, and whether a SmartScreen prompt, antivirus alert or policy block showed (ask me if you can't tell).
9. Domain: is USERDNSDOMAIN set (yes/no only)?

Answer in one fenced block with exactly these headings, in this order, nothing outside the block:
## 1 tree
## 2 settings keys
## 3 statusline
## 4 CLAUDE.md
## 5 shell
## 6 tools
## 7 home
## 8 program
## 9 domain
```

## Answer

Run on work machine #1, 2026-11-16, redacted by the user and checked again before commit. Check 8 was replaced: the
user chose not to download the program to a work machine without asking IT first, so check 8 asked which runtimes are
installed instead (`node`, `npm`, `bun`, `winget`, versions or "not found"). Whether the unsigned program runs stays
open for phase 9's real-Windows checklist.

```text
## 1 tree
~/.claude/  (821 entries; machine-generated ID names collapsed to <uuid>/<hex>/<num>/<slug> with counts)
.credentials.json
.last-cleanup
.last-update-result.json
.oauth_refresh.lock.owner.tmp.<hex>
CLAUDE.md
WORK-TOOL-3.md
WORK-TOOL-3.md.bak
STATUSLINE_GUIDE.md
history.jsonl
remote-settings-consent.json
settings.json
settings.json.bak
stats-cache.json
statusline-simple.sh
statusline.ps1
statusline_BACK.ps1
statusline_BACK_OLD.ps1
test-statusline.sh
backups/
  .claude.json.backup.<num>  (x5)
cache/
  changelog.md
  my-closed-issues.json
  model-catalog/
    <uuid>-<hex>-cc.json  (x3)
    published-floor.json
chrome/
  chrome-native-host.bat
work-tool-1/
  heal-partial-install.log
  content/
    <hex>.db  (x2)
  sessions/
    <hex>.db  (x35)
    <hex>.db-shm  (x35)
    <hex>.db-wal  (x35)
    <hex>-events.md  (x1)
    stats-pid-<num>.json  (the remaining ~260 entries)
daemon/
  control.key
  pipe.key
  attach-journal/
    <uuid>.json  (x1)
  dispatch/
  pty-pids/
debug/            (contents skipped)
downloads/        (empty)
feedback/         (empty)
file-history/     (contents skipped)
hooks/
  work-tool-1-cache-heal.mjs
ide/              (empty)
jobs/
  pins.json
paste-cache/
  <hex>.txt  (x9)
plans/
  <slug>.md  (x11)
plugins/
  .last_inuse_sweep
  blocklist.json
  installed_plugins.json
  known_marketplaces.json
  plugin-catalog-cache.json
  plugin-directory-cache-v2.json
  .trash/
    <num>-<num>-<id>/
  cache/
    work-tool-2/
    claude-plugins-official/
    work-tool-1/
  data/
    work-tool-1-work-tool-1/
    csharp-lsp-claude-plugins-official/
    typescript-lsp-claude-plugins-official/
  marketplaces/
    work-tool-2/
    claude-plugins-official/
    work-tool-1/
  store/
    cc-plugin-diff_builtin-<hex>.json
  synced/
    .bucket-<uuid>_<uuid>  (x3, files)
    <uuid>_<uuid>/  (x3)
projects/         (contents skipped)
scripts/          (empty)
session-env/
  <uuid>/  (x324, all empty at this depth)
sessions/
  <num>.<hex>.key
  <num>.json
shell-snapshots/  (contents skipped)
skills/
  work-tool-4            (link, not a plain folder)
  audit-agent-instructions  (link)
  find-skills            (link)
  .trash/
    <num>-<num>-<id>/
  synced/
    .bucket-<uuid>_<uuid>  (x3, files)
    <uuid>_<uuid>/  (x3)
state/            (empty)
todos/            not present
statsig/          not present

## 2 settings keys
hooks : object
  hooks.PreToolUse : array of 1
  hooks.SessionStart : array of 1
statusLine : object
  statusLine.type : string
  statusLine.command : string
enabledPlugins : object
  enabledPlugins.work-tool-1@work-tool-1 : boolean
  enabledPlugins.agent-skills@work-tool-2 : boolean
extraKnownMarketplaces : object
  extraKnownMarketplaces.work-tool-1 : object
  extraKnownMarketplaces.work-tool-2 : object
effortLevel : string
modelSettings : object
  modelSettings.claude-opus-5-5 : object
autoUpdatesChannel : string
tui : string
inputNeededNotifEnabled : boolean
agentPushNotifEnabled : boolean
autoMode : object
  autoMode.environment : array of 25
model : string

hooks:
  PreToolUse   - 1 group (has matcher), 1 hook: type=command, sets "shell": no, program: unknown: not reported
  SessionStart - 1 group (no matcher),  1 hook: type=command, sets "shell": no, program: node.exe

## 3 statusline
type: command
program: powershell.exe
script: statusline.ps1
script also in ~/.claude: yes (top level, ~/.claude/statusline.ps1; the command refers to the .claude folder)

## 4 CLAUDE.md
exists: yes
lines: 69
@ lines: 1
  @WORK-TOOL-3.md

## 5 shell
Bash tool: Git Bash (MSYS2 bash 5.2.37, MINGW64)
  how: `echo $0` -> /usr/bin/bash; $BASH_VERSION -> 5.2.37(1)-release; $OSTYPE -> msys; $MSYSTEM -> MINGW64; SHELL -> bash.exe
PowerShell tool: PowerShell 7.6.9 (Core)
  how: $PSVersionTable.PSVersion
Hooks: Git Bash (inferred) - neither hook sets "shell", so Claude Code's default shell for hook commands applies
Statusline: command is started by the same default shell and itself launches powershell.exe (Windows PowerShell 5.1)
claude doctor: unknown: interactive screen, not run in this non-interactive session (claude --version -> 2.1.325)

## 6 tools
Git for Windows: yes - git version 2.50.1.windows.1
Git Bash: C:/Program Files/Git/usr/bin/bash.exe
  (also on PATH: System32/bash.exe and ~/AppData/Local/Microsoft/WindowsApps/bash.exe)
jq: yes - jq-1.6
CLAUDE_CODE_GIT_BASH_PATH set: no
PowerShell 5.1: yes (5.1.26100.9711)
PowerShell 7: yes (7.6.9)

## 7 home
Git Bash  `ls $HOME/.claude`: yes
Git Bash  `ls ~/.claude`: yes
PowerShell 5.1 (-NoProfile)  `$HOME/.claude`: yes
PowerShell 5.1 (-NoProfile)  `~/.claude`: yes
PowerShell 7: unknown: not tested separately

## 8 runtimes
node: v26.13.0
npm: 11.20.0
bun: 1.3.14
winget: v1.29.380

## 9 domain
USERDNSDOMAIN set: yes
```
