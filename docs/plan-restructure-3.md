# Phase 3: Re-layout existing files

Roadmap: `docs/plan-restructure.md`. Goal of this phase: every synced file lives under `dotfiles/<platform>/<tool>/`,
`.gitconfig` is split into a common part and one local part per OS, the first `dir` entries exist, and lint enforces
the new layout. Local paths in the moved Windows entries don't change.

No Windows machine is available during this phase. Every PowerShell change is checked by `engine-windows`, and step 16
adds a round trip of the real config on `windows-latest`. What only a real machine can prove is listed under
[Later on the Windows machine](#later-on-the-windows-machine), and step 17 copies that list into `TODO.md`.

Out of scope: new Linux configs other than `.gitconfig.local` (phase 4), dconf (phase 5), packages (phase 6), new
Windows configs (phase 8), dropping `sampleGrok.md` (phase 9), the Node port (`docs/plan-safety-fixes.md`, its own plan).

## Findings that shaped this plan

All from a throwaway clone and `HOME`, or read-only checks on this machine.

| Finding | Result | Effect |
|---|---|---|
| `dotfiles/{common,linux}/** text eol=lf` from the roadmap | `git check-attr` reports `eol: unspecified`; gitattributes has no brace expansion | Two lines in step 6 |
| Common `.gitconfig` with the credential block removed | Replaces the Linux `~/.gitconfig`, which holds the `gh` helpers | Linux `.gitconfig.local` moves here from phase 4 (step 10) |
| `./export.sh` before import on this machine, after the split | `MODIFIED`, 84 lines deleted from the common file | Import first; step 19 runs straight after the merge |
| Import with `<YOUR_NAME>` and `<YOUR_EMAIL>` not cached | Inference compares line by line, the Linux file has a different layout, so import stops before writing anything | Step 19 needs a terminal |
| `dir` entry on `~/.claude/skills` | Would take `synced/`, 4.6 MB managed by Claude Code | One `dir` entry per skill |
| `dir` entry on `~/.claude/bin` | `bin/tests/` has 13 `home-path` leak-scan hits, and `dir` entries can't have rules | `bin/` stays as file entries |
| Live `settings.json` calls `hooks/metrics-capture.sh` | The file isn't synced, so a restored machine has a broken hook | `hooks` becomes a `dir` entry (steps 12, 13) |
| `./sync preview` today | 4 files drifted: `CLAUDE.md`, `settings.json`, `mk-delegate/SKILL.md`, `known_marketplaces.json` | Step 1 syncs them first |
| Blobs under `dotfiles/` | All `i/lf`; `git add --renormalize` changes nothing | Step 6 rewrites no content |

## Decisions to confirm in review

1. **Linux `.gitconfig.local` lands in this phase**, not phase 4. Without it, the first import after the split removes
   the `gh` credential helpers from this machine.
2. **`init.defaultBranch = main` goes to the common file**, as the roadmap's inventory says. The Windows machine gains
   it; today it has no such setting.
3. **`detectLinkedPaths` stays for now.** Decision 5 of `docs/plan-safety-fixes.md` recommended replacing it with `dir`
   entries, but `/c/MakuCustomAlias` is outside `~`, `localPath` must start with `~`, and moving the folder would change
   a local path. It can be revisited in phase 8, when the folder can be inspected.
4. **`.gitconfig` is the one Windows path whose spelling changes.** Lint requires `common` entries to start with `~/`,
   so `~\\.gitconfig` becomes `~/.gitconfig`. It is the same file on Windows. `.bashrc`, `.bash_profile` and the Windows
   Terminal entry stay byte-identical, and the new Windows `.gitconfig.local` uses `~\\.gitconfig.local`.
5. **`dir` entries:** `hooks`, `skills/mk-check`, `skills/mk-delegate`. A new skill needs its own entry. `bin/` gains a
   file entry for `metrics-archive`; `bin/tests/` stays out of the repo.
6. **Lint rejects any entry inside a `dir` entry**, including a nested `dir`. That is wider than the carried item, which
   names `file` entries, because a nested `dir` loses files the same way and the rule is the same line.
7. **An empty local folder keeps the repo files** (`SKIPPED`), on both engines. PowerShell linked folders share the
   code, so they get the same guard.
8. **The PR merges on CI without the Windows checks.** The Windows clone stays on the old layout until it is pulled,
   and the checks below run then.

## Shared rules

- Branch `feat/re-layout`, one commit per step, one PR, opened as a draft at step 2 and marked ready at step 18. Step 1
  is its own sync PR on `master`, merged first. Commits carry the `Plan-Step` and `Route` trailers.
- Bash and PowerShell rules from `docs/plan-restructure-2.md` apply. Every behavior change adds fixture cases and updates
  `docs/sync-contract.md`.
- Workers use `tests/fixtures/user-values.json` only. They never open, copy or print `.user-values.json`, and they never
  read `~/.claude` or `~/.gitconfig`. Steps that need the real home are `[inline]`.
- A move commit changes paths only, so `git log --follow` keeps the history. Each one checks
  `git diff -M --summary HEAD~ HEAD` for `rename … (100%)`. The content edit comes in its own commit.
- From step 2 on, each step lands with `git push`, then `gh run watch` on the `ci` run. A red job counts as a rejection.
- Never run `./export.sh` or `./sync export` against the real `HOME` between step 9 and step 19. `./sync preview` is
  safe but will show `.gitconfig` as changed.

## What verifies each step

CI runs the real engines but with a fake profile. It proves paths, platform filters, hydration and the git include. It
can't prove that the real Windows files match the repo.

| Step | Local | CI | Windows machine |
|---|---|---|---|
| 1 Sync drift | `./sync preview` | `leak-scan`, `lint` | none |
| 2 Lint script | `engine.sh` | `lint`, `engine-linux` | none |
| 3 Inside-`dir` rule | `engine.sh` | `lint`, `engine-linux` | none |
| 4 Empty folder, bash | `engine.sh` | `engine-linux` | none |
| 5 Empty folder, PowerShell | none | `engine-windows` | none |
| 6 `.gitattributes` | `git check-attr` | `engine-windows` via step 16 | W3 |
| 7 Move shell files | `engine.sh` | `engine-windows` via step 16 | **W1, W3, W4** |
| 8 Move Windows Terminal | `engine.sh` | `engine-windows` via step 16 | **W1, W3, W4** |
| 9 Move `.gitconfig` | `engine.sh` | `engine-windows` via step 16 | **W1, W2** |
| 10 Split `.gitconfig` | `git config` checks | `engine-windows` via step 16 | **W1, W2** |
| 11 Common Claude files | `engine.sh` | `engine-windows` via step 16 | **W1, W3** |
| 12, 13 `dir` entries, `metrics-archive` | `engine.sh` | `engine-linux`, `leak-scan` | none (Linux only) |
| 14 Tighten rule | `engine.sh` | `lint`, `engine-linux` | none |
| 15 Round trip, bash | `engine.sh` | `engine-linux` | none |
| 16 Round trip, PowerShell | none | `engine-windows` | none |
| 17 Docs | read through | `lint` | none |
| 18 Verify | all | all | none |
| 19 Migrate this machine | manual | none | none |

Steps 7 to 11 are the ones to recheck on Windows, in the order below.

## Steps

### 1. Sync the drift on this machine `[inline: reviews real content]`

On `master`: `./sync preview`, read the four diffs, `./sync export`, `./sync commit`, then merge through the normal gate.

Test: after the merge and `git pull`, `./sync preview` prints that nothing would change.

### 2. Move config lint into a script `[worker:low]`

Files: `scripts/ci/check-config.sh` (new, executable), `.github/workflows/ci.yml`, `tests/linux/engine.sh`.

The rules live inline in `ci.yml`, so no test can run them. Same style as `leak-scan.sh`.

- Move the `Config sanity` jq program unchanged into `scripts/ci/check-config.sh [config-file]`, default
  `sync-config.json`. `set -euo pipefail`, exit 1 on invalid entries.
- `ci.yml`: the `Config sanity` step runs `scripts/ci/check-config.sh`. The shellcheck glob already covers it.
- `tests/linux/engine.sh`: helper `lint_run <jq-filter>` writes the filtered real config to `$t/config.json` and runs the
  script on it, storing `rc` and `$out`. Add each new case to the case list and the `case` statement.

| Case | Change | Expected |
|---|---|---|
| `lint-real-config` | none | exit 0, prints `sync-config.json: OK` |
| `lint-platform-missing` | delete `platform` from `dotfiles/linux/claude/CLAUDE.md` | exit 1, output names that repoPath |
| `lint-platform-bad` | set that entry's `platform` to `mac` | exit 1, names it |
| `lint-linux-prefix` | set that entry's `repoPath` to `dotfiles/x/CLAUDE.md` | exit 1, names it |
| `lint-dir-with-rules` | add `{repoPath: "dotfiles/linux/d", localPath: "~/d", platform: "linux", type: "dir", sanitizeRules: []}` | exit 1, names it |

Test: `tests/linux/engine.sh lint-` all `ok`; whole suite green; the draft PR's `lint` job green. Open the draft PR here.

### 3. Lint rejects an entry inside a `dir` entry `[worker]`

Carried from step 19d of `docs/plan-restructure-2.md`: lint must reject a `file` entry whose `repoPath` lies under a `dir`
entry's `repoPath`, because `export_dir` removes such a file unless it also exists in the local folder.

Files: `scripts/ci/check-config.sh`, `tests/linux/engine.sh`.

Bind the prefixes before the `$bad` list, and add one line to it. This form was run against the cases below:

```jq
(.files | map(select(.type == "dir") | .repoPath | rtrimstr("/"))) as $dirs
| [ ...,
    (.files[] | .repoPath as $p | select(any($dirs[]; . as $d | ($p // "") | startswith($d + "/"))) | $p)
  ]
```

| Case | Entries added | Expected |
|---|---|---|
| `lint-file-in-dir` | dir `dotfiles/linux/d`, file `dotfiles/linux/d/x.txt` | exit 1, names `dotfiles/linux/d/x.txt` |
| `lint-typed-file-in-dir` | as above, with `type: "file"` | exit 1, names it |
| `lint-dir-in-dir` | dir `dotfiles/linux/d`, dir `dotfiles/linux/d/e` | exit 1, names `dotfiles/linux/d/e` |
| `lint-dir-trailing-slash` | dir `dotfiles/linux/d/`, file `dotfiles/linux/d/x.txt` | exit 1, names the file |
| `lint-sibling-prefix` | dir `dotfiles/linux/d`, file `dotfiles/linux/d-old/x.txt` | exit 0, output has no `d-old` |

Test: `tests/linux/engine.sh lint-` all `ok`. Delete the new line in a scratch copy: the first four cases fail.

### 4. An empty local folder keeps the repo files, bash `[worker]`

Carried from "Not in this plan" in `docs/plan-safety-fixes.md`. Today an emptied `~/.claude/hooks` makes export delete
every repo file in that entry.

Files: `export.sh`, `tests/linux/engine.sh`, `docs/sync-contract.md`.

- `export_dir`: count the files in the first loop that pass the symlink and exclude checks. If that count is 0 and
  `$repo_dir` holds at least one file: `status SKIPPED "$repo_path/" 'local folder is empty; repo files kept'`, add 1 to
  `SKIPPED`, `return 0` before the removal loop.
- Contract, "Directory entries", after the "local folder is missing" bullet, add the same rule with the same note, and
  state that a folder holding only symlinks or excluded files counts as empty.

| Case | Setup | Expected |
|---|---|---|
| `dir-export-empty-keeps-repo` | empty local `dir/` | exit 0, the `SKIPPED` line, no `REMOVED`, both repo files byte-equal |
| `dir-export-only-excluded` | local `dir/` holds only `x.secret` | same |
| `dir-export-only-symlink` | local `dir/` holds only a symlink | same, plus the existing `symlink` line for it |
| `dir-export-one-left` | delete local `dir/a/b.txt` only | `REMOVED dotfiles/common/dir/a/b.txt`, `c.txt` kept |
| `dir-export-empty-both` | empty local `dir/`, no repo folder | exit 0, no `SKIPPED`, no `REMOVED` for the entry |

Test: `tests/linux/engine.sh dir-` all `ok`; whole suite green.

### 5. An empty local folder keeps the repo files, PowerShell `[worker]`

Files: `scripts/windows/SyncHelpers.ps1`, `tests/windows/Engine.Tests.ps1`, `docs/sync-contract.md`.

- `Sync-LinkedDirectory`: count `$sourceFiles` that pass the reparse-point and exclude checks. If 0 and `$DestDir` holds
  a file: `Write-StatusLine 'SKIPPED' "$Label/" 'local folder is empty; repo files kept'`, `$stats.skipped++`, return
  before the removal block. Linked folders use this function, so they get the guard too.
- Contract, "Linked folders": add "An empty folder keeps its repo files, like a `dir` entry."

Cases, in the same `Describe` as `dir-export-adds`: `dir-export-empty-keeps-repo`, `dir-export-only-excluded`,
`dir-export-one-left`, `dir-export-empty-both` as in step 4, plus `linked-export-empty-keeps-repo` built like
`import-linked-keeps-local`, with an empty linked folder. CI `engine-windows` green.

### 6. `.gitattributes` for `dotfiles/` `[worker:low]`

Files: `.gitattributes`.

Add these two lines. The brace form in the roadmap doesn't work. `dotfiles/windows/` gets no rule, so its files keep
today's behavior.

```
dotfiles/common/** text eol=lf
dotfiles/linux/** text eol=lf
```

Test: `git check-attr eol -- dotfiles/linux/claude/RTK.md` → `eol: lf`. `git add --renormalize dotfiles` followed by
`git status --short dotfiles` prints nothing.

### 7. Move the Windows shell files `[worker:low]`

Files: `dotfiles/.bashrc`, `dotfiles/.bash_profile`, `dotfiles/.bashrc.linked/`, `sync-config.json`.

```sh
mkdir -p dotfiles/windows/shell
git mv dotfiles/.bashrc dotfiles/.bash_profile dotfiles/.bashrc.linked dotfiles/windows/shell/
```

`sync-config.json`: `repoPath` of the two entries becomes `dotfiles/windows/shell/.bashrc` and
`dotfiles/windows/shell/.bash_profile`. Nothing else changes; `detectLinkedPaths` stays.

Test: renames at 100%. The `localPath` values match the old config:

```sh
diff <(git show HEAD~:sync-config.json | jq -S '[.files[] | select(.platform == "windows") | .localPath]') \
     <(jq -S '[.files[] | select(.platform == "windows") | .localPath]' sync-config.json)
```

`scripts/ci/check-config.sh` OK; `tests/linux/engine.sh path-real-config` `ok`.

### 8. Move Windows Terminal `[worker:low]`

Files: `dotfiles/WindowsTerminal/settings.json`, `sync-config.json`, `scripts/windows/SyncHelpers.ps1`.

- `git mv dotfiles/WindowsTerminal/settings.json dotfiles/windows/windows-terminal/settings.json`, and the entry's
  `repoPath`. Its long `localPath` stays exactly as it is.
- `SyncHelpers.ps1:459`, comment only: the example becomes `dotfiles/windows/shell/.bashrc`.

Test: same as step 7, and `git ls-files dotfiles | grep -c WindowsTerminal` → `0`.

### 9. Move `.gitconfig` to common, unsplit `[worker:low]`

Files: `dotfiles/.gitconfig`, `sync-config.json`.

- `git mv dotfiles/.gitconfig dotfiles/common/git/.gitconfig`.
- The entry: `repoPath` `dotfiles/common/git/.gitconfig`, `platform` `common`, `localPath` `~/.gitconfig`. Rules unchanged.

Test: renames at 100%; `scripts/ci/check-config.sh` OK; `tests/linux/engine.sh path-real-config` `ok`.

### 10. Split `.gitconfig` `[inline: judgment on what is portable]`

Files: `dotfiles/common/git/.gitconfig`, `dotfiles/windows/git/.gitconfig.local` (new),
`dotfiles/linux/git/.gitconfig.local` (new), `sync-config.json`.

- Common file: remove everything from `# ===== CREDENTIALS =====` down. Append:

  ```ini
  # ===== INIT =====
  [init]
  	defaultBranch = main

  # ===== MACHINE-SPECIFIC =====
  [include]
  	path = ~/.gitconfig.local
  ```

- Windows local: the removed block, unchanged, including its comment about the empty `helper =` line.
- Linux local:

  ```ini
  [credential "https://github.com"]
  	helper =
  	helper = !/usr/bin/gh auth git-credential
  [credential "https://gist.github.com"]
  	helper =
  	helper = !/usr/bin/gh auth git-credential
  ```

- `sync-config.json`:
  - The common entry keeps the rules `<YOUR_NAME>` and `<YOUR_EMAIL>`.
  - New `dotfiles/windows/git/.gitconfig.local`, `~\\.gitconfig.local`, `windows`, with the rules `<YOUR_GH_USERNAME>`,
    `<YOUR_GH_ORG>` and `<GH_CLI_PATH>` moved over intact, including `default` and `escapeBackslashes`.
  - New `dotfiles/linux/git/.gitconfig.local`, `~/.gitconfig.local`, `linux`, no rules.

Test: in a throwaway `HOME`, with fake values, hydrate old and new by hand with `sed`, then compare both ways:

- Windows: `git config --file <old> -l | sort` against `git config --file $HOME/.gitconfig --includes -l | sort` differs
  only by `init.defaultbranch=main` and `include.path=~/.gitconfig.local`.
- Linux: `--get-all credential.https://github.com.helper` and the same for `gist.github.com` return the same two lines
  as the real `~/.gitconfig`.

`scripts/ci/leak-scan.sh` clean.

### 11. Move the shared Claude files `[worker:low]`

Files: `dotfiles/linux/claude/RTK.md`, `dotfiles/linux/claude/docs/token-routing-map.html`, `sync-config.json`.

- `git mv` to `dotfiles/common/claude/RTK.md` and `dotfiles/common/claude/docs/token-routing-map.html`.
- Both entries: new `repoPath`, `platform` `common`. `localPath` stays.

From this step on, both entries also run on Windows. A missing `~\.claude` is `SKIPPED`.

Test: renames at 100%; `scripts/ci/check-config.sh` OK; `tests/linux/engine.sh` green.

### 12. First `dir` entries and `metrics-archive` `[worker:low]`

Files: `sync-config.json`.

- Replace the three `dotfiles/linux/claude/hooks/*` entries with one: `repoPath` `dotfiles/linux/claude/hooks`,
  `localPath` `~/.claude/hooks`, `platform` `linux`, `type` `dir`, `description` `Claude Code hook scripts`.
- Replace the two skill entries with one `dir` entry each: `dotfiles/linux/claude/skills/mk-delegate` →
  `~/.claude/skills/mk-delegate`, and the same for `mk-check`. Keep each `description`.
- Add a file entry: `dotfiles/linux/claude/bin/metrics-archive`, `~/.claude/bin/metrics-archive`, `linux`,
  `description` `Archives workflow metrics`.
- `bin/` keeps its file entries.

Test: `jq '[.files[] | select(.type == "dir")] | length' sync-config.json` → `3`; `scripts/ci/check-config.sh` OK;
`tests/linux/engine.sh path-real-config` `ok`.

### 13. Add the two unsynced files `[inline: reads the real home]`

Files: `dotfiles/linux/claude/hooks/metrics-capture.sh`, `dotfiles/linux/claude/bin/metrics-archive`.

`cp -p` both from `~/.claude`. Don't run `./export.sh` for this; see the shared rules.

Test: read both files; `scripts/ci/leak-scan.sh` clean; `git ls-files -s` shows mode `100755` for both;
`jq -r '.files[].repoPath' sync-config.json | while read -r p; do [ -e "$p" ] || echo "MISSING $p"; done` prints nothing.

### 14. Tighten the Windows rule `[worker:low]`

The rule that step 7 of `docs/plan-restructure-2.md` deferred. It needs steps 7 to 10, so it comes after them.

Files: `scripts/ci/check-config.sh`, `tests/linux/engine.sh`.

The `windows` line of the `$bad` list becomes:

```jq
(.files[] | select(.platform == "windows") | select((.repoPath // "") | startswith("dotfiles/windows/") | not) | .repoPath // "<missing repoPath>"),
```

| Case | Change | Expected |
|---|---|---|
| `lint-windows-root` | Windows entry `repoPath` → `dotfiles/.bashrc` | exit 1, names it |
| `lint-windows-sibling` | → `dotfiles/windows-old/.bashrc` | exit 1, names it |
| `lint-windows-linux-prefix` | → `dotfiles/linux/.bashrc` | exit 1, names it |
| `lint-windows-ok` | none | exit 0 |

Test: `tests/linux/engine.sh lint-` all `ok`.

### 15. Round trip of the real config, bash `[worker]`

Files: `tests/linux/engine.sh`.

Case `real-config-roundtrip`, starting from `case_path_real_config`:

- Also `cp -a "$REPO/dotfiles" "$t/repo/"`, keeping a copy at `$t/before`.
- Write `$t/repo/.user-values.json` with fake values: `<YOUR_NAME>` `Fixture User`, `<YOUR_EMAIL>`
  `fixture@example.com`, `<YOUR_GH_USERNAME>` `fixture-user`, `<HOME>` `$t/home`.
- `import.sh --force` → exit 0, no `ERROR` line.
- `export.sh` → exit 0, prints `Repo is up to date`, no line with `MODIFIED`, `ADDED`, `REMOVED`, `ORPHAN` or `ERROR`.
- `diff -r "$t/before" "$t/repo/dotfiles"` empty.
- `HOME=$t/home git config --file "$t/home/.gitconfig" --includes --get user.name` → `Fixture User`.
- The last `--get-all credential.https://github.com.helper` value → `!/usr/bin/gh auth git-credential`.
- `$t/home/.gitconfig` has no `<YOUR_`. `$t/home/.bashrc` and `$t/home/.gitconfig.bak` don't exist.
- `$t/home/.claude/hooks/worker-mode-guard.sh` is executable.

Test: `tests/linux/engine.sh real-config` `ok`. Break it on purpose: remove a linux entry's `dotfiles` file in a scratch
copy → fails.

### 16. Round trip of the real config, PowerShell `[worker:high]`

This is what lets CI stand in for the Windows machine.

Files: `tests/windows/Engine.Tests.ps1`.

Case `real-config-roundtrip`, in `Describe 'Windows engine'`. Use `Copy-EngineToRepo`, then copy the real
`sync-config.json` and `dotfiles\` over the fixture config. Set `$env:HOME = $script:HomeDir` and restore it in `finally`.

> [!WARNING]
> This suite also runs on the real Windows machine. The test must never touch the real `C:\MakuCustomAlias`. In the temp
> copy only, replace `/c/MakuCustomAlias` in `.bashrc` with `/c/SyncSettingsTest-<guid>/MakuCustomAlias`, as
> `import-linked-keeps-local` does, and remove that folder in `finally`.

- Fake `.user-values.json`: `<YOUR_NAME>`, `<YOUR_EMAIL>`, `<YOUR_GH_USERNAME>`, `<YOUR_GH_ORG>`, and `<GH_CLI_PATH>`
  as `C:\Tools\gh.exe`.
- Create `$home\AppData\Local\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState` and `$home\.claude\docs`,
  because import skips a missing target folder.
- `Invoke-Engine` import with `-Force` → no `ERROR`. These exist, under the unchanged paths: `.bashrc`, `.bash_profile`,
  `.gitconfig`, `.gitconfig.local`, the Windows Terminal `settings.json`, `.claude\RTK.md`,
  `.claude\docs\token-routing-map.html`, and `vs.bat` in the linked folder.
- `.claude\CLAUDE.md`, `.claude\hooks` and `.claude-worker` don't exist: no linux entry ran.
- `Invoke-Engine` export → no `MODIFIED`, `ADDED`, `REMOVED`, `ORPHAN` or `ERROR`, prints the up-to-date message.
- `git config --file "$home\.gitconfig" --includes --get-all credential.https://github.com.helper`: the last value is
  `!'C:\Tools\gh.exe' auth git-credential`, because the file holds doubled backslashes and git undoes them. This proves
  `~/.gitconfig.local` resolves in Git for Windows.
- `.claude\RTK.md` has no CR byte, which proves step 6 survives the runner's `core.autocrlf=true` checkout.

Test: CI `engine-windows` green. Also confirm the case ran in the job's log.

### 17. Docs `[inline: user-facing copy]`

Files: `docs/layout.md` (new), `docs/configuration.md`, `docs/sync-contract.md`, `docs/daily-workflow.md`, `README.md`,
`CLAUDE.md`, `docs/plan-restructure.md`, `TODO.md`.

- `docs/layout.md`: `common/windows/linux` rules, decision table for where a file goes, naming, why `.gitconfig` has a
  local part, one `dir` entry per skill and why.
- Replace the old paths in `README.md` (lines 181, 203, 218, 231, 247), `CLAUDE.md` (73, 82, 108) and
  `docs/configuration.md` (70, 144, 154). Note that a `dir` entry can't contain another entry.
- `docs/daily-workflow.md`: new section "Moving a machine to the new layout": pull, import first, then export, and what
  to do after exporting first (from the Windows section below).
- `docs/plan-restructure.md`: the inventory row for Linux gitconfig bits says it was done in phase 3, and the
  `.gitattributes` text in phase 3 shows the two lines.
- `TODO.md`: new section "Windows checks after phase 3", with W0 to W5 as checkboxes.

Test: read through; `grep -rnE 'dotfiles/(\.gitconfig|\.bashrc|\.bash_profile|WindowsTerminal)' README.md CLAUDE.md
docs/*.md scripts | grep -v docs/plan-` prints nothing; examples parse with `jq`.

### 18. Verify and PR `[inline: final review, gate touches workflows]`

1. `tests/linux/engine.sh` green; shellcheck clean; `scripts/ci/check-config.sh` OK; `scripts/ci/leak-scan.sh` clean.
2. `git ls-files dotfiles | grep -vE '^dotfiles/(common|linux|windows)/'` prints nothing.
3. The Windows `localPath` diff from step 7 against `b404e4d:sync-config.json`: the only difference is `~\\.gitconfig`
   replaced by `~\\.gitconfig.local`, because the first is now a `common` entry.
4. `gh pr ready`. `leak-scan`, `lint`, `engine-linux`, `engine-windows` green.
5. `/agent-skills:review` of the phase diff.
6. The PR touches `.github/workflows/ci.yml`, so auto-approval doesn't apply: you add `reviewed` and merge.

### 19. Migrate this machine `[inline: changes the real home, needs a terminal]`

Run straight after the merge, before any export.

1. `git switch master && git pull`.
2. You run `! ./import.sh`: it prompts for the name and email, then for overwriting `~/.gitconfig`. The old file stays as
   `~/.gitconfig.bak`.
3. Check: `git config --global user.name`; `git config --global --includes --get-all
   credential.https://github.com.helper` shows the `gh` line; `git config --global --includes alias.st`;
   `git ls-remote origin HEAD` works; `gh auth status` is fine.
4. `./sync preview` prints that nothing would change.

## Later on the Windows machine

The order matters: W0 can only pass before W1. Phase 3 is done without these; `TODO.md` tracks them until they pass.

| Check | Command | Expected | CI can't show |
|---|---|---|---|
| **W0** Substep 5 of step 18 in `docs/plan-safety-fixes.md`, and step 20.7 of `docs/plan-restructure-2.md` | `git fetch`, `git switch --detach b404e4d`, `export.bat`, `import.bat`, `git switch master` | No changes, all `UNCHANGED` | The real files match the repo before the move |
| **W1** Migrate | `git pull --ff-only`, then `import.bat`, first | `UPDATED` `.gitconfig` with `.bak`; `CREATED` `.gitconfig.local`; `UNCHANGED` for shell and Windows Terminal; Claude files `CREATED`, `UPDATED` or `SKIPPED` | The real `.user-values.json` and real targets work |
| **W2** Git works | `git config --global user.email`; `git config --global --includes --get-all credential.https://github.com.helper`; `git ls-remote origin HEAD` | Own email; `gh.exe` line; remote answers | The real `gh.exe` path and login |
| **W3** Round trip | `export.bat` | "Repo is up to date", no `ORPHAN`, including the `common` Claude files | Line endings of the real local files |
| **W4** Apps | Open Git Bash and run `vs`; open Windows Terminal | The alias works; settings load | The linked folder and the real package path |
| **W5** PR flow | With the next real change: `export.bat`, `commit.bat` | PR opened from a `sync/windows-…` branch, `dotfiles/windows/` paths in it | The new layout through `commit.bat` |

**If W0 reports changes:** those are Windows edits the repo doesn't have. Note the files, run `git restore dotfiles`,
continue with W1, and reapply them from the `.bak` files before W3. Import only once before that, because a second
import can replace a `.bak`.

**If `export.bat` runs before W1:** the whole `.gitconfig` lands in the common file. The cached-value check stops
`commit.bat`. Run `git restore dotfiles`, then W1.

## Not in this plan

- The rest of the Linux inventory, including `~/.config/git/ignore` (phase 4).
- `metrics-archive` in the link hint at the end of `import.sh` (bootstrap links, phase 7).
- `.gitattributes` for `dotfiles/windows/`. Line endings there can be decided in phase 8, with the real files at hand.
- Removing `detectLinkedPaths` (decision 3).

## Done when

- `git ls-files dotfiles` shows only `common/`, `linux/` and `windows/`.
- Lint rejects an entry inside a `dir` entry and a Windows `repoPath` outside `dotfiles/windows/`.
- An empty local folder never empties a `dir` entry, on either engine.
- `real-config-roundtrip` is green on `engine-linux` and `engine-windows`.
- This machine is migrated: `./sync preview` shows nothing and git credentials work.
- `TODO.md` lists W0 to W5.
