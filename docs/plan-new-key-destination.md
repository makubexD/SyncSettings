# New keys ask where they go, Windows leak scan, setup wording (`v1.1.3`)

Found 2026-11-25 on the first work machine (Windows, Git Bash, `mksync` 1.1.2, profile `work1`). Contract:
`docs/sync-contract.md` ("Layers (program only)", "New settings", "Public-repo guard", "mksync setup", "Diff"). Branch
`engine/new-key-destination`, one PR, then release `v1.1.3` with the user's OK.

## The bugs

1. **A new key in a one-layer JSON entry skips the question.** On Windows `claude/settings.json` has only the common
   layer. `mksync preview` put the machine's own `autoMode` (organization text), `enabledPlugins`,
   `extraKnownMarketplaces` and `hooks` under "All machines": a push would publish them and send them to every machine.
   Cause: `resolveNewSettingTarget` in `src/core/merge/json.ts` falls back to "the one present layer" before the
   new-setting question, even when the machine has a record and could answer `profile` (held while public).
2. **Leak scan false hit on Windows.** `scripts/ci/leak-scan.sh` allows extension UUIDs only for files matching
   `*dotfiles/linux/gnome/dconf/*.ini`; the preview passes Windows paths with `\`, so the allowance never matches and
   `clipboard-history@…` in `shell.ini` reads as an email. The same scan is clean on Linux.
3. **Setup asks "apply" when nothing is applied.** After `--existing stop` (answer `3`), the confirm still reads
   `Write the record and apply? [Y/n]`.
4. **Diff lists a path no entry owns any more.** The sync point (`ef9d98a`, 11-10) holds
   `dotfiles/windows/shell/.bashrc.linked/MakuCustomAlias/vs.bat`; cffe292 (11-18) made `MakuCustomAlias` a `dir`
   entry and removed that path. `diff` prints it as `IN`, `check` (rightly) has nothing to do there, and a pull can't
   clear it except by recording a new sync point.

## Proposed (approved by `/next`)

1. **With a record, a one-layer entry asks.** The one-present-layer fallback applies only without a record (today's
   `json-new-item-one-layer` stays as it is). With a record, a new key or array item with no destination is a New
   setting: asked, suggestion `3` (the profile), or `1` for `personal`; `--yes` and the preview take the suggestion; the
   diff plans it there. So a `personal` machine keeps today's result, and a work profile's keys stay in local state.
2. **Leak scan folds `\` to `/`** in the file name before the allow rules, in every rule that tests the path.
3. **Setup's confirm after `stop`:** `Write the record? [Y/n] ` (the guard-block `[y/N]` form never follows `stop`,
   since stop makes no guard block).
4. **Diff skips a sync-point path no current entry (or linked folder) owns**, the way it already skips other
   platforms' paths. Not listed, not counted.

## Step 1: Contract `[inline: contract wording needs judgment]`

Files: `docs/sync-contract.md`.

- "json entries, export": "an entry with one layer puts it there" gets "when this machine has no record"; with a record
  it is a [New setting](#new-settings).
- "New settings": say it applies to a one-layer entry too, and that the diff and preview plan the suggestion.
- "Public-repo guard" or the leak-scan rule: paths are compared with `/`, whatever the OS.
- "mksync setup" Confirm: after `stop` the question is `Write the record? [Y/n] `.
- "Diff": a path in the sync point that no current entry or linked folder owns isn't listed.

Test: `grep -n 'Write the record? \[Y/n\]' docs/sync-contract.md` prints the new line.

## Step 2: New-key cases `[worker]`

Files: new `tests/parity/cases/json-new-key-one-layer-record/`, `json-new-key-one-layer-personal/`,
`preview-new-key-one-layer/`. Model: `json-new-setting-destination` (record `wk1-laptop`, profile `work-1`, state
files) and `json-new-item-one-layer` (one `json` entry, base layer only). OS `linux`.

- `json-new-key-one-layer-record`: the local file adds key `delta: 1` the repo lacks; `export --yes`. The repo's
  `dotfiles/common/parity/settings.json` is unchanged; `state/profiles/work-1/parity/settings.json` is created with
  `{"delta": 1}` (`ADDED`); exit 0.
- `json-new-key-one-layer-personal`: same, profile `personal` in the record and state. `delta` goes to the base file
  (`MODIFIED dotfiles/common/parity/settings.json`); no profile layer file; exit 0.
- `preview-new-key-one-layer`: as the first, `preview`. The output shows the `New settings` block with
  `     goes to: profile work-1 (asked by mksync export)`; nothing written; exit 0.

Test: `tests/parity/run.sh --engine dist/mksync new-key-one-layer` fails on the first and third (delta goes to the
base) and passes on the second.

## Step 3: One-layer entries ask with a record `[inline: public-repo placement logic]`

Files: `src/core/merge/json.ts` (`resolveNewSettingTarget`, its `SplitContext`), the caller in `src/app/export.ts` or
`src/core/plan/` that builds the context (pass whether a record exists), `src/core/merge/json.test.ts`.

Change: the "one present layer" fallback runs only when the context says there is no record. Unit test: one layer,
with a record → the setting is in `newSettings`; without → it goes to the base.

Test: `bun test src/core/merge` and `tests/parity/run.sh --engine dist/mksync 'json-new|preview-new|diff-new'` after
`bun run build`.

## Step 4: Windows-path leak-scan case and fix `[inline: VM reproduction]`

Files: new `tests/parity/cases/preview-extension-uuid/` (one `whole` entry, OS `linux`,
`dotfiles/linux/gnome/dconf/shell.ini` holding `enabled-extensions=['clipboard-history@example.github.io']`, a local
edit to another file, `preview`: `Leak scan: clean.`, exit 0), `scripts/ci/leak-scan.sh` (`file=${file//\\//}` before
the allow rules).

Test: the case fails in the VM before the fix (`run.ps1 -Engine dist/mksync.exe preview-extension-uuid`) and passes
after; `tests/parity/run.sh --engine dist/mksync leak` stays green.

## Step 5: Setup's confirm after stop `[worker]`

Files: `src/wizard/setup.ts` (a `CONFIRM_STOP_QUESTION` constant used when the action is `stop`),
`src/wizard/setup.test.ts`, the `expect/` of any setup case whose output shows the stop confirm.

Test: `bun test src/wizard` and `tests/parity/run.sh --engine dist/mksync setup-existing` after `bun run build`.

## Step 6: Diff skips unowned sync-point paths `[inline: diff ownership judgment]`

Files: new `tests/parity/cases/diff-entry-moved/` (sync point holds `dotfiles/common/parity/old.linked/x.conf`, HEAD
removed it, config has no entry owning it; `diff` prints `This machine and the repo agree.`, exit 0), `src/app/diff.ts`
(filter sync-point paths through the same ownership test the current entries use).

Test: the case fails before and passes after; `tests/parity/run.sh --engine dist/mksync diff-` stays green.

## Step 7: Docs, changelog and full suite `[inline: user-facing copy]`

Files: `docs/pull-push-modes.md` (a one-layer file's new key is asked), `docs/daily-workflow.md` if it repeats the
rule, `CHANGELOG.md` (`v1.1.3`), `package.json` version `1.1.3`, design "Open" if anything is left.

Test: `tests/all.sh` with the VM up.

## After the release (work machine `work-machine-1`)

`mksync update`, then `mksync preview`: the four keys show `goes to: profile work1`. Then
`mksync push --force dotfiles/common/claude/settings.json`, answering `3` for each; the PR should change no repo file
for Claude (the keys are held). Windows Terminal (`OUT`, Windows layer) is decided separately.
