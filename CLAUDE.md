# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

Sync user dotfiles and config files between a Windows machine and this git repository. Works on Windows 10/11 with PowerShell 5.1+ and Git.

## Architecture

- `.bat` files are the only user-facing entry points — they set the working directory and invoke the corresponding PowerShell script
- All logic lives in `scripts/*.ps1`
- `sync-config.json` is the data contract — it maps `repoPath` (inside `dotfiles/`) to `localPath` (on the machine), using `~` as a `$env:USERPROFILE` placeholder
- `dotfiles/` is the staging area inside the repo; it mirrors the logical file set

## Entry Points

| Command | Script | Purpose |
|---|---|---|
| `export.bat` | `scripts/Export-Settings.ps1` | Copy changed local files → repo |
| `commit.bat` | `scripts/Commit-Settings.ps1` | Stage, commit, push `dotfiles/` |
| `import.bat` | `scripts/Import-Settings.ps1` | Copy repo files → local machine |

## Key Patterns

- **Content comparison:** Always use `Get-FileHash -Algorithm SHA256`. Never compare by date.
- **User resolution:** `~` in `localPath` resolves to `$env:USERPROFILE` (current user) or `C:\Users\<name>` for `-User <name>`.
- **Elevation:** Import targeting another user's profile triggers `Start-Process -Verb RunAs` to re-launch elevated.
- **Backups:** Import creates `<file>.bak` before overwriting any existing local file.
- **Error handling:** `$ErrorActionPreference = 'Stop'` at script level; per-file `try/catch` so one failure doesn't abort the rest.
- **Exclude patterns:** Checked via `-like` before every copy. Never copy files matching patterns in `sync-config.json > excludePatterns`.

## Adding New Files to Sync

Add an entry to the `files` array in `sync-config.json`:

```json
{
  "repoPath": "dotfiles/<filename>",
  "localPath": "~\\<path-relative-to-userprofile>",
  "description": "What this file configures"
}
```

Then run `export.bat` to pull it into the repo for the first time.
