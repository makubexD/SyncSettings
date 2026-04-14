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

- **Content comparison:** Files without sanitize rules use `Get-FileHash -Algorithm SHA256`. Files with sanitize rules use normalized text comparison after sanitization. Never compare by date.
- **Sanitization layer:** Files with `sanitizeRules` in `sync-config.json` have sensitive values (name, email, credentials) replaced with `<PLACEHOLDERS>` during export and hydrated back during import. Actual values are cached in `.user-values.json` (gitignored). Shared helpers live in `scripts/SyncHelpers.ps1` (dot-sourced by Export and Import).
- **User resolution:** `~` in `localPath` resolves to `$env:USERPROFILE` (current user) or `C:\Users\<name>` for `-User <name>`.
- **Elevation:** Import targeting another user's profile triggers `Start-Process -Verb RunAs` to re-launch elevated.
- **Backups:** Import creates `<file>.bak` before overwriting any existing local file.
- **Error handling:** `$ErrorActionPreference = 'Stop'` at script level; per-file `try/catch` so one failure doesn't abort the rest.
- **Exclude patterns:** Checked via `-like` before every copy. Never copy files matching patterns in `sync-config.json > excludePatterns`.
- **PS 5.1 compatibility:** No null-coalescing (`??`), no ternary. Use `[IO.File]::WriteAllText()` for UTF-8 without BOM.

## Linked Paths (Auto-Detection)

Set `"detectLinkedPaths": true` on any file entry. The script automatically parses the file content for directory paths (Unix `/c/...` or Windows `C:\...`), verifies they exist on disk, and syncs their contents.

```json
{
  "repoPath": "dotfiles/.bashrc",
  "localPath": "~\\.bashrc",
  "detectLinkedPaths": true
}
```

Detected directories are stored under `<repoPath>.linked/<foldername>/`:
```
dotfiles/.bashrc.linked/MakuCustomAlias/vs.bat
```

- `Find-LinkedPaths` in `SyncHelpers.ps1` does the parsing — filters out system dirs, user profile, temp
- **Export**: reads local file, detects paths, syncs each dir -> repo `.linked/` folder
- **Import**: scans repo `.linked/` folders, resolves local paths from file content, syncs back
- Files inside linked dirs are subject to `excludePatterns`
- Orphaned files (deleted from source) are removed from destination

## Adding New Files to Sync

Add an entry to the `files` array in `sync-config.json`:

```json
{
  "repoPath": "dotfiles/<filename>",
  "localPath": "~\\<path-relative-to-userprofile>",
  "description": "What this file configures"
}
```

For files containing sensitive data, add `sanitizeRules`:

```json
{
  "repoPath": "dotfiles/.gitconfig",
  "localPath": "~\\.gitconfig",
  "description": "Git global configuration",
  "sanitizeRules": [
    { "placeholder": "<YOUR_NAME>", "prompt": "Full name for git commits" },
    { "placeholder": "<YOUR_EMAIL>", "prompt": "Email for git commits" }
  ]
}
```

Then run `export.bat` to pull it into the repo for the first time.
