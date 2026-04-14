# SyncSettings

Keep your Windows dotfiles and config files in sync across machines via a git repository.

## What gets synced

| File | Description |
|---|---|
| `~\.gitconfig` | Git global configuration |
| `~\.bashrc` | Bash run commands |
| `~\.bash_profile` | Bash login profile |
| `~\.nuxtrc` | Nuxt.js runtime config |
| `~\.angular-config.json` | Angular CLI global config |
| `~\AppData\Local\...\WindowsTerminal\settings.json` | Windows Terminal settings |

Add or remove files by editing `sync-config.json`.

---

## Requirements

- Windows 10 or 11
- PowerShell 5.1+
- Git (in PATH)

---

## Usage

### Scenario 1 — Export local changes to the repo

Run when your local files have changed and you want to push them to the repo:

```
export.bat
```

This compares local files against the repo **by content** (SHA256 hash). Changed or new files are copied into `dotfiles/`. Then review the diff and commit:

```
commit.bat
```

`commit.bat` will auto-generate a descriptive commit message (e.g., `sync: update .gitconfig, .bashrc`) and prompt whether to push.

To push automatically without prompting:

```
commit.bat -Push
```

To use a custom commit message:

```
commit.bat -Message "update work laptop aliases"
```

If nothing changed, `export.bat` reports `Repo is up to date. No changes detected.`

---

### Scenario 2 — Import repo settings to a new machine

Clone the repo, then run:

```
import.bat
```

This copies every file from `dotfiles/` to the correct local path under your profile. Before overwriting any existing file it:
1. Asks for confirmation (unless `-Force`)
2. Creates a `.bak` backup

To skip prompts:

```
import.bat -Force
```

---

### Scenario 3 — Propagate settings to another user on the same machine

```
import.bat -User johndoe
```

If the target user is different from the current session, PowerShell will request a UAC elevation prompt automatically. No manual right-clicking needed.

---

## Configuration (`sync-config.json`)

```jsonc
{
  "files": [
    {
      "repoPath": "dotfiles/.gitconfig",   // path inside the repo
      "localPath": "~\\.gitconfig",        // ~ = C:\Users\<username>
      "description": "Git global configuration"
    }
  ],
  "excludePatterns": ["*.pem", "*.key", "id_rsa*", ".env", ...]
}
```

Files matching `excludePatterns` are **never copied** in either direction, even if listed in `files`.

---

## Repository structure

```
SyncSettings/
├── sync-config.json        File mapping configuration
├── export.bat              Run to copy local changes → repo
├── commit.bat              Run to commit and push
├── import.bat              Run to apply repo files → machine
├── scripts/
│   ├── Export-Settings.ps1
│   ├── Commit-Settings.ps1
│   └── Import-Settings.ps1
└── dotfiles/               Repo copies of all synced files
    ├── .gitconfig
    ├── .bashrc
    └── ...
```
