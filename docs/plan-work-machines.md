# Work machines on `v1.1.3`, then the private switch

Testing on the personal Linux machine is done: `tests/all.sh` is green with the Windows VM (151 VM cases), the macOS
checks run in CI, and on 2026-11-25 this machine runs `mksync 1.1.3` with `check`, `diff` and `status` all clean. What
is left can only run on the Windows work machines: the real `preview`/`push` that v1.1.3 was released for, the
"Confirm on Windows" items in `docs/design-layers.md`, and work #2 and #3 from scratch. This plan ends at the private
switch, which is step 13 of `docs/plan-single-engine-10.md`; its part D (steps 14-16) follows there.

Branch `engine/work-machines`. Results go into `docs/design-layers.md` ("Real-machine results", "Confirm on Windows")
and `docs/windows-cutover-run.md` ("Answer") as each step finishes.

## Rules for this plan

- **The user runs every command on a work machine** and pastes the output back with `/next`. Claude never asks for
  anything that writes outside the clone and `~/.claude` except where a step says so.
- **Redact before pasting:** user, host, domain, email, company, product and person names become `USER`, `HOST`,
  `DOMAIN`, `<email>`, `work-tool-1`, `work-tool-2`… Claude checks the paste again before writing it into a doc.
- **A bug stops the plan.** Claude writes it down with the output, and it gets its own hotfix plan and release (as
  v1.1.3 did); this plan resumes at the same step after the fix is on that machine.
- **Every push opens a PR** that Claude reviews against the public-repo rule: no work setting lands in
  `dotfiles/common/` or `dotfiles/windows/` unless it is generic. Profile and machine layers stay in local state.
- Work #3 is "maybe": if there is no third machine, steps 10 and 11 are marked skipped with the date.

## Part A: work #1

## Step 1: Update work #1 and read its state `[inline: the user's machine]`

On work #1, in Git Bash or PowerShell:

```
mksync --version
mksync update            # a clone install says to use git pull instead: then run the next line
git -C ~/SyncSettings pull
mksync --version
mksync status; mksync doctor; mksync diff; mksync check
```

Test: `--version` prints `mksync 1.1.3`; `diff` no longer lists `.bashrc.linked/MakuCustomAlias/vs.bat` as `IN`;
`diff` and `check` agree on every file (Windows Terminal is the one expected `OUT`).

## Step 2: Preview on work #1 `[inline: the user's machine]`

```
mksync preview
```

Test: the 4 local Claude keys (`autoMode`, `enabledPlugins`, `extraKnownMarketplaces`, `hooks`) read
`goes to: profile work1`, none under "All machines"; the leak scan is clean (no hit on `clipboard-history@…` in
`shell.ini`); exit 0.

## Step 3: Push the Claude settings from work #1 `[inline: the user's machine and a public-repo review]`

```
mksync push --force dotfiles/common/claude/settings.json
```

Answer `3` (this profile) for each new key. Then `mksync diff`.

Test: if a PR opens, Claude reads its whole diff and finds none of the 4 keys in `dotfiles/common/`; the keys are in
the profile layer in local state (`mksync profile show work1` or the state clone's `profiles/work1/`); `diff` prints
"This machine and the repo agree" for that file. Claude merges the PR under the repo's auto-approval rule.

## Step 4: Windows Terminal on work #1 `[inline: the user decides what is shared]`

Claude shows the 20 `OUT` lines from step 1's diff (redacted) and asks: share them in the Windows layer (every Windows
machine), keep them in profile `work1`, or leave them unsynced. Then the user runs the matching push, or nothing.

Test: the chosen layer holds the lines (PR diff, or `mksync profile show work1`), or the decision is recorded; next
`mksync diff` on work #1 agrees, or lists only that file if it was left unsynced.

## Step 5: Statusline and Git Bash on work #1 `[inline: the user's machine]`

From Git Bash: `command -v mksync; mksync --version` (the extensionless shim from cut-over step 9). Then open Claude
Code: the status bar shows `mksync statusline`'s line.

Test: `mksync` runs from Git Bash with exit 0, and the bar shows. This settles real-Windows checklist item 2
(`docs/design-layers.md`, "Tests").

## Step 6: "Confirm on Windows" checks on work #1 `[inline: the user's machine]`

The five checks in `docs/windows-cutover-run.md` ("Work #2 and #3: the extra checks"), run on work #1 too, plus setup
with no console, in PowerShell:

```powershell
cmd /c "mksync setup < NUL"; "exit $LASTEXITCODE"
```

Test: setup refuses without a terminal (exit 2, asks for `--yes`) and writes nothing; the five answers are pasted and
recorded under a new "Work #1: extra checks" block in the run sheet.

## Step 7: Linux after work #1's push `[inline: the user's personal machine]`

On personal Linux, after step 3's (and step 4's) PRs are merged: `git -C <clone> pull`, `mksync diff`, `mksync pull`
if it lists `IN` files, then `mksync check`.

Test: Linux gets nothing from work #1's profile keys; `check` prints "This machine matches the repo".

## Part B: work #2 and #3

## Step 8: Install on work #2 and answer the survey `[inline: the user's machine]`

The install through a signed-in `gh` (run sheet, "Work #2 and #3"), the run sheet's steps 1-7, its five extra checks,
and the survey questions work #1 answered (`docs/design-layers.md`, "Confirm on Windows": shell, Git Bash and `jq`,
current Claude layout, `$HOME` in commands).

Test: `mksync --version` prints `1.1.4` (`docs/plan-windows-hotfix.md`, released before work #2); the report and the
answers are pasted, redacted, and recorded under "Work #2" in the run sheet and design.

## Step 9: Set up and push work #2 `[inline: the user's machine and a public-repo review]`

First the doctor hotfix (`docs/plan-doctor-hotfix.md`, `v1.1.5`): `git -C "$env:USERPROFILE\SyncSettings" pull`, then
`mksync --version` (`1.1.5`) and `mksync doctor` from the clone (`OK       bash`). Then `mksync setup` with profile
`work2` (answer `3`, stop, when it finds existing settings). Setup on `v1.1.5` wrote the record, then `preview`
stopped on a missing value: the values hotfix (`docs/plan-values-hotfix.md`, `v1.1.6`) reads the values from the
machine's files, so after a second `git pull` (`mksync --version` prints `1.1.6`) nothing is filled by hand. `1.1.6`
still stopped at `missing value for <HOME>` (Windows sets no `HOME`): the values-ask release
(`docs/plan-values-ask.md`, `v1.1.7`) takes the home folder for it and makes push ask for any value nothing fills, so
after a third `git pull` (`mksync --version` prints `1.1.7`) push needs no shell variable. Then `mksync preview`, then
`mksync push` from a terminal, answering the public-name question (not the hostname) and `3` (this profile) for each
machine-only key.

Test: `mksync doctor` shows the record and profile; Claude reviews any PR as in step 3; `mksync diff` agrees.

## Step 10: Install on work #3 and answer the survey `[inline: the user's machine]`

As step 8, on work #3.

Test: as step 8, recorded under "Work #3".

## Step 11: Set up and push work #3 `[inline: the user's machine and a public-repo review]`

As step 9, with profile `work3`.

Test: as step 9.

## Part C: every machine in step, then private

## Step 12: Every machine agrees `[inline: the user's machines]`

On each machine: `mksync --version` and `mksync diff`. Pull where it lists `IN`.

Work #1 and the personal machine get their public name (`alias`) on their next push from a terminal, as `v1.1.4`
asks once per record.

Test: every machine prints `mksync 1.1.7` (or the latest release) and "This machine and the repo agree".

## Step 13: The private switch `[inline: the user's switch]`

Step 13 of `docs/plan-single-engine-10.md`: `gh auth login` on each machine, then the user switches the repo to
private. Claude checks `gh repo view makubexD/SyncSettings --json visibility` and records the date in
`docs/decision-private-repo.md`.

Test: the `gh repo view` above prints `PRIVATE`; `mksync status` on Linux still reads "Origin : up to date" through
the signed-in `gh`.

## Step 14: Docs `[inline: user-facing docs]`

Files: `docs/design-layers.md` (close each "Confirm on Windows" item with its answer, add the work machines to
"Real-machine results"), `docs/windows-cutover-run.md` (answer blocks), `docs/plan-single-engine.md` (phase 10 part C
done), `CHANGELOG.md` if a hotfix shipped, and the README or `docs/daily-workflow.md` for anything the machines showed
to be wrong or missing.

Test: `npx prettier --check docs/*.md`, `leak-scan` green, `grep -rn "$HOME" docs/` prints nothing.
