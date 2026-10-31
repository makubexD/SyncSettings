# SyncSettings v2: common / windows / linux, full-machine restore, gated PRs

## Context

The repo began as a Windows-only settings store and its Windows flow works well (`export.bat` → review →
`commit.bat`, `import.bat` with prompts, `.bak` backups, sanitized placeholders). PR #1 (`feat/linux-claude`, merged as
`6f0ef3d`) added Linux in a "hard compatibility" style: Windows files at the root of `dotfiles/`, Linux under
`dotfiles/linux/`, an entry without `platform` silently means Windows, nothing can be shared.

Goals:
1. Clear layout: platform (`common`/`windows`/`linux`) → tool, readable at a glance.
2. Full-machine restore: lose the computer → clone, run a couple of commands → configs, aliases, packages back.
3. Keep the proven Windows flow; give Linux the same flow (same contract, native engine per OS).
4. Every change lands through a PR that CI holds red until it's reviewed (label `reviewed`), then green → merge.

Baseline for comparison: `02c6aa7` (last commit before PR #1). All post-PR-#1 work is kept.

## Review: PR #1 and existing files

| Today | Verdict | Why |
|---|---|---|
| `dotfiles/.gitconfig` | split common + windows | identity, core, diff/merge, aliases portable; `[credential*]` is Windows (`manager`, `gh.exe`) |
| `dotfiles/.bashrc`, `.bashrc.linked/…/vs.bat`, `.bash_profile` | windows/shell | Git-for-Windows (`PATHEXT`, `/c/MakuCustomAlias`) |
| `dotfiles/WindowsTerminal/settings.json` | windows/windows-terminal | |
| `linux/claude/RTK.md`, `docs/token-routing-map.html` | common/claude | platform-neutral |
| `linux/claude/` rest, `linux/claude-worker/` | linux | bash, nvm, `mk-exec` |
| `linux/claude/sampleGrok.md`, `docs/plan-linux.md` | drop | leftovers |
| `sync-config.json` | rework | implicit Windows default, mixed `~\\`/`~/` |

## Review: the sync engines

Same flow on both sides: export (content compare, sanitize, copy changed) → commit → import (prompt, `.bak`, hydrate).

| Behavior | Windows (PS 5.1) | Linux (bash) | Action |
|---|---|---|---|
| platform filter | no field = Windows | `== "linux"` | required `common\|windows\|linux`, both accept `common` |
| `defaultEnv` on rules | missing | yes | add to PS |
| `escapeBackslashes` | yes | missing | add to bash (needed for common rules later) |
| infer placeholder values from existing local file | yes (`Import-Settings.ps1:102`) | missing | add to bash |
| directory sync w/ orphan removal | only via `detectLinkedPaths` | missing | generic `"type": "dir"` entry in both (Claude skills, VS Code snippets) |
| missing target folder on import | skip ("app not installed") | `mkdir -p` | keep, document as contract difference |
| entry removed/renamed in config | ignored | ignored | export reports repo files not owned by any entry |
| commit stages | `dotfiles/` only | `dotfiles/` only | `dotfiles/ packages/ sync-config.json` |
| commit target | push to current branch (master) | same | branch + PR (below) |
| repo behind origin | not checked | not checked | export/commit warn and offer `git pull --ff-only` |

Decision: keep two native engines (PowerShell 5.1 ships with Windows; bash on Linux) bound by a written contract
(`docs/sync-contract.md`) and the same fixture tests run on both OSes in CI.

## Inventory of this Linux machine (not synced today)

| Item | Target |
|---|---|
| `~/.bashrc` (nvm, bun, fzf, zoxide, starship, `fd`, `cproj`), `~/.profile` | Done in phase 4: linux/shell, `omniroute.env` line guarded |
| Linux gitconfig bits (`/usr/bin/gh` helper), `init.defaultBranch=main` | Done in phase 3: linux/git/.gitconfig.local; `defaultBranch` → common |
| `~/.config/git/ignore` | Done in phase 4: common/git/ignore |
| `.tmux.conf`, `starship.toml`, `wezterm.lua`, `htoprc` | Done in phase 4: linux/{tmux,starship,wezterm,htop} |
| `~/.config/gh/config.yml`, `~/.config/rtk/` | Done in phase 4: linux/{gh,rtk} |
| VS Code default profile: `settings.json`, `snippets/` | Done in phase 4: linux/vscode |
| VS Code extensions (73) | packages; named profiles stay with Settings Sync |
| `mimeapps.list`, GTK bookmarks, `disco-datos` and `mis-discos` launchers | Done in phase 4: linux/gnome |
| `wezterm-xwayland` and its launcher | Done in phase 4: linux/wezterm |
| dconf (Ptyxis, favorites, `clipboard-history` extension, tiling-assistant, nautilus) | linux/gnome |
| Nerd Fonts | packages/linux/fonts.txt (downloaded, not stored) |
| `~/.local/bin` links to `~/.claude/bin/*` | created by bootstrap |
| apt (+ brave, chrome, gh, wezterm sources), snap (code, postman), npm globals, pipx poetry, bun, rtk, claude, copilot, dotnet-sdk-10 | packages/linux/* |
| **Never in repo**: gh `hosts.yml`, `claude-workers/env`, `omniroute.env`, ssh keys, `~/.gnupg`, `~/.claude.json`, `repown/accounts.json` | manual steps in `docs/restore.md` |

Windows candidates (inventory on that machine, phase 8): `winget export`, PowerShell `$PROFILE`, VS Code
`%APPDATA%\Code\User`, `~/.ssh/config`, `.minttyrc`, PowerToys backup, npm globals, user env vars/PATH.

## Target layout

```
dotfiles/
  common/   git/.gitconfig  git/ignore  claude/RTK.md  claude/docs/token-routing-map.html
  linux/    shell/  git/.gitconfig.local  tmux/  starship/  wezterm/  htop/  gh/  rtk/
            vscode/  gnome/  claude/  claude-worker/
  windows/  shell/(.bashrc .bash_profile .bashrc.linked/)  git/.gitconfig.local  windows-terminal/  (+ phase 8)
packages/   linux/{apt.txt,apt-sources/,snap.txt,npm.txt,pipx.txt,vscode-extensions.txt,fonts.txt}  windows/winget.json
bootstrap/  linux.sh  windows.ps1
scripts/    windows/*.ps1   linux/sync.sh
tests/      fixtures/  engine.bats-or-sh  Engine.Tests.ps1
.github/    workflows/{review-gate.yml,ci.yml}  pull_request_template.md
docs/       (see Documentation below)
export.* import.* commit.*   README.md   sync-config.json
```
- `common/git/.gitconfig` → `~/.gitconfig` with `[include] path = ~/.gitconfig.local`.
- Package lists are curated; `export` prints drift, never rewrites them.

## PR + review gate

- `commit.bat` / `commit.sh`: refuse on a dirty non-sync tree; create `sync/<platform>-<host>-<yyyymmdd-hhmm>`
  from up-to-date `master`, stage `dotfiles/ packages/ sync-config.json`, commit (existing auto message), push,
  `gh pr create --fill` with the change list, print the PR URL, return to `master`. gh is on both machines.
- `.github/workflows/review-gate.yml` on `pull_request` [opened, reopened, synchronize, labeled, unlabeled]:
  `synchronize` removes the `reviewed` label (new commits need a new review); job fails with
  "Review pending: add the `reviewed` label" unless the label is present. GitHub sends the failed-run
  notification (email/mobile) → you review → add label → check reruns green → merge.
- `ci.yml` (real checks): leak scan (real `/home/<user>`, `C:\Users\<user>`, emails, key/token patterns in
  `dotfiles/ packages/`), lint (shellcheck, shfmt, PSScriptAnalyzer, `sync-config.json` schema: platform required,
  repoPath prefix matches platform), engine fixture tests on `ubuntu-latest` + `windows-latest` (PS 5.1), and later
  a bootstrap dry-run in an ubuntu container.
- Branch protection on `master`: PR required, required checks `review-gate` + `ci` jobs, applies to admins,
  delete branch on merge. (Changes repo settings on GitHub; I'll confirm before running the `gh api` call.)
- Claude's own feature branches go through the same gate.

## Documentation

README stays a short landing page; everything else lives in `docs/`, one topic per file, linked from the README.

**`README.md`** (one screen or two):
- Title, one-line pitch, badges (CI, review-gate, license).
- "What it does" diagram (Mermaid, rendered by GitHub): machine ⇄ export/import ⇄ repo ⇄ PR + gate ⇄ master.
- **Quick start** with tabs-like `<details>` per OS, three commands each:
  - New Linux machine: `git clone … && cd SyncSettings && ./bootstrap/linux.sh`
  - New Windows machine: `git clone …` → `bootstrap\windows.ps1`
  - Daily: `./export.sh` → `./commit.sh` (opens PR) → add `reviewed` → merge.
- Repo map (the platform → tool tree, one line per folder).
- "Read next" table linking every doc.

**`docs/`**:
| File | Content |
|---|---|
| `getting-started.md` | prerequisites per OS, first clone, first export/import, `.user-values.json` |
| `restore.md` | lost-machine runbook per OS: bootstrap, then the manual secret steps (gh auth, ssh key, Claude login, DeepSeek key) as a checklist |
| `daily-workflow.md` | export → commit → PR → review label → merge → import on the other machine; Mermaid sequence diagram |
| `layout.md` | `common/windows/linux` rules, how to decide where a file goes (decision table), naming |
| `configuration.md` | `sync-config.json` reference: fields, `platform`, `sanitizeRules` (`default`, `defaultEnv`, `escapeBackslashes`), `type: dir`, `detectLinkedPaths`, dconf, `excludePatterns`; copy-paste examples |
| `adding-a-file.md` | step-by-step recipe with an example per platform |
| `packages.md` | package lists format, drift report, adding/removing packages |
| `review-gate.md` | how CI + the `reviewed` label work, notifications setup, branch protection |
| `sync-contract.md` | engine behavior contract (statuses, prompts, backups, sanitize, parity table) for contributors |
| `security.md` | what never goes in the repo, exclude patterns, leak scan, how `.user-values.json` is handled |
| `troubleshooting.md` | FAQ: placeholder prompts in non-interactive runs, `.bak` files, elevation, CRLF, gate stuck red |

Style: GitHub alerts (`> [!TIP]`, `> [!WARNING]`) for gotchas, Mermaid for flows, `<details>` for long output
samples, every command copy-pasteable, consistent headings. CI adds `markdownlint` + a link check (lychee) so docs
don't rot. Each phase updates the docs it touches; repo `CLAUDE.md` is trimmed to point at `docs/` for details.
`docs/plan-*.md` stay as working plans and aren't linked from the README.

## Roadmap (commit as `docs/plan-restructure.md`; one step-level `docs/plan-restructure-<phase>.md` per phase)

1. **PR flow + gate first**, so every later phase lands gated: `review-gate.yml`, `ci.yml` (leak scan + lint),
   PR template, commit scripts → branch + PR, `reviewed` label, branch protection.
2. **Engine contract + parity**: move scripts to `scripts/windows|linux` (fix `.bat`, `source`, `$repoRoot`);
   write `docs/sync-contract.md`; required `platform` with `common`; parity items from the table; fixture tests
   for both engines wired into `ci.yml`.
3. **Re-layout existing files**: `git mv` to platform → tool, rewrite `sync-config.json`, split `.gitconfig`
   (`[inline]`), `.gitattributes` (`dotfiles/common/** text eol=lf` and `dotfiles/linux/** text eol=lf`).
4. **Linux configs** from the inventory (+ `.bashrc` guard); `grep -rl "$HOME" dotfiles` empty.
5. **dconf** entries (`{path, repoPath}`): dump on export, load on import.
6. **Packages + drift report** (`packages/linux/*`, curated; drift in `export.sh`).
7. **`bootstrap/linux.sh` + `docs/restore.md`**: idempotent install (apt sources/keyrings, apt, snap, nvm + node + npm
   globals, pipx, bun, rtk, claude, fonts, VS Code extensions) → `import.sh` → links; bootstrap dry-run in CI.
   - Plugins: read `extraKnownMarketplaces` and `enabledPlugins` from `settings.json`, run `claude plugin marketplace add`
     for each source, then `claude plugin install` for each plugin. `sigil` needs its `ref`, so check how `add` takes
     one. `add` dropped `autoUpdate: true` from `settings.json` in testing, so run this before the import that writes
     `settings.json`, or import again after it, and end on a clean `./sync preview`.
   - CI lint: `enabledPlugins` must name a declared marketplace.
   - `docs/restore.md`: Settings Sync sign-in for VS Code profiles and extensions; the `/mnt/Data` mount that the
     launchers and bookmark use; ssh keys depend on the machine, and this one has none today.
8. **Windows**: inventory on the Windows machine, add its configs, `winget.json`, `bootstrap/windows.ps1`.
9. **Cleanup + docs polish**: drop `sampleGrok.md`, `docs/plan-linux.md`; final README landing page, fill any
   `docs/` gaps, Mermaid diagrams, badges, markdownlint + link check in CI, trim repo `CLAUDE.md`
   (`[inline]`: user-facing copy). Phases 1–8 each update their own doc pages as they go.

## Verification

- Phase 1: open a test PR → `review-gate` red + notification; add `reviewed` → green; push again → label removed,
  red; merge blocked until green.
- Engines: CI fixture tests green on both OSes; locally `HOME=$(mktemp -d) ./import.sh --force < /dev/null`
  then `./export.sh` → no diff; `git config --file $HOME/.gitconfig --includes -l` shows `.gitconfig.local` lines.
- Windows phases: you run `export.bat` (expect no changes), `import.bat`, `commit.bat` → PR opened.
- Bootstrap: container dry-run in CI; end-to-end on a fresh VM when convenient.
- Docs: markdownlint + link check green; follow the README quick start literally in a throwaway HOME / VM.
- End: `/agent-skills:review` of each phase PR; leak scan clean.
