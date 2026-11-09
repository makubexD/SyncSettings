# Plan: Linux support (bash scripts)

The PowerShell scripts handle Windows entries. These bash scripts handle entries in `sync-config.json`
that have `"platform": "linux"`, and ignore all others. Behavior mirrors `scripts/*.ps1`.

Dependencies: `bash`, `jq`, `git`, `cmp`. No other tools.

## Shared rules (all steps)

- Start every script with `#!/usr/bin/env bash` and `set -euo pipefail`. Make root scripts executable.
- Root entry points (`export.sh`, `import.sh`, `commit.sh`) `cd` to the repo root
  (`cd "$(dirname "$0")"`) and source `scripts/sync.sh`.
- Linux entries: `jq -c '.files[] | select(.platform == "linux")' sync-config.json`.
- `localPath` starting with `~/` resolves to `$HOME/`.
- **Keep trailing newlines exactly.** Read files with `c=$(cat "$f"; printf x); c=${c%x}` and write with
  `printf '%s' "$c" > "$f"`. Never use plain `$(cat f)`, which strips trailing newlines.
- **Keep file modes.** Use `cp -p` for plain copies. When writing a new file from text, copy the mode from
  its source with `chmod --reference=<source> <dest>`.
- Replace text **literally**, never as a regex: `c=${c//"$from"/"$to"}` (quote both sides).
- Status lines: `printf '  %-10s %s%s\n' "$status" "$label" "${note:+  ($note)}"`, where status is one of
  ADDED, MODIFIED, UNCHANGED, SKIPPED, CREATED, UPDATED, ERROR.
- One failing file prints an ERROR line and the loop continues. It must not abort the run.

## Step 1: `scripts/sync.sh` helpers and `export.sh`

`scripts/sync.sh` (sourced, not executed) provides:

- `linux_entries`: prints each Linux entry as compact JSON, one per line.
- `resolve_local <localPath>`: expands `~/` to `$HOME/`.
- `is_excluded <path>`: true if the file's basename matches any `excludePatterns` glob (`[[ $leaf == $pat ]]`),
  or the full path ends with `/<pattern>`.
- `load_values` / `save_values`: read and write `.user-values.json` at the repo root. It's a flat JSON object,
  placeholder to value, the same file the PowerShell scripts use. Save with `jq -S` (sorted keys). A
  missing file means no values.
- `request_values <direction> <reset> <rules-json-array>`: for each unique placeholder with no cached value
  (or for all of them when reset is 1), prompt `  <rule.prompt> [<default>]: ` with `read -r`. The default is
  the cached value, then `rule.default`, then the env var named by `rule.defaultEnv` (for example `HOME`).
  Empty input takes the default. If stdin is not a terminal and a value is still missing, fail with
  `missing value for <PLACEHOLDER>: add it to .user-values.json`.
- `sanitize <text> <rules-json-array>`: replace each rule's real value with its placeholder, longest value
  first. Rules with no value are skipped.
- `hydrate <text> <rules-json-array>`: replace each placeholder with its real value.
- `same_normalized <a> <b>`: true if equal after removing `\r` and trailing whitespace at the end.
- `status <STATUS> <label> [note]`: prints a status line.

`export.sh [--reset-values]`: copies changed local files into the repo.

1. Print a banner (`SyncSettings -- EXPORT (linux)`), plus `$HOME` and the repo root.
2. Collect `sanitizeRules` from Linux entries whose local file exists, run `request_values export`, and save the values.
3. For each Linux entry (label = `repoPath`):
   - excluded: SKIPPED `matches exclude pattern`
   - local file missing: SKIPPED `local file not found: <path>`, counted as skipped
   - otherwise `mkdir -p` the repo folder
   - entry has sanitizeRules: sanitize the local text and compare it with the repo file using
     `same_normalized`. Equal: UNCHANGED. Different: write it, MODIFIED `sanitized`. No repo file yet:
     ADDED `sanitized`. A new file gets the local file's mode.
   - no sanitizeRules: no repo file: `cp -p`, ADDED. `cmp -s` equal: UNCHANGED. Otherwise `cp -p`, MODIFIED.
   - `detectLinkedPaths` is ignored on Linux.
4. Summary: `<n> file(s) copied to the repo.` plus `Review the changes, then run ./commit.sh`, or
   `Repo is up to date. No changes detected.` If any were skipped, add a note to run `./import.sh` first on a
   new machine.

**Done when:** `bash -n export.sh scripts/sync.sh` passes, then `./export.sh < /dev/null` exits 0 and
`dotfiles/linux/claude/` holds 16 files. `grep -rl "$HOME" dotfiles/linux` prints nothing,
`git diff --quiet -- sync-config.json scripts/*.ps1` succeeds, and a second `./export.sh < /dev/null`
reports all 16 as UNCHANGED.
Files allowed to change: `scripts/sync.sh`, `export.sh`, `dotfiles/linux/claude/**`.

## Step 2: `import.sh`

`import.sh [--force] [--reset-values]`: copies repo files to the machine.

1. Print a banner (`SyncSettings -- IMPORT (linux)`), `$HOME` and the repo root.
2. Collect `sanitizeRules` from Linux entries whose repo file exists, run `request_values import`, and save the values.
3. For each Linux entry:
   - excluded: SKIPPED
   - repo file missing: SKIPPED `not found in repo`
   - local folder missing: `mkdir -p` it
   - entry has sanitizeRules: hydrate the repo text. If the local file exists and `same_normalized` matches:
     UNCHANGED. If it differs: unless `--force`, ask `  Overwrite <path>? [Y/n] ` (anything but empty, Y or y
     skips with SKIPPED `user skipped`). Then `cp -p local local.bak`, write the hydrated text, and print
     UPDATED `backup saved as <name>.bak`. No local file: write it with the repo file's mode, CREATED.
   - no sanitizeRules: same flow, using `cmp -s` to compare and `cp -p` to copy.
4. Summary: `<n> file(s) applied.`, plus a reminder to link the scripts:
   `ln -sf ~/.claude/bin/oc-exec ~/.claude/bin/worker-mode ~/.local/bin/`.

**Done when:** `bash -n import.sh` passes, and with `T=$(mktemp -d)`:
- `HOME=$T ./import.sh --force < /dev/null` exits 0 and creates 16 files under `$T/.claude`. This works
  because `.user-values.json` already holds the values.
- `diff -r` of each created file against the real `~/.claude/<same path>` shows no differences, and
  `$T/.claude/bin/oc-exec` is executable.
- A second run with `--force`, after appending a line to `$T/.claude/RTK.md`, prints UPDATED for that file
  and leaves `$T/.claude/RTK.md.bak`.

Files allowed to change: `import.sh` (and `scripts/sync.sh` only to fix a bug, with the reason stated).

## Step 3: `commit.sh`

A port of `scripts/Commit-Settings.ps1`. `commit.sh [-m <message>] [--push]`:

- `git status --porcelain -- dotfiles/`. If empty, print `Nothing to commit -- dotfiles/ is clean.` and exit 0.
- List the changed files. Build the message the same way as `Build-CommitMessage`: basenames grouped as
  `add …; update …; remove …` (codes `A` and `??` are add, `M` is update, `D` is remove). Over 72 characters
  becomes `sync: update <n> config file(s)`. Nothing classified becomes `sync: update config files`.
- `git add dotfiles/`, then `git commit -m`. Then push if `--push`, or ask `Push to remote? [Y/n]`
  (empty or Y/y pushes; if `read` fails because there is no input, don't push). On push failure, print the remote hint and exit 1.

**Done when:** `bash -n commit.sh` passes, and in a throwaway clone (`git clone -q . $(mktemp -d)`) with one
file changed under `dotfiles/`, `./commit.sh < /dev/null` commits with the generated message and doesn't push
(non-tty input means no). Files allowed to change: `commit.sh`.

## Step 4 (main session): docs
README Linux section and new-machine checklist, plus `CLAUDE.md` updates for the bash scripts and the
`platform` field.
