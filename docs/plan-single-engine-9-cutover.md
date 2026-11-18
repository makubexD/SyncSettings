# One engine, phase 9: cut-over

Roadmap: `docs/plan-single-engine.md`, phase 9, second plan (the first, `docs/plan-single-engine-9.md`, is merged as
PR #80). Design: `docs/design-layers.md` ("Linked folders", "v2 while the old engines read v1", "Release and update",
"Tests", "Open"). Contract: `docs/sync-contract.md`. Goal: the first release, the real-machine checks, the Claude layout,
then the bash and PowerShell engines deleted and `v1.0.0`.

## Shared rules

- **Two parts, two branches.** Part 1 (steps 1 to 8) on `engine/cutover-config`, merged in step 4 so the `v0.9.0` tag
  sits on `master`; steps 5 to 8 run on the real machines and change no repo file except their records. Part 2 (steps
  9 to 25) on `engine/cutover`, one PR in the finish. Part 2 changes `.github/workflows/`, so its PR waits for the
  user's `reviewed` label (CLAUDE.md, "Claude auto-approval").
- **Stops for the user:** step 5 (the tag is a publish: Claude asks for the GO, then tags), step 8 (the work-machine
  answers), and any failure step 6 or 8 finds. A failure gets a fix step inserted before step 9 (a plan edit, committed),
  with a shared case first as usual.
- **Old engines frozen until step 12's tag**, as in `docs/plan-single-engine-9.md`. After the tag they are deleted,
  not changed.
- **Contract first** (CLAUDE.md rule 2) for every rule visible in exit codes, status lines or files.
- **Public repo.** Fixtures use `example.com`, `/home/user`, `C:\Users\user`, profiles `work-1` and `personal`,
  machines `wk1-laptop` and `home-linux`. Real-machine results are recorded redacted (`work-tool-1`) and shown to the
  user before they are committed. `leak-scan` stays green.
- **Real machines.** Steps 6 and 8 are the only ones that run on a real home; every other step tests on temp homes,
  stubs and the VM, as CLAUDE.md "Tests" says.
- Each worker step: about 3 files (a shared case folder counts as one; a deleted folder counts as one), one concern.
  Test commands run that step's cases and tests only; `tests/all.sh` runs once, in the finish.
- Shared-case test command: `bun run build && tests/parity/run.sh --engine dist/mksync <filter>`.

## Decisions to confirm in review

The user's calls the first plan left for this one ("After this plan", item 4), plus what the survey of the repo for
this plan found. Each has a recommendation; the review confirms or changes them before `/next`. Step 1 writes them
into the design.

1. **Personal-only Claude keys go to the Linux overlay until phase 10.** `enabledPlugins`, `extraKnownMarketplaces`,
   `permissions`, `autoMode` and `skipDangerousModePermissionPrompt` serve the personal workflow. A `personal` profile
   layer can't be committed while the repo is public (the guard), and the only Linux machine is personal, so the Linux
   overlay (`dotfiles/linux/claude/settings.json`) holds them; phase 10 moves them to `profiles/personal/`. The base
   keeps `agentPushNotifEnabled`, `autoUpdatesChannel`, `cleanupPeriodDays`, `effortLevel`,
   `inputNeededNotifEnabled`, `model`, `modelSettings`, `statusLine`, `theme` and `tui`. So a work machine's own
   plugins, marketplaces, permissions and `autoMode` stay its own.
2. **`<HOME>` stays a placeholder.** `hooks` is in the Linux overlay (survey: no hooks on Windows), and `statusLine`
   becomes `mksync statusline`, which holds no path, so no Windows command needs `~`. No change.
3. **`<YOUR_WORK_MARKETPLACE>` waits for phase 10.** It is in `dotfiles/common/vscode/settings.json`, not Claude's
   settings. Moving it to the work profiles' layer needs those layers in the repo, so it stays in the design's "Open"
   with the phase 10 note.
4. **The `.linked/` tree becomes a Windows `dir` entry.** `dotfiles/windows/shell/.bashrc.linked/MakuCustomAlias/`
   (one `vs.bat`) is moved with `git mv` to `dotfiles/windows/shell/MakuCustomAlias/`, entry
   `{"file": "shell/MakuCustomAlias", "module": "shell", "merge": "dir", "localPath": "C:/MakuCustomAlias",
"os": ["windows"]}` (the folder `.bashrc` puts on `PATH`). Every Windows machine is a work machine, so the OS layer
   reaches only them; phase 10 can move it to a work profile.
5. **`sampleGrok.md` is dropped** from the repo and both configs; git history keeps it.
6. **The bootstrap runs the program.** `bootstrap/linux.sh` stays bash but sources `scripts/linux/sync.sh` and calls
   `./import.sh` and `./sync preview` today. It gets the helpers it uses copied in, and calls `./mksync import` and
   `./mksync preview` (the clone's launcher, which runs the installed Bun or Node, or the installed program first if
   `mksync` is on `PATH`).
7. **The program keeps reading v1 configs.** About 200 shared cases use a v1 `config.json`; converting them is a large
   mechanical change with no user benefit. `loadConfig` picks the parser by the file's own `schemaVersion` (step 2), so
   the renamed `sync-config.json` (v2) and the cases' v1 files both load. Dropping v1 goes in "Open".
8. **The rename ships before the tag.** `v0.9.0`'s `loadConfig` reads `sync-config.v2.json` when present, else parses
   `sync-config.json` as v1. After step 21 renames v2 to `sync-config.json`, a `v0.9.0` program would fail. So step 2
   (pick by `schemaVersion`, error lines name the file read) is in `v0.9.0`, and every machine that installs it reads
   both layouts.
9. **Machines move before they pull the deletion.** Each machine installs `mksync` (or runs `mksync update`) before
   its first pull past `v1.0.0`; a machine that pulls first runs the install line again. README says so in step 25;
   the installers drop a leftover `~/.local/bin/sync` link into the clone (step 14).
10. **The research probe goes too.** `probe/` and `.github/workflows/single-engine-probe.yml` served phase 1; their
    evidence is in `docs/single-engine-research.md`. Deleted in step 22.

## Step 1: Decisions into the design `[inline: records the plan review's decisions]`

Files: `docs/design-layers.md`, `docs/plan-single-engine.md`.

- Design "Open": settle "Today's `.linked/` trees" (decision 4), "`sampleGrok.md`" (decision 5), "A profile without a
  value" gets the phase 10 note (decision 3); add "Dropping v1 configs" (decision 7).
- Design "The Claude layout waits for cut-over": decision 1's key split and decision 2.
- Design "v2 while the old engines read v1", "At cut-over": `loadConfig` picks the parser by `schemaVersion`
  (decisions 7 and 8).
- Roadmap phase 9: a line that this plan is in progress, and decision 10.

Test: `npx prettier --check docs/design-layers.md docs/plan-single-engine.md`.

## Step 2: The config picked by its schemaVersion `[worker]`

Files: `tests/parity/cases/config-v2-in-sync-config/`, `tests/parity/cases/config-v2-in-sync-config-newer/`,
`src/adapters/snapshot.ts` (+ `snapshot.test.ts`), `src/core/config/v2.ts`.

Contract first: `docs/sync-contract.md` is changed in step 25; the cases follow decision 8 and the existing
`schemaVersion` rule ("A config newer than the program").

- `config-v2-in-sync-config` (`oldEngines: ["none"]`, description names decision 8 of this plan): the repo has only
  `sync-config.json`, holding a v2 config (`schemaVersion: 2`) with one `whole` entry `parity/a.conf` for linux,
  macOS and Windows; command `import` with `force`. Expect exit 0 and the local file written. If the runners can only
  place a v2 config as `sync-config.v2.json`, add a case field `"configName": "sync-config.json"` to `run.sh` and
  `run.ps1` (and their README) and say so in the summary.
- `config-v2-in-sync-config-newer`: the same with `schemaVersion: 3`. Expect exit 2, stderr
  `ERROR: sync-config.json: this config needs a newer mksync: run mksync update.`, no file written.
- `loadConfig`: `sync-config.v2.json` when it exists (unchanged); else read `sync-config.json`, and when its JSON is an
  object with a `schemaVersion` key, `parseV2(text, "sync-config.json")`; otherwise v1 as today. Unparseable JSON keeps
  today's v1 error.
- `parseV2(text, file = "sync-config.v2.json")`: every error line names `file` instead of the constant.
- Unit tests: both files present (v2 wins), only a v2 `sync-config.json`, only a v1 `sync-config.json`, a v2 error
  naming `sync-config.json`.

Test: `bun test src/adapters/snapshot.test.ts src/core/config && bun run build && tests/parity/run.sh --engine dist/mksync config-v2-in-sync-config`.

## Step 3: Personal-only keys in the Linux overlay `[worker]`

Files: `tools/claude-layout.ts`, `tools/claude-layout.test.ts`, `tools/fixtures/claude-layout/`.

Decision 1: `export const LINUX_OVERLAY_KEYS = ["enabledPlugins", "extraKnownMarketplaces", "permissions", "autoMode",
"skipDangerousModePermissionPrompt"]`, and `LayoutOptions.linuxOverlayKeys` (defaults to it), as
`WINDOWS_OVERLAY_KEYS` does. The split puts these top-level keys in the Linux overlay, next to `hooks` and the keys
that hold `<HOME>` or a `.sh` path; a key absent from the source is skipped. Tests: a source with all five keys splits
them into the overlay and none into the base; a source without them writes the same base and overlay as today; an
explicit empty list keeps them in the base. The fixture's source gains the five keys with `example.com` values.

Test: `bun test tools/claude-layout.test.ts && bun run lint`.

## Step 4: Merge part 1 `[inline: a PR and its merge]`

Push `engine/cutover-config`, open the PR (steps 1 to 3), wait for checks, run `pr-ready <n>`, add `reviewed` after
reading the full diff and rerunning steps 2 and 3's tests, and merge when it exits 0 (CLAUDE.md "Claude
auto-approval"; no workflow file is touched). Then `git switch master && git pull`.

Test: `pr-ready <n>` exits 0; `git log -1 --format=%s master` is the merge.

## Step 5: The v0.9.0 release `[inline: a publish needs the user's GO]`

Ask the user for the GO (push notification), then `git tag v0.9.0 && git push origin v0.9.0` on `master`. Wait for the
release workflow. Check, in the scratchpad: `gh release view v0.9.0` lists `mksync-linux-x64`, `mksync-linux-arm64`,
`mksync-darwin-arm64`, `mksync-windows-x64.exe` and `SHA256SUMS`; `sha256sum -c SHA256SUMS` passes;
`gh attestation verify mksync-linux-x64 --repo <owner>/<repo>` passes; `./mksync-linux-x64 --version` prints `0.9.0`.

Test: the four checks above. A failure stops the plan with the workflow log.

## Step 6: Personal Linux on the release `[inline: the real machine]`

On this machine: run the install line from `README.md` with `--no-setup` (the machine is set up), check
`~/.local/bin/mksync --version` is `0.9.0` and that `mksync status` and `mksync doctor` exit 0. Then `mksync shadow` in
the clone: `shadow: same`, or each difference explained in the design's checklist results ("Real-machine results",
new, under "Tests"), redacted. `mksync update` prints `mksync is up to date (v0.9.0).`. Nothing is pulled or pushed.

Test: the commands above; the design's prettier check if it changed. An unexplained difference stops the plan.

## Step 7: The work-machine run sheet `[inline: user-facing instructions]`

Files: `docs/windows-cutover-run.md` (new), modeled on `docs/windows-survey.md`: one prompt the user pastes into
Claude Code on work #1, which runs the design's real-Windows checklist items 1 to 11 in order and prints one redacted
answer block (no names, hosts, accounts or paths beyond `C:\Users\<user>`). Items 8 and 10 come with the user's IT
answer if the program is blocked. It also runs `mksync statusline` by hand with a sample payload (the synced
`statusLine` changes only in part 2) and `mksync pull` with `--check` only.

Test: `npx prettier --check docs/windows-cutover-run.md && scripts/ci/leak-scan.sh`. Then push-notify and stop: the
user runs it on work #1.

## Step 8: The work-machine answers `[inline: needs the user at work #1]`

When the user brings the answer block: show it redacted, record it in the design's "Real-machine results", settle
"The unsigned program" in "Open", and write into `mksync` (the launcher) the oldest Bun that ran (item 11) if it is
older than the launcher's check. Every failed item gets a fix step before step 9 (plan edit, committed). Work #2 and
#3 run the same sheet when the user is at them; their answers don't block part 2.

Test: `npx prettier --check docs/design-layers.md && scripts/ci/leak-scan.sh`; `tests/linux/launcher.sh` if the
launcher changed.

## Step 9: The Claude layout goes live `[inline: writes real repo data after a reviewed dry run]`

On `engine/cutover`, from `master`. Run `bun tools/claude-layout.ts .`, show the user the `would write` lines and the
key split, then `bun tools/claude-layout.ts . --cutover`. Check: `dotfiles/common/claude/settings.json` (base) and
`dotfiles/linux/claude/settings.json` (overlay) by decision 1; the v2 Claude `settings.json` entry covers Windows; the
synced `statusLine` is `{"type": "command", "command": "mksync statusline"}`; `dotfiles/linux/claude/statusline.sh`
and its rows in both configs are removed with `git rm`. Then on a temp home, `HOME=$(mktemp -d) dist/mksync import
--force < /dev/null` with this machine's values copied there, and the merged `settings.json` equals the live
`~/.claude/settings.json` except `statusLine`.

Test: `bun run tools/check-config.ts && bun run build && tests/parity/run.sh --engine dist/mksync claude && scripts/ci/leak-scan.sh`.

## Step 10: The linked tree as a dir entry `[worker]`

Files: `dotfiles/windows/shell/.bashrc.linked/MakuCustomAlias/` → `dotfiles/windows/shell/MakuCustomAlias/` with
`git mv`, `sync-config.v2.json` (decision 4's entry, after the Windows `.bashrc` entry). The v1 config is unchanged
(its engine is deleted in step 18). If `parseV2` refuses `C:/MakuCustomAlias`, stop and report the error line.

Test: `bun run tools/check-config.ts && bun test src/core/config`.

## Step 11: sampleGrok.md dropped `[worker:low]`

Files: `git rm dotfiles/common/claude/sampleGrok.md`; its entries in `sync-config.json` and `sync-config.v2.json`.

Test: `bun run tools/check-config.ts && jq empty sync-config.json`.

## Step 12: Tag two-engines-final `[inline: a rollback tag on the shared remote]`

`git tag two-engines-final` on the step 11 commit and `git push origin two-engines-final` (roadmap "Rollback"). The
release workflow runs only on `v*` tags, so nothing is released.

Test: `git ls-remote --tags origin two-engines-final` prints one line.

## Step 13: The bootstrap runs the program `[worker:high: reasoning: bootstrap/linux.sh sources the bash engine's internals; which helpers it needs and how its stubs reach the program can't be listed without reading 850 lines]`

Files: `bootstrap/linux.sh`, `tests/linux/bootstrap.sh`, `scripts/ci/bootstrap-check.sh` if it calls the engine.

Decision 6: replace `source scripts/linux/sync.sh` with copies of the functions the bootstrap calls (from
`scripts/linux/sync.sh` and `scripts/linux/os.sh`, verbatim, list them in the summary); `./import.sh` becomes
`"$MKSYNC" import` and `./sync preview` becomes `"$MKSYNC" preview`, where `MKSYNC` is `mksync` from `PATH` when
present, else `./mksync`. Output and exit codes stay as `tests/linux/bootstrap.sh` expects; a stub `mksync` on the
test `PATH` stands in where the tests stubbed the engine. Nothing may reach the real `sudo`, `apt-get`, `snap` or
`curl`. After this step `grep -n "scripts/linux\|import.sh\|\./sync" bootstrap/linux.sh` prints nothing.

Test: `tests/linux/bootstrap.sh && shellcheck -x bootstrap/linux.sh`.

## Step 14: The installers no longer look for the old engines `[worker]`

Files: `install.sh`, `install.ps1`, `tests/windows-vm/install-check.ps1` if it checks the marker.

- The clone check (`install.sh` line ~226, `install.ps1` line ~292) looks for `mksync` and `sync-config.json` (Windows:
  `mksync.cmd`), not `sync` or `sync.cmd`.
- Decision 9: `install.sh` removes `~/.local/bin/sync` when it is a symlink into the clone (a left-over of earlier
  installers), and prints `removed the old sync link`. Any other file there is left alone.
- `install.ps1` removes the old `%LOCALAPPDATA%\SyncSettings\bin\mksync.cmd` launcher as it does today; nothing new.

Test: `bash -n install.sh && shellcheck install.sh && tests/linux/launcher.sh && tests/linux/release-files.sh`, plus
the installer tests that exist for the changed lines (find them with `grep -rln "install.sh" tests`).

## Step 15: The shared-case runners run the program only `[worker]`

Files: `tests/parity/run.sh`, `tests/parity/run.ps1`, `tests/parity/README.md`.

`--engine` (`-Engine`) defaults to `dist/mksync` (`dist\mksync.exe`); the old-engine mode, its `sync`/`sync.cmd`
calls and the `oldEngines` field go. The same step removes the field from the 17 `case.json` files that have it
(`jq 'del(.oldEngines)'`, keeping the files' formatting), so no case carries a key the runners no longer read.

Test: `bun run build && tests/parity/run.sh && grep -rl oldEngines tests/parity/cases | wc -l` prints 0.

## Step 16: The bash engine deleted `[worker:low]`

`git rm export.sh import.sh commit.sh sync scripts/linux/ tests/linux/engine.sh tests/fixtures/` (the fixtures only
`engine.sh` reads: check with `grep -rl tests/fixtures` first and keep any other user). `scripts/ci/` stays.

Test: `bun run build && tests/parity/run.sh && tests/linux/bootstrap.sh`; `grep -rn "scripts/linux\|export\.sh\|import\.sh\|commit\.sh" --include=*.sh --include=*.ts --include=*.ps1 . | grep -v tests/parity/cases` lists only lines step 22 or 24 removes.

## Step 17: The PowerShell engine deleted `[worker:low]`

`git rm sync.cmd scripts/windows/ tests/windows/`. `tests/windows-vm/` stays (it runs `run.ps1 -Engine`).

Test: `grep -rn "scripts\\\\windows\|scripts/windows\|sync\.cmd\|Engine.Tests" --include=*.ps1 --include=*.sh --include=*.ts --include=*.md . | grep -v "docs/plan-"` lists only lines steps 22, 24 or 25 change.

## Step 18: Shadow mode removed `[worker]`

Files: `src/app/shadow.ts`, `src/core/shadow.ts` (+ test), `src/adapters/engine.ts` (+ test) deleted; `src/cli/parse.ts`
(+ test) and `src/main.ts` lose the `shadow` kind. `mksync shadow` then exits 2 as any unknown command.

Test: `bun run lint && bun test src/cli src/app && bun run build && tests/parity/run.sh --engine dist/mksync usage`.

## Step 19: Linked-folder detection removed `[worker]`

Files: `src/core/machine/linked.ts` (+ test) deleted; its callers (find them with `grep -rn detectLinkedPaths src`)
and `scanLinks` in `sync-config.v2.json`'s Windows `.bashrc` entry. `parseV2` keeps accepting `scanLinks` as an
ignored key only if a shared case still uses it; otherwise it goes from the allowed keys too.

Test: `bun run lint && bun test src && bun run tools/check-config.ts`.

## Step 20: The v1/v2 check and converter removed `[worker]`

Files: `tools/check-config.ts` (keeps checking the one config: valid v2, every repo file exists, no file without an
entry; the v1/v2 comparison goes), `tools/convert-config.ts` deleted, `scripts/ci/check-config.sh` deleted if it only
compared v1 (else it calls `bun run tools/check-config.ts`). `src/core/config/convert.ts` stays (decision 7).

Test: `bun run tools/check-config.ts && bun run lint`.

## Step 21: One config file `[worker:low]`

`git rm sync-config.json && git mv sync-config.v2.json sync-config.json`. Then every reference to
`sync-config.v2.json` in `src/`, `tools/`, `install.sh` and `install.ps1` reads `sync-config.json`
(`src/adapters/snapshot.ts` keeps reading a `sync-config.v2.json` when present, for clones mid-pull; its unit test
stays). `src/adapters/git.ts`'s path list keeps both names.

Test: `bun run lint && bun test src && bun run tools/check-config.ts && bun run build && tests/parity/run.sh`.

## Step 22: The research probe removed `[worker:low]`

Decision 10: `git rm -r probe/ .github/workflows/single-engine-probe.yml`. `docs/single-engine-research.md` keeps its
evidence; a line at its top says the probe was deleted at cut-over and names the tag `two-engines-final`.

Test: `ls probe .github/workflows/single-engine-probe.yml 2>&1 | grep -c "No such"` prints 2.

## Step 23: CI and the local test command `[inline: a workflow file]`

Files: `.github/workflows/ci.yml`, `tests/all.sh`, `tests/macos/manual-checks.sh`.

- `ci.yml`: `engine-linux`, `engine-macos` and `engine-windows` jobs go; `lint` shellchecks `bootstrap/linux.sh`,
  `install.sh`, `mksync`, `scripts/ci/*.sh`, `tests/**/*.sh` that remain; `jq empty sync-config.json` stays;
  `check-config.sh` follows step 20; `macos-checks` runs `mksync doctor` (M3) instead of `./sync doctor`, and the
  `/bin/bash` re-exec check goes with `export.sh`. The bootstrap tests move into `program-build`.
- `tests/all.sh`: `parity-bash` and `windows-powershell` layers go; the rest stays.
- `tests/macos/manual-checks.sh`: `./sync` calls become `mksync`.

Test: `python3 -c 'import yaml; yaml.safe_load(open(".github/workflows/ci.yml"))' && bash -n tests/all.sh
tests/macos/manual-checks.sh` (plus `actionlint .github/workflows/ci.yml` when it is installed).

## Step 24: CLAUDE.md `[inline: the project's own rules]`

`CLAUDE.md`: "Direction" says the program is the only engine; "Today's engines" becomes "The program" (config,
`mksync` commands, invariants) and loses the bash and PowerShell 5.1 rules that only the engines used (keep the
installer and bootstrap ones); rule 3 goes; "Tests" drops `tests/linux/engine.sh`, `parity-bash` and Pester. The
"Claude auto-approval" section is not touched.

Test: `npx prettier --check CLAUDE.md`.

## Step 25: Docs `[inline: user-facing docs need judgment]`

Files: `docs/sync-contract.md`, `docs/design-layers.md`, `docs/configuration.md`, `docs/layout.md`, `README.md`,
`docs/daily-workflow.md`, `docs/design-test-moves.md`, `TODO.md`.

- Contract: one engine. The intro, "Front door" and the "Known differences" table lose the bash and PowerShell
  columns (each row that only explained an old engine goes); `sync`, `sync.cmd`, `-User` and the linked folders go;
  `config-v2-in-sync-config` and decision 8's rule join "Config".
- Design: "Tests" (the layers left, "Real-machine results"), "Open" pruned of what this plan settled, "At cut-over"
  sections in the past tense.
- `configuration.md` and `layout.md`: one `sync-config.json`, schema 2; the `.linked/` text replaced by the dir entry.
- `README.md`: the install line installs the program; decision 9 in plain words ("on a machine set up before
  v1.0.0, run the install line again, then `mksync pull`"); the old `sync` commands go.
- `docs/daily-workflow.md`: `mksync` commands only. `docs/design-test-moves.md`: a top line that the old suites were
  deleted at cut-over (tag `two-engines-final`). `TODO.md`: M1-M3 now run `mksync`.

Test: `npx prettier --check docs README.md CLAUDE.md && bun run tools/check-config.ts && scripts/ci/leak-scan.sh`.

## After this plan

The finish opens part 2's PR; it touches `.github/workflows/`, so it waits for the user's `reviewed` label. After the
merge: the user tags `v1.0.0` (a publish); Claude checks the release as in step 5, runs `mksync update` on personal
Linux (`v0.9.0 -> v1.0.0`) and `mksync pull`, and the roadmap marks phase 9 done. Work #1 runs `mksync update`, then
`mksync pull`, and checks `C:\MakuCustomAlias` and the status bar. Phase 10 starts when the user says development is
done.
