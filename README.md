# SyncSettings

Keeps dotfiles and app settings the same on Linux, macOS and Windows machines. The files live in this git repo, every
change arrives as a pull request, and nothing reaches `master` until the PR is reviewed and merged.

## Install

Linux and macOS, in a terminal. On macOS 13 or newer, install [Homebrew](https://brew.sh) first; the installer then asks to
run `brew install bash jq`.

```bash
curl -fsSL https://raw.githubusercontent.com/makubexD/SyncSettings/master/install.sh | bash
```

Windows, in PowerShell (the 5.1 that comes with Windows is enough):

```powershell
irm https://raw.githubusercontent.com/makubexD/SyncSettings/master/install.ps1 | iex
```

Each one asks before installing a missing tool (`git`, `jq` and `diffutils` on Linux, `bash` and `jq` on macOS, Git
and the GitHub CLI on Windows), clones the repo to `~/SyncSettings`
(`%USERPROFILE%\SyncSettings`), puts the `mksync` command on your `PATH`, and runs `mksync setup`. On Windows, open a
new window afterwards so it finds `mksync`.

Run the same line again to update. `SYNCSETTINGS_REPO_URL`, `SYNCSETTINGS_DIR` and the other `SYNCSETTINGS_*` variables
change the defaults, for example for a fork; the [front door section](docs/sync-contract.md#front-door) lists them all.

## Every day

| Command | Does |
|---|---|
| `mksync` | Shows where this machine stands: updates waiting, changes not sent, files that differ, and what to run next |
| `mksync pull` | Gets the latest repo, shows what changes here, and applies it after you say yes |
| `mksync push` | Copies this machine's changes into the repo, shows them, and opens a pull request after you say yes |
| `mksync setup` | First run on a machine. On Ubuntu it also offers to restore your apps and packages |
| `mksync doctor` | Checks the tools, the GitHub sign-in and the setup, and says how to fix what's missing |

The commands, their wording and their exit codes are the same on every system. `--yes` answers the questions for you,
and `mksync push` needs `gh auth login` once.

What good looks like on Linux (`mksync`, then `mksync doctor`):

```text
  SyncSettings  linux (Ubuntu 26.04.1 LTS)
  Repo      : /home/you/SyncSettings
  Origin    : up to date
  Unsent    : none
  Machine   : matches the repo

  Next: nothing to do.

  OK       bash 5.3.9(1)-release
  OK       git
  OK       jq
  OK       cmp
  OK       gh (signed in)
  OK       repo clone with origin
  OK       mksync on PATH
  OK       values
  Ready.
```

In `doctor`, `WARN` is worth fixing and `MISSING` stops `setup`; each line says how to fix it.

## See before you change anything

| Command | Shows | Direction |
|---|---|---|
| `mksync` | How many updates, unsent changes and differing files there are | both |
| `mksync check` | Every file the clone would change on this machine. It doesn't fetch: if `mksync` shows updates waiting, a pull changes more | repo → machine |
| `mksync preview` | Exactly what a push would send, as a diff | machine → repo |
| `mksync diff` | Which side changed each file since this machine last synced, after a fetch | both |

All four write nothing. In the check, `CREATE` is a file this machine doesn't have yet, `UPDATE` one the pull would
overwrite (keeping a `.bak`), and `EXTRA` a local file the repo doesn't have, which is kept. In the preview, `ADDED`,
`MODIFIED` and `REMOVED` say what would change in the repo.

The check can't tell which side is newer; `mksync diff` can. It marks each file `IN` (only the repo changed: pull
takes it), `OUT` (only this machine changed: push sends it) or `BOTH` (merge by hand). `mksync pull` stops before it
overwrites an `OUT` or `BOTH` file unless you add `--force`. Until this machine's first pull or push, the diff marks
differing files `?`, because it has no sync to compare against.

## Run from a clone

Without the installer:

```bash
git clone https://github.com/makubexD/SyncSettings.git
cd SyncSettings
./sync setup
```

On Windows, run `.\sync setup` in PowerShell or `sync setup` in cmd. `./sync <command>` takes every `mksync` command,
plus the single steps `export`, `commit` and `import`; options pass through (`./sync import --force`, `-Force` on
Windows).

Contributors run both engines' tests: `tests/linux/engine.sh [case-name-filter]` on Linux, and
`Invoke-Pester -Path tests/windows -CI` in Windows PowerShell 5.1 with Pester 5.

## What gets synced

| What | Systems |
|---|---|
| Git: `~/.gitconfig`, the global ignore, and `~/.gitconfig.local` for each system's credentials | all |
| `~/.claude/RTK.md` and the workflow guide page in `~/.claude/docs/` | all |
| Git Bash: `~/.bashrc`, `~/.bash_profile`, and the folders `.bashrc` puts on `PATH` | Windows |
| Windows Terminal settings | Windows |
| tmux, Starship, WezTerm, htop and GitHub CLI settings | Linux, macOS |
| VS Code's default profile: `settings.json` and `snippets/` (home path sanitized) | Linux, macOS |
| `~/.claude/CLAUDE.md` | Linux, macOS |
| Zsh: `~/.zshrc`, `~/.zprofile` | macOS |
| Bash: `~/.bashrc`, `~/.profile`, and the WezTerm XWayland launcher | Linux |
| RTK settings, default apps, Files bookmarks and desktop launchers | Linux |
| GNOME settings through dconf: theme, keyboard, shortcuts, dock, power, Ptyxis, Files ([which keys](docs/layout.md#which-dconf-settings-are-synced)) | Linux |
| The rest of the Claude Code setup: settings, status line, skills, hooks, the `mk-exec` worker scripts and its config | Linux |

Never synced: the DeepSeek key, `.credentials.json`, Claude history, transcripts, memory and plans, plugin install
state, caches, the GitHub CLI's `hosts.yml`, VS Code's named profiles, and GNOME location, window sizes and history.
Your name, email and paths are replaced with placeholders in the repo and filled back in on import.

`sync-config.json` lists every file. [Configuration](docs/configuration.md) says how to add one.

## Requirements

- **Linux:** bash 4+, `jq`, `git`, `cmp` (diffutils). `dconf-cli` for the GNOME settings; without it they're skipped
- **macOS:** 13 (Ventura) or newer, [Homebrew](https://brew.sh), and from it `bash` 4+ and `jq`
- **Windows:** Windows 10 or 11, PowerShell 5.1+, Git on `PATH`
- **To push:** the [GitHub CLI](https://cli.github.com/), signed in with `gh auth login`

## Read next

- [Daily workflow](docs/daily-workflow.md): push, review, merge, pull on the other machine, and troubleshooting
- [Restore a machine](docs/restore.md): a new Ubuntu, Windows or Mac machine, and what's left to do by hand
- [Configuration](docs/configuration.md): every `sync-config.json` field, placeholders and linked folders
- [Repository layout](docs/layout.md): where a file goes under `dotfiles/`, and why
- [Packages](docs/packages.md): the Ubuntu package lists and the drift report
- [Review gate](docs/review-gate.md): the checks every PR must pass and the `reviewed` label
- [Sync contract](docs/sync-contract.md): the rules both engines follow

[`docs/archive/`](docs/archive/) keeps the finished plans the scripts were built from.
