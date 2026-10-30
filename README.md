# SyncSettings

Keep your dotfiles and config files in sync across machines via a git repository. Windows uses the
PowerShell scripts (`.bat` entry points). Linux uses the bash scripts (`.sh` entry points), see [Linux](#linux).

## Commands

One command on every system. It picks the right scripts for your OS.

| Command | Does |
|---|---|
| `./sync preview` | Shows exactly what would be sent to the repo. Changes nothing |
| `./sync export` | Copies your changed files into the repo, sanitized |
| `./sync commit` | Commits on a new branch and opens a pull request |
| `./sync import` | Applies the repo's files to this machine, keeping a `.bak` of every file it replaces |

On Windows, use `.\sync preview` in PowerShell or `sync preview` in cmd. Options pass through, for example
`./sync import --force` (`-Force` on Windows). Run `./sync` alone to see the usage and the detected OS.

## What gets synced

**Windows**

| File | Description |
|---|---|
| `~\.gitconfig` | Git global configuration |
| `~\.bashrc` | Bash run commands |
| `~\.bash_profile` | Bash login profile |
| `~\AppData\Local\...\WindowsTerminal\settings.json` | Windows Terminal settings |

**Linux: Claude Code setup (`~/.claude`)**

| File | Description |
|---|---|
| `CLAUDE.md`, `RTK.md` | Global instructions for Claude Code |
| `settings.json` | Hooks, plugins, permissions (home path and GitHub username sanitized) |
| `statusline.sh` | Status line script |
| `skills/mk-delegate/`, `skills/mk-check/` | `/mk-delegate` and `/mk-check` slash commands |
| `hooks/` | context-mode hook and the worker-mode guard |
| `bin/mk-exec`, `bin/workflow-report`, `bin/worker-mode` | Worker wrapper (headless Claude Code on the paid DeepSeek API), run report, worker-mode switch |
| `plugins/installed_plugins.json`, `known_marketplaces.json` | Which plugins are installed (home path sanitized) |
| `docs/token-routing-map.html`, `sampleGrok.md` | Workflow guide page, old Windows Grok setup for reference |
| `~/.claude-worker/CLAUDE.md`, `settings.json` | The worker's own config dir: its rules and permissions (no credentials) |

Never synced: the DeepSeek key (`~/.config/claude-workers/env`), `.credentials.json`, `history.jsonl`, conversation transcripts, memory, plans, caches.

Add or remove files by editing `sync-config.json`.

---

## Read next

- [Daily workflow](docs/daily-workflow.md): export → PR → review → merge → import on the other machine
- [Review gate](docs/review-gate.md): the checks every PR must pass and the `reviewed` label
- [Configuration reference](docs/configuration.md): every `sync-config.json` field, with examples
- [Sync contract](docs/sync-contract.md): the rules both engines follow

---

## Requirements

- **Windows:** Windows 10 or 11, PowerShell 5.1+, Git (in PATH)
- **Linux:** bash 4+, `jq`, `git`, `cmp` (diffutils)
- **Both, for committing:** the [GitHub CLI](https://cli.github.com/), logged in with `gh auth login`

---

## Usage

### Scenario 1 — Export local changes to the repo

Run when your local files have changed and you want to push them to the repo:

```
export.bat
```

This compares local files against the repo **by content** (not dates). Files with sanitize rules (like `.gitconfig`) have sensitive values stripped automatically — your name becomes `<YOUR_NAME>`, your email becomes `<YOUR_EMAIL>`, etc. On the first run you'll be prompted for your actual values; these are cached locally in `.user-values.json` (gitignored). Then review the diff and commit:

```
commit.bat
```

`commit.bat` auto-generates a descriptive commit message (e.g., `sync: update .gitconfig, .bashrc`), commits on a
new `sync/windows-…` branch and opens a pull request. Review it, add the `reviewed` label, merge, then `git pull`.
Needs the [GitHub CLI](https://cli.github.com/) (`gh auth login`). `-Push` is still accepted but does nothing.
The first run asks for a machine alias (e.g. `desktop`) to use in branch names instead of the computer name.

To use a custom commit message:

```
commit.bat -Message "update work laptop aliases"
```

If nothing changed, `export.bat` reports `Repo is up to date. No changes detected.`

To re-enter your sanitized values (e.g., changed email):

```
export.bat -ResetValues
```

---

### Scenario 2 — Import repo settings to a new machine

Clone the repo, then run:

```
import.bat
```

This copies every file from `dotfiles/` to the correct local path under your profile. For files with placeholders (like `.gitconfig`), you'll be prompted to enter your actual values (name, email, etc.) — or they'll be reused from cache if you've imported before. Before overwriting any existing file it:
1. Asks for confirmation (unless `-Force`)
2. Creates a `.bak` backup

To skip confirmation prompts:

```
import.bat -Force
```

To re-enter all placeholder values (e.g., changed email on a new org):

```
import.bat -ResetValues
```

---

### Scenario 3 — Propagate settings to another user on the same machine

```
import.bat -User johndoe
```

If the target user is different from the current session, PowerShell will request a UAC elevation prompt automatically. No manual right-clicking needed.

---

## Linux

The bash scripts handle entries marked `"platform": "linux"` or `"common"`. The PowerShell scripts handle
`"windows"` and `"common"`, so one repo serves both systems.

| Command | Does |
|---|---|
| `./export.sh` | Copy changed local files → repo (sanitized). `--reset-values` re-asks for placeholder values |
| `./commit.sh` | Commit `dotfiles/` on a new `sync/linux-…` branch and open a pull request (needs `gh`). The first run asks for a machine alias for branch names. `-m "<msg>"` sets the message |
| `./import.sh` | Copy repo files → this machine, asking before each overwrite and saving `<file>.bak` first. `--force` skips the questions |

Export and import ask once for each placeholder value and cache the answers in `.user-values.json`
(gitignored). `<HOME>` defaults to your `$HOME`, so pressing Enter is usually enough. Without a terminal,
a missing value is an error: nothing is written with a placeholder left unfilled.

### New Linux machine: restore the Claude Code setup

1. Install the tools: `git`, `jq`, `python3`, Claude Code, [nvm](https://github.com/nvm-sh/nvm) with Node and
   [`rtk`](https://github.com/rtk-ai/rtk) in `~/.local/bin`.
2. Open Claude Code once so `~/.claude` exists, then install the plugins with `/plugin`
   (`context-mode`, `agent-skills`).
3. Clone this repo and run `./import.sh`.
4. Link the scripts onto your PATH:
   `ln -sf ~/.claude/bin/mk-exec ~/.claude/bin/workflow-report ~/.claude/bin/worker-mode ~/.local/bin/`
5. Add your DeepSeek key: `mkdir -p -m 700 ~/.config/claude-workers`, then put
   `export DEEPSEEK_API_KEY=<key>` in `~/.config/claude-workers/env` and `chmod 600` it.
6. In Claude Code, run `/mk-check`. All checks should pass and the live job should finish on DeepSeek.

Not supported on Linux: `detectLinkedPaths` and importing into another user's profile.

---

## Linked Paths — Auto-Sync Referenced Directories

Some config files reference external directories that hold important content. For example, `.bashrc` adds `/c/MakuCustomAlias` to `PATH` and auto-aliases every `.bat` file inside it. Without that folder, the settings are useless on a new machine.

Set `"detectLinkedPaths": true` on any file entry in `sync-config.json` to enable automatic directory detection and sync:

```json
{
  "repoPath": "dotfiles/.bashrc",
  "localPath": "~\\.bashrc",
  "platform": "windows",
  "detectLinkedPaths": true
}
```

The script reads the file content, finds all directory paths (both Unix-style `/c/...` and Windows-style `C:\...`), verifies they exist on disk, and syncs their contents automatically — no manual path listing needed.

**Export** backs up detected directories into the repo:
```
dotfiles/
├── .bashrc
└── .bashrc.linked/
    └── MakuCustomAlias/   <- backed up from C:\MakuCustomAlias
        └── vs.bat
```

**Import** on a new machine creates the directory if it doesn't exist and copies files into it.

If you have multiple referenced directories, all of them are detected and grouped under `<filename>.linked/`:
```
dotfiles/.bashrc.linked/
    MakuCustomAlias/
    AnotherFolder/
    YetAnotherPath/
```

---

## Sanitization — How it Works

Files with `sanitizeRules` in `sync-config.json` are never stored raw in the repo. Instead:

| Direction | What happens |
|---|---|
| **Export** | Reads your local `.gitconfig`, replaces `Jane Doe` → `<YOUR_NAME>`, `jane@example.com` → `<YOUR_EMAIL>`, etc., then saves the sanitized version to `dotfiles/` |
| **Import** | Reads the sanitized `dotfiles/.gitconfig`, prompts you for each `<PLACEHOLDER>` value, writes the hydrated file to your profile |
| **Change detection** | Only structural/non-sensitive changes are detected. Adding a new alias = change. Changing your email = no change (it's sanitized away) |

Actual values are cached in `.user-values.json` (gitignored, never committed). Use `-ResetValues` on either export or import to re-enter them.

---

## Configuration (`sync-config.json`)

```jsonc
{
  "files": [
    {
      "repoPath": "dotfiles/.gitconfig",
      "localPath": "~\\.gitconfig",
      "platform": "windows",
      "description": "Git global configuration",
      "sanitizeRules": [                        // optional — omit for plain files
        { "placeholder": "<YOUR_NAME>", "prompt": "Full name for git commits" },
        { "placeholder": "<YOUR_EMAIL>", "prompt": "Email for git commits" },
        {
          "placeholder": "<GH_CLI_PATH>",
          "prompt": "Path to GitHub CLI executable",
          "default": "C:\\Program Files\\GitHub CLI\\gh.exe",
          "escapeBackslashes": true             // double backslashes when hydrating (for .gitconfig syntax)
        }
      ]
    },
    {
      "repoPath": "dotfiles/.bashrc",
      "localPath": "~\\.bashrc",
      "platform": "windows",
      "description": "Bash run commands",
      "detectLinkedPaths": true                 // auto-detect and sync referenced directories
    }
  ],
  "excludePatterns": ["*.pem", "*.key", "id_rsa*", ".env", ...]
}
```

- `~` in `localPath` resolves to `C:\Users\<username>` at runtime
- Files matching `excludePatterns` are **never copied** in either direction
- `sanitizeRules` is optional — files without it are compared/copied as-is
- `escapeBackslashes: true` on a sanitize rule doubles backslashes when hydrating (needed for `.gitconfig` where paths use `\\` escaping)
- `detectLinkedPaths: true` — scans the file's content for directory references and automatically syncs them; no manual path listing required
- `platform` is required: `windows`, `linux` or `common`. `linux` and `common` entries use `~/` and forward slashes in `localPath` (`~/.claude/settings.json`). An entry without a valid `platform` stops the scripts
- `defaultEnv: "HOME"` on a sanitize rule — the prompt's default is that environment variable's value

---

## Repository structure

```
SyncSettings/
├── sync-config.json        File mapping configuration
├── export.bat              Run to copy local changes → repo
├── commit.bat              Run to commit on a branch and open a PR
├── import.bat              Run to apply repo files → machine
├── export.sh               Linux: copy local changes → repo
├── commit.sh               Linux: commit on a branch and open a PR
├── import.sh               Linux: apply repo files → machine
├── docs/
│   ├── daily-workflow.md   Export → PR → review → merge → import
│   ├── review-gate.md      The PR checks and the `reviewed` label
│   └── plan-*.md           Plans the scripts were built from
├── scripts/
│   ├── SyncHelpers.ps1     Shared functions (sanitization, hashing, linked paths, etc.)
│   ├── Export-Settings.ps1
│   ├── Commit-Settings.ps1
│   ├── Import-Settings.ps1
│   └── sync.sh             Linux: shared bash helpers
└── dotfiles/               Repo copies of all synced files
    ├── linux/claude/       Linux: the ~/.claude setup (see "What gets synced")
    ├── .gitconfig
    ├── .bashrc
    ├── .bashrc.linked/     Auto-generated: directories referenced inside .bashrc
    │   └── MakuCustomAlias/
    │       └── vs.bat
    └── WindowsTerminal/
        └── settings.json
```
