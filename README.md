# SyncSettings

Keep your Windows dotfiles and config files in sync across machines via a git repository.

## What gets synced

| File | Description |
|---|---|
| `~\.gitconfig` | Git global configuration |
| `~\.bashrc` | Bash run commands |
| `~\.bash_profile` | Bash login profile |
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

This compares local files against the repo **by content** (not dates). Files with sanitize rules (like `.gitconfig`) have sensitive values stripped automatically — your name becomes `<YOUR_NAME>`, your email becomes `<YOUR_EMAIL>`, etc. On the first run you'll be prompted for your actual values; these are cached locally in `.user-values.json` (gitignored). Then review the diff and commit:

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

## Sanitization — How it Works

Files with `sanitizeRules` in `sync-config.json` are never stored raw in the repo. Instead:

| Direction | What happens |
|---|---|
| **Export** | Reads your local `.gitconfig`, replaces `Kiefer Fernandez Valladolid` → `<YOUR_NAME>`, `Kiefer.Fernandez@tranzact.net` → `<YOUR_EMAIL>`, etc., then saves the sanitized version to `dotfiles/` |
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
      "description": "Git global configuration",
      "sanitizeRules": [                        // optional — omit for plain files
        { "placeholder": "<YOUR_NAME>", "prompt": "Full name for git commits" },
        { "placeholder": "<YOUR_EMAIL>", "prompt": "Email for git commits" }
      ]
    }
  ],
  "excludePatterns": ["*.pem", "*.key", "id_rsa*", ".env", ...]
}
```

- `~` in `localPath` resolves to `C:\Users\<username>` at runtime
- Files matching `excludePatterns` are **never copied** in either direction
- `sanitizeRules` is optional — files without it are compared/copied as-is

---

## Repository structure

```
SyncSettings/
├── sync-config.json        File mapping configuration
├── export.bat              Run to copy local changes → repo
├── commit.bat              Run to commit and push
├── import.bat              Run to apply repo files → machine
├── scripts/
│   ├── SyncHelpers.ps1     Shared functions (sanitization, hashing, etc.)
│   ├── Export-Settings.ps1
│   ├── Commit-Settings.ps1
│   └── Import-Settings.ps1
└── dotfiles/               Repo copies of all synced files
    ├── .gitconfig
    ├── .bashrc
    └── ...
```
