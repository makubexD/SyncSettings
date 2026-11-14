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

Not run yet.
