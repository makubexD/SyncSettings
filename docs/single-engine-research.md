# One engine: research

Phase 1 of [plan-single-engine.md](plan-single-engine.md). This file holds the evidence. The recommendation comes in
step 7 of [plan-single-engine-1.md](plan-single-engine-1.md). Line numbers are for commit `27ab769`.

## 1. Inventory

### Size

| Side | Engine code | Front door and installer | Tests |
|---|---|---|---|
| bash | `scripts/linux/sync.sh` 1,423, `export.sh` 390, `import.sh` 515, `commit.sh` 342, `scripts/linux/os.sh` 38: **2,708** | `scripts/linux/front.sh` 658, `sync` 127, `install.sh` 313: **1,098** | `tests/linux/engine.sh` 8,303 lines, **485** cases (`grep -c '^case_'`) |
| PowerShell | `scripts/windows/SyncHelpers.ps1` 1,821, `Export-Settings.ps1` 318, `Import-Settings.ps1` 485, `Commit-Settings.ps1` 313: **2,937** | `scripts/windows/Front.ps1` 777, `sync.cmd` 97, `install.ps1` 245: **1,119** | `tests/windows/Engine.Tests.ps1` 4,762 lines, **240** cases (`grep -c "It '"`) |

`bootstrap/linux.sh` and `tests/linux/bootstrap.sh` (1,960 lines) stay bash under every option, so they are left out.

### By contract section

Cases are counted by name: each case name is matched against keywords for the section (a `dir` in the name goes to
directory entries, `only` to picking files, and so on), in the row order below, and a name goes to the first row it
matches. The counts add up to 485 and 240. "Code" lists the functions that implement the section; a script with no
functions (the PowerShell entry scripts) is cited by the lines that hold the behavior.

| Contract section | bash code | PowerShell code | bash cases | Pester cases | Outside tools |
|---|---|---|---|---|---|
| Lint of the config and packages (`scripts/ci/`, outside the engine) | `scripts/ci/check-config.sh`, `check-packages.sh` | — | 110 | 2 | `jq` |
| [Checks before pushing](sync-contract.md#checks-before-pushing), commit | `sync.sh:1096-1113` `run_leak_scan`; `commit.sh:51-342` | `SyncHelpers.ps1:1015-1060` `Find-GitBash`, `Invoke-LeakScan`; `Commit-Settings.ps1:32-313` | 31 | 18 | `git`, `gh`, bash (`leak-scan.sh` runs under Git Bash on Windows) |
| [Package drift](sync-contract.md#package-drift) | `sync.sh:688-946` (`package_names` … `report_drift`) | none | 50 | 1 | `apt-mark`, `dpkg-query`, `snap`, `pipx`, `npm`, `code`, `cmp` |
| [dconf entries](sync-contract.md#dconf-entries-type-dconf) | `sync.sh:80-84`, `634-687`; `export.sh:285-390` `export_dconf`; `import.sh:350-515` `import_dconf` | validation only, `SyncHelpers.ps1:37-105` | 50 | 8 | `dconf`, `jq`, `git` |
| [`localPath`](sync-contract.md#localpath), [macOS](sync-contract.md#macos) | `sync.sh:173-188` `resolve_local`; `os.sh:7-38` `sync_os`; the bash 4.4 guard at `export.sh:4` and the other entry scripts | `SyncHelpers.ps1:12-25` `Resolve-UserProfile`, `237-245` `Resolve-LocalPath` | 20 | 5 | `uname` |
| [Sync point](sync-contract.md#sync-point) | `sync.sh:948-959`, `996-1027` | `SyncHelpers.ps1:1693-1743` | 11 | 8 | `git` |
| [Front door](sync-contract.md#front-door) (`mksync`, status, doctor, setup, pull, push) | `front.sh:1-658`, `install.sh:1-313` | `Front.ps1:1-777`, `install.ps1:1-245` | 35 | 38 | `git`, `gh`, `jq`, `cmp`, `apt-get` or `brew`, `winget` |
| [One command](sync-contract.md#one-command) (`sync`, `sync.cmd`) | `sync:1-127` | `sync.cmd:1-97` | 37 | 12 | `cygpath` (Git Bash hand-over) |
| [Diff](sync-contract.md#diff) | `sync.sh:1194-1403` `diff_path_same`, `run_diff` | `SyncHelpers.ps1:1185-1482` `Invoke-ExportDiff` | 18 | 16 | `git`, `cmp`, `mktemp` |
| [Export preview](sync-contract.md#export-preview) | `sync.sh:1114-1193` `run_preview` | `SyncHelpers.ps1:1061-1184` `Invoke-ExportPreview` | 9 | 9 | `git`, `mktemp` |
| [Up-to-date check](sync-contract.md#up-to-date-check) | `sync.sh:368-406` `check_upstream` | `SyncHelpers.ps1:437-489` `Test-RepoUpToDate` | 6 | 15 | `git` |
| [Linked folders](sync-contract.md#linked-folders-detectlinkedpaths) | none | `SyncHelpers.ps1:754-959` (`Resolve-UnixPath` … `Sync-LinkedDirectory`), `1616-1692` `Import-LinkedDirectory` | 2 | 5 | — |
| [Directory entries](sync-contract.md#directory-entries-type-dir) | `export.sh:189-284` `export_dir`; `import.sh:287-349` `import_dir` | `Export-Settings.ps1:152`; `SyncHelpers.ps1:1536-1615` `Import-DirEntry` | 22 | 21 | `cmp` |
| [Orphan report](sync-contract.md#orphan-report) | `sync.sh:1047-1095` `report_orphans` | `SyncHelpers.ps1:960-1014` `Write-OrphanReport` | 2 | 2 | `git`, `jq` |
| [Backups](sync-contract.md#backups) | `sync.sh:960-995` | `SyncHelpers.ps1:1744-1788` | 7 | 8 | — |
| [Import check](sync-contract.md#import-check) | `import.sh:23-60` and the `CHECK` branches | `Import-Settings.ps1:34-131` and the `$Check` branches | 11 | 10 | — |
| [Picking files](sync-contract.md#picking-files) | `sync.sh:212-331` `resolve_only`, `only_selected`, `warn_only_no_hits` | `SyncHelpers.ps1:246-410` `Resolve-OnlyPaths`, `Test-OnlySelected`, `Test-OnlyEntrySelected`; `1816-1821` | 21 | 18 | — |
| [Path safety](sync-contract.md#path-safety) | `sync.sh:51-79` `path_is_safe`, `92-166` `check_paths`, `189-211` `normalize_path` | `SyncHelpers.ps1:106-236` `Test-SafePath`, `Get-OwningRepoPath`, `Assert-SafePaths` | 7 | 6 | `jq` |
| [Entry selection](sync-contract.md#entry-selection), [Which system](sync-contract.md#which-system) | `sync.sh:29-50` `check_platforms`, `167-172` `platform_entries`, `332-352` `entry_selected` | `SyncHelpers.ps1:26-105` `Test-WindowsEntry`, `Assert-ValidPlatform`, `Select-WindowsEntries` | 8 | 12 | `jq` |
| [Sanitize and hydrate](sync-contract.md#sanitize-and-hydrate) | `sync.sh:407-619` (`load_values` … `hydrate`); `import.sh:90-132` | `SyncHelpers.ps1:490-585` (`Get-UserValues` … `ConvertFrom-Sanitized`), `675-753` `Request-MissingValues` | 18 | 19 | `jq` |
| [Exclude patterns](sync-contract.md#exclude-patterns) | `sync.sh:353-367` `is_excluded` | `SyncHelpers.ps1:411-421` `Test-Excluded` | 2 | 1 | — |
| [Compare](sync-contract.md#compare) | `sync.sh:620-633` `same_normalized`, `1404-1423` `read_text`, `write_text`, `copy_mode` | `SyncHelpers.ps1:586-674` (`Compare-NormalizedContent` … `Write-Utf8File`) | 2 | 3 | `cmp`, `sha256sum` |
| [Flow](sync-contract.md#flow), [Statuses](sync-contract.md#statuses), [Overwrite prompt](sync-contract.md#overwrite-prompt) | `export.sh:113-188`, `import.sh:133-286` (`apply_plain`, `process_entry`, the prompt at `import.sh:150`); `sync.sh:1028-1046` `status` | `Export-Settings.ps1:1-318`, `Import-Settings.ps1:1-485`; `SyncHelpers.ps1:1483-1535` `Copy-RepoFileToLocal` (prompt at `1520`), `1789-1815` `Write-StatusLine` | 6 | 3 | — |
| Totals | | | **485** | **240** | |

What the counts say:

- 110 of the 485 bash cases test `scripts/ci/`, not the engine. Those scripts are bash run by CI and stay bash under any
  option. That leaves 375 bash engine cases against 240 Pester cases.
- 100 bash cases (package drift and dconf) cover behavior that exists only on Linux. Without them, and without
  `scripts/ci/`, both suites cover the shared contract with about the same number of cases: 275 bash, 229 Pester (without the 2 lint, 1 drift and 8 dconf validation cases).
- `jq` is used across every part of the bash engine that reads the config (`sync.sh` 14 functions, `export.sh` and
  `import.sh` main loops). PowerShell reads JSON natively. A TypeScript engine needs neither.
- Every engine calls `git`. Only commit and `mksync` call `gh`. The Windows leak scan needs Git Bash
  (`SyncHelpers.ps1:1015-1029` `Find-GitBash`) because `leak-scan.sh` is bash. `cygpath` is used only by `sync` for
  the Git Bash hand-over, and `Start-Process -Verb RunAs` only by `Import-Settings.ps1` for `-User`.

### Cost of two engines

From `git log --since=2026-10-01 --no-merges` (346 commits):

| Commits | Count |
|---|---|
| Touch engine code or tests (`scripts/linux`, `scripts/windows`, the entry scripts and installers, `tests/linux`, `tests/windows`) | 189 |
| bash side only | 112 |
| PowerShell side only | 67 |
| Both sides in one commit | 10 |

A behavior is rarely changed on both sides in one commit: the plans split it into a bash step and a PowerShell step. The
four plans since `plan-docs-dryrun-1.md` show how much:

| Plan | Steps | bash steps with a PowerShell twin | PowerShell twin steps |
|---|---|---|---|
| `plan-docs-dryrun-1.md` | 8 | 1, 4 | 2, 5 |
| `plan-docs-dryrun-2.md` | 10 | 1, 2, 3, 4, 5, 6 | 7, 8, 9 |
| `plan-safe-sync.md` | 10 | 1, 2, 3, 4, 5, 6 | 8, 9 |
| `plan-follow-ups.md` | 10 | 1, 3 | 2, 4 |
| Total | 38 | 16 | 9 |

So 25 of 38 steps (66%) wrote one behavior per engine, and 9 steps (24%) existed only to repeat a behavior in the
second engine. The PowerShell twins were the costly ones: `plan-safe-sync.md` and `plan-follow-ups.md` tagged them
`[worker:high]`, because the worker can't run Pester on Linux, so the only check was the `engine-windows` CI job.

The two engines also drift apart, which costs fix steps. Since 2026-10-01:

- `22db874` fix(windows): compare sanitized text case-sensitively
- `cdb3c35` fix: PowerShell rejects a dconf platform list
- `plan-follow-ups.md` steps 7 and 8: Windows compared and exported shared files with CRLF where bash kept LF
- `plan-follow-ups.md` steps 2 and 4: `..` refusal and the no-hits warning existed on bash only

## 2. Known differences

Each row of the [Known differences](sync-contract.md#known-differences) table, classed. "Forced" means the OS or its
file system decides; one engine keeps both behaviors behind an OS check. "Accidental" means the two engines grew apart;
one engine picks one behavior and the contract records it.

| Behavior | Class | One engine would |
|---|---|---|
| Export, local file missing | accidental | use the Linux note, adding `folder not found: <dir>` when the folder is missing too |
| Import, target folder missing | accidental | create the folder, as Linux does. A restore runs import before most apps have started once, and an empty folder for an app that isn't installed is harmless |
| Exclude patterns | accidental | match case-insensitively everywhere. Patterns are file-name globs like `*.log`; no current pattern depends on case |
| End of input at the overwrite prompt | accidental | count end of input as no, and name `--force` in the note. Safer than a silent yes. Bootstrap keeps the terminal as stdin (`bootstrap/linux.sh:614-616`), so its prompts don't change |
| `detectLinkedPaths` | accidental | support it on every OS, as PowerShell does |
| `type: dconf` | forced (GNOME) | run it on Linux, validate it elsewhere |
| Package drift | forced (apt, snap, pipx are Linux tools) | report on Linux; nothing elsewhere until a Windows list exists |
| `-User <name>` | forced (Windows profiles and elevation) | keep it Windows-only |
| File modes | forced (NTFS has no Unix modes) | keep modes where the file system has them |
| Status line layout | accidental | one layout: `WORD       label`, colored when the output is a terminal |
| Sanitized text that isn't valid UTF-8 | accidental | keep the bytes, as bash does |
| `defaultEnv` name check | accidental | stop the run on an invalid name everywhere |
| Import check, target folder missing | accidental (follows the import row) | report `CREATE` |
| Import check for another profile | forced (follows `-User`) | keep the error |
| `mksync setup` bootstrap question | forced (`bootstrap/linux.sh` is Ubuntu bash) | keep it Linux-only |
| `mksync` on `PATH` | forced (launcher form per OS) | keep both forms; the installer writes one |
| Installer | forced (`curl … \| bash` and `irm … \| iex`, apt-get, brew, winget) | keep both installers; they download the program instead of copying scripts |
| macOS rows (bash version, dconf, drift, setup, doctor, installer) | forced | keep them. The bash version row goes away: the program doesn't need bash |

Of the 17 rows in the Linux and Windows table (the macOS rows, folded into one row above, are all forced), 9 are accidental and would disappear, and 8 are forced and stay as OS checks in one place.

## 3. Probe

Run [42748992114](https://github.com/makubexD/SyncSettings/actions/runs/42748992114) on commit `12ce45a`: the probe
(`probe/single-engine/main.ts`) compiled with Bun 1.4.4 and Deno 2.9.8, each leg on its own runner, then 20 timed runs
on `tests/fixtures` (Python `time.perf_counter` around the loop, so the time includes starting the process).

| Runner | Runtime | Built | Size (MB) | Time per run (ms) | Output correct |
|---|---|---|---|---|---|
| `ubuntu-latest` (x64) | Bun | yes | 109.1 | 16.1 | yes |
| `ubuntu-latest` (x64) | Deno | yes | 105.0 | 54.3 | yes |
| `ubuntu-24.04-arm` | Bun | yes | 109.2 | 17.5 | yes |
| `ubuntu-24.04-arm` | Deno | yes | 105.9 | 44.8 | yes |
| `macos-latest` (arm64) | Bun | yes | 89.2 | 52.7 | yes |
| `macos-latest` (arm64) | Deno | yes | 68.2 | 54.0 | yes |
| `windows-latest` (x64) | Bun | yes | 115.3 | 57.5 | yes |
| `windows-latest` (x64) | Deno | yes | 80.4 | 102.9 | yes |

"Output correct" means `entries: 8` (as `jq '.files | length'`), the same SHA256 on all eight legs
(`8229606f…778519d`, as `sha256sum`), `crlf-fold: equal`, a `git version` line, the right `os:`, and exit 0.

Cross-compiled on `ubuntu-latest`, every target built, and each matches the size of the native build within a few bytes:
Bun `bun-linux-arm64` 109.2 MB, `bun-darwin-arm64` 89.2 MB, `bun-windows-x64` 115.3 MB; Deno
`aarch64-unknown-linux-gnu` 105.9 MB, `aarch64-apple-darwin` 68.2 MB, `x86_64-pc-windows-msvc` 80.4 MB. So one Linux
job could build every program, but the run didn't start a cross-compiled program on its target, so step 5 can't count
on that yet.

What the numbers say:

- Both runtimes build and run the same file unchanged on all four targets. Neither needed a code change or a flag per OS.
- Start-up: Bun is about 3 times faster than Deno on Linux, the same on macOS, and twice as fast on Windows. Either way a
  sync run starts one process, where the bash engine starts `jq` many times per entry, so start-up is not the deciding
  cost.
- Size: 68 to 115 MB per program, uncompressed. The current install is the git clone of a few hundred KB of scripts.
  Compressed download size wasn't measured.

What the runners can't show:

- **Windows SmartScreen.** It warns on programs that carry the Mark of the Web, which browsers add on download. The
  installers fetch the program from a script (`irm`, `curl`), which doesn't add it as far as the docs say, but this
  wasn't tried on a real machine. A program started from Explorer after a browser download would warn.
- **macOS Gatekeeper.** Same rule with the quarantine flag, which `curl` doesn't set. Apple Silicon also refuses to run
  any unsigned code; the programs built on `macos-latest` ran, so the compilers sign them ad hoc there. Whether the
  `aarch64-apple-darwin` and `bun-darwin-arm64` programs cross-compiled on Linux carry that signature wasn't checked.
- **Signing**, if needed: Apple Developer Program (yearly fee) for notarizing; on Windows a code-signing certificate or a
  managed signing service (monthly fee). Neither is needed while the installers download the program from a script.

## 4. Shared case format

The format is in [tests/parity/README.md](../tests/parity/README.md): a case is a folder with `case.json` (config,
values, commands, OS list), the `home/` and `repo/` trees before, and `expect/` (exit codes, status lines, the trees
after). Output is cut down to `WORD label` per status line, so the two layouts compare equal. Four cases are in
`tests/parity/cases/`: `export-adds`, `check-one-change`, `sanitize-round-trip` and `hydrate-creates` (the review asked for a case where hydrate writes the file). `tests/parity/run.sh` runs all four
against the bash engine, and all four pass; phase 2 adds the PowerShell runner.

### Sample

40 cases. The plan said every tenth bash case and every sixth Pester case, which gives 49 and 40 (89 in all). To keep
to 40 with both engines weighed the same, the sample takes 20 from each: every 24th bash case (1, 25, …, 457) and
every 12th Pester `It` (1, 13, …, 229).

Classes: **fits** (files in, command, status lines and files out); **stub** (fits once the runner stubs a git remote,
`gh`, a prompt answer, `dconf` or a package manager); **internal** (calls one function from the inside, stays a unit
test); **not engine** (tests `scripts/ci/` or an installer, which stay scripts).

| # | Suite | Case (`file:line`) | Class | Why |
|---|---|---|---|---|
| 1 | bash | `import_creates` (`engine.sh:566`) | fits | import into an empty home, files compared |
| 2 | bash | `import_check_needs_values` (`engine.sh:1112`) | fits | no values file; status line and exit only |
| 3 | bash | `common_import` (`engine.sh:1555`) | fits | `CREATED` and the file's bytes |
| 4 | bash | `lint_real_config` (`engine.sh:2063`) | not engine | `scripts/ci/check-config.sh` |
| 5 | bash | `lint_packages_apt_trailing_dash` | not engine | `scripts/ci/check-packages.sh` |
| 6 | bash | `lint_packages_pipx_flag` | not engine | `scripts/ci/check-packages.sh` |
| 7 | bash | `lint_packages_source_second_stanza` | not engine | `scripts/ci/check-packages.sh` |
| 8 | bash | `lint_real_plugins` | not engine | `scripts/ci/check-plugins.sh` |
| 9 | bash | `dir_export_one_left` (`engine.sh:3185`) | fits | `REMOVED` in a `type: dir` entry |
| 10 | bash | `preview_leak_found` (`engine.sh:3646`) | stub | preview needs the repo committed to git |
| 11 | bash | `commit_packages` (`engine.sh:3941`) | stub | git remote and `gh` |
| 12 | bash | `sync_doctor_ready` (`engine.sh:4425`) | stub | tool stubs, `gh` |
| 13 | bash | `sync_pull_matches` (`engine.sh:4898`) | stub | git remote |
| 14 | bash | `front_pull_recorded` (`engine.sh:5283`) | stub | git remote and a prompt answer |
| 15 | bash | `dconf_path_missing` (`engine.sh:5718`) | fits | config error, exit 1; `os: linux` |
| 16 | bash | `lint_type_unknown` | not engine | `scripts/ci/check-config.sh` |
| 17 | bash | `dconf_import_merge` (`engine.sh:6306`) | stub | private `dconf` bus |
| 18 | bash | `drift_snap_extra` (`engine.sh:6673`) | stub | `snap` stub |
| 19 | bash | `drift_key_etc_apt` (`engine.sh:6941`) | stub | a fake `/etc/apt` root |
| 20 | bash | `diff_in` (`engine.sh:7346`) | stub | git remote and a sync point |
| 21 | Pester | `import-creates` (`Engine.Tests.ps1:422`) | fits | same case as bash 1 |
| 22 | Pester | `localpaths-bad-key` (`Engine.Tests.ps1:670`) | fits | config error, exit 1 |
| 23 | Pester | `dconf-path-no-slash` (`Engine.Tests.ps1:852`) | fits | config error, exit 1 |
| 24 | Pester | `dir-bracket-name` (`Engine.Tests.ps1:1045`) | fits | a `[x].txt` file in a `dir` entry |
| 25 | Pester | `infer-escaped` (`Engine.Tests.ps1:1282`) | fits | inferred value lands in `.user-values.json`; the runner would need to read that file for this one |
| 26 | Pester | `upstream-behind-noninteractive` (`Engine.Tests.ps1:1626`) | stub | git remote |
| 27 | Pester | `preview-scan-missing` (`Engine.Tests.ps1:1822`) | stub | committed repo with `leak-scan.sh` removed |
| 28 | Pester | `commit-leak-blocked` (`Engine.Tests.ps1:2036`) | stub | git remote |
| 29 | Pester | `sync-point-check-none` (`Engine.Tests.ps1:2216`) | stub | clone with a remote |
| 30 | Pester | `only-other-platform` (`Engine.Tests.ps1:2380`) | internal | calls `Resolve-OnlyPaths`; the same behavior through `--only` would fit |
| 31 | Pester | `export-only-one` (`Engine.Tests.ps1:2549`) | stub | committed repo |
| 32 | Pester | `backup-second-run` (`Engine.Tests.ps1:2759`) | fits | needs the runner to read the state folder it otherwise leaves out |
| 33 | Pester | `sync-cmd-help-lists-check` (`Engine.Tests.ps1:2972`) | fits | `sync help`, output text |
| 34 | Pester | `import check other user` (`Engine.Tests.ps1:3201`) | fits | `os: windows`, exit 1, trees unchanged |
| 35 | Pester | `crlf-common-binary-export` (`Engine.Tests.ps1:3421`) | fits | bytes of a binary file |
| 36 | Pester | `doctor gh signed out` (`Engine.Tests.ps1:3613`) | stub | `gh` |
| 37 | Pester | `push declined` (`Engine.Tests.ps1:3841`) | stub | git remote, `gh`, a prompt answer |
| 38 | Pester | `front-unknown-option-diff` (`Engine.Tests.ps1:4033`) | stub | front door on a clone |
| 39 | Pester | `install missing gh yes` (`Engine.Tests.ps1:4353`) | not engine | `install.ps1` with a `winget` stub |
| 40 | Pester | `git in mingw64\bin` (`Engine.Tests.ps1:4536`) | internal | mocks `Get-Command` for `Find-GitBash` |

Totals: 14 fit, 17 fit with a stub, 2 internal, 7 not engine. Of the 33 engine cases, 31 (94%) can be shared. The stubs
are few and repeat: git (12 of the 17: a remote or a clone in 9, a committed repo in 3), `gh`, a prompt answer, `dconf`, a package manager. Two "fits" rows (25,
32) need the runner to read a file it leaves out by default, so `expect/` should be able to name such files.

## 5. Options

The step counts below are estimates, sized like the recent plans (8 to 10 steps of one concern each).

| | A. Go | B. Shared cases only | C. Stop |
|---|---|---|---|
| What | Phases 2-5: shared cases, then one TypeScript engine on Bun | Phase 2: shared cases run against both engines | Nothing |
| Cost | about 50 steps: phase 2 ~10, phase 3 ~14 (core, about 2,700 lines in each engine today), phase 4 ~16 (the rest, and the front door, about 1,100 lines in each), phase 5 ~8 (release workflow, installers, removing both engines) | about 10 steps: a PowerShell runner, stubs for a git remote and `gh` (10 of the 17 stub cases need a remote), and moving the cases | none |
| Gain | One change per behavior. In the last four plans that is 9 of 38 steps (24%) that wouldn't exist, plus the drift fixes (4 since 2026-10-01). Windows logic gets tested on Linux, so fewer `[worker:high]` steps that only CI can check. 9 of the 17 "Known differences" rows go away | One suite for the contract instead of two: about 94% of the engine cases can be shared (31 of 33 in the sample). The two engines are held to the same cases, so the drift fixes stop. Engine work stays doubled | none |
| Risk | Rewriting a working tool; programs of 68-115 MB to download; cross-built programs not yet run on their targets; Gatekeeper and SmartScreen not tried on a real machine | small: the engines don't change | drift keeps showing up as fixes |
| Payback | At 9 twin steps per 38, removing duplication saves about 1 step in 4. The ~40 steps of phases 3-5 pay back after about 160 more plan steps, about 16 plans at the current size | starts at once: each new contract case is written once | |

### Recommendation: B, then decide on A with its numbers

Phase 2 is worth doing under either path: the roadmap needs the shared cases before a new engine can be called done,
and they stop the drift fixes on their own. A doesn't pay for itself unless engine work keeps up its October pace for
about 16 more plans. `TODO.md` lists only W10 and the macOS M1-M4 runs as open, so that pace isn't likely. After
phase 2, count the twin steps in the plans that follow; if two engines still cost a quarter of the steps, phase 3 starts
with the shared cases already in place, so nothing done in B is wasted.
