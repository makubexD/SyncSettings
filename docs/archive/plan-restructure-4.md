# Phase 4: Linux configs

Roadmap: `docs/plan-restructure.md`. Goal of this phase: the Linux configs from the inventory are in the repo, `~/.bashrc`
no longer errors on a machine without OmniRoute, `~/.config/git/ignore` is synced on both systems, and `./sync preview`
stays clean when nobody changed a setting.

Out of scope: dconf (phase 5), packages, fonts and VS Code extensions (phase 6), `~/.local/bin` links, plugin restore
and `docs/restore.md` (phase 7), Windows configs (phase 8), dropping `sampleGrok.md` (phase 9).

## Findings that shaped this plan

All from read-only checks on this machine, or a throwaway `HOME` and config dir.

| Finding | Result | Effect |
|---|---|---|
| `tests/linux/engine.sh` with the real config | 105 of 106 pass, `preview-no-changes` fails | Step 1 |
| Same suite with `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 XDG_CONFIG_HOME=/nonexistent` | 106 of 106 | Step 1 uses these three |
| A throwaway `HOME` holding only `core.autocrlf = input` | Fails the same way, so the bug isn't specific to this machine | Step 1 proof |
| Cause | `make_git_repo` runs `git add` with the real `HOME`, the setting strips the CR from the `win.conf` fixture in the commit, and preview then sees a difference | The fix belongs in the harness, not `run_preview` |
| `dotfiles/windows/` in the real worktree | All `i/lf w/lf` | Real `./sync preview` isn't affected |
| Restored `installed_plugins.json` and `known_marketplaces.json` with no plugin cache | `claude plugin list`: every plugin `failed to load` (`cache-miss`) | Decision 1 |
| Same files after `claude plugin marketplace update` | `context-mode` recovers; `agent-skills` still fails, cloning over SSH with no GitHub host key | Decision 1 |
| Only the `settings.json` declaration, then `plugin marketplace add` per source and `plugin install` per plugin | Both plugins `enabled` | Decision 1, phase 7 |
| That same restore | `agent-skills` came back at a newer version than the repo recorded; `marketplace add` dropped `autoUpdate: true` from `settings.json` | Phase 7 notes (step 10) |
| History of the two plugin files | 12 commits, 10 only change `lastUpdated` | Decision 1 |
| `~/.config/Code/User/settings.json` | CRLF on all 181 lines, and git's `eol=lf` makes a plain `cmp` differ after every checkout | Decision 2 |
| VS Code Settings Sync | Enabled, last ran today; probably the source of the CRLF | Decisions 2 and 3 |
| The repo | Public | Decision 2: nothing work-identifying goes in as plain text |
| VS Code profiles | Six named profiles besides the default, each with its own settings, keybindings, snippets and extensions; one has an `mcp.json` | Decision 3 |
| `pypoetry/config.toml` | 0 bytes | Decision 4 |
| `real-config-roundtrip` line 673 | Fails if `~/.bashrc` exists, and the Linux entry creates it | Step 4 changes that assertion |
| New `<YOUR_WORK_MARKETPLACE>` rule | The round trip stops with `missing value` unless its fake values include it | Step 7 adds it |
| Windows import with a missing target folder | `SKIPPED` with a warning; Linux runs `mkdir -p` | Steps 9 and 10: `common/git/ignore` needs `~/.config/git` on Windows |
| Leak scan and cached-value check over every candidate | Only `home-path` hits, in the bookmarks and two `.desktop` files; replacing the home path clears both checks | `<HOME>` rule on the two files kept (step 6) |
| Existing `~/.bashrc` on a bare profile | Prints `omniroute.env: No such file or directory`, then the shell works | The guard removes noise; the roadmap's "breaks" overstated it (step 4) |

## Drift in generated files

**Decision: stop syncing `installed_plugins.json` and `known_marketplaces.json`.** Step 2 removes both entries and files.

They are Claude Code's install state, not settings. `lastUpdated`, `gitCommitSha`, `version` and `installPath` change
when Claude Code refreshes a marketplace or updates a plugin, and they describe a cache of about 200 MB the repo doesn't
hold. `dotfiles/linux/claude/settings.json` already declares what matters: `extraKnownMarketplaces` and `enabledPlugins`.

| Option | Preview stays clean | Restores plugins | Cost |
|---|---|---|---|
| **Stop syncing, rely on `settings.json`** (chosen) | Yes | Yes, with `plugin marketplace add` and `plugin install`, as tested | Versions float to latest; phase 7 runs the commands |
| Strip the volatile keys in both engines | Yes | No: what remains still fails with `cache-miss` | New field in two engines and the contract, and import must merge into a live file |
| Keep syncing and accept the noise | No | No | A commit whenever a timestamp moves, as in 10 of 12 commits so far |

Between this phase and phase 7 nothing gets worse: a restore from today's repo already leaves those plugins failing.
The live files stay on this machine, because import never deletes.

The other new entries are kept, because a change in them is a real setting:

| File | Who rewrites it | Handling |
|---|---|---|
| `htoprc` | htop, when settings change in its interface. Unchanged since 2026-10-23 | Keep; review the diff |
| `mimeapps.list` | The desktop, when a default app changes | Keep; review the diff |
| VS Code `settings.json` | Settings Sync, with changes from the other machine | Keep; CRLF handled by decision 2 |
| Claude `settings.json` | Claude Code, on `/config` or `plugin marketplace add` | Already synced; phase 7 checks `autoUpdate` |
| `rtk/config.toml` | Nothing seen so far. Unchanged since 2026-10-27 | Keep |

## Decisions to confirm in review

1. **The plugin state files leave the repo**, as above. A restored machine gets the latest plugin versions, not the ones
   last exported.
2. **VS Code `settings.json` gets two `sanitizeRules`:** `<HOME>`, and `<YOUR_WORK_MARKETPLACE>` for the one marketplace
   URL that names a work GitHub org. Any entry with rules compares through `same_normalized`, which ignores CR, so CRLF
   stops being drift (`crlf-unchanged` covers this). The local file isn't converted, because Settings Sync could carry
   that to the other machine or bring CRLF back. A fresh machine prompts for the new value; it has no default.
   `cSpell.userWords` holds work jargon but no names, and stays as it is. Say so in review if you want those out.
3. **Only the default VS Code profile goes in the repo**, as the roadmap lists. The named profiles stay with Settings
   Sync: they hold work config, and one has an `mcp.json`. So a full restore needs a Settings Sync sign-in, and
   `docs/restore.md` (phase 7) says so. Import can overwrite `settings.json`, and Settings Sync then spreads that to the
   other machine, so the docs step warns about it.
4. **`pypoetry/config.toml` is dropped from the inventory.** It's empty, so there's nothing to restore.
5. **Added to the inventory:** `~/.config/rtk/` (`dir`; RTK is a daily tool and these files hold no secrets), GTK
   bookmarks, `wezterm-xwayland` with its launcher, and the `disco-datos` and `mis-discos` launchers.
6. **Left out on purpose:**

   | Item | Why |
   |---|---|
   | `maku-sata-report.service`, `sata-status`, `~/sata-diagnosis/` | Diagnosis for this machine's hardware; say so in review to keep it |
   | `claude-code-url-handler.desktop` | Generated by Claude Code, holds the home path |
   | `.bash_logout` | Identical to `/etc/skel` |
   | `~/.npmrc` | One comment line, and it matches `excludePatterns` |
   | `opencode/`, `.config/tiling-assistant/`, `org.gnome.Ptyxis/session.gvariant` | Unused, or generated session state |
   | `chatLanguageModels.json`, VS Code `History/`, `globalStorage/`, `sync/` | Generated, or may hold credentials |

7. **`gh/config.yml` and `htoprc` come back as `644`, not `600`.** Git keeps only the executable bit, and neither file
   holds a secret; `hosts.yml` stays excluded.
8. **The launchers and bookmark that use `/mnt/Data` are synced as they are.** The mount isn't, so `docs/restore.md`
   lists it in phase 7.

## Shared rules

- Branch `feat/linux-configs`, one commit per step, one draft PR opened at step 1 and marked ready at step 11. Commits
  carry the `Plan-Step` and `Route` trailers.
- From step 1 on, each step lands with `git push`, then `gh run watch` on the `ci` run. A red job counts as a rejection.
- Workers use `tests/fixtures/user-values.json` only. They never open, copy or print `.user-values.json`, and they never
  read the real home. Steps that read it are `[inline]`.
- Before each `./export.sh`, run `./sync preview`. If it shows a file that step doesn't own, stop: that's a real change
  and goes in its own sync PR on `master`.
- After each export, `git status --short` lists only that step's paths, and `git diff` is read in full before committing.
  The repo is public.
- No engine change in this phase, so `docs/sync-contract.md` doesn't change.

## What verifies each step

| Step | Local | CI | Windows machine |
|---|---|---|---|
| 1 Harness | `engine.sh` with the real config | `engine-linux` | none |
| 2 Plugin state | `engine.sh`, `./sync preview` | `lint`, `leak-scan` | none |
| 3 Git ignore | `git check-attr`, `engine.sh` | `engine-windows` | **W6** |
| 4 to 7 Linux entries | `engine.sh`, `./sync preview` | `lint`, `leak-scan`, `engine-linux` | none |
| 8 Round trip, bash | `engine.sh` | `engine-linux` | none |
| 9 Round trip, PowerShell | none | `engine-windows` | **W6** |
| 10 Docs | read through | `lint` | none |
| 11 Verify | all, plus a throwaway restore | all | none |
| 12 This machine | manual | none | none |

## Steps

### 1. The test harness ignores the host's git config `[worker:low]`

Files: `tests/linux/engine.sh`.

Write the case first, then the fix.

- New case `host-git-config-ignored`, added to the case list and the `case` statement. Fail if
  `git config --list --show-scope` prints a line that starts with `global` or `system`.
- After `rc=0` in the header, before the helpers:

```bash
# Cases build repos with git outside the throwaway HOME. Keep the host's git
# config, ignore and attributes files out of them: core.autocrlf=input rewrites
# fixture line endings in the commit.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 XDG_CONFIG_HOME=/nonexistent
```

| Case | Without the fix | With the fix |
|---|---|---|
| `host-git-config-ignored` | Fails, names the case | Passes |
| `preview-no-changes` | Fails on this machine | Passes |

Test, by the main session on this machine, with no overrides in the environment:

1. `git config --global core.autocrlf` prints `input`, so the real config is in place.
2. `tests/linux/engine.sh` exits 0 with 107 `ok` lines, none skipped by a filter, and no `CRLF will be replaced`
   warning.
3. `H=$(mktemp -d); printf '[core]\n\tautocrlf = input\n' > "$H/.gitconfig"; HOME=$H tests/linux/engine.sh
   preview-no-changes` passes. The same command failed before the fix.

### 2. Stop syncing plugin install state `[worker:low]`

Files: `sync-config.json`, `dotfiles/linux/claude/plugins/` (`git rm`), `tests/linux/engine.sh`, `README.md`.

- Remove the entries for `installed_plugins.json` and `known_marketplaces.json`. Leave `settings.json` and its rules
  alone.
- `git rm` both files.
- `real-config-roundtrip`: fail if `$t/home/.claude/plugins` exists after import.
- `README.md`: line 46 says `Hooks, plugin declarations, permissions`, delete line 51, and add `plugin install state` to
  the "Never synced" sentence.

Test: `tests/linux/engine.sh` green, including no `ORPHAN` in `real-config-roundtrip`; `scripts/ci/check-config.sh` OK.

Then the main session runs `claude plugin marketplace update` and `./sync preview`: no plugin paths and no changes. Also
`jq -r '.enabledPlugins | keys[] | split("@")[1]' dotfiles/linux/claude/settings.json` prints only names that are keys of
`.extraKnownMarketplaces`.

### 3. Sync `~/.config/git/ignore` `[inline: reads the real home]`

Files: `sync-config.json`, `dotfiles/common/git/ignore`.

The item deferred from phase 3. `core.excludesFile` isn't set, so git finds this file at its default path on both
systems.

| `repoPath` | `localPath` | `platform` | Description |
|---|---|---|---|
| `dotfiles/common/git/ignore` | `~/.config/git/ignore` | `common` | Global git ignore rules |

Run `./export.sh`.

Test: `git check-attr eol dotfiles/common/git/ignore` says `lf`; `engine.sh` green; `./sync preview` clean after the
commit. `engine-windows` stays green: the folder is missing in the fake profile, so import reports `SKIPPED` until
step 9.

### 4. Guard OmniRoute, sync the shell files `[inline: edits the real home]`

Files: `~/.bashrc`, `sync-config.json`, `dotfiles/linux/shell/.bashrc`, `dotfiles/linux/shell/.profile`,
`tests/linux/engine.sh`.

- Keep a copy as `~/.bashrc.bak`, then change the OmniRoute line, using the file's own nvm idiom:

```bash
[ -s "$HOME/.config/opencode/omniroute.env" ] && \. "$HOME/.config/opencode/omniroute.env"
```

| `repoPath` | `localPath` | `platform` | Description |
|---|---|---|---|
| `dotfiles/linux/shell/.bashrc` | `~/.bashrc` | `linux` | Bash run commands |
| `dotfiles/linux/shell/.profile` | `~/.profile` | `linux` | Login shell profile |

- `real-config-roundtrip`: replace the line that fails when `.bashrc` exists. Now `$t/home/.bashrc` must equal
  `dotfiles/linux/shell/.bashrc`, which proves the Linux entry ran and the Windows one didn't.
- Run `./export.sh`.

Test:

1. `T=$(mktemp -d); cp dotfiles/linux/shell/.bashrc "$T/"; env -i HOME="$T" PATH=/usr/bin:/bin TERM=xterm bash -ic 'echo
   READY'` prints `READY` and no `omniroute.env` line.
2. A new interactive shell on this machine still loads the OmniRoute values: `bash -ic 'compgen -e | wc -l'` prints the
   same number before and after the edit.
3. `engine.sh` green; the diff has no key value in it.

### 5. Terminal tools `[inline: reads the real home]`

Files: `sync-config.json`, `dotfiles/linux/{tmux,starship,wezterm,htop,gh,rtk}/`.

| `repoPath` | `localPath` | Type |
|---|---|---|
| `dotfiles/linux/tmux/.tmux.conf` | `~/.tmux.conf` | file |
| `dotfiles/linux/starship/starship.toml` | `~/.config/starship.toml` | file |
| `dotfiles/linux/wezterm/wezterm.lua` | `~/.config/wezterm/wezterm.lua` | file |
| `dotfiles/linux/htop/htoprc` | `~/.config/htop/htoprc` | file |
| `dotfiles/linux/gh/config.yml` | `~/.config/gh/config.yml` | file |
| `dotfiles/linux/rtk` | `~/.config/rtk` | `dir` |

All `"platform": "linux"`. Keep `wezterm.lua` as a file entry: step 6 adds more files to that repo folder that don't
come from `~/.config/wezterm`. Run `./export.sh`.

Test: `git ls-files dotfiles | grep hosts.yml` prints nothing; `rtk/pipeline.toml` names `GEMINI_API_KEY` as an env var
and holds no value; `engine.sh` green; `./sync preview` clean after the commit.

### 6. Desktop files `[inline: reads the real home]`

Files: `sync-config.json`, `dotfiles/linux/gnome/`, `dotfiles/linux/wezterm/`.

| `repoPath` | `localPath` | Rules |
|---|---|---|
| `dotfiles/linux/gnome/mimeapps.list` | `~/.config/mimeapps.list` | none |
| `dotfiles/linux/gnome/bookmarks` | `~/.config/gtk-3.0/bookmarks` | `<HOME>` |
| `dotfiles/linux/gnome/applications/disco-datos.desktop` | `~/.local/share/applications/disco-datos.desktop` | none |
| `dotfiles/linux/gnome/applications/mis-discos.desktop` | `~/.local/share/applications/mis-discos.desktop` | none |
| `dotfiles/linux/wezterm/wezterm-xwayland` | `~/.local/bin/wezterm-xwayland` | none |
| `dotfiles/linux/wezterm/wezterm-xwayland.desktop` | `~/.local/share/applications/wezterm-xwayland.desktop` | `<HOME>` |

All `"platform": "linux"`. Each `<HOME>` rule uses `"defaultEnv": "HOME"`, like the other entries. These are separate
files, so no `dir` entry: `~/.local/share/applications` also holds generated files.

Test: `git ls-files -s dotfiles/linux/wezterm/wezterm-xwayland` shows mode `100755`; `scripts/ci/leak-scan.sh` clean;
`grep -rl "$HOME" dotfiles` prints nothing; `engine.sh` green.

### 7. VS Code `[inline: reads the real home, private value]`

Files: `.user-values.json` (local, gitignored), `sync-config.json`, `dotfiles/linux/vscode/`, `tests/linux/engine.sh`.

- Add `<YOUR_WORK_MARKETPLACE>` to `.user-values.json` with `umask 077`, reading the URL out of `settings.json` so it
  isn't typed anywhere. This session has no terminal to answer the prompt.

| `repoPath` | `localPath` | Type |
|---|---|---|
| `dotfiles/linux/vscode/settings.json` | `~/.config/Code/User/settings.json` | file, two rules |
| `dotfiles/linux/vscode/snippets` | `~/.config/Code/User/snippets` | `dir` |

Rules on `settings.json`: `<HOME>` with `"defaultEnv": "HOME"`, and `<YOUR_WORK_MARKETPLACE>` with the prompt
`Work plugin marketplace URL` and no default.

- `real-config-roundtrip`: add `"<YOUR_WORK_MARKETPLACE>": "https://example.com/plugins"` to the fake values.
- Take `sha256sum` of the local `settings.json`, run `./export.sh`, read the whole diff.

Test:

1. The local `settings.json` hash is unchanged, so it's still CRLF.
2. `git ls-files --eol dotfiles/linux/vscode/settings.json` shows `i/lf`.
3. After the commit, `rm dotfiles/linux/vscode/settings.json`, `git restore` it, then `./sync preview` reports nothing.
   This is the CRLF drift test: the repo copy is now LF and the local one CRLF.
4. `git grep -il` for the org name, read from `.user-values.json`, prints nothing on the branch.
5. `engine.sh` green.

### 8. Round trip covers the new entries, bash `[worker]`

Files: `tests/linux/engine.sh`.

Extend `real-config-roundtrip`. It already imports into a fresh `HOME` with fake values and exports back.

| Check after import | Expected |
|---|---|
| `$t/home/.config/git/ignore` | Same bytes as `dotfiles/common/git/ignore` |
| `$t/home/.local/bin/wezterm-xwayland` | Executable |
| `$t/home/.local/share/applications/wezterm-xwayland.desktop` | Has `Exec=$t/home/.local/bin/wezterm-xwayland`, no `<HOME>` |
| `$t/home/.config/gtk-3.0/bookmarks` | Has `file://$t/home/Documents`, no `<HOME>` |
| `$t/home/.config/Code/User/settings.json` | Has `https://example.com/plugins`, no `<YOUR_` |
| `$t/home/.config/Code/User/snippets/` | Has at least one file |
| `$t/home/.config/gh/hosts.yml` | Doesn't exist |
| `$t/home/.config/rtk/config.toml` | Exists |

The placeholder check at the end of the case covers every imported file: `grep -rlE '<(HOME|YOUR_[A-Z_]+)>' "$t/home"`
prints nothing.

Test: `tests/linux/engine.sh real-config` green; change one expected value locally and see it fail, then put it back.

### 9. Round trip covers the common ignore file, PowerShell `[worker]`

Files: `tests/windows/Engine.Tests.ps1`.

In the real-config round trip, near line 1161, create `.config\git` with the other parent folders, because the Windows
engine skips an entry whose target folder is missing. After import:

- Add `.config\git\ignore` to the `Should -Exist` list.
- `.config\git\ignore` has no CR byte, like the check on `.claude\RTK.md`.
- `.tmux.conf`, `.config\gh` and `.config\rtk` `Should -Not -Exist`: no Linux entry ran.

Test: CI `engine-windows` green, and the case shows in the job's log. `pwsh` can only parse the file here.

### 10. Docs `[inline: user-facing copy]`

Files: `docs/layout.md`, `docs/daily-workflow.md`, `docs/plan-restructure.md`, `README.md`, `TODO.md`.

- `docs/layout.md`: the tree gains the new folders. New sections: "Why plugin state isn't synced" (declared in
  `settings.json`, install state is generated), and "VS Code and Settings Sync" (repo holds the default profile only,
  and import can overwrite what Settings Sync then spreads).
- `docs/daily-workflow.md`: under the export section, what preview may show without you changing a file (`htoprc`,
  `mimeapps.list`, VS Code settings from the other machine), and to read that diff rather than revert it.
- `README.md`: the list of what's synced gains the new tools.
- `docs/plan-restructure.md`:
  - Inventory: `~/.config/git/ignore` done; the `pypoetry` item removed; rtk, bookmarks and launchers added; profiles
    noted as Settings Sync.
  - Phase 7 gains: read `extraKnownMarketplaces` and `enabledPlugins` from `settings.json`, run `claude plugin marketplace
    add` for each source, then `claude plugin install` for each plugin. `sigil` needs its `ref`, so check how `add`
    takes one. `add` dropped `autoUpdate: true` from `settings.json` in the test, so run this before the import that
    writes `settings.json`, or import again after it, and end on a clean `./sync preview`.
  - `docs/restore.md`: Settings Sync sign-in for profiles and extensions; the `/mnt/Data` mount; this machine has no ssh
    keys today, so that checklist item depends on the machine.
- `TODO.md`: add **W6** to the Windows checks: create `~/.config/git`, run `import.bat`, expect `CREATED` or `UNCHANGED`
  for `dotfiles/common/git/ignore`, then `git check-ignore -v` on a path named `.claude/settings.local.json` shows it.
  If the folder is missing, import reports `SKIPPED`.

Test: read through; `git grep -il` for the work org prints nothing.

### 11. Verify and PR `[inline: final review]`

1. `tests/linux/engine.sh` green with the real config; shellcheck clean; `scripts/ci/check-config.sh` OK;
   `scripts/ci/leak-scan.sh` clean; `grep -rl "$HOME" dotfiles` prints nothing.
2. Restore in a throwaway clone with a copy of `.user-values.json`: `HOME=$(mktemp -d) ./import.sh --force < /dev/null`,
   no `ERROR`. Then `./export.sh` with that `HOME` reports the repo up to date, `git status --short` is empty, and
   `git config --file "$HOME/.gitconfig" --includes -l` shows the `.gitconfig.local` lines. Delete the clone.
3. Nothing in the repo is in the roadmap's never-in-repo list: `git ls-files` has no `hosts.yml`, `*.env`,
   `accounts.json` or `.claude.json`.
4. `gh pr ready`. `leak-scan`, `lint`, `engine-linux`, `engine-windows` green.
5. `/agent-skills:review` of the phase diff.
6. The PR touches none of the paths that block auto-approval, so Claude may add `reviewed` and merge once the conditions
   in `CLAUDE.md` hold.

### 12. Check this machine `[inline: the real home]`

After the merge: `git switch master && git pull`.

1. `./sync preview` prints that nothing would change.
2. `./import.sh` run from a terminal reports only `UNCHANGED` and writes no `.bak`. `settings.json` stays `UNCHANGED` even
   though it's CRLF locally.
3. Run `claude plugin marketplace update` and start a VS Code window, then `./sync preview` again: still clean.
4. `tmux`, `starship`, `gh`, WezTerm and VS Code open as before.
5. Delete `~/.bashrc.bak` once a new terminal works.

## Not in this plan

- `gnome-workspace-keys-restore.sh` in the home folder sets four keybindings; phase 5's dconf dump covers them.
- Guards for `zoxide` and `starship` in `.bashrc`: bootstrap installs them before import (phase 7).
- `.gitattributes` for `dotfiles/windows/` (phase 8).
- VS Code on Windows (phase 8).
- A lint rule that `enabledPlugins` names a declared marketplace (phase 7, with the restore that needs it).

## Done when

- `tests/linux/engine.sh` passes on this machine with the real `~/.gitconfig`.
- `grep -rl "$HOME" dotfiles` prints nothing, and the leak scan is clean.
- `real-config-roundtrip` covers the new entries on `engine-linux`, and `common/git/ignore` on `engine-windows`.
- `./sync preview` stays clean after a marketplace update and with CRLF in the local VS Code settings.
- A fresh interactive shell from the repo's `.bashrc` prints no OmniRoute error.
- `TODO.md` lists W6, and the roadmap's phase 7 has the plugin restore steps.
