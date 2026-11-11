# Design: one engine with modules, profiles and layers

Phase 3 of `docs/plan-single-engine.md`. This file turns the decisions of 2026-11-10 into rules, worked examples and
file shapes. No TypeScript is written before the user approves it. Anything not decided here is in "Open".

## Statusline and hooks on Windows

Today the Claude settings are synced on Linux only (`dotfiles/linux/claude/`). `settings.json` points the statusline at
`<HOME>/.claude/statusline.sh` and every hook at a bash script under `<HOME>/.claude/hooks/`. The statusline reads its
input with one `jq` call and runs `git` for the branch and changes. The repo's history has no Windows `settings.json`
for Claude, so the Windows side comes from the documentation only.

What Claude Code's documentation says:

- **Statusline shell.** "On Windows, Claude Code runs status line commands through Git Bash when Git Bash is installed,
  or through PowerShell when Git Bash is absent."
  ([statusline, Windows configuration](https://code.claude.com/docs/en/statusline#windows-configuration))
- **Hook shell.** A hook's `command` goes to "`sh -c` on macOS and Linux, Git Bash on Windows, or PowerShell when Git
  Bash isn't installed". A hook can pin it with `"shell": "bash"` or `"shell": "powershell"`. With `args` set, the
  hook runs a program directly, with no shell, and on Windows the program must be a real `.exe`.
  ([hooks](https://code.claude.com/docs/en/hooks))
- **Home paths.** In the statusline command, "the `~` shorthand also works and expands to your Windows home
  directory". Backslashes are eaten by Git Bash, so paths use forward slashes (`C:/Users/…`). `$HOME` isn't mentioned
  for Windows: Git Bash sets it, PowerShell has `$HOME` as its own variable, so it works in both, but untested.
  Hooks get `${CLAUDE_PROJECT_DIR}` from Claude Code on every OS.
- **Which tools exist.** Without Git for Windows, Claude Code has no Bash at all and uses its PowerShell tool
  ([setup](https://code.claude.com/docs/en/setup)). So a machine without Git Bash can't run `statusline.sh` or any of
  the bash hooks, and the documentation doesn't promise `jq` anywhere.

Example: on Windows work #1 with Git for Windows but no `jq`, a shared `statusline.sh` starts under Git Bash, the `jq`
call fails, and the bar shows the fallback text or nothing. On work #2 without Git for Windows, PowerShell gets
`~/.claude/statusline.sh` and can't run it at all.

The two options:

| | One shared `statusline.sh` | `mksync statusline` |
|---|---|---|
| Needs on Windows | Git Bash and `jq` | the `mksync` program, already installed by the restore |
| Runs under | Git Bash only | Git Bash or PowerShell: the command is a program name, the same in both |
| Code | one bash file, as today | one TypeScript command, tested by the shared cases |
| Start-up on Windows | Git Bash, then `jq` and `git`; not measured | about 57 ms (Bun, `docs/single-engine-research.md` section 3), plus `git` |
| Change by hand | edit the file, see it on the next refresh | edit the source and rebuild, or wait for a release |

Decision: the statusline becomes `mksync statusline`, on every OS. The work machines may have neither Git Bash nor
`jq`, and the subcommand needs only the program the restore already installs, under whichever shell Claude Code picks.
It is written once, in the same language as the engine, and the shared cases test its output. The cost is hand
tweaks: they go through the source. A machine that wants its own bar keeps a machine-layer `statusLine` override in
`settings.json`, as any other setting.

Example: on personal Linux, `settings.json` says `"command": "mksync statusline"`; the Linux bar looks the same as
today's `statusline.sh`. On Windows work #1 to #3 the same line works under Git Bash or PowerShell, with no `jq`.

Hooks stay scripts. The Linux hooks (`metrics-capture.sh` and others, under `dotfiles/linux/claude/hooks/`) are synced
files like any other, not engine code, so they don't move into `mksync`. On Windows a bash hook needs Git Bash, or a
`"shell": "powershell"` twin. Which hooks the work machines need goes in "Open".

## Open

### Confirm on Windows

- **Shell.** Which shell Claude Code uses for the statusline and hooks on each work machine: Git Bash or PowerShell.
  (`claude doctor`, or a hook that prints `$0`.) The docs say Git Bash when Git for Windows is installed.
- **Git Bash and `jq`.** Whether Git for Windows (with Git Bash) and `jq` are installed on work #1 to #3, and whether
  `CLAUDE_CODE_GIT_BASH_PATH` is set anywhere.
- **Current layout.** The current Windows statusline (`statusLine` in `%USERPROFILE%\.claude\settings.json`, and the
  script it calls), and what else is in `~/.claude` there: hooks, skills, `CLAUDE.md`. Names that point at an employer
  are redacted (`work-tool-1`) before they reach the repo.
- **`$HOME` in commands.** Whether `$HOME/.claude/…` in a hook or statusline command resolves under both Git Bash and
  PowerShell, or only `~` does.
- **Hooks on Windows.** Which of the Linux hooks the work machines need, and whether each gets a PowerShell twin
  (`"shell": "powershell"`) or stays Linux-only.
