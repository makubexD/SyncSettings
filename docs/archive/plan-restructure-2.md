# Phase 2: Engine contract + parity

Roadmap: `docs/plan-restructure.md`. Goal of this phase: both engines live under `scripts/windows|linux`, follow
one written contract (`docs/sync-contract.md`), accept a required `platform` field with a shared `common` value,
close the parity gaps from the roadmap table, and prove it with the same fixtures run on `ubuntu-latest` and
`windows-latest` in CI.

Out of scope here: moving files in `dotfiles/` or converting existing entries to `type: dir` (phase 3), new
Linux configs (phase 4), dconf (phase 5), packages (phase 6), markdownlint/link check (phase 9).

## Decisions to confirm in review

1. **`type: dir` on import never deletes local files.** Export removes repo files that no longer exist locally
   (git keeps the history). Import reports local files missing from the repo as `EXTRA` and leaves them, so a
   skill you haven't exported yet survives an import.
2. **`*.bak` joins `excludePatterns`**, so `.bak` files that import leaves inside a synced directory are never
   exported.
3. **The orphan report checks all of `dotfiles/` against all entries** (every platform), so both engines print the
   same list. It only reports; it never deletes and never changes the exit code.
4. **The up-to-date check runs on export and import** (the roadmap names export; a stale import is the worse
   case). Commit already fast-forwards since phase 1.
5. **An entry without a valid `platform` stops the engine** before any file is touched (exit 1). Lint catches it
   first in CI.
6. **Bash tests are a plain bash script** (no bats dependency); PowerShell tests use Pester 5 on PS 5.1.

## Shared rules (all steps)

- Work on branch `feat/engine-parity`; one commit per step; one PR for the phase, opened as a draft at step 4
  (`ci.yml` runs only on `pull_request` and pushes to `master`) and marked ready at step 20.
- Bash: `#!/usr/bin/env bash`, `set -euo pipefail`, match `scripts/sync.sh` style (4-space indent, `printf`,
  `(( ))` for numbers, `[[ ]]` for strings), and the repo `CLAUDE.md` bash rules (byte-exact text, NUL-separated
  jq, prompts on another fd). New scripts are executable.
- PowerShell: PS 5.1 compatible (no `??`, no ternary, `[IO.File]::WriteAllText` for UTF-8 without BOM), match
  `scripts/SyncHelpers.ps1`. Statuses go through `Write-StatusLine`.
- Status words are the contract (step 2): export `ADDED MODIFIED UNCHANGED SKIPPED REMOVED ERROR`, import
  `CREATED UPDATED UNCHANGED SKIPPED EXTRA ERROR`, both `ORPHAN`. Both engines print the same word for the same case.
- Every engine change adds its fixture cases to `tests/linux/engine.sh` and/or `tests/windows/Engine.Tests.ps1`
  in the same step.
- The Pester suite calls `powershell.exe`, which Linux lacks. PowerShell steps are checked by the `engine-windows` CI job: after each PS step,
  `git push` (the draft PR picks it up) and `gh run watch` on the `ci` run. A red job counts as a rejection.
- Never test in the real repo: the harness copies the engine into a temp dir; manual checks use a throwaway clone
  and `HOME=$(mktemp -d)`.

## Fixtures (built up across steps)

`tests/fixtures/` holds two trees that are images of each other plus the config and seeded values:

```
tests/fixtures/
  sync-config.json        entries below, excludePatterns ["*.secret", "*.bak"]
  user-values.json        {"<NAME>": "Fixture User", "<WINPATH>": "C:\\Tools\\gh.exe"}
  repo/dotfiles/...       sanitized side (what export must produce)
  home/...                hydrated side (what import must produce), paths relative to HOME / USERPROFILE
```

| Entry (repoPath under `dotfiles/`) | localPath | platform | Added in | Content |
|---|---|---|---|---|
| `linux/plain.txt` | `~/.config/fixture/plain.txt` | linux | step 3 | `plain\n` |
| `linux/tool.sh` | `~/.config/fixture/tool.sh` | linux | step 3 | `#!/bin/sh\necho hi\n`, mode 755 |
| `linux/named.conf` | `~/.config/fixture/named.conf` | linux | step 3 | repo `name = <NAME>\n`, home `name = Fixture User\n` |
| `linux/no-trailing.txt` | `~/.config/fixture/no-trailing.txt` | linux | step 3 | `a\n\n` (two trailing newlines, byte-exact check) |
| `windows/win.conf` | `~\.config\fixture\win.conf` | windows | step 3 | repo `user = <NAME>\r\n`, home `user = Fixture User\r\n` |
| `common/shared.conf` | `~/.config/fixture/shared.conf` | common | step 5 | repo `owner = <NAME>\n`, home `owner = Fixture User\n` |
| `common/paths.ini` | `~/.config/fixture/paths.ini` | common | step 9 | rule `<WINPATH>` with `escapeBackslashes: true`; repo `gh = <WINPATH>\n`, home `gh = C:\\Tools\\gh.exe\n` |
| `common/dir` (`type: dir`) | `~/.config/fixture/dir` | common | step 11 | `a/b.txt` = `b\n`, `c.txt` = `c\n` |

The harness copies the engine (entry scripts + its `scripts/<os>/` folder) into `$t/repo`, copies
`fixtures/sync-config.json` and `fixtures/user-values.json` (as `.user-values.json`) next to it, and points
`HOME` (bash) or `$env:USERPROFILE` (PS) at `$t/home`. Comparisons are byte-exact (`cmp` / SHA256) and include
the file mode on bash.

## Steps

### 1. Move scripts to `scripts/windows` and `scripts/linux` `[worker:low]`

Files: `git mv scripts/*.ps1 scripts/windows/`, `git mv scripts/sync.sh scripts/linux/sync.sh`; then
`export.bat`, `import.bat`, `commit.bat`, `export.sh`, `import.sh`, `commit.sh`, `.github/workflows/ci.yml`,
repo `CLAUDE.md`. One mechanical concern (path fixes), so one step despite the file count.

- `.bat`: `-File "scripts\windows\<Name>.ps1"`.
- `*.sh`: `source scripts/linux/sync.sh`. The comment at the top of `sync.sh` still says "after cd-ing to the
  repo root"; keep it.
- `Export-Settings.ps1`, `Import-Settings.ps1`, `Commit-Settings.ps1`: `$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent`.
  The `. "$PSScriptRoot\SyncHelpers.ps1"` lines stay (same folder).
- `ci.yml`: shellcheck list uses `scripts/linux/sync.sh`; PSScriptAnalyzer gets `-Recurse` (without it only
  the top level of `scripts/` is analyzed, which would now be empty).
- Repo `CLAUDE.md`: replace `scripts/sync.sh`, `scripts/*.ps1`, `scripts/SyncHelpers.ps1` and the three
  `scripts/<Name>.ps1` table cells with the new paths. No other wording change.

Tests:
- `shellcheck -x export.sh import.sh commit.sh scripts/linux/sync.sh scripts/ci/*.sh` → exit 0.
- `git grep -nE 'scripts[/\\](sync\.sh|[A-Z][A-Za-z-]+\.ps1)' -- ':!docs/plan-*'` → no output.
- Throwaway clone: `HOME=$(mktemp -d) ./import.sh --force < /dev/null` → exit 0, files created; then
  `./export.sh < /dev/null` in the same clone with the same HOME → "Repo is up to date".
- `grep -n 'repoRoot =' scripts/windows/*.ps1` → three lines, all with the double `Split-Path`.

### 2. `docs/sync-contract.md` `[inline: contract design, contributor-facing copy]`

The spec the later steps implement, written first. Sections:
- Flow: export (compare by content, sanitize, copy changed), commit (branch + PR), import (prompt, `.bak`, hydrate).
- Entry selection: required `platform` (`common|windows|linux`); Windows engine takes `windows`+`common`, bash takes
  `linux`+`common`; invalid or missing → exit 1 before any file is touched.
- `localPath`: `~/…` with forward slashes works on both (PS converts `/` to `\`); `~\…` is Windows-only.
  `common` entries must use `~/`.
- Statuses: the table from Shared rules, one line per case (local missing, excluded, unchanged, changed,
  repo-only, user skipped, failure).
- Sanitize: longest value first; the backslash-doubled variant of a value is replaced before the plain value;
  `escapeBackslashes: true` doubles backslashes on hydrate; values from `.user-values.json`, then prompt with
  default order cached → `default` → `defaultEnv`; on import, missing values are first inferred from the
  existing local file (line-by-line prefix/suffix match); non-interactive with a missing value → exit 1
  (bash) / skip (PS today, documented as a difference).
- Compare: plain files byte/hash; sanitized files after CRLF→LF and trailing-whitespace trim.
- Backups: import writes `<file>.bak` before overwriting.
- `type: dir`: recursive, regular files only, `excludePatterns` apply, no `sanitizeRules`; export removes repo
  orphans (`REMOVED`), import never deletes (`EXTRA`).
- Orphan report and the up-to-date check (decisions 3 and 4).
- **Known differences** table: missing target folder on import (Windows skips "app not installed", Linux
  `mkdir -p`); `detectLinkedPaths` Windows-only; elevation `-User` Windows-only; file modes Linux-only.
- **Parity table**: the roadmap rows, each with the step that closes it.

Test: read through; every rule above maps to a fixture case in steps 3–18.

### 3. Bash fixture harness, baseline `[worker:high]`

Files: `tests/linux/engine.sh` (new, executable), `tests/fixtures/**` (the step-3 rows of the fixture table).

`tests/linux/engine.sh [case-name-filter]`: for each case, fresh `t=$(mktemp -d)` (removed by `trap … EXIT`),
set up as in Fixtures, run, assert. Prints `ok   <case>` or `FAIL <case>: <reason>`, exits 1 if any failed.
Runs from any cwd (resolves the repo from its own path). Engine runs use `< /dev/null`.

Cases:
- `import-creates`: empty home, `./import.sh --force` → exit 0; every linux file in `home/` equals the
  fixture byte for byte, `tool.sh` mode 755; `.config/fixture/win.conf` does not exist.
- `export-adds`: home = fixture home, empty `dotfiles/` → `./export.sh` exit 0; `dotfiles/linux/*` equals
  `repo/dotfiles/linux/*`; `dotfiles/windows` absent; output has `ADDED` for each of the 4 linux entries.
- `roundtrip-unchanged`: home and repo both from fixtures → export then import --force → both print only
  `UNCHANGED` lines for entries; no `.bak` created.
- `import-backup`: home `plain.txt` = `old\n` → import --force → `UPDATED`, `plain.txt.bak` = `old\n`.
- `excluded`: add a `linux/x.secret` entry to the temp config, local file exists → export prints
  `SKIPPED … matches exclude pattern`, repo file absent.
- `noninteractive-missing-value`: empty `.user-values.json` → import exits 1 with
  `missing value for <NAME>`; no file written.
- Added after the step 2 review (contract rules with no case yet):
  - `error-continues`: repo `plain.txt` made read-only (`chmod 444`), local `plain.txt` = `new\n` → export exit 0,
    `ERROR` line for `dotfiles/linux/plain.txt`, status lines for the other three linux entries. Skipped with
    `ok   error-continues (skipped: root)` when `EUID` is 0.
  - `import-eof-overwrites`: home `plain.txt` = `old\n`, import **without** `--force`, `< /dev/null` → `UPDATED`,
    `plain.txt` equals the fixture, `plain.txt.bak` = `old\n`.
  - `crlf-unchanged`: home `named.conf` = `name = Fixture User\r\n` → export prints `UNCHANGED` for it and the repo
    file keeps its bytes; import `--force` prints `UNCHANGED`, local file keeps its CRLF, no `.bak`.

Test: `tests/linux/engine.sh` → all `ok`, exit 0. Break one fixture byte → that case `FAIL`, exit 1.

### 4. Pester fixture tests, baseline + CI jobs `[worker:high]`

Files: `tests/windows/Engine.Tests.ps1` (new), `.github/workflows/ci.yml`, `.gitattributes` (new).

- `.gitattributes`: `tests/fixtures/** -text`, so the `windows-latest` checkout (`core.autocrlf=true`) keeps the
  fixture bytes as committed. Phase 3 adds the `dotfiles/` rules to the same file.

- Pester 5. `BeforeEach` builds the temp layout (`$t\repo\scripts\windows\*.ps1`, config, values) and sets
  `$env:USERPROFILE = "$t\home"`, restored in `AfterEach`. Engine runs:
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$t\repo\scripts\windows\Import-Settings.ps1" -Force`
  (and `Export-Settings.ps1`), output captured for assertions.
- Import skips entries whose target folder is missing (contract), so `BeforeEach` creates `$t\home\.config\fixture`.
- Cases mirror step 3 for the windows entry: `import-creates` (only `win.conf` created, CRLF kept, no linux files),
  `export-adds` (`dotfiles\windows\win.conf` equals fixture), `roundtrip-unchanged`, `import-backup`, `excluded`.
- `ci.yml` new jobs:
  - `engine-linux` (ubuntu-latest): checkout, `tests/linux/engine.sh`.
  - `engine-windows` (windows-latest), steps with `shell: powershell` (PS 5.1, not pwsh):
    `Install-Module Pester -MinimumVersion 5.5.0 -Force -SkipPublisherCheck -Scope CurrentUser`, then
    `Invoke-Pester -Path tests/windows -CI`.
  - shellcheck list adds `tests/linux/*.sh`.

Test: YAML parses (`python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]))' .github/workflows/ci.yml`);
push → `engine-linux` and `engine-windows` green.

### 5. `platform` required + `common`, bash `[worker]`

Files: `scripts/linux/sync.sh`, `export.sh`, `import.sh`, `tests/linux/engine.sh`, fixtures (`common/shared.conf` row).

- Rename `linux_entries` → `platform_entries`: `select(.platform == "linux" or .platform == "common")`.
  Update both callers in each entry script.
- New `check_platforms`, called by `sync.sh` right after it loads the config (so all three entry scripts get it):
  any entry whose `platform` is missing or not one of `common|windows|linux` →
  `ERROR: sync-config.json: entry <repoPath> needs "platform": "common", "windows" or "linux".` exit 1.

New cases: `common-import` / `common-export` (shared.conf round-trips), `missing-platform` (temp config with
one entry's `platform` deleted → export and import both exit 1 with that message, no file written).

### 6. `platform` required + `common`, PowerShell `[worker]`

Files: `scripts/windows/SyncHelpers.ps1`, `Export-Settings.ps1`, `Import-Settings.ps1`, `tests/windows/Engine.Tests.ps1`.

- `Test-WindowsEntry`: true for `windows` and `common` only.
- New `Assert-ValidPlatform -Files $config.files`: throws the same message as step 5. Export and Import call it
  before filtering; the existing top-level `catch` prints it and exits 1.
- `Resolve-LocalPath`: after the `~` replacement, `-replace '/', '\'`.

New cases: `common-import`, `common-export` (shared.conf lands at `$t\home\.config\fixture\shared.conf`),
`missing-platform`. CI `engine-windows` green.

### 7. Config + lint for `platform` `[worker:low]`

Files: `sync-config.json`, `.github/workflows/ci.yml`.

- `sync-config.json`: add `"platform": "windows"` to the four Windows entries (`.gitconfig`, `.bashrc`,
  `.bash_profile`, `WindowsTerminal/settings.json`); add `"*.bak"` to `excludePatterns`. Nothing else.
- Config sanity in `ci.yml`, added to the existing jq `$bad` list:
  - `platform` missing or not in `common|windows|linux`;
  - `linux` repoPath not starting `dotfiles/linux/`, `common` not starting `dotfiles/common/`, `windows` starting
    with either of those (tightened to `dotfiles/windows/` in phase 3);
  - `common` localPath not starting `~/`;
  - `type` present and not `file|dir`; a `dir` entry with `sanitizeRules` or `detectLinkedPaths`.

Tests: the jq command on `sync-config.json` → `sync-config.json: OK`. On temp copies, each of: platform
deleted, `platform: "mac"`, a linux entry moved to `dotfiles/x`, a `dir` entry with rules → exit 1 naming the
repoPath. `tests/linux/engine.sh` still green; real-repo `./export.sh` in a throwaway clone unchanged.

### 8. `defaultEnv` in PowerShell `[worker]`

Files: `scripts/windows/SyncHelpers.ps1`, `tests/windows/Engine.Tests.ps1`.

`Request-MissingValues`: default order cached → `default` → `defaultEnv`
(`[Environment]::GetEnvironmentVariable($rule.defaultEnv)` when the property exists and the variable is non-empty).

Unit cases (dot-source `SyncHelpers.ps1`, `Mock Read-Host { '' }`): rule `{placeholder:'<X>', defaultEnv:'FIXTURE_ENV'}`
with `$env:FIXTURE_ENV='abc'` → value `abc`; with `default:'d'` too → `d`; cached `c` → `c`; env unset and no
default → value not set.

### 8a. Missing value stops PowerShell without a terminal `[worker]`

Added after the step 2 review: today PowerShell writes the file with the placeholder unfilled. Bash exits 1.

Files: `scripts/windows/SyncHelpers.ps1`, `tests/windows/Engine.Tests.ps1`, `docs/sync-contract.md`.

- New `Test-Interactive`: `[Environment]::UserInteractive -and -not [Console]::IsInputRedirected` (step 18 reuses it).
- `Request-MissingValues`, for a placeholder that needs a value: when `Test-Interactive` is false, don't call
  `Read-Host`. Take the default (step 8 order) if there is one; otherwise throw
  `missing value for <PLACEHOLDER>: add it to .user-values.json`. Export and Import call it before any file is
  touched, so their top-level `catch` prints `ERROR: …` and exits 1 with nothing written. Interactive runs are
  unchanged.
- `docs/sync-contract.md`: in "Missing value, non-interactive", replace the bash-only sentence and "PowerShell
  behaves differently; see Known differences." with one rule for both engines (bash text kept, "the engine" instead
  of "bash"); delete the "Missing placeholder value, non-interactive" row from Known differences; add a parity row
  `| Missing value without a terminal stops the run | step 8a | yes | |` above "Missing target folder on import".

Cases (engine runs piped from `''`, so stdin is redirected): `noninteractive-missing-value` import (empty
`.user-values.json` → exit 1, output has `missing value for <NAME>`, `win.conf` not created) and export (same →
exit 1, `dotfiles\windows\win.conf` not written); `noninteractive-default` (rule with `default` and no cache →
import exit 0, `win.conf` hydrated with the default). CI `engine-windows` green.

### 9. `escapeBackslashes` in bash `[worker]`

Files: `scripts/linux/sync.sh`, `tests/linux/engine.sh`, fixtures (`common/paths.ini` row, also exercised by Pester
in the same step: add a case to `Engine.Tests.ps1`, 4th file).

- `sanitize`: for each placeholder (longest value first, as today), replace the backslash-doubled value
  (`${v//\\/\\\\}`) first when it differs from `v`, then `v`. Matches `ConvertTo-Sanitized`.
- `hydrate`: when the placeholder's rule has `escapeBackslashes: true` and the value contains `\`, insert the
  doubled value. Read the flag per placeholder with jq from the rules (NUL-separated, no `@tsv`).

New cases (both harnesses): `escape-import` (`paths.ini` home equals fixture, `gh = C:\\Tools\\gh.exe`),
`escape-export` (repo equals `gh = <WINPATH>`), `escape-roundtrip-unchanged`, and `sanitize-longest-first`
(added after the step 2 review: temp config adds rule `<TOOLS>` to the `paths.ini` entry, temp values
`"<TOOLS>": "C:\\Tools"` → export writes `gh = <WINPATH>\n`, not `gh = <TOOLS>\\gh.exe\n`).

### 10. Infer placeholder values on bash import `[worker]`

Files: `scripts/linux/sync.sh`, `import.sh`, `tests/linux/engine.sh`.

New `infer_values <entries-json-lines>` in `sync.sh`, a port of `Import-Settings.ps1` lines 102–134: for each
entry with rules whose local and repo files both exist, compare line by line (up to the shorter file, CR
stripped); where the repo line contains a placeholder and the local line doesn't, take the text between the
repo line's prefix and suffix if the local line starts/ends with them; store it only when the value is not yet
in `USER_VALUES` and is non-empty. `import.sh` calls it after `load_values` and before `request_values`, unless
`--reset-values`.

New cases: `infer-name` (no `.user-values.json` except `<WINPATH>`, home `named.conf` = `name = Jane Roe\n`,
non-interactive import → exit 0, `.user-values.json` has `"<NAME>": "Jane Roe"`, `named.conf` `UNCHANGED`);
`infer-reset` (`--reset-values` non-interactive → exit 1 missing value, as today); `infer-keeps-cache` (cached
`<NAME>` = `Fixture User` wins over the inferred one).

### 10a. Inferred values undo `escapeBackslashes`, bash + contract `[worker]`

Added after the step 9 review. For a rule with `escapeBackslashes: true`, the local file holds the doubled form
(`gh = C:\\Tools\\gh.exe`), so inference stores `C:\\Tools\\gh.exe`; hydrate doubles it again and import rewrites
the file with `C:\\\\Tools\\\\gh.exe`. It only bites when the value is not cached yet (a new machine), which is
the case inference exists for. PowerShell has the same bug today (step 10b).

Files: `scripts/linux/sync.sh` (`infer_values`), `tests/linux/engine.sh`, `docs/sync-contract.md`.

- `infer_values`: when the rule for `ph` has `escapeBackslashes: true`, turn each `\\` in the extracted value into
  `\` (`${v//\\\\/\\}`) before storing it. Read the flag per placeholder NUL-separated, as `hydrate` does.
- `docs/sync-contract.md`, "Inference on import": append `For a rule with escapeBackslashes: true, each \\ in the
  inferred value becomes \, because the file holds the doubled form.` (with code spans); add the parity row
  `| Inference undoes escapeBackslashes | step 10b | step 10a | |` below "Infer values from the local file on import".

Case `infer-escaped`: repo fixture; `.user-values.json` = `{"<NAME>": "Fixture User"}` (no `<WINPATH>`); home
`paths.ini` = the fixture (`gh = C:\\Tools\\gh.exe\n`); import without `--force`, `< /dev/null` → exit 0;
`.user-values.json` `<WINPATH>` is `C:\Tools\gh.exe` (single backslashes); `UNCHANGED` line for
`dotfiles/common/paths.ini`; `paths.ini` bytes unchanged; no `.bak`. Mutant check: drop the un-doubling →
the case fails.

### 10b. Inferred values undo `escapeBackslashes`, PowerShell `[worker]`

Files: `scripts/windows/Import-Settings.ps1` (the inference block), `tests/windows/Engine.Tests.ps1`.

- Same rule as 10a: when the rule has `escapeBackslashes` set to `$true`, `$extracted = $extracted.Replace('\\', '\')`
  before storing it.

Case `infer-escaped`, mirroring 10a: repo fixture, `.user-values.json` = `{"<NAME>": "Fixture User"}`, home
`paths.ini` from the fixture, `Invoke-EnginePiped Import-Settings.ps1` (no `-Force`; no prompt is needed because
the value is inferred) → exit 0; `.user-values.json` `<WINPATH>` is `C:\Tools\gh.exe`; `UNCHANGED` for
`dotfiles/common/paths.ini`; `paths.ini` bytes unchanged; no `.bak`. CI `engine-windows` green.

### 11. `type: dir` export, bash `[worker:high]`

Files: `scripts/linux/sync.sh`, `export.sh`, `tests/linux/engine.sh` (+ fixtures `common/dir` row).

In `export.sh`, entries with `type == "dir"` go to new `export_dir <entry>`:
- local dir missing → `SKIPPED <repoPath>/  (local folder not found: …)`, counts as skipped.
- each regular file under the local dir (`find -type f`, NUL-separated, sorted), relative path `rel`: excluded →
  `SKIPPED`; else `ADDED`/`MODIFIED`/`UNCHANGED` against `<repoPath>/<rel>` with `cmp -s` and `cp -p`
  (create parent dirs). Symlinks → `SKIPPED … symlink`.
- each repo file under `<repoPath>/` with no local counterpart (or now excluded) → `rm`, `REMOVED  (no longer in source)`;
  then remove empty directories under `<repoPath>`.
- ADDED/MODIFIED/REMOVED count toward `CHANGED`. Labels are `<repoPath>/<rel>`.

New cases: `dir-export-adds` (both files `ADDED`, modes kept), `dir-export-modify-remove` (repo has `old.txt`,
local `c.txt` changed → `MODIFIED c.txt`, `REMOVED old.txt`, empty subdir pruned), `dir-export-excluded`
(`x.bak` in local dir not copied), `dir-export-missing`, and `dir-export-symlink` (added after the step 2
review: local `link.txt -> c.txt` → `SKIPPED <repoPath>/link.txt  (symlink)`, not in the repo).

### 12. `type: dir` import, bash `[worker:high]`

Files: `scripts/linux/sync.sh` (if a helper is shared), `import.sh`, `tests/linux/engine.sh`.

- Extract the plain-file branch of `process_entry` (compare, prompt unless `--force`, `.bak`, `cp -p`, statuses)
  into `apply_plain <repo_file> <local_file> <label>` with no behavior change; `process_entry` calls it.
- `import_dir <entry>`: repo dir missing → `SKIPPED`; each repo file under `<repoPath>/` (not excluded) →
  `apply_plain` to `<localPath>/<rel>` (`mkdir -p` parents); each local file under the dir with no repo
  counterpart → `EXTRA <label>  (not in repo; kept)`. Never deletes.

New cases: `dir-import-creates`, `dir-import-update-backup` (local `c.txt` differs → `UPDATED`, `c.txt.bak`),
`dir-import-extra` (local `mine.txt` → `EXTRA`, file still there), `dir-roundtrip-unchanged`, plus step-3 cases
still green (refactor check).

### 13. `type: dir` export, PowerShell `[worker:high]`

Files: `scripts/windows/SyncHelpers.ps1`, `Export-Settings.ps1`, `tests/windows/Engine.Tests.ps1`.

`type -eq 'dir'` entries: `Sync-LinkedDirectory -SourceDir <local> -DestDir <repo> -Recursive $true`
(already does hash compare, excludes, orphan removal). Add to it: prune empty directories after orphan removal;
status `REMOVED` gets a color in `Write-StatusLine` (Red). Local folder missing → `SKIPPED`, same note as bash.
Count added + modified + removed toward the changed total.

Cases: the step 11 cases except `dir-export-symlink` (creating symlinks on Windows needs admin or developer
mode), same labels and status words.

### 14. `type: dir` import, PowerShell `[worker:high]`

Files: `scripts/windows/SyncHelpers.ps1`, `Import-Settings.ps1`, `tests/windows/Engine.Tests.ps1`.

Not `Sync-LinkedDirectory` (it deletes). New `Import-DirEntry`: target folder's parent missing → skip, like file
entries ("app not installed"); per repo file: same compare / `-Force` prompt / `.bak` / copy flow as plain
file entries (extract that flow into a helper if it is duplicated); local extras → `EXTRA (not in repo; kept)`.
`EXTRA` gets a color (DarkYellow).

Cases: same as step 12.

### 15. Orphan report, bash `[worker]`

Files: `scripts/linux/sync.sh`, `export.sh`, `tests/linux/engine.sh`.

`report_orphans` at the end of `export.sh`, before the summary: every file under `dotfiles/` (all platforms) that is
not a file entry's `repoPath`, not under a `dir` entry's `repoPath/`, and not under `<repoPath>.linked/` of a
`detectLinkedPaths` entry → `ORPHAN <path>  (no entry in sync-config.json; git rm it or add an entry)`.
Uses all entries, not just this platform's. No effect on `CHANGED` or exit code.

Cases: `orphan-reported` (`dotfiles/linux/stray.txt` → one ORPHAN line), `orphan-none` (fixture repo → no
ORPHAN), `orphan-linked-ok` (temp config entry with `detectLinkedPaths: true` and a file under its `.linked/` → no ORPHAN).
Also: real repo in a throwaway clone → `./export.sh` prints no ORPHAN.

### 16. Orphan report, PowerShell `[worker]`

Files: `scripts/windows/SyncHelpers.ps1`, `Export-Settings.ps1`, `tests/windows/Engine.Tests.ps1`.

`Write-OrphanReport`, same rules and message as step 15 (repo paths printed with `/`). `ORPHAN` color Magenta.
Cases: same three.

### 17. Up-to-date check, bash `[worker]`

Files: `scripts/linux/sync.sh`, `export.sh`, `import.sh` (+ cases in `tests/linux/engine.sh`, 4th file).

`check_upstream`, called near the top of `export.sh` and `import.sh` (after the banner):
- not a git repo, no `origin`, or current branch ≠ `master` → return silently.
- `git fetch -q origin master` fails → `  NOTE: could not reach origin; skipping the up-to-date check.`, return.
- `n=$(git rev-list --count HEAD..origin/master)`; 0 → return.
- terminal on stdin: `  Repo is <n> commit(s) behind origin/master. Pull now (git pull --ff-only)? [Y/n] `;
  yes → `git pull --ff-only` (failure → `ERROR: pull failed; resolve it and rerun.` exit 1); no → continue.
- no terminal: `  WARNING: repo is <n> commit(s) behind origin/master; run git pull --ff-only.` and continue.

Cases (temp repo made a git repo with a local bare `origin`): `upstream-none` (no git → no NOTE/WARNING),
`upstream-behind-noninteractive` (origin one commit ahead → WARNING, export still runs, exit 0),
`upstream-current` (no message), `upstream-unreachable` (origin URL points to a missing path → NOTE).

### 18. Up-to-date check, PowerShell `[worker]`

Files: `scripts/windows/SyncHelpers.ps1`, `Export-Settings.ps1`, `Import-Settings.ps1` (+ cases in `Engine.Tests.ps1`).

`Test-RepoUpToDate -RepoRoot $repoRoot`, same rules and messages as step 17; "terminal" =
`[Environment]::UserInteractive -and -not [Console]::IsInputRedirected`. Check `$LASTEXITCODE` after each git call.
Cases: same four.

### 18a. Stop after a pull, bash + contract `[worker]`

Added after the step 17/18 review. After a successful pull the run went on with what it loaded before it: the
config (PowerShell reads it first; bash reads `excludePatterns` and runs `check_platforms` when sourcing
`sync.sh`) and the engine code itself. A pull that changes either was applied by the old version. Stop instead.

Files: `scripts/linux/sync.sh`, `tests/linux/engine.sh`, `docs/sync-contract.md`.

- `check_upstream`: after a successful `git pull --ff-only`, `printf '  Pulled %d commit(s); run the command again.\n'`
  and `exit 0`.
- Contract, "Up-to-date check", the "Behind, with a terminal" bullet: "Yes pulls, prints `Pulled <n> commit(s); run
  the command again.` and exits 0, so the next run uses the pulled config and scripts."

Case `upstream-behind-pull` (the first test of the prompt path): as `upstream-behind-noninteractive`, but export runs
on a pseudo-terminal answering `y`: `printf 'y\n' | script -qec "cd '$t/repo' && HOME='$t/home' ./export.sh" /dev/null`
→ exit 0; output contains `Pulled 1 commit(s); run the command again.`; `HEAD` equals `origin/master`; no
`UNCHANGED` line (the export did not run).

### 18b. Stop after a pull, PowerShell `[worker]`

Files: `scripts/windows/SyncHelpers.ps1`, `Export-Settings.ps1`, `Import-Settings.ps1`, `tests/windows/Engine.Tests.ps1`.

- `Test-RepoUpToDate` returns `$true` after a successful pull (`$false` otherwise) and prints the same `Pulled …`
  line; Export and Import: `if (Test-RepoUpToDate -RepoRoot $repoRoot) { exit 0 }`.

Unit case in a new `Describe 'Test-RepoUpToDate'` (dot-source `SyncHelpers.ps1`; repo, bare origin and a second
clone that pushes one commit, under `$TestDrive`): `Mock Test-Interactive { $true }`, `Mock Read-Host { 'y' }` →
returns `$true`, `HEAD` equals `origin/master`; with `Mock Read-Host { 'n' }` → returns `$false`, `HEAD` unchanged.
CI `engine-windows` green.

### 19. Docs `[inline: user-facing copy]`

Files: `docs/sync-contract.md` (parity table: all rows closed, adjust anything the implementation changed),
`docs/configuration.md` (new: `sync-config.json` reference for the fields that exist now: `platform`,
`localPath` forms, `sanitizeRules` with `default`/`defaultEnv`/`escapeBackslashes`, `type: dir`,
`detectLinkedPaths`, `excludePatterns`; copy-paste examples), repo `CLAUDE.md` (Architecture: `platform`
required, `common`; Key Patterns: tests in `tests/`, how to run them; replace the "entries without it are
Windows-only" sentence), `README.md` (one "Read next" link per new doc; full rewrite is phase 9).

Test: read through; every command copy-pasteable; examples parse with `jq`.

### 19a. `dir` entry whose root is a symlink, bash `[worker]`

Added after the phase review of PR #21, like 19b to 19d. `find "$local_dir"` does not follow a symlink given as its
start path, so export printed one `SKIPPED … (symlink)` line with a garbled label and then "Repo is up to date",
having synced nothing. PowerShell follows the link. A trailing slash makes `find` follow it too.

Files: `export.sh`, `import.sh`, `tests/linux/engine.sh`, `docs/sync-contract.md`.

- `export.sh`, `export_dir`: `find "$local_dir" \( -type f …` becomes `find "$local_dir/" \( -type f …`. Leave the
  `find "$repo_dir"` calls alone.
- `import.sh`, `import_dir`: `find "$local_dir" -type f …` becomes `find "$local_dir/" -type f …`.
- Contract, "Directory entries", the first bullet, append: "A symlink at the folder's own path is followed."

Case `dir-root-symlink`: home fixture, move `$t/home/.config/fixture/dir` to `$t/home/real-dir` and symlink it back.
With `$t/repo/dotfiles/common/dir` removed, export → exit 0, `ADDED dotfiles/common/dir/c.txt` and `ADDED
dotfiles/common/dir/a/b.txt`, no output line containing `(symlink)`, both repo files byte-equal to the fixture. A
following import → `UNCHANGED dotfiles/common/dir/c.txt`, no `EXTRA` line.

### 19b. Close the test gaps the mutation check found, bash `[worker]`

Tests only. Each case below stayed green with its guard deleted from the code.

Files: `tests/linux/engine.sh`.

- `dir-symlink-removed`: guard `-L $local_file` in `export_dir`. Replace local `dir/c.txt` with a symlink to
  `dir/a/b.txt` → export exit 0, `REMOVED dotfiles/common/dir/c.txt`, repo file gone.
- `orphan-no-dir-entries`: guard `[[ -n $prefix ]]` in the `dir_prefixes` loop of `report_orphans`. Drop the dir entry
  from the temp config with `jq`, remove `$t/repo/dotfiles/common/dir`, add `$t/repo/dotfiles/stray.txt` → export
  prints `ORPHAN dotfiles/stray.txt`.
- `infer-skips-unhydrated-local`: guard `[[ $l == *"$ph"* ]] && continue` in `infer_values`. Delete `<NAME>` from the
  temp `.user-values.json`, delete local `shared.conf`, leave local `named.conf` literally `name = <NAME>\n` → import
  with stdin `/dev/null` exits 1, prints `missing value for <NAME>: add it to .user-values.json`.
- `infer-overlapping-context`: guard `(( ${#l} >= ${#prefix} + ${#suffix} ))`. Delete `<NAME>` from the temp
  `.user-values.json`, delete local `shared.conf`, repo `named.conf` = `abc<NAME>cba\n`, local `named.conf` =
  `abcba\n` → import with stdin `/dev/null` exits 1 with the same message (with the guard gone it infers `b`).
- `upstream-off-master`: guard `[[ $branch == master ]]`. As `upstream-behind-noninteractive`, but first `git -C
  "$t/repo" switch -q -c feature` → export exit 0, output has neither `WARNING: repo is` nor `NOTE:`.

Test: delete each guard in a scratch copy; the matching case must fail. Restore; all green.

### 19c. Trim text in linear time, bash `[worker]`

`same_normalized` trims with `${a%%+([[:space:]])}`, which is quadratic: 2 KB 0.6 s, 16 KB 33 s, 64 KB does not finish
in a minute. It runs twice per sanitized file. The largest one today is 3 KB, so runs are only slow, but the time grows
with every file added under rules.

Files: `scripts/linux/sync.sh`, `tests/linux/engine.sh`.

- `same_normalized`: `a=${a%"${a##*[![:space:]]}"}` and the same for `b`.
- Delete `shopt -s extglob` (line 6); nothing else uses it.

Case `sanitized-large-file`: `named.conf` local and repo with `name = <NAME>\n` followed by 128 KB of `x` lines, the
local copy with `Fixture User` and an extra `\n\n` at the end → export under `timeout 20`: exit 0, `UNCHANGED
dotfiles/linux/named.conf`.

### 19d. Literal paths in `dir` entries, PowerShell `[worker]`

`type: dir` is the first feature that handles arbitrary file names, and `-Path` treats `[` and `]` as wildcards, so
`[x].txt` is not found and the file is reported or copied wrongly.

Files: `scripts/windows/SyncHelpers.ps1`, `tests/windows/Engine.Tests.ps1`.

- In `Compare-FilesByHash`, `Sync-LinkedDirectory`, `Copy-RepoFileToLocal` and `Import-DirEntry`: `-LiteralPath`
  instead of `-Path` (or the positional path) on `Test-Path`, `Copy-Item`, `Get-Item`, `Remove-Item`, `New-Item` is
  excluded because it has no `-LiteralPath`, and `Get-ChildItem` (`LiteralPath` key in `$gciParams` and
  `$destGciParams`).

Case `dir-bracket-name`, in the same `Describe` as `dir-export-adds`: add local `dir/[x].txt` = `b\n` → export `ADDED
dotfiles/common/dir/[x].txt`, repo file present; second export `UNCHANGED`, no `REMOVED`; import `UNCHANGED`, no
`EXTRA`. CI `engine-windows` green.

Carried to phase 3, which adds `dir` entries to the real config: lint must reject a `file` entry whose `repoPath` lies
under a `dir` entry's `repoPath`, because `export_dir` removes such a file unless it also exists in the local folder.

### 20. Verify + PR `[inline: final review, gate touches workflows]`

1. `tests/linux/engine.sh` green; shellcheck clean; config sanity OK.
2. Throwaway clone + `HOME=$(mktemp -d)`: `./import.sh --force < /dev/null` then `./export.sh` → no diff, no ORPHAN.
3. Real machine, throwaway clone with real HOME: `./export.sh` → "Repo is up to date" (proves the move and parity
   changes don't alter the current Linux files).
4. Push, mark the draft PR ready (`gh pr ready`), update its description. CI: `leak-scan`, `lint`, `engine-linux`, `engine-windows` green.
5. `/agent-skills:review` of the phase diff.
6. The PR touches `.github/workflows/ci.yml`, so auto-approval doesn't apply: you add `reviewed` and merge.
7. Windows machine after merge: `export.bat` → no changes (the four entries now carry `platform: windows`);
   `import.bat` → all `UNCHANGED`.

## Done when

- Scripts live in `scripts/windows/` and `scripts/linux/`; all entry points work.
- Every config entry has a valid `platform`; both engines handle `common`; lint enforces the prefix rules.
- The roadmap parity table is closed: `defaultEnv` (PS), `escapeBackslashes` and value inference (bash),
  `type: dir`, orphan report and the up-to-date check in both engines.
- `engine-linux` and `engine-windows` run the shared fixtures and are green.
- `docs/sync-contract.md` and `docs/configuration.md` describe the behavior.
