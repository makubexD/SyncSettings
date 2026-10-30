# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

Sync user dotfiles and config files between a machine and this git repository. Windows: PowerShell 5.1+ and Git. Linux: bash 4+, `jq`, `git`, `cmp`. The Linux side currently syncs the Claude Code setup in `~/.claude`.

## Architecture

- `.bat` files are the Windows entry points — they set the working directory and invoke the corresponding PowerShell script
- `export.sh`, `import.sh`, `commit.sh` are the Linux entry points; shared bash helpers live in `scripts/sync.sh`
- Windows logic lives in `scripts/*.ps1`. The two sides share `sync-config.json` and the `.user-values.json` format, not code
- Each entry's `platform` field picks its side: `"linux"` entries are bash-only, and entries without it are Windows-only (`Test-WindowsEntry` filters right after the config loads)
- `sync-config.json` is the data contract — it maps `repoPath` (inside `dotfiles/`) to `localPath` (on the machine), using `~` as a `$env:USERPROFILE` placeholder
- `dotfiles/` is the staging area inside the repo; it mirrors the logical file set

## Entry Points

| Command | Script | Purpose |
|---|---|---|
| `export.bat` | `scripts/Export-Settings.ps1` | Copy changed local files → repo |
| `commit.bat` | `scripts/Commit-Settings.ps1` | Commit `dotfiles/` on a `sync/windows-…` branch, open a PR (never pushes to `master`) |
| `import.bat` | `scripts/Import-Settings.ps1` | Copy repo files → local machine |
| `./export.sh` | `scripts/sync.sh` | Linux: copy changed local files → repo |
| `./commit.sh` | (self-contained) | Linux: commit `dotfiles/` on a `sync/linux-…` branch, open a PR (never pushes to `master`) |
| `./import.sh` | `scripts/sync.sh` | Linux: copy repo files → local machine |

Every change reaches `master` through a PR that the `review-gate` check holds red until it carries the
`reviewed` label; see `docs/review-gate.md` and `docs/daily-workflow.md`.

### Claude auto-approval (temporary, development stage)

Claude may add the `reviewed` label and merge a PR (`gh pr merge <n> --merge --delete-branch`) without asking,
once all of these hold:

1. Claude has read the full diff and rerun the PR's tests.
2. `lint` and `leak-scan` are green.
3. The PR touches none of: `.github/workflows/`, `docs/review-gate.md`, `.claude/settings.json`, or this section.
   Those PRs, and any PR with a failing check, wait for the user to add the label.

After a merge, `git switch master && git pull`. Remove this section when development is done; see `TODO.md`.

## Key Patterns

- **Content comparison:** Files without sanitize rules use `Get-FileHash -Algorithm SHA256`. Files with sanitize rules use normalized text comparison after sanitization. Never compare by date.
- **Sanitization layer:** Files with `sanitizeRules` in `sync-config.json` have sensitive values (name, email, credentials) replaced with `<PLACEHOLDERS>` during export and hydrated back during import. Actual values are cached in `.user-values.json` (gitignored). Shared helpers live in `scripts/SyncHelpers.ps1` (dot-sourced by Export and Import).
- **User resolution:** `~` in `localPath` resolves to `$env:USERPROFILE` (current user) or `C:\Users\<name>` for `-User <name>`.
- **Elevation:** Import targeting another user's profile triggers `Start-Process -Verb RunAs` to re-launch elevated.
- **Backups:** Import creates `<file>.bak` before overwriting any existing local file.
- **Error handling:** `$ErrorActionPreference = 'Stop'` at script level; per-file `try/catch` so one failure doesn't abort the rest.
- **Exclude patterns:** Checked via `-like` before every copy. Never copy files matching patterns in `sync-config.json > excludePatterns`.
- **PS 5.1 compatibility:** No null-coalescing (`??`), no ternary. Use `[IO.File]::WriteAllText()` for UTF-8 without BOM.

### Bash scripts (Linux)

- **Byte-exact text:** read with `read_text` (keeps trailing newlines) and write with `write_text`. Never use plain `$(cat f)`.
- **No `@tsv` for values:** jq's `@tsv` escapes backslashes and `read` with `IFS=$'\t'` collapses empty fields. Parse values and rules NUL-separated (`jq -j … "\u0000"`, `read -d ''`) and replace text literally (`${c//"$from"/"$to"}`).
- **Prompts inside loops:** a loop that reads from a pipe must use another fd (`read … <&3` with `done 3< <(…)`), or `read` takes the next loop line as the user's answer.
- **Modes:** `cp -p` for plain copies, `chmod --reference` for files written from text. `bin/` scripts must stay executable.
- **Non-interactive runs:** with no terminal and a placeholder value missing, `request_values` fails rather than writing an unfilled placeholder.
- **Testing:** use a throwaway `HOME` (`HOME=$(mktemp -d) ./import.sh --force < /dev/null`) and a throwaway `git clone` for `commit.sh`. Don't test in the real repo.

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

For a Linux file, add `"platform": "linux"`, put it under `dotfiles/linux/`, and use a `~/` path:

```json
{
  "repoPath": "dotfiles/linux/claude/settings.json",
  "localPath": "~/.claude/settings.json",
  "platform": "linux",
  "description": "Claude Code user settings",
  "sanitizeRules": [
    { "placeholder": "<HOME>", "prompt": "Home directory", "defaultEnv": "HOME" }
  ]
}
```

Then run `./export.sh`. Check `grep -rl "$HOME" dotfiles/linux` prints nothing before committing.
