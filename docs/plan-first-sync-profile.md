# First sync keeps a work machine's own settings in its profile (`v1.1.10`)

Found 2026-11-26 on work #2 (`docs/plan-work-machines.md`, step 9), on `v1.1.9`. Work #2's `~/.claude/settings.json`
differed from the shared one in about 110 lines: its own hooks, plugins, marketplaces, permissions, model, statusline
and an `autoMode` block that names the employer. The first push needed eleven questions, two hand edits and three
moves, and still planned to change the shared file for every machine. Branch `engine/first-sync-profile`. Contract:
`docs/sync-contract.md` ("Front door" push, "No sync point", "Move a change", "New settings", "Export preview").

The model stays as designed (`docs/design-layers.md`, "Layers"): base for every machine, OS, profile per job, machine
per computer. A key that has a layer syncs on its own after that: a shared key changed anywhere goes to every machine
by fast-forward; a profile key stays with its job. What fails is the first sync of a machine that already has its own
settings.

## The gaps

1. **A first sync has no "keep this machine's settings with its job".** The picker offers `s` (send), `r` (take the
   repo's) and `k` (skip). `s` treats each difference as a daily change: a changed base key goes to all machines, and
   the user must move each one to the profile by hand.
2. **A base key the machine lacks can only be removed for everyone.** `theme`, `tui` and `cleanupPeriodDays` showed
   as `-` under "All machines", and a removal can't move (`change <n> removes a setting; it can't move.`). The user
   had to add them to the local file by hand.
3. **Numbers change after a move.** The contract says the block prints again "with the change under its new group and
   its number kept", but `groupsOf` (`src/core/plan/groups.ts`) numbers the lines on every render, in group order.
   After moving `1` (`model`) to the profile, `statusLine` became `1` and `model` `2`, so the second move hit `model`
   again and `statusLine` stayed under "All machines".
4. **A push that sends nothing records no sync point.** `writeSyncPoint` runs only after a PR opens
   (`src/app/commit.ts`). A first sync answered with `r` alone, or whose changes all stay in private layers, ends with
   `Nothing to send.` and no sync point, so the next push asks the whole picker again and `mksync diff` keeps saying
   `?`.
5. **Preview's count leaves out a file waiting for a value.** `3 file(s) would change.` while a fourth,
   `claude/settings.json`, was `SKIPPED … needs <YOUR_GH_OWNER>`. The summary line is easy to read as the whole story.

## Decided (proposed, for review)

1. **`p`: keep this machine's differences in its profile.** With a machine record, the first-sync picker offers `p`
   for a `json` or `whole` entry:

   ```text
     dotfiles/common/claude/settings.json  109 line(s) changed
     Send this machine's version (s), keep its differences in profile work2 (p), take the repo's (r) or skip (k)? [p]
   ```

   - `json`: every changed or new key and every new array item goes to the profile layer; the base and OS layers are
     not changed. A base key or array item the local file lacks is not removed anywhere: after the export, the local
     file is written from the layers (`.bak` first), so it gains it. Every value on this machine stays as it was.
   - `whole`: the local file becomes the profile layer's copy; the base stays.
   - It prints, before the export's lines:
     `  PROFILE    dotfiles/common/claude/settings.json  (9 change(s) kept in profile work2; 4 shared setting(s) added here)`.
   - The suggestion in brackets is `p` on any profile but `personal`, `s` on `personal`. An empty answer takes it.
   - Without a record, or for another merge type (`text`, `import`, `dconf`, `dir`), the question stays
     `[s/r/k]` with no suggestion, as in `v1.1.9`. There, `p` prints `  Pick s, r or k.`; with `p` offered, a bad
     answer prints `  Pick s, p, r or k.`
   - `--yes` with no sync point takes each file's suggestion: `p` on a work profile where it is offered, `s` otherwise.
     The `v1.1.9` warning names the profile:
     `WARNING: no sync is recorded on this machine; the differences of 1 file(s) stay in profile work2, the rest are sent.`
   - The profile layer is private: while the repo is public it stays in local state ("held until the repo is private"),
     so `p` alone opens no PR.

2. **Numbers are kept.** A change's number is set once, when the block first prints, and stays with it through every
   move, as the contract already says. A group lists its changes in number order, so a moved change can appear between
   higher numbers. New settings keep theirs too.
3. **A push that leaves this machine in agreement records the sync point.** A push that ends with `Nothing to send.`
   records `last-sync` at the clone's `HEAD` when no file was skipped (`k`), no path was picked, the clone is clean,
   and `HEAD` is `origin/master` after push's fetch. With a `k` file it records nothing, as today.
4. **Preview counts the waiting files.** The summary reads
   `  3 file(s) would change; 1 more wait(s) for a value (mksync push asks for it).` when a file is `SKIPPED … needs`.
   Without one it is unchanged.

Not in this plan (design "Open"):

- **Promote or demote a key.** A command that moves a key that is already synced between the profile and the base
  (for example, make work #2's statusline the shared one), and its name, through the `cli` skill.
- **Removing a key in a later layer** stays open. `p` doesn't need it, since it adds the shared key on this machine.
- **work #2's `statusLine`.** `p` keeps its PowerShell statusline in profile work2, and it then overrides the shared
  `mksync statusline` there, so a later shared statusline change won't reach work #2. The promote command, once it
  exists, settles it.

## Step 1: Contract `[inline: contract wording]`

Files: `docs/sync-contract.md`, `docs/design-layers.md`.

- "Front door" push, "No sync point": decision 1, with the question lines, `PROFILE` line, suggestion, `Pick` lines,
  the `--yes` rule and warning, and the `p` follow-up import (`.bak`).
- "Move a change": decision 2 (numbers set once; group order by number).
- Sync point: decision 3 under push.
- "Export preview": decision 4's summary line.
- Design: "First sync" gets the `p` rule; "Open" gets the three items above.

Test: `rtk grep -n "keep its differences in profile\|Pick s, p, r or k\|more wait(s) for a value" docs/sync-contract.md`
finds each line.

## Step 2: Shared cases for kept numbers `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `tests/parity/cases/push-move-keeps-number/`.

A machine record with profile `work-1` (as `newsetting-yes-work`'s `state/`), a sync point, one `json` entry in the
base with keys `a: 1` and `b: 1`; the local file has `a: 2` and `b: 2`. stdin `1\n3\n2\n3\n\nn\n`. Expect (from
decision 2): the second block lists `2 M … b` under "All machines" and `1 + … a` under "Profile work-1"; after the
second move "All machines" is `(none)` and "Profile work-1" lists `1` then `2`; `Open a PR …? [y/N]` answered `n`;
exit 0; the repo file unchanged.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync push-move-keeps-number` fails (the second block shows
`1 M … b`).

## Step 3: Keep a change's number through moves `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/core/plan/groups.ts`, `src/app/export.ts`, `src/core/plan/groups.test.ts`.

`groupsOf` and `changeLineNumbers` take an optional number map (change identity to number: entry file plus key path,
plus the item for an array item, or the file for a whole file). `askMoveQuestions` builds it from the first render and
passes it to every later `groupBlock` and to `changeForNumber`. Lines in a group print in number order. Unit cases:
a move to a later group keeps both numbers; a group lists by number; no map numbers as today.

Test: `bun test src/core/plan/groups.test.ts src/app` passes; `tests/parity/run.sh --engine dist/mksync "push-move|push-front-move|push-groups"`
passes.

## Step 4: Shared cases for `p` `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `tests/parity/cases/push-first-sync-profile/`, `tests/parity/cases/push-first-sync-profile-whole/`,
`tests/parity/cases/push-first-sync-personal/`, `tests/parity/cases/push-first-sync-profile-yes/`.

A machine record with profile `work-1`, no sync point, a git remote and the `gh` stub. Expected trees from decision 1:

- `push-first-sync-profile`: one `json` entry, base `{"a": 1, "b": 1, "c": [1]}`, local `{"a": 2, "d": 1, "c": [1, 2]}`.
  stdin `\n`. The `[p]` question; `PROFILE … (3 change(s) kept in profile work-1; 1 shared setting(s) added here)`;
  the profile layer in `state/` holds `a: 2`, `d: 1`, `c: [2]`; the base unchanged; the local file is `a: 2`, `b: 1`,
  `c: [1, 2]`, `d: 1` with a `.bak`; `Nothing to send.`; no `gh` call; `last-sync` written; exit 0.
- `push-first-sync-profile-whole`: one `whole` entry, stdin `p\n`. The profile layer holds the local file; the base
  unchanged; local unchanged; `last-sync` written.
- `push-first-sync-personal`: profile `personal`, the `json` entry. The question ends `[s]`; stdin `\n` sends it as
  `s` does (the PR in `gh.log`).
- `push-first-sync-profile-yes`: `--yes`, the `json` entry and a `text` entry. The decision 1 warning; the `json`
  file kept in the profile, the `text` file sent (`gh.log`).

Test: `bun run build && tests/parity/run.sh --engine dist/mksync push-first-sync` fails on the four new cases only.

## Step 5: Place a file's changes in the profile `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/core/plan/move.ts`, `src/core/plan/move.test.ts`.

A new `keepInProfile(plan, snapshot, file): Result<{ plan: RunPlan; kept: number; added: number }, string>`: every
change line of `file` but `-` is moved with `applyMove(…, "profile")` (in line order, numbers fixed before the first
move); a `-` line is left out of the plan (nothing is removed from its layer) and counted as `added`. A `whole` file
moves with `moveWholeFile`. Unit cases: changed base key, new key, new array item, removed base key, removed array
item, whole file, a file with no changes (`kept: 0`).

Test: `bun test src/core/plan/move.test.ts` passes.

## Step 6: The picker offers `p` `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/app/push.ts`, `src/app/push.test.ts`.

`pickChoice` and `askOneChoice` take whether `p` is offered and the suggestion; an empty answer takes it.
`pickFirstSync` returns `keep` (the `p` paths) besides `skip` and `take`, and offers `p` only with a record and a
`json` or `whole` entry. With `--yes` and no sync point, `guardPush` returns the suggestions as `keep` and prints the
new warning. Unit cases: each answer, Enter on a work and on `personal`, `p` not offered, the two `Pick` lines, end of
input, `--yes`.

Test: `bun test src/app/push.test.ts` passes.

## Step 7: Push keeps the `p` files in the profile `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/app/push.ts`, `src/app/export.ts`, `src/main.ts`.

`executePush` passes `keep` to `deps.runExport`; `pushExportCommand(only, yes, skip, keep)` in `main.ts`. The export
applies `keepInProfile` to each kept file before the new-setting questions, prints its `PROFILE` line, and asks no
new-setting question for a kept file. After the export, `executePush` runs `deps.runImport(keep)` to write each kept
file from its layers (`.bak` first). A failed import stops the push with its code.

Test: `tests/parity/run.sh --engine dist/mksync "push-first-sync|push-guard|newsetting"` passes, except the sync point
in `push-first-sync-profile` (step 9); `bun test src/app`.

## Step 8: Shared cases for the sync point after nothing sent `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `tests/parity/cases/push-first-sync-all-repo/`, `tests/parity/cases/push-first-sync-skip-no-point/`.

- `push-first-sync-all-repo`: no record, two `whole` files, stdin `r\nr\n`. Both taken, `Nothing to send.`,
  `last-sync` is the clone's `HEAD`; a second command, `diff`, prints every file `=` and exits 0.
- `push-first-sync-skip-no-point`: stdin `r\nk\n`. `Nothing to send.`, no `last-sync`.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync push-first-sync` fails on `push-first-sync-all-repo`
and `push-first-sync-profile`.

## Step 9: Record the sync point when nothing is sent `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/app/push.ts`, `src/app/commit.ts`, `src/app/push.test.ts`.

Export `writeSyncPoint`'s caller as `recordSyncPoint(context, sha)` from `commit.ts`. In `executePush`, both
`Nothing to send.` returns record it at `HEAD` (decision 3: no `skip`, no `only`, clean clone, `HEAD` equal to
`origin/master`). Unit cases: all `r`; all `p`; a `k`; picked paths; dirty clone; clone behind.

Test: `tests/parity/run.sh --engine dist/mksync push` passes; `bun test src/app/push.test.ts`.

## Step 10: Shared case and fix for preview's count `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `tests/parity/cases/preview-count-waiting/`, `src/core/plan/preview.ts`, `src/core/plan/preview.test.ts`.

The case first (two `whole` files, one waiting for `<YOUR_NAME>`): decision 4's summary line, exit 1. Then
`previewSummary` adds the `; <n> more wait(s) for a value (mksync push asks for it)` part when `gaps.length > 0`.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync preview` passes; `bun test src/core/plan/preview.test.ts`.

## Step 11: Docs, runbook and release `v1.1.10` `[inline: release notes and docs need judgment]`

Files: `package.json`, `CHANGELOG.md`, `docs/daily-workflow.md`, `docs/plan-work-machines.md`.

- `docs/daily-workflow.md`, "First sync": what `s`, `p`, `r` and `k` do, with work #2's Claude settings as the
  example; "a shared change reaches every machine by itself" (base key edited, pushed, pulled elsewhere).
- `docs/plan-work-machines.md` step 9: the runbook below.
- Bump to `1.1.10`, changelog for gaps 1 to 5.
- `tests/all.sh` (the Windows VM layer when up), `leak-scan`, review (`ts-code-reviewer`; `ts-security-auditor`, since
  `p` decides what stays private), PR, `reviewed`, `pr-ready`, merge. Tag `v1.1.10` after the user's OK, then check
  `SHA256SUMS` and `mksync --version`, and `mksync update` on the Linux machine.

Test: `tests/all.sh` exits 0.

## Runbook: where to run what, in order

Each block says which machine and which shell. Copy it whole. Stop at the first output that differs from "Expect" and
send it to Claude.

### A. Linux laptop, Claude Code in `~/WorkspaceMaku/MakuReposStable/SyncSettings`

Review this plan, then type:

```text
/clear
/next
```

Claude runs steps 1 to 11 and stops for your OK to tag `v1.1.10`. Expect: a push notification "plan finished, PR
merged", then a question to tag.

### B. work #2, PowerShell, before or after A

Undo the half-done `v1.1.9` push. If a push is still waiting at `Open a PR with these changes? [y/N]`, type `N` first.

```powershell
cd "$env:USERPROFILE\SyncSettings"
git restore dotfiles/common/claude/settings.json
git status --short
```

Expect: `git status --short` prints nothing. Your Claude settings stay as they are now (restored from the `.bak`,
with the four shared keys added).

### C. work #2, PowerShell, after `v1.1.10` is released

```powershell
cd "$env:USERPROFILE\SyncSettings"
git pull
mksync update
mksync --version
mksync preview
```

Expect: `mksync 1.1.10`; preview's count line names no waiting file; under "All machines" the Claude settings
changes are listed, since preview shows `s`. Then:

```powershell
mksync push
```

Answer:

- the value questions: Enter when the suggestion is right (`makubexD` for the owner).
- `dotfiles/common/claude/settings.json … [p]`: Enter (keeps every work #2 Claude setting in profile work2, the
  `autoMode` block included).
- any other file: Enter on `[p]`; a `[s/r/k]` question: send Claude the line first.

Expect: a `PROFILE` line, `Nothing to send.`, no PR. Then:

```powershell
mksync diff
mksync doctor
```

Expect: `mksync diff` prints every file `=` and exits 0; `mksync doctor` ends `Ready.` and shows profile `work2`.
Open a new Claude Code session on work #2 and check that the statusline, the rtk hook and the plugins still work.

### D. Linux laptop, bash, after C

```bash
cd ~/WorkspaceMaku/MakuReposStable/SyncSettings
git pull
mksync --version
mksync pull
mksync diff
```

Expect: `mksync 1.1.10` (Claude ran `mksync update` in A); `pull` lists what changed from the repo and asks
`Apply these changes? [y/N]`: answer `y`; `diff` prints every file `=`. Nothing from work #2's profile reaches this
machine.

### E. work #1, PowerShell, after C

```powershell
cd "$env:USERPROFILE\SyncSettings"
git pull
mksync update
mksync --version
mksync diff
```

Expect: `mksync 1.1.10`. If `diff` shows only `IN` lines (`<`), run `mksync pull` and answer `y`. If it shows `?`
(no sync point yet) or `OUT`/`BOTH` lines, stop and send Claude the output: work #1's first sync gets the same `p`
answer as work #2, with its own profile.
