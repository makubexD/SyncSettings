# Clear docs and safe dry runs

Goal: the README gets you from nothing to a synced machine in one screen, and before anything is copied you can see
what would move in each direction and which side is newer.

## Findings (review on 2026-11-09)

**README.** 466 lines, and about two thirds of it is reference material that `docs/` already covers or that is out of
date:

- "Usage" (scenarios 1-3) teaches `export.bat`, `commit.bat` and `import.bat`, the old flow from before `mksync`.
- "Linked Paths", "Sanitization" and "Configuration" repeat `docs/configuration.md`, and the README copy is stale: its
  `platform` list has no `macos` and no lists, and it says `~` is always `C:\Users\<username>`.
- "Repository structure" is out of date: no `sync`, `sync.cmd`, `install.*`, `tests/`, `front.sh`, `Front.ps1` or
  `dotfiles/macos/`.
- The Install section repeats the same `curl` line for Linux and macOS, and the dry runs aren't mentioned at all.
- There are no steps for running from a clone without the installer.

**Dry runs.** They exist but can't be found, and they don't say which side is newer:

| Direction | Command | Writes |
|---|---|---|
| Machine → repo | `./sync preview` (`mksync preview`, `.\sync preview`) | nothing |
| Repo → machine | `./import.sh --check` (`Import-Settings.ps1 -Check`) | nothing |
| Both, counts only | `mksync` | nothing |

`mksync check` isn't a command, so the repo → machine check needs the script name. Worse, on this machine today the
check lists 9 `UPDATE` lines for `~/.claude` files *edited here after the last export*, and it ends with "Run mksync
pull to apply". Following that advice overwrites the newer local edits (each one keeps a `.bak`). Neither check can
tell "the repo changed" from "this machine changed", because nothing records which commit a machine last synced at.

**Root folder.** Every file is live: `sync` and `sync.cmd` are the front door, `install.*` are the installers, `*.sh`
are the Linux entry points that `sync` calls, and `.user-values.json` is the gitignored values cache. The only redundant
files are `export.bat`, `import.bat` and `commit.bat`: `sync.cmd` calls the PowerShell scripts directly. They stay until
the Windows checks W0-W6 in `TODO.md` pass, because those checks run them; then they go.

**`docs/`.** 17 finished `plan-*.md` files (about 450 KB) sit next to the 8 guides.

## Phase 1: docs and wording (`docs/plan-docs-dryrun-1.md`) (done 2026-11-09)

`mksync check` for the repo → machine dry run, check output that warns before a pull overwrites local edits, the
PowerShell hints moved to `mksync`, a short README, and the finished plans out of `docs/`.

## Phase 2: which side is newer (`mksync diff`)

Design, to be planned when phase 1 is merged:

- After a successful import or export, each engine writes the repo commit it synced at to a per-machine state file
  (`~/.local/state/sync-settings/last-sync` on Linux and macOS, `%LOCALAPPDATA%\SyncSettings\last-sync` on Windows).
  Not in the repo, because it belongs to the machine.
- `mksync diff` fetches, then compares three versions of every file: the repo at the last sync, the repo at
  `origin/master`, and the machine's file sanitized as export would write it. Each file gets one label: `IN` (only the
  repo changed: pull takes it), `OUT` (only this machine changed: push sends it), `BOTH` (both changed: decide by hand),
  `NEW`, or `?` (no last-sync record yet).
- `mksync` status uses the same labels for its `Next` line, and `mksync pull` refuses to overwrite an `OUT` or `BOTH`
  file without `--force`.
- Both engines, fixtures for every label, contract section.

## Not doing

- Moving the entry scripts out of the root: `sync`, the installers and the CI paths depend on them, and the root is
  already small once the `.bat` files go.
