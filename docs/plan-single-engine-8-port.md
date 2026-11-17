# One engine, phase 8: the case port

Roadmap: `docs/plan-single-engine.md`, phase 8 (the last part). Move list: `docs/design-test-moves.md`. Contract:
`docs/sync-contract.md`. Goal: every old bash and Pester case without a shared twin is either covered by the program
(a shared case, or a unit or adapter test when the runner can't drive it), or dropped for a written reason, so phase 9
can delete the old engines without losing a check.

## The inventory

`docs/port-inventory.tsv` (committed with this plan) holds one row per old case of the move list, 540 rows:
`suite`, `name`, `verdict`, `target`, `spec`. It was built on 2026-11-16 by reading each old case and searching
`tests/parity/cases/` and `src/**/*.test.ts` for the same behavior:

| Verdict    | Rows | Meaning                                                                                                        |
| ---------- | ---- | -------------------------------------------------------------------------------------------------------------- |
| `TWIN`     | 258  | a shared case or unit test already checks it (`target` names it)                                               |
| `BASHTWIN` | 124  | a Pester case whose bash twin is in the list; it follows that twin's verdict                                   |
| `PORT`     | 124  | nothing checks it yet: a step below                                                                            |
| `DROP`     | 34   | can't exist in the program (bash internals, `sync`/`sync.cmd`, installers, `-User`, CI scripts that stay bash) |

The inventory is a first pass. This plan overrides it where they differ: eleven `TWIN` rows whose twin skips the
note or `ERROR:` text the old case checks (marked `gap:` in their spec) are ported here, and the setup and bootstrap
rows wait for phase 9 (decision 6). Step 39 records the final verdict of every row.

## Shared rules

- Branch `engine/case-port`, one commit per step, one PR at the end.
- **Old engines frozen.** No change to `export.sh`, `import.sh`, `commit.sh`, `sync`, `sync.cmd`, `scripts/linux/`,
  `scripts/windows/`, `sync-config.json`, `tests/linux/engine.sh`, `tests/windows/`. The runners (`tests/parity/run.sh`,
  `run.ps1`) and their README may change; no existing case's `expect/` changes.
- **Contract first** (CLAUDE.md rule 2). `expect/` is written from the contract, quoting its lines, never from an
  engine's output. A ported case runs on the bash engine and the program (and the PowerShell engine in the VM, in the
  finish): the old case passed on bash, so bash failing a ported case means the case is wrong. Fix the case.
- **A program failure is a stop**, except in the steps that fix a named gap. When the program fails a ported case for a
  reason the step doesn't fix, the worker leaves that case out, keeps the rest, and names it with the failing lines in
  its summary. `/next` stops there. The plan gets a fix step through a plan edit.
- **Public repo.** Fixtures use `example.com`, `/home/user`, `C:\Users\user`, profiles `work-1` and `personal`,
  machines `wk1-laptop` and `home-linux`. `leak-scan` stays green.
- **Every OS a case claims.** CI runs the shared cases on Linux, macOS and Windows. A case with no `os` field picks,
  changes and expects only `common` entries (`dotfiles/common/…`); a `linux` or `windows` entry in it is a bystander
  that stays unchanged everywhere. A case that needs a `linux` entry synced sets `os: ["linux"]`.
- **Case names.** Each step names its new cases. The names share a prefix with their group (`only-`, `check-`,
  `dir-`, …), so the step's filter also reruns the group's existing cases.
- **Description** of each case: one sentence and the contract section in brackets, plus `Ported from <old name>` (and
  the Pester name when there is one). Step 39 builds the "Moved from" table from these.
- **Layout.** `src/core/` stays pure. Tests sit next to their file. No new dependencies.
- Each worker step: about 3 files (a shared case folder counts as one file), one concern. The test commands run that
  step's cases and tests only; the full suite (`tests/all.sh`) runs once, in the finish.
- Shared-case test command, used by every port step with that step's `<filter>`:
  `bun run build && tests/parity/run.sh <filter> && tests/parity/run.sh --engine dist/mksync <filter>`.

## Out of this plan

- **Setup and bootstrap cases** (`sync-setup-offers-bootstrap`, `sync-setup-doctor-fails`,
  `front-macos-setup-no-bootstrap`, `front-macos-bootstrap-flag`): the program has no bootstrap question,
  `--bootstrap` flag or doctor before setup yet. Phase 9 builds those with the installers, and ports these four cases
  then (step 1 adds them to the roadmap's phase 9).
- **Package-list and plugin-list lint, leak-scan and installer cases**: their scripts stay bash (`DROP` rows).
- **The Windows answer trim and the other phase 9 items** in the design's "Open": unchanged.

## Decisions to confirm in review

Proposals; the review of this plan confirms or changes them before `/next`. Step 1 writes them into the contract,
the design and the runner README.

1. **Ported cases check the text the old case checked.** The runner drops notes, `ERROR:`/`WARNING:` lines and
   summaries, which is why eleven twins are only partial. A case may add `expect/lines.txt`: lines that must appear
   in the command output, in that order, with other lines in between allowed. Lines are compared after the runner's
   color strip and with leading and trailing spaces trimmed. Status lines are compared in one layout, `WORD label note`
   with single spaces, whichever engine printed them. With more than one command, each command's lines follow a line
   `# <n>` (1-based). `output.txt` stays the exact check of status lines. A plain line that must _not_ appear is
   written `! <text>`.
2. **What stays a unit or adapter test.** The runner can't set up a write failure, a symlink in `home/`, an
   unreachable origin, a failing `gh`, a real dconf bus or the package managers (README, "What fits"). Those cases
   become unit or adapter tests next to the code, as the move list says for `core unit test` and `adapter test` rows.
   The runner doesn't grow for them.
3. **Gaps found by the inventory are fixed here, contract first.** The contract already states each rule; the
   program doesn't follow it:
   - a symlink under `dotfiles/` (contract "Paths": `Nothing under dotfiles/ is a symlink`): the program's
     `readTree` follows it. It must stop with `ERROR: sync-config.json: entry <repoPath> has an unsafe path.` (step 29);
   - an unreadable local file (contract "Status lines": an `ERROR` line, `<n> error(s)`, exit 1): the snapshot drops it,
     so check reports `CREATE` and export would treat the file as gone (step 27);
   - a sync point write that fails (contract "Sync point": `WARNING: could not record the sync point in <file>.`): the
     program ignores the result of its `finish` actions (step 28);
   - `--only` with a `dir` entry's own folder (contract "Only": `equal to a dir entry's folder gives its repoPath`):
     the program's `resolveOnly` refuses it (step 8);
   - Windows export of a shared file (contract "Line endings": `export writes it with LF line endings`): the program
     writes the local CRLF bytes (step 31);
   - the export preview's `--stat` summary and full diff (contract "Export preview"): the program prints neither
     (steps 32 and 33);
   - the macOS doctor's `brew` line (contract "Front door", `mksync doctor`): missing (step 34);
   - local state readable by the user only on Windows (design rule 6, "checked on the VM"): `writeValuesFile` skips
     the ACL (step 35).
4. **A local file that became a symlink in a `dir` entry.** The contract skips symlinks (`SKIPPED … symlink`) but
   doesn't say what happens to the repo copy. Bash removes it (`REMOVED … no longer in source`), since a symlink isn't
   a file of the folder; the program keeps it. Proposal: follow bash, and write the sentence into "Directory entries"
   (step 30).
5. **Push behind origin.** The bash front door checks before the export (`scripts/linux/front.sh`, `push`): after
   `git fetch -q origin master`, any commit in `HEAD..origin/master` stops it with
   `ERROR: origin has updates; run mksync pull first.`, exit 1, nothing exported, `gh` not called. A failed fetch
   skips the check. The contract doesn't say so, the PowerShell front door doesn't do it, and the program runs export
   (which only warns without a terminal) and lets commit stop with `ERROR: master is behind origin; pull first.`.
   Amended at step 1 (first draft had the program's order): the contract's push row states the bash check, the
   program does the same on every OS (step 19), and the PowerShell front door's lack of it is a Known difference
   until cut-over (old engines frozen), so the case runs on Linux and macOS.
6. **Config lint rules.** Fourteen `lint-*` cases test rules of `scripts/ci/check-config.sh` that neither v1 nor v2
   parsing has (an entry inside a `dir` entry, `dir` with sanitize rules, `dconf` with `localPath`, rules, linking or
   bad `keys`, `keys` on a file, an unknown type). The config check script dies at cut-over with the v1 config.
   Proposal: step 36 decides, rule by rule, which have a v2 meaning (a file inside a `dir` entry's folder does; a
   v1 field name doesn't), writes those as v2 refusals in the design, and step 37 adds them to `parseV2`. The rest
   are dropped with that reason.

## Step 1: The port's rules in the contract, design and roadmap `[inline: contract and design text, written from the decisions above]`

Files: `docs/sync-contract.md`, `docs/design-layers.md`, `docs/plan-single-engine.md`.

Contract: decision 4 in "Directory entries" (a local file that is now a symlink: `SKIPPED <label> symlink`, then the
repo copy `REMOVED <label> no longer in source`); decision 5 in the `mksync push` row (the check before the export,
its line and exit code) and a "Known differences" row for the PowerShell front door. Design: "Decided in phase 8, the port": decisions 1 to 6 as rules, one example
each, and the Open items they settle. Roadmap phase 8: this plan's link; phase 9: the four setup and bootstrap cases.

Test: `npx prettier --check docs/design-layers.md docs/plan-single-engine.md && git diff --check`.

## Step 2: The runner checks `expect/lines.txt` `[worker]`

Files: `tests/parity/run.sh`, `tests/parity/run.ps1`, `tests/parity/README.md`, new case
`tests/parity/cases/only-no-file-import/`.

Both runners implement decision 1 (as step 1 wrote it into the README's "A case" and "How the runner checks it"
sections): read `expect/lines.txt` when present; for each command, normalize the output (color strip, trim, status
lines as `WORD label note`); check each expected line in order, `! <text>` absent anywhere in that command's output.
A failure prints the first missing line and the command's normalized output. The PowerShell side is written to the
same rule and checked in the finish's VM run.

Case `only-no-file-import` (Only), from `only-no-file-import`: the fixture's file entry
`dotfiles/linux/plain.txt` ↔ `~/.config/fixture/plain.txt`; `import --force --only ~/.config/fixture/dir/missing.txt`
(a path under no entry is refused, so give the config a `dir` entry `dotfiles/common/dir` ↔ `~/.config/fixture/dir`
and pick a file it doesn't hold); exit 0; `lines.txt`: `WARNING: --only matched no file.`; trees unchanged.

Test: `bun run build && tests/parity/run.sh only-no-file && tests/parity/run.sh --engine dist/mksync only-no-file`,
and a copy of the case with a wrong line in `lines.txt` fails on both (then delete the copy).

## Step 3: Shared cases for `--only` no-match warnings `[worker]`

Files: new folders under `tests/parity/cases/`. Contract "Only". Each case's fixture as in step 2's case.

- `only-no-file-check` (`only-no-file-check`): `check --only ~/.config/fixture/dir/missing.txt`; exit 0; lines
  `WARNING: --only matched no file.`
- `only-no-file-export` (`only-no-file-export`): `export --only` the same path; exit 0; same line; repo unchanged.
- `only-hit-no-warning` (`only-hit-no-warning`): `import --force --only dotfiles/linux/plain.txt`, local differs;
  exit 0; `UPDATED dotfiles/linux/plain.txt`; lines `! WARNING: --only matched no file.`

`only-no-file-diff` moved to step 5: the program fails it.

Test: the shared-case command with filter `only-`.

## Step 4: Shared cases for `--only` picks `[worker]`

Files: new folders under `tests/parity/cases/`. Contract "Only". Each case's fixture as in step 2's case.

- `only-check-one` (`import-only-check`): `plain.txt` and `tool.sh` both differ; `check --only
dotfiles/linux/plain.txt`; exit 3; status `UPDATE dotfiles/linux/plain.txt` only; lines
  `1 file(s) would change. mksync pull overwrites them (each keeps a .bak).`
- `only-export-one` (`export-only-one`): both differ; `export --only dotfiles/linux/plain.txt`; exit 0;
  `MODIFIED dotfiles/linux/plain.txt` only; repo `tool.sh` unchanged.
- `only-export-dir-removed` (`export-only-dir-removed`): `dir` entry; local `a/b.txt` changed, `c.txt` deleted;
  `export --only dotfiles/common/dir/a/b.txt`; exit 0; `MODIFIED dotfiles/common/dir/a/b.txt` only; repo `c.txt`
  kept.
- `only-import-dir-file` (`import-only-dir-file`): `dir` entry; local `c.txt` and `a/b.txt` changed;
  `import --force --only dotfiles/common/dir/c.txt`; exit 0; `UPDATED dotfiles/common/dir/c.txt`, note
  `backup saved as c.txt.bak` in lines; local `a/b.txt` keeps its text.
- `only-two-picks` (Pester `import-only-split`): three file entries, two picked with two `only` items; exit 0; both
  `UPDATED` with their `.bak` notes; the third gets no line and is untouched.

Test: the shared-case command with filter `only-`.

## Step 5: The program warns on `diff --only` with no match `[worker]`

Files: `src/core/plan/diff.ts`, `src/core/plan/diff.test.ts` (and `src/app/diff.ts` only if the plan input needs a
flag), new case `tests/parity/cases/only-no-file-diff/`.

The gap: `mksync diff --only <path>` that labels no file prints the header and `This machine and the repo agree.`
with no warning; the contract ("Only": "When `--only` is given and no file gets a status line or a diff label, the
run prints `  WARNING: --only matched no file.` before the summary; the exit code and counts don't change") and the
bash engine print it. The fix: when `--only` was given and the diff labels no path, the rendered lines hold
`  WARNING: --only matched no file.` right before the summary line; exit code unchanged. Reuse the wording constant
from `src/core/plan/run.ts` (export it) rather than a second copy.

Unit tests in `diff.test.ts`: `--only` given and no label → the warning line, then the summary; `--only` given and
a label → no warning; no `--only` → no warning.

Case:

- `only-no-file-diff` (`only-no-file-diff`): `git: remote`, `syncPoint: true`; fixture as in step 2's case;
  `diff --only ~/.config/fixture/dir/missing.txt`; exit 0; lines in this order: `WARNING: --only matched no file.`, `This machine and the repo agree.`

Test: `bun test src/core/plan/diff.test.ts` and the shared-case command with filter `only-no-file`.

## Step 6: Shared cases for `--only` refusals and values `[worker]`

Files: new folders under `tests/parity/cases/`. Contract "Only".

- `only-unknown-local` (`import-only-unknown`, `only-unknown`): `import --force --only ~/not-synced`; exit 1;
  lines `ERROR: ~/not-synced is not synced on this machine.`; home unchanged.
- `only-other-platform` (`only-other-platform`), `os: ["linux"]`: a `windows` entry `dotfiles/windows/win.conf`;
  `export --only dotfiles/windows/win.conf`; exit 1; lines
  `ERROR: dotfiles/windows/win.conf is not synced on this machine.`
- `only-repo-linked` (`only-repo-linked`): `export --only dotfiles/linux/plain.txt.linked/x`; exit 1; lines
  `ERROR: dotfiles/linux/plain.txt.linked/x is not synced on this machine.`
- `only-dotdot-in-name` (`only-repo-dotdot-name`): `dir` entry holding `foo..bar`; `export --only
dotfiles/common/dir/foo..bar`; exit 0; `ADDED dotfiles/common/dir/foo..bar` only.
- `only-dotdot-backslash` (Pester `only-repo-dotdot-backslash`), `os: ["windows"]`: `export --only
dotfiles\common\dir\..\x`; exit 1; lines `ERROR: dotfiles\common\dir\..\x is not synced on this machine.`
- `diff-only-summary` (`diff-only`): `git: remote`, `syncPoint: true`, two files changed locally;
  `diff --only` one; exit 3; `OUT` for it only; lines `1 file(s) differ: 0 in, 1 out, 0 both.`

`only-skips-unpicked-values` and its export twin moved to step 7: the missing-value line reads differently.

Test: the shared-case command with filter `only-`, then filter `diff-only`.

## Step 7: Shared cases for values an unpicked entry needs `[worker]`

Files: new folders under `tests/parity/cases/`. Contracts "Only" and "Values" ("Missing value"). Fixture as in step
2's case, plus a `linux` entry `dotfiles/linux/san.conf` ↔ `~/.config/fixture/san.conf` holding `name=<MISSING>`,
with a sanitize rule for `<MISSING>` (`prompt` `Missing value`, no default) and `values: {}`.

The second command checks no missing-value line: with no terminal bash prints the value prompt and the line on
stderr, the program no prompt and the line on stdout, and the contract names neither (design, "Open"). It checks exit
1 and trees unchanged by it.

- `only-skips-unpicked-values` (`only-skips-unpicked-values`): a picked plain entry and an unpicked sanitized entry
  whose value is missing (no default, empty values); `import --force --only dotfiles/linux/plain.txt`; exit 0;
  `UPDATED dotfiles/linux/plain.txt`; lines `! missing value for <MISSING>`. Second command without `--only`: exit 1, no
  file written (home after it as after the first command).
- `only-skips-unpicked-values-export` (`only-skips-unpicked-values-export`): the same with `export`; repo `plain.txt`
  updated by the first command.

Test: the shared-case command with filter `only-skips`.

## Step 8: `--only` with a `dir` entry's folder `[worker]`

Files: `src/core/plan/pick.ts`, `src/core/plan/pick.test.ts`, new case `tests/parity/cases/only-dir-root/`.

The case first (`only-dir-root`, from `only-dir-root`): `dir` entry, both local files changed;
`export --only ~/.config/fixture/dir`; exit 0; `MODIFIED` for both files of the folder. It fails on the program:
`resolveOnly` matches a `dir` entry only when the path starts with `<local>/`. Then the fix: a path equal to the
folder resolves to the entry's `repoPath` (contract "Only"). Unit tests: the folder itself, the folder with a
trailing `/`, a file inside, a sibling `dir-other` not matched.

Test: `bun test src/core/plan/pick.test.ts` and the shared-case command with filter `only-dir-root`.

## Step 9: Shared cases for the import check `[worker]`

Files: new folders under `tests/parity/cases/`. Contract "Import check".

- `check-create-and-update` (`import-check-writes-nothing`): local `plain.txt` differs, `no-trailing.txt` missing;
  `check`; exit 3; `UPDATE dotfiles/linux/plain.txt`, `CREATE dotfiles/linux/no-trailing.txt`; lines
  `2 file(s) would change. mksync pull overwrites them (each keeps a .bak).` and
  `If you changed them on this machine, run mksync push first.`; trees and values unchanged.
- `check-sanitized` (`import-check-sanitized`): a sanitized entry with its value; `import --force` then `check`:
  `UNCHANGED` exit 0. Then the local value changed to `name = Someone Else` (a second case
  `check-sanitized-differs`, since a case can't edit between commands): `check` exit 3, `UPDATE`.
- `check-dir` (`import-check-dir`): `dir` entry, local `c.txt` changed and `extra.txt` added; `check`; exit 3;
  `UPDATE dotfiles/common/dir/c.txt`, `EXTRA dotfiles/common/dir/extra.txt`; lines
  `1 file(s) would change. mksync pull overwrites them (each keeps a .bak).`
- `check-missing-folder` (`import-check-missing-folder`): empty home; `check`; exit 3;
  `CREATE dotfiles/linux/plain.txt`; home stays empty.
- `check-no-prompt` (`import-check-no-prompt`): local differs, stdin `n\n`; `check`; exit 3; `UPDATE`; lines
  `! Overwrite`.
- `check-dconf` (`import-check-dconf`), `os: ["linux"]`, `stubs: ["dconf", "getent"]`: repo `app.ini` `a=2`, stub
  dump `a=1`; `check`; exit 3; `UPDATE dotfiles/linux/dconf/app.ini`; no `expect/dconf.log` (nothing loaded).
- `check-needs-values` (`import-check-needs-values`): a sanitized entry, no `values`; `check`; exit 3 or the
  contract's code; `SKIPPED dotfiles/linux/named.conf`, lines `needs values: run mksync setup` and
  `! Enter values`; `expect/values.json` absent and no `.user-values.json` in the repo tree.

Test: the shared-case command with filter `check-`.

## Step 10: Shared cases for `dir` entries on export `[worker]`

Files: new folders under `tests/parity/cases/`. Contract "Directory entries". The `dir` entry `dotfiles/common/dir`
↔ `~/.config/fixture/dir`, `excludePatterns` with `*.bak` and `*.secret`.

- `dir-export-adds-modes` (`dir-export-adds`): local `a/b.txt`, `c.txt` mode 755, no repo folder; `export`;
  exit 0; `ADDED` both; repo `c.txt` mode 755 (`os: ["linux", "macos"]`, modes).
- `dir-export-excluded` (`dir-export-excluded`): local `x.bak`; `export`; `SKIPPED dotfiles/common/dir/x.bak`; lines
  its note `matches exclude pattern`; not copied.
- `dir-export-missing` (`dir-export-missing`): no local folder; `export`; exit 0; `SKIPPED dotfiles/common/dir/`;
  repo kept. (The note holds the home path, so no `lines.txt`.)

A 600 fixture can't be set up (git stores only 644 and 755), so the mode check keeps the 755 file. The other cases
moved: the empty-folder ones to step 12, `dir-export-modify-remove` and `dir-export-one-left` to step 13 (the program
fails them).

Test: the shared-case command with filter `dir-export`.

## Step 11: The runner makes empty folders `[worker]`

Files: `tests/parity/run.sh`, `tests/parity/run.ps1`, `tests/parity/README.md`.

Git stores no empty folder, so `home/` can't hold one. New optional `case.json` field `emptyDirs`: a list of paths
relative to the case's temp home, each created (with parents) after `home/` is copied and before the first command.
An absolute path or one with a `..` segment is a runner error, as for `CTX_WINDOW_DIR`. A non-list or a non-string
item is a runner error. The tree compare stays files only, so an `expect/` side needs nothing. README: the field in
the `case.json` table and a line in "What fits" (an empty folder is now covered).

Test: a temp copy of `only-no-file-import` with `"emptyDirs": [".config/fixture/empty"]` passes on both engines; one
with `"emptyDirs": ["../x"]` and one with `"emptyDirs": "x"` fail with a runner error; delete the copies. Then the
shared-case command with filter `only-no-file`.

## Step 12: Shared cases for empty `dir` folders `[worker]`

Files: new folders under `tests/parity/cases/`. Contract "Directory entries". Fixture as in step 10. An empty local
folder is made with `emptyDirs` (step 11).

- `dir-export-empty-keeps-repo` (`dir-export-empty-keeps-repo`): local folder empty; exit 0; `SKIPPED
dotfiles/common/dir/`; lines `local folder is empty; repo files kept` and `! REMOVED`; repo kept.
- `dir-export-only-excluded` (`dir-export-only-excluded`): local folder holds only `x.secret`; both `SKIPPED` lines;
  repo kept.
- `dir-export-empty-both` (`dir-export-empty-both`): no repo folder, empty local folder; exit 0; no status line for
  the folder; repo folder not created.
- `dir-bracket-name` (Pester `dir-bracket-name`): local `[x].txt`; `export` twice then `import --force`; `ADDED`,
  then `UNCHANGED`, then `UNCHANGED`, each for `dotfiles/common/dir/[x].txt`; repo bytes equal.

Test: the shared-case command with filter `dir-export`, then `dir-bracket`.

## Step 13: Export removes the folders a `REMOVED` empties `[worker]`

Files: `src/core/plan/types.ts`, `src/core/plan/export.ts`, `src/adapters/fs.ts` (and their tests), new cases.

The gap: after `REMOVED dotfiles/common/dir/old/old.txt` the program leaves the empty `old/` folder in the repo;
the contract ("Directory entries": "Export deletes repo files that are gone locally or are now excluded (`REMOVED`;
git keeps the history), then removes empty folders under the entry's `repoPath`") and bash
(`find "$repo_dir" -mindepth 1 -type d -empty -delete`) remove it. The fix: the `removeRepo` action gets an optional
`pruneUpTo` (the `dir` entry's `repoPath`), set by the `dir` export; after the file is removed the adapter removes
each parent folder that is now empty, walking up and stopping before `pruneUpTo` (never removing it). A folder that
can't be removed is left, as bash does. Unit tests: nested `a/b/c.txt` removed leaves neither `a/b` nor `a`; a parent
still holding a file stays; the entry's own folder stays even when empty; no `pruneUpTo` removes only the file.

Cases (fixture as in step 10):

- `dir-export-modify-remove` (`dir-export-modify-remove`): repo has `old/old.txt` too, local `c.txt` changed;
  `export`; exit 0; `MODIFIED …/c.txt`, `REMOVED …/old/old.txt`, `UNCHANGED …/a/b.txt`; lines
  `REMOVED dotfiles/common/dir/old/old.txt no longer in source`; repo `old/` gone.
- `dir-export-one-left` (`dir-export-one-left`): local `a/b.txt` deleted; `REMOVED …/a/b.txt` with lines note
  `no longer in source`, `UNCHANGED …/c.txt`; repo `a/` gone.

Test: `bun test src/adapters/fs.test.ts src/core/plan/export.test.ts` and the shared-case command with filter
`dir-export`.

## Step 14: Shared cases for `dir` entries on import `[worker]`

Files: new folders under `tests/parity/cases/`. Contract "Directory entries", "Import". Same entry as step 10.

First, the two cases left from step 13 (its fix is committed; fixture as in step 10), test filter `dir-export`:

- `dir-export-modify-remove` and `dir-export-one-left`, exactly as step 13 lists them.

Then:

- `dir-import-creates` (`dir-import-creates`): empty home; `import --force`; exit 0; `CREATED …/a/b.txt`,
  `CREATED …/c.txt`.
- `dir-import-update-backup` (`dir-import-update-backup`): local `c.txt` is `c2`; `import --force`; `UPDATED
…/c.txt`, lines note `backup saved as c.txt.bak`; home `c.txt.bak` holds `c2`; no `EXTRA`.
- `dir-roundtrip-unchanged` (`dir-roundtrip-unchanged`): in sync; `export`, `import --force`; exit 0, 0; `UNCHANGED`
  for both files twice; no `.bak` in either tree.
- `dir-import-answer-no` (`dir-import-prompt-reads-stdin`): local `c.txt` differs, stdin `n\n`; `import`; exit 0;
  `SKIPPED …/c.txt`, lines note `user skipped`; home unchanged.

Test: the shared-case command with filter `dir-import`, then `dir-roundtrip`.

## Step 15: Shared cases for excludes, orphans and notes `[worker]`

Files: new folders under `tests/parity/cases/`. Contract "Exclude patterns", "Orphans", "Import".

- `excluded-note` (`excluded`): file entry whose local is `x.secret`; `export`; `SKIPPED`, lines note
  `matches exclude pattern`; not copied.
- `excluded-credentials` (`excluded-credentials`): the shipped `excludePatterns` of `sync-config.json` copied into the
  case's config, `dir` entry `dotfiles/common/creds` holding `.git-credentials`, `.netrc`, `.npmrc`, `.pgpass`,
  `hosts.yml`, `auth.json`, `secrets.yaml`, `token`, `app.env`, `id_dsa` and `ordinary.txt`; `export`; exit 0;
  `SKIPPED` for each credential (note `matches exclude pattern`), `ADDED …/ordinary.txt` only copied. (If a name of
  this list isn't in the shipped patterns, the case follows the shipped list and the summary says which.)
- `import-eof-backup-note` (`import-eof-overwrites`): no `--force`, empty stdin, local differs; `import`; exit 0;
  `UPDATED`, lines note `backup saved as plain.txt.bak`.
- `orphan-none-other-os` (`orphan-none`): a `windows` entry whose repo file exists; `export` on Linux
  (`os: ["linux", "macos"]`); exit 0; no `ORPHAN` line.
- `orphan-linked-ok` (`orphan-linked-ok`), `os: ["linux", "macos"]`: a `windows` entry with `detectLinkedPaths` and repo
  file `dotfiles/windows/linked.sh.linked/tool/x.bat`; `export`; no `ORPHAN`.
- `orphan-note` (`orphan-no-dir-entries`): repo `dotfiles/stray.txt` no entry owns; `export`; `ORPHAN
dotfiles/stray.txt`, lines note `no entry in sync-config.json; git rm it or add an entry`.
- `export-sanitized-note` (`common-export`): a `common` sanitized entry; `export`; `ADDED dotfiles/common/shared.conf`,
  lines note `(sanitized)`.

Test: the shared-case command with filters `excluded`, `orphan-`, `import-eof-backup`, `export-sanitized-note`.

## Step 16: Shared cases for the export preview `[worker]`

Files: new folders under `tests/parity/cases/`. Contract "Export preview". `git: committed`.

- `preview-nothing-written` (`preview-writes-nothing`): a modified, an added and a removed file; `preview`; exit 0;
  `MODIFIED`, `ADDED`, `REMOVED`; lines `Nothing was written. Run mksync push to send it.`; trees unchanged.
- `preview-leak-found` (`preview-leak-found`): local `plain.txt` is `/home/someone/x`; `preview`; exit 1; lines
  `WARNING: the leak scan found the lines above. Fix them before committing.` and `! /home/someone`.
- `preview-reset-refused` (`preview-reset-rejected`): `preview` with `resetValues`; exit 1; lines
  `ERROR: --preview cannot be combined with --reset-values.` (if the runner refuses `resetValues` on `preview`, this
  case is a parse unit test in `src/cli/parse.test.ts` instead, and the summary says so).
- `preview-scan-missing` (`preview-scan-missing`): `repo/scripts/ci/leak-scan.sh` absent from the case's repo (if the
  runner always copies it, a unit test in the preview app's test file instead); `preview`; exit 1; lines
  `ERROR: leak scan could not run; nothing was committed.`
- `preview-matches-export` (`preview-matches-export`): one change; `preview`, then `export`; the preview's status
  lines equal the export's.

Test: the shared-case command with filter `preview-`.

## Step 17: Shared cases for commit `[worker]`

Files: new folders under `tests/parity/cases/`. Contract "Checks before pushing". `git: remote`, `stubs: ["gh"]`,
modeled on `commit-opens-pr`.

- `commit-packages` (`commit-packages`): `unsent/packages/linux/apt.txt` holds `foo`; `commit`; exit 0; `gh.log`
  `pr create`.
- `commit-packages-leak` (`commit-packages-leak-blocked`): `apt.txt` holds a home path; exit 1; lines
  `ERROR: the leak scan found the lines above; nothing was committed.`, `packages/linux/apt.txt`, `home-path`;
  no `gh.log`.
- `commit-scan-missing` (`commit-scan-missing`): as step 16's `preview-scan-missing`; exit 1; lines
  `ERROR: leak scan could not run; nothing was committed.`; no `gh.log`.
- `commit-value-untracked` (`commit-value-untracked`): `values` `{"<NAME>": "Fixture User"}`, a sanitize rule for it,
  `unsent/dotfiles/linux/new/added.txt` holds `author = Fixture User`; exit 1; lines
  `ERROR: a cached value for <NAME> is in dotfiles/linux/new/added.txt; nothing was committed.`
- `commit-value-case-variant` (`commit-value-case-variant`): the file holds `FIXTURE USER`; exit 1; the same line
  for `dotfiles/linux/plain.txt`.
- `commit-value-doubled` (`commit-value-doubled`): value `<WINPATH>` `C:\Tools\gh.exe`, file
  `tool = C:\\Tools\\gh.exe`; exit 1; the line for `<WINPATH>`.
- `commit-value-placeholder-only` (`commit-value-placeholder-only`): the file holds `author = <NAME>`; exit 0;
  `gh.log` `pr create`.
- `commit-value-not-printed` (`commit-value-not-printed`): as `commit-value-untracked` on a tracked file; exit 1;
  lines `! Fixture User`.

Test: the shared-case command with filter `commit-`.

## Step 18: Shared cases for diff `[worker]`

Files: new folders under `tests/parity/cases/`. Contract "Diff", "Sync point". `git: remote`.

- `diff-sanitized-agrees` (`diff-sanitized`): `syncPoint: true`, a sanitized entry whose local holds the hydrated
  value; `diff`; exit 0; lines `This machine and the repo agree.`
- `diff-dir-removed` (`diff-dir-removed`): `dir` entry, `syncPoint: true`, local `c.txt` deleted; `diff`; exit 3;
  `OUT dotfiles/common/dir/c.txt`; lines `1 file(s) differ: 0 in, 1 out, 0 both.`
- `diff-other-platform` (`diff-other-platform`), `os: ["linux", "macos"]`: a `windows` entry, `syncPoint: true`,
  `origin/dotfiles/windows/win.conf` changed; `diff`; exit 0; lines `This machine and the repo agree.` and
  `! dotfiles/windows/`.
- `diff-bad-record` (`diff-bad-record`): `state/last-sync` holds forty `0`s, local changed; `diff`; exit 3; `?`
  label for the file as in `diff-no-sync-point`; lines
  `1 file(s) differ. No sync is recorded on this machine, so the newer side is unknown.`
- `diff-export-fails` (`diff-export-fails`): `syncPoint: true`, a sanitized entry with no value and no default;
  `diff`; exit 1; lines `missing value for <NAME>` and the contract's diff failure line.
- `diff-front-in` (`sync-diff-fetches`): `syncPoint: true`, `origin/` changes `plain.txt`; `front-diff`; exit 3;
  `IN dotfiles/linux/plain.txt`.

Test: the shared-case command with filter `diff-`.

## Step 19: Shared cases for pull and push, and push behind origin `[worker]`

Files: new folders under `tests/parity/cases/`, `src/app/push.ts`, `src/app/push.test.ts`. Contract "Front door" (as
step 1 left it). `git: remote`.

- `pull-only-partial` (`front-pull-only`): no sync point, `origin/` changes `plain.txt` and `no-trailing.txt`;
  `pull` with `yes`, `force`, `paths: ["dotfiles/linux/plain.txt"]`; exit 0; home `plain.txt` has origin's text,
  `no-trailing.txt` unchanged; `expect/state/` has no `last-sync` (a partial pull records none; if `expect/state/`
  can't state an absence, lines `! Sync point`).
- `pull-no-sync-point-force` (`front-pull-first-force`): no sync point, origin changes `plain.txt`; `pull` with
  `yes`, `force`; exit 0; home `plain.txt` new, `plain.txt.bak` old; `expect/state/last-sync` holds origin's head.
- `push-behind-origin` (`sync-push-behind`), `os: ["linux", "macos"]`, `stubs: ["gh"]`: origin one commit ahead,
  local change; `push` with `yes`; exit 1; lines `ERROR: origin has updates; run mksync pull first.`; repo tree
  unchanged (nothing exported); no `gh.log`. It fails on the program until the fix below.

The fix: `push` fetches `origin master` after the clone check and before the export; commits in `HEAD..origin/master`
stop it with that line, exit 1; a failed fetch skips the check. Unit tests in `push.test.ts`: behind stops before
the export and calls no commit; a failed fetch goes on; up to date goes on.

Test: `bun test src/app/push.test.ts` and the shared-case command with filters `pull-only`,
`pull-no-sync-point-force`, `push-behind`.

## Step 20: dconf write failure and a real bus `[worker]`

Files: new case `tests/parity/cases/dconf-export-in-the-way/`, `src/adapters/dconf.test.ts`.

- `dconf-export-in-the-way` (`dconf-export-write-fails`), `os: ["linux"]`, `stubs: ["dconf", "getent"]`: a `dconf`
  entry `dotfiles/linux/dconf/app.ini`, `repo/dotfiles/linux/dconf` is a file; stub dump `[/]\na=1`; `export`; exit
  0; `ERROR dotfiles/linux/dconf/app.ini`, later `UNCHANGED dotfiles/linux/plain.txt`.
- Two adapter tests on a private bus (`dconf-import-bad-file`, `dconf-roundtrip-values`): start
  `dbus-daemon --session --fork --print-address=1 --print-pid=1` with `HOME` and `XDG_CONFIG_HOME` in a temp
  folder, assert the address isn't the caller's `DBUS_SESSION_BUS_ADDRESS` before any dconf call, kill it after; skip
  with a message when `dbus-daemon` or `dconf` is missing. Read `on_test_bus` in `tests/linux/engine.sh` for the
  setup. (1) loading `[/]\na=2\nbad=notvalid value\n` fails with the adapter's load-failure result and `/test/app/a`
  stays `1`; (2) a dump of `s='x=y'`, `m="it's\nline2"`, `l=['a', 'b']`, `e=@as []`, `u=uint32 3`, `t=(1, 'x')`
  loaded into an empty path dumps back byte for byte.

Test: `bun test src/adapters/dconf.test.ts` and the shared-case command with filter `dconf-export-in-the-way`.

## Step 21: Values unit tests `[worker]`

Files: `src/core/values/values.test.ts`, `src/core/compare.test.ts`, `src/core/plan/export.test.ts`.

- `askValues` with a rule without default, cached `{}`, answers `[""]` → not ok, `missing value for <NAME>: add it to
.user-values.json`, code 1, cached values unchanged (`prompt-empty-stops`, Pester "interactive empty answer").
- `sanitize` text `gh = C:\\Tools\\gh.exe\n`, `escapeBackslashes`, `<WINPATH>` = `C:\Tools\gh.exe` → `gh =
<WINPATH>\n` (`escape-export`).
- a text file with escaped backslashes: `sanitize(hydrate(repo))` equals the repo bytes and `hydrate(sanitize(local))`
  the local bytes (`escape-roundtrip-unchanged`).
- `inferValues` local `gh = C:\\Tools\\gh.exe`, repo `gh = <WINPATH>`, `escapeBackslashes` → `<WINPATH>` =
  `C:\Tools\gh.exe` (`infer-escaped`).
- `inferValues` local `name = <NAME>`, repo the same → `{}` (`infer-skips-unhydrated-local`).
- `inferValues` local `abcba`, repo `abc<NAME>cba` → `{}` (`infer-overlapping-context`).
- compare, sanitized: 1025 lines of 128 `x` against the same plus two blank lines → equal, under one second
  (`sanitized-large-file`).
- `planExport` with a rule without default, values `{}`, no answers → code 1, the missing-value message, no
  `writeRepo` action (Pester `noninteractive-missing-value-export`).

Test: `bun test src/core/values/values.test.ts src/core/compare.test.ts src/core/plan/export.test.ts`.

## Step 22: Entry selection unit tests `[worker]`

Files: `src/core/layers/select.test.ts` (or the file next to the selection code; the worker names it).

- v1 `platform: ["linux", "macos"]` on `dotfiles/common`: selected on Linux and macOS, not on Windows
  (`platform-array`, Pester `platform-list-linux-macos-skipped`).
- `["windows"]` under `dotfiles/windows`: not selected on Linux, selected on Windows (`platform-array-windows-only`).
- `["windows", "macos"]` on Windows: selected (Pester `platform-list-with-windows-used`).
- a `dconf` entry on Windows: not selected, no line, no error (Pester `dconf-entry-ignored`).

Test: `bun test src/core/layers/select.test.ts`.

## Step 23: Local path and pick unit tests `[worker]`

Files: `src/core/plan/pick.test.ts`.

- `localPaths.macos` `~/.config/other/m.txt` on macOS with home `/Users/u` → `/Users/u/.config/other/m.txt`; Linux
  still `localPath` (`localpaths-macos`).
- `localPaths.macos` with `Application Support` → spaces kept (`localpaths-spaces`).
- `localPaths.windows` on Windows with home `C:\Users\u` → `C:\Users\u\other\m.txt` (Pester `localpaths-windows-used`).
- `resolveOnly`: `dotfiles/linux/plain.txt` → itself (`only-repo-path`); `~/.config/fixture/plain.txt` →
  `dotfiles/linux/plain.txt` (`only-local-tilde`); `.config/fixture/plain.txt` with cwd = home → the same
  (`only-local-relative`, `front-only-relative`); `~/.config/fixture/dir/a/b.txt` → `dotfiles/common/dir/a/b.txt`
  (`only-dir-file`).
- `onlySelected`: only `[dotfiles/common/dir]` selects `dotfiles/common/dir/a/b.txt`, not `dotfiles/common/dirx/a`;
  only `[dotfiles/linux/plain.txt]` selects `dotfiles/linux/plain.txt.linked/x`, not `dotfiles/linux/plain.txt2`; no
  picks select everything (`only-selected`).

Test: `bun test src/core/plan/pick.test.ts`.

## Step 24: Config unit tests `[worker]`

Files: `src/core/config/v1.test.ts`, `src/core/config/convert.test.ts`, `src/core/plan/import.test.ts`.

- `parseV1` of the repo's own `sync-config.json` is ok (`path-real-config`, both suites).
- a `dconf` entry without `path` → exit 1, `ERROR: sync-config.json: entry dotfiles/linux/dconf/app.ini needs
"platform": "linux" and a dconf path like /org/gnome/shell/.` (Pester `dconf-path-missing`; copy the contract's
  line if it differs).
- convert: `platform: "windows"` with `dotfiles/linux/.bashrc` → `ERROR: dotfiles/linux/.bashrc: no v2 layer root
matches this path` (`lint-windows-linux-prefix`).
- the real config and `dotfiles/` with a fixture value per placeholder (`fixture-<name>`), home not the login home:
  `planImport` has no `ERROR` line and every `dconf` entry is `SKIPPED` with `HOME is not the login home; dconf left
alone`; `planExport` on the result has no `MODIFIED`, `ADDED`, `REMOVED` or `ORPHAN` (`real-config-roundtrip`).
- the same with the login home and empty dconf dumps: every `dconf` entry `CREATED` with one load whose text is the
  repo file (`real-config-dconf-restore`).

Test: `bun test src/core/config/v1.test.ts src/core/config/convert.test.ts src/core/plan/import.test.ts`.

## Step 25: Filesystem and git adapter tests `[worker]`

Files: `src/adapters/fs.test.ts`, `src/adapters/git.test.ts`.

- a `dir` entry whose local folder is a symlink to a folder: the snapshot lists its files as regular files, no
  symlink record for the root (`dir-root-symlink`).
- two imports with a change between, at different times: two backup folders, the first keeps the first text
  (`backup-second-run`); an import with nothing to change makes no backup folder (`backup-none`).
- `readSyncPoint`: missing file → undefined; `abc` → undefined; forty `0`s → undefined; `HEAD` plus newline → that
  SHA (`sync-point-read`).
- `git archive HEAD dotfiles` of a commit holding `lf line\ncrlf line\r\nlast\n` under `dotfiles/windows/` with the
  repo's `.gitattributes`, for `core.autocrlf` `input`, `true` and `false`: the bytes come back unchanged (Pester
  `windows-dotfiles-byte-exact`).

Test: `bun test src/adapters/fs.test.ts src/adapters/git.test.ts`.

## Step 26: Failure unit tests `[worker]`

Files: `src/core/plan/export.test.ts`, `src/core/plan/check.test.ts`, `src/app/import.ts`'s test file (new
`src/app/import.test.ts` if none).

- export: one file's write fails → an `ERROR` status line for it, and the other entries still get their lines
  (`error-continues`).
- check: one file can't be read → `ERROR` line, `1 error(s); see the ERROR lines above.`, exit 1, no `This machine
matches the repo.` (`import-check-error`).
- export: a `dir` folder holding only a symlink → `SKIPPED …/link.txt symlink`, the folder's `local folder is empty;
repo files kept`, no `REMOVED` (`dir-export-only-symlink`).
- import: the sync point write fails → `WARNING: could not record the sync point in <file>.`, exit 0
  (`sync-point-write-fails`).

Test: `bun test src/core/plan/export.test.ts src/core/plan/check.test.ts src/app/import.test.ts`.

## Step 27: An unreadable local file is an `ERROR` `[worker]`

Files: `src/core/plan/types.ts`, `src/adapters/fs.ts`, the plan code that reads a local file's bytes (`changes.ts`,
`export.ts`, `import.ts` under `src/core/plan/`), and their tests.

Found by step 26 (`import-check-error`): `readBytes` in `src/adapters/fs.ts` turns a local file it can't read into an
absent one, so `check` reports `CREATE …` and exit 3, export reports the file gone, and a `dir` export would remove its
repo copy. Bash prints `ERROR <label> cannot read local file` (`import.sh`, `export.sh`). The fix: the snapshot keeps
an unreadable local file as its own kind (no bytes); check, import and export give it `ERROR <label>` with the note
`cannot read local file`, write nothing for it, and go on with the other files; the run ends with the contract's
`<n> error(s); see the ERROR lines above.` and exit 1. A `dir` export never removes the repo copy of an unreadable
file. Unit tests: the snapshot of a mode 000 file (skipped as root) is the unreadable kind; check gives the `ERROR`
line, `1 error(s); see the ERROR lines above.`, exit 1 and no `This machine matches the repo.` (step 26's
`import-check-error`); export of a `dir` entry with one unreadable file gives its `ERROR` and no `REMOVED`; import
gives the `ERROR` and no write for it.

Test: `bun test src/adapters/fs.test.ts src/core/plan/`.

## Step 28: A failed sync point write warns `[worker]`

Files: `src/adapters/fs.ts`, `src/adapters/fs.test.ts`, the import app (`src/app/import.ts`) and its test (new
`src/app/import.test.ts` if none).

Found by step 26 (`sync-point-write-fails`): `runPlan` runs the `finish` actions and drops their results, so a
`writeState` that fails prints nothing and `Sync point : <sha>` still shows. The contract ("Sync point") says a failed
write prints `WARNING: could not record the sync point in <file>.` and never changes the exit code. The fix:
`runPlan` returns the failed `finish` actions in its outcome; the import prints the warning for a failed `writeState`
(the file path as the contract shows it) and leaves out the `Sync point :` line, exit unchanged. Unit tests: a
`writeState` whose folder is a file gives the warning and exit 0 (step 26's `sync-point-write-fails`); a good write
prints no warning.

Test: `bun test src/adapters/fs.test.ts src/app/import.test.ts`.

## Step 29: A symlink under `dotfiles/` stops the run `[worker]`

Files: `src/adapters/fs.ts`, `src/adapters/fs.test.ts`.

Tests first: a file entry whose `dotfiles/linux/plain.txt` is a symlink, and a `dconf` entry whose
`dotfiles/linux/dconf/app.ini` is one, stop the snapshot with exit 1 and `ERROR: sync-config.json: entry <repoPath>
has an unsafe path.` before any write (`path-repo-symlink`, `dconf-symlink-named`, Pester `path-repo-symlink`); a
symlink in a `dir` entry's repo folder does the same. Then the fix: `readTree` and the repo reads use `lstat` and
refuse a symlink anywhere under `dotfiles/`. Local symlinks keep their contract rules.

Test: `bun test src/adapters/fs.test.ts`.

## Step 30: A local file that became a symlink in a `dir` entry `[worker]`

Files: `src/core/plan/export.ts`, `src/core/plan/export.test.ts`.

Test first (`dir-symlink-removed`): repo `dir/c.txt`, local `c.txt` now a symlink → `SKIPPED
dotfiles/common/dir/c.txt symlink`, then `REMOVED dotfiles/common/dir/c.txt no longer in source` and a remove action,
as step 1 wrote into "Directory entries". Then the fix in the export plan. The folder-empty rule (`local folder is
empty; repo files kept`) still wins when every local file is a symlink.

Test: `bun test src/core/plan/export.test.ts`.

## Step 31: Shared files exported with LF on Windows `[worker]`

Files: `src/core/plan/export.ts`, `src/core/plan/export.test.ts`, `src/core/compare.test.ts`.

Tests first (Windows host in the snapshot, contract "Line endings"):

- common file, local `a\r\nb\r\n`, no repo file → `ADDED`, written `a\nb\n` (`crlf-common-export-new`).
- common file, repo `a\nb\n`, local `a\r\nc\r\n` → `MODIFIED`, written `a\nc\n` (`crlf-common-export-modified`).
- `dotfiles/windows` file, repo `x\n`, local `a\r\nb\r\n` → `MODIFIED`, written `a\r\nb\r\n`
  (`crlf-windows-export-keeps-crlf`).
- common file holding `61 00 0D 0A` → `ADDED`, bytes unchanged (`crlf-common-binary-export`).
- common `dir` entry, new local `new.txt` `y\r\n` → `ADDED`, written `y\n` (`crlf-common-dir-export-new`).
- compare: repo `a\nb\n` and local `a\r\nc\r\n` differ (`crlf-common-changed-line`).

Then the fix: on Windows, a shared file without sanitize rules and without a NUL byte is written with CRLF folded to
LF. A sanitized shared file follows the same rule after sanitizing.

Test: `bun test src/core/plan/export.test.ts src/core/compare.test.ts`.

## Step 32: The preview's diff from git `[worker:high: reasoning: a stat and full diff of an in-memory tree against HEAD without touching the working tree, refs or the real index]`

Files: `src/adapters/git.ts`, `src/adapters/git.test.ts`.

A function that takes the exported repo files (path → bytes, for `dotfiles/` and `sync-config.json`) and returns
git's `--stat` summary and full diff against `HEAD`: blobs written with `git hash-object -w --stdin`, a temp index
(`GIT_INDEX_FILE` in a temp folder, seeded with `git read-tree HEAD`), `git update-index --cacheinfo` per file and
`--force-remove` for files gone, then `git diff --cached --stat HEAD` and `git diff --cached HEAD` limited to
`dotfiles` and `sync-config.json`. The temp index is removed in a `finally`. Tests: a modified, an added and a removed
file give the three stat lines and diff headers; the working tree, `HEAD`, the real index and `git status
--porcelain` are unchanged after; no change gives empty text.

Test: `bun test src/adapters/git.test.ts`.

## Step 33: The preview prints the stat and diff `[worker]`

Files: the preview's app file (`src/app/export.ts`), its test, new case `tests/parity/cases/preview-shows-diff/`.

The case first (`preview-shows-diff`, contract "Export preview"): `git: committed`, local `plain.txt` gains the line
`preview change`; `preview`; exit 0; lines `dotfiles/linux/plain.txt | `, `+preview change`, then `Nothing was
written. Run mksync push to send it.` Also the two cases moved from step 16 (the program's preview ran no leak
scan): `preview-leak-found` (local `plain.txt` is `/home/someone/x`; exit 1; lines `WARNING: the leak scan found the
lines above. Fix them before committing.` and `! /home/someone`) and `preview-scan-missing`
(`repo/scripts/ci/leak-scan.sh` absent; exit 1; lines `ERROR: leak scan could not run; nothing was committed.`; if
the runner always copies it, a unit test in the app's test file instead). Then the code: after the status lines, run
the leak scan on the exported temp repo through `src/adapters/leakscan.ts` (as `src/app/commit.ts` does), then print
step 32's stat and diff (sanitized text, as the plan holds it), and none when the scan hit or couldn't run (exit 1).
Remove the `shortcut:` comment in `src/core/plan/preview.ts`.

Test: `bun test src/app/` and the shared-case command with filter `preview-`.

## Step 34: The macOS doctor and label `[worker]`

Files: `src/core/front/doctor.ts`, `src/core/front/doctor.test.ts`, `src/adapters/osname.test.ts` (new).

Tests first: on macOS with no `brew` on `PATH`, the doctor prints `MISSING  brew: install from https://brew.sh` (copy
the contract's line) and ends not ready, exit 1 (`front-macos-doctor-no-brew`); with `sw_vers` answering `26.7.2`, the
OS name is `macos (26.7.2)` (`front-macos-label`); on Linux an os-release with `PRETTY_NAME="Test OS 1"` gives `linux
(Test OS 1)`, the last `PRETTY_NAME` wins, a missing file gives the contract's fallback (`sync-status-os-name`).
Then the `brew` check.

Test: `bun test src/core/front/doctor.test.ts src/adapters/osname.test.ts`.

## Step 35: Local state readable by the user only on Windows `[worker]`

Files: `src/adapters/fs.ts`, `src/adapters/fs.test.ts`, `tests/parity/run.ps1`.

`writeValuesFile` on Windows (and `writePrivateFile` for profiles and records) removes inherited access and grants
full control to the current user only, by SID, with no domain lookup: `whoami /user` for the SID, then
`icacls <file> /inheritance:r /grant:r *<SID>:F`. A pure function builds the argument list; unit tests pin it on
Linux. `run.ps1` checks after every program case that leaves a `.user-values.json` or state file: `Get-Acl` shows
no inherited rule and one rule, the current user (Pester `values-private-new`, `values-private-tightened`,
`values-private-no-domain`). Remove the `shortcut:` comment.

Test: `bun test src/adapters/fs.test.ts`; the `run.ps1` check runs in the VM in the finish
(`tests/windows-vm/vm.sh status` 0), or on CI.

## Step 36: Config lint rules in v2 `[inline: deciding which v1 lint rules have a v2 meaning is design work]`

Files: `docs/design-layers.md`, `docs/port-inventory.tsv`.

For each of the fourteen `lint-*` rows (`lint-dir-with-rules`, `lint-file-in-dir`, `lint-typed-file-in-dir`,
`lint-dir-in-dir`, `lint-dir-trailing-slash`, `lint-sibling-prefix`, `lint-dconf-localpath`, `lint-dconf-rules`,
`lint-dconf-linked`, `lint-dconf-keys-empty`, `lint-dconf-keys-type`, `lint-keys-on-file`, `lint-path-on-dir`,
`lint-type-unknown`), read the rule in `scripts/ci/check-config.sh` and its case, and decide against "Config v2":
a v2 refusal with its `ERROR: sync-config.v2.json: entry <file> …` line, or dropped with the reason. Write the
refusals next to the other v2 lines in the design and the verdicts in the inventory.

Test: `npx prettier --check docs/design-layers.md`.

## Step 37: The v2 refusals `[worker]`

Files: `src/core/config/v2.ts`, `src/core/config/v2.test.ts`.

The refusals step 36 wrote, one test each with its exact line, plus a valid config with the sibling-prefix shape
(`dotfiles/common/dir` and `dotfiles/common/dir2`) still accepted.

Test: `bun test src/core/config/v2.test.ts`.

## Step 38: The pending inventory rows `[inline: reconciling the inventory with what the steps did]`

Files: `docs/port-inventory.tsv`.

Set every row's final verdict: `PORTED` with the new case or test name, `TWIN`, `DROP` with its reason, or `PHASE 9`
for the setup and bootstrap rows. No row stays `PORT`. A row a step left out (a program failure) is a stop, not a
verdict.

Test: `awk -F'\t' 'NR>1 && $3=="PORT"' docs/port-inventory.tsv` prints nothing.

## Step 39: Docs `[inline: docs summary of the port]`

Files: `docs/design-test-moves.md`, `tests/parity/README.md`, `docs/plan-single-engine.md`, `docs/sync-contract.md`.

`design-test-moves.md`: a "Status" section with the counts per verdict and a pointer to the inventory, and each row's
group marked done. The README's "Moved from": one row per new shared case with its old cases and what they check
beyond it (from the inventory), and "What fits" updated for `lines.txt`. The roadmap's phase 8: **Done** with the case
count. The contract: anything a step found unstated, as a note in its section.

Test: `npx prettier --check docs/design-test-moves.md tests/parity/README.md docs/plan-single-engine.md && git diff --check`.
