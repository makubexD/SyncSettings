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

## Catalog

Every entry in `sync-config.json` today, and where it lands. The columns:

- **Module:** the group a profile lists to get the entry (`git`, `shell`, `claude`…). A machine whose record says
  "Claude: none" skips `claude`; only "Claude plus DeepSeek" gets `claude-worker`.
- **Layer:** where the file's content lives. Base is every machine; OS is one OS (or a list); profile is one profile;
  machine is one machine record. Values (`<YOUR_EMAIL>`, `<HOME>`) are in "Values" in the last column, not a layer
  of their own: an account belongs to the profile, a path to the machine.
- **Receives:** which machines end up with the file today, when their profile lists the module.
- **Merge:** how the layers combine. "Whole file" means one layer owns the file (values still hydrate). "JSON" merges
  keys, later layers win. "`@import`" keeps one file per layer and the base file imports the others. "dconf" loads
  only the listed keys. "Dir" syncs a folder entry by entry.

| Entry | Module | Layer | Receives | Merge | Values |
|---|---|---|---|---|---|
| `dotfiles/common/git/.gitconfig` | `git` | base | all | whole file | `<YOUR_NAME>`, `<YOUR_EMAIL>`: profile |
| `dotfiles/common/git/ignore` | `git` | base | all | whole file | |
| `dotfiles/windows/git/.gitconfig.local` | `git` | OS (Windows) | Windows | whole file | `<YOUR_GH_USERNAME>`, `<YOUR_GH_ORG>`: profile; `<GH_CLI_PATH>`: machine |
| `dotfiles/linux/git/.gitconfig.local` | `git` | OS (Linux) | Linux | whole file | |
| `dotfiles/macos/git/.gitconfig.local` | `git` | OS (macOS) | macOS | whole file | |
| `dotfiles/macos/shell/.zshrc` | `shell` | OS (macOS) | macOS | whole file | |
| `dotfiles/macos/shell/.zprofile` | `shell` | OS (macOS) | macOS | whole file | |
| `dotfiles/windows/shell/.bashrc` | `shell` | OS (Windows) | Windows | whole file | linked folders: machine (see Open) |
| `dotfiles/windows/shell/.bash_profile` | `shell` | OS (Windows) | Windows | whole file | |
| `dotfiles/linux/shell/.bashrc` | `shell` | OS (Linux) | Linux | whole file | |
| `dotfiles/linux/shell/.profile` | `shell` | OS (Linux) | Linux | whole file | |
| `dotfiles/common/tmux/.tmux.conf` | `tmux` | OS (Linux, macOS) | Linux, macOS | whole file | |
| `dotfiles/common/starship/starship.toml` | `starship` | OS (Linux, macOS) | Linux, macOS | whole file | |
| `dotfiles/common/wezterm/wezterm.lua` | `wezterm` | OS (Linux, macOS) | Linux, macOS | whole file | |
| `dotfiles/common/htop/htoprc` | `htop` | OS (Linux, macOS) | Linux, macOS | whole file | |
| `dotfiles/common/gh/config.yml` | `gh` | OS (Linux, macOS) | Linux, macOS | whole file | |
| `dotfiles/linux/rtk` | `rtk` | OS (Linux) | Linux | dir | |
| `dotfiles/linux/gnome/mimeapps.list` | `gnome` | OS (Linux) | Linux | whole file | |
| `dotfiles/linux/gnome/bookmarks` | `gnome` | OS (Linux) | Linux | whole file | `<HOME>`: machine |
| `dotfiles/linux/gnome/applications/disco-datos.desktop` | `gnome` | machine (see Open) | personal Linux | whole file | |
| `dotfiles/linux/gnome/applications/mis-discos.desktop` | `gnome` | machine (see Open) | personal Linux | whole file | |
| `dotfiles/linux/wezterm/wezterm-xwayland` | `wezterm` | OS (Linux) | Linux | whole file | |
| `dotfiles/linux/wezterm/wezterm-xwayland.desktop` | `wezterm` | OS (Linux) | Linux | whole file | `<HOME>`: machine |
| `dotfiles/common/vscode/settings.json` | `vscode` | base | Linux, macOS (Windows: see Open) | JSON | `<HOME>`: machine; `<YOUR_WORK_MARKETPLACE>`: profile |
| `dotfiles/common/vscode/snippets` | `vscode` | base | Linux, macOS (Windows: see Open) | dir | |
| `dotfiles/windows/windows-terminal/settings.json` | `windows-terminal` | OS (Windows) | Windows | whole file | |
| `dotfiles/common/claude/CLAUDE.md` | `claude` | base, profile adds one | Linux, macOS; Windows in phase 7 | `@import` | |
| `dotfiles/common/claude/RTK.md` | `claude` | base | all with Claude | whole file | |
| `dotfiles/linux/claude/settings.json` | `claude` | base, OS overlay | Linux | JSON | `<HOME>`: machine; `<YOUR_GH_USERNAME>`: profile |
| `dotfiles/linux/claude/statusline.sh` | `claude` | none: replaced by `mksync statusline` | Linux until cut-over | whole file | |
| `dotfiles/common/claude/sampleGrok.md` | `claude` | none (see Open) | Linux, macOS | whole file | |
| `dotfiles/linux/claude/hooks` | `claude` | OS (Linux) | Linux | dir | |
| `dotfiles/linux/claude/skills/mk-delegate` | `claude-worker` | OS (Linux) | Linux with DeepSeek | dir | |
| `dotfiles/linux/claude/skills/mk-check` | `claude-worker` | OS (Linux) | Linux with DeepSeek | dir | |
| `dotfiles/common/claude/docs/token-routing-map.html` | `claude` | base | all with Claude | whole file | |
| `dotfiles/linux/claude/bin/mk-exec` | `claude-worker` | OS (Linux) | Linux with DeepSeek | whole file | |
| `dotfiles/linux/claude/bin/workflow-report` | `claude-worker` | OS (Linux) | Linux with DeepSeek | whole file | |
| `dotfiles/linux/claude/bin/metrics-archive` | `claude` | OS (Linux) | Linux | whole file | |
| `dotfiles/linux/claude-worker/CLAUDE.md` | `claude-worker` | OS (Linux) | Linux with DeepSeek | whole file | |
| `dotfiles/linux/claude-worker/settings.json` | `claude-worker` | OS (Linux) | Linux with DeepSeek | JSON | |
| `dotfiles/linux/claude/bin/worker-mode` | `claude-worker` | OS (Linux) | Linux with DeepSeek | whole file | |
| `dotfiles/linux/gnome/dconf/interface.ini` | `gnome` | OS (Linux) | Linux | dconf | |
| `dotfiles/linux/gnome/dconf/input-sources.ini` | `gnome` | OS (Linux) | Linux | dconf | |
| `dotfiles/linux/gnome/dconf/wm-keybindings.ini` | `gnome` | OS (Linux) | Linux | dconf | |
| `dotfiles/linux/gnome/dconf/privacy.ini` | `gnome` | OS (Linux) | Linux | dconf | |
| `dotfiles/linux/gnome/dconf/session.ini` | `gnome` | OS (Linux) | Linux | dconf | |
| `dotfiles/linux/gnome/dconf/power.ini` | `gnome` | OS (Linux) | Linux | dconf | |
| `dotfiles/linux/gnome/dconf/shell.ini` | `gnome` | OS (Linux) | Linux | dconf | |
| `dotfiles/linux/gnome/dconf/ptyxis.ini` | `gnome` | OS (Linux) | Linux | dconf | |
| `dotfiles/linux/gnome/dconf/nautilus.ini` | `gnome` | OS (Linux) | Linux | dconf | |
| `dotfiles/linux/gnome/dconf/file-chooser.ini` | `gnome` | OS (Linux) | Linux | dconf | |
| Windows Claude settings (expected) | `claude` | OS (Windows) overlay on the base | Windows; confirm in phase 7 | JSON | `<HOME>`: machine |
| Windows statusline (expected) | `claude` | none: `mksync statusline` | Windows; confirm in phase 7 | (no file) | |
| Windows `CLAUDE.md` (expected) | `claude` | base, work profile adds one | Windows; confirm in phase 7 | `@import` | |

Example, a base file with a value per profile: `dotfiles/common/vscode/settings.json` lists three Copilot plugin
marketplaces, the last one `<YOUR_WORK_MARKETPLACE>`. The file is base: the same on every machine with the `vscode`
module. The value is per profile: work #1's profile holds `https://marketplace.example.com/work-1`, work #2's holds its
own. Pull on work #1 writes the file with work #1's address; push turns it back into `<YOUR_WORK_MARKETPLACE>`, so
nothing from job #1 reaches job #2. The `personal` profile has no work marketplace, which is the open question below.

## Open

### Design

- **A profile without a value.** `personal` has no `<YOUR_WORK_MARKETPLACE>`. Today import stops rather than write a
  placeholder. Options: the profile marks the value "none" and the engine drops that array item; or the entry is split
  into a base JSON and a profile JSON overlay that adds the item. The second fits "JSON" merge, but a JSON array merge
  (append, not replace) needs its own rule.
- **Linux-only or personal-only.** There is one Linux machine and it is personal, so every Linux row could be an OS
  layer or the `personal` profile. The table says OS for tools (they'd suit any Linux machine) and machine for the two
  disk launchers (`disco-datos.desktop`, `mis-discos.desktop`), which name this machine's disks.
- **Tools that could reach Windows.** `tmux`, `starship`, `wezterm`, `htop`, `gh`, `rtk` and VS Code are Linux and macOS
  today. Whether each also belongs on Windows (`gh` and VS Code likely do) is a profile choice for the work machines.
- **`sampleGrok.md`.** An old Windows `CLAUDE.md`, kept for reference. Drop it at cut-over, or keep it as a document
  outside the sync.
- **`.bashrc` linked folders on Windows.** `detectLinkedPaths` becomes `dir` entries at cut-over (roadmap). Whether
  those entries live on the machine record or on the work profile is decided with "Linked folders".
- **`metrics-archive` and the hooks.** They serve the plan workflow, not the DeepSeek worker, so they're in `claude`
  rather than `claude-worker`. Whether the work machines want them is part of "Hooks on Windows".

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
