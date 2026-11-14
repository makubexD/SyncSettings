# One engine, phase 8: the front door

Roadmap: `docs/plan-single-engine.md`, phase 8. Design: `docs/design-layers.md` ("Push and pull", "Linked folders",
"Code layout", "Tests", and the Open items marked phase 8). Contract: `docs/sync-contract.md` ("Sync point", "Diff",
"Checks before pushing", "Up-to-date check", "dconf entries", "Package drift", "Front door", "The program"). Goal: the
program does everything the old engines and their front door do, so phase 9 can switch the installers to it: `export
--diff`, `commit`, dconf, package drift, the up-to-date check and `--reset-values` behind the old verbs, and `status`,
`doctor`, `pull`, `push` (with "Move a change?"), `diff`, `check` and `preview` as its own commands; the first run and
`status` offer linked folders as `dir` entries; and, once work machine #1 answers the survey, the Claude layout tool.

## Shared rules

- Branch `engine/front-door`, one commit per step, one PR at the end.
- **Old engines frozen.** No change to `export.sh`, `import.sh`, `commit.sh`, `sync`, `sync.cmd`, `scripts/linux/`,
  `scripts/windows/`, `sync-config.json`. The runners (`tests/parity/run.sh`, `run.ps1`) and their README may change;
  no existing case's `expect/` changes.
- **Contract first** (CLAUDE.md rule 2): step 1 writes this plan's decisions into the contract; each feature's shared
  cases come in a step before the code that makes them pass. A case whose rule both old engines follow runs against
  them too; a program-only rule uses `configV2` or a program-only command so the old engines skip it.
- **Public repo.** Fixtures use `example.com`, `/home/user`, `C:\Users\user`, profiles `work-1` and `personal`,
  machines `wk1-laptop` and `home-linux`. The survey answer is redacted (`work-tool-1`) and shown to the user before
  it's committed. `leak-scan` stays green.
- **Layout** from the design's "Code layout": `src/core/` stays pure (the boundary grep prints nothing). Command flows
  that wire core and adapters for one command go in `src/app/<command>.ts` (step 2 creates the folder); `main.ts` only
  dispatches. Git calls go in `src/adapters/git.ts`, `gh` calls in `src/adapters/gh.ts`, dconf in
  `src/adapters/dconf.ts`, package managers in `src/adapters/packages.ts`. Tests sit next to their file.
- **No new dependencies.**
- **Messages are the contract's.** Every line a step prints is copied from `docs/sync-contract.md` as step 1 leaves
  it. A worker spec names the section to copy from.
- **The usage line** grows with each command a step adds: `src/cli/parse.ts` `USAGE`, its pin in
  `src/cli/parse.test.ts`, and the contract's usage block change in the same step.
- Each worker step: about 3 files, one concern, tests in the same step. Test commands run that step's tests only; the
  full suite runs once, in the finish.

## Out of this phase

- **Porting the old cases without a shared twin** (`docs/design-test-moves.md`, about 370 shared cases and 150 unit
  and adapter tests) goes to its own plan, `docs/plan-single-engine-8-port.md`, written when this one finishes. Only
  the dconf and drift groups are ported here, because their steps build the rule they test. Proposal: the roadmap's
  phase 8 says so (step 1).
- `mksync setup` handing over from the front door, `--bootstrap`, `mksync update` and the `schemaVersion` check: phase 9
  with the installers, which call them.
- Skipping a group on pull: stays in the design's Open.
- PowerShell twins of the Linux hooks: listed from the survey (step 27), built only on a real need.
- ESLint: still `tsc` only. Adding it means a new dependency (`ts-add-package`), so it's a question for this plan's
  review, not a step.

## Decisions to confirm in review

Proposals; the review of this plan confirms or changes them before `/next`. Step 1 writes them into the contract and
the design.

1. **Old verbs and new commands side by side.** The program keeps `export` and `import` (the shared cases drive
   them) and gains the old engines' remaining verbs: `export --diff`, `import --reset-values`, `commit [-m <msg>]
[--partial]`. It also gains the front door's commands as its own: `status`, `doctor`, `pull [--yes] [--force]
[path…]`, `push [--yes] [-m <msg>] [path…]`, `diff [path…]`, `check [path…]` (= `import --check`), `preview`
   (= `export --preview`). Whether `export`, `import` and `commit` stay public after cut-over stays in Open.
2. **Diff without a temp folder.** `base` and `theirs` are read from git objects (`git ls-tree` and `cat-file
--batch`, as `readHeadTree` does); `mine` is `base` with the export plan's writes applied in memory, the export
   planned against `base` as the repo side. Same labels, lines, text and exit codes as the contract's "Diff"; nothing
   is written, so there's no temp folder to remove.
3. **Commit is the program's.** Branch `sync/<os>-<machine>-<stamp>` as `commit.sh` names it (machine from the
   record, else the hostname as today), never `master`; the PR body names the profile when there is a record. The
   checks before pushing run in this order: changes outside the sync paths, the public-repo guard (tracked paths and,
   new, every commit in `origin/master..HEAD`: a commit that adds or changes a path under `profiles/` or `machines/`
   while public is refused with the guard's `refused` line), the leak scan, then the cached values (with a record:
   the record's and profile's values, as `.user-values.json`'s are today).
4. **The leak scan stays bash.** The program runs `bash scripts/ci/leak-scan.sh` as `commit.sh` does. No `bash` on
   `PATH` (a Windows machine without Git Bash) is the contract's "could not run" case: the commit stops. Whether the
   work machines have Git Bash is a survey question; if they don't, phase 9 needs a different scan.
5. **dconf through a stub in the cases.** The runners gain `"stubs": ["dconf"]`: a `dconf` on `PATH` that answers
   `dump <path>` from the case's `dconf/<path-with-slashes-as-dashes>.ini` and appends `load <path>` plus the loaded
   text to `dconf.log`, compared with `expect/dconf.log`. The login-home guard reads `getent passwd` through a stub
   too (`"stubs": ["getent"]`), so the case's temp home counts as the login home. Linux only (`"os": ["linux"]`).
6. **Drift stays in export and preview.** The contract puts the drift report after the orphan report of an export
   and a preview; `docs/design-test-moves.md` says "moves into `mksync doctor`". The contract wins: the program
   reports drift where bash does, and `mksync doctor` gets one line, `WARN drift: <n> package(s) differ; run mksync
preview` when there is any. The drift cases become core unit tests over stubbed lists, as the move list says.
7. **Pull doesn't re-run itself.** The old front door re-ran itself after a fast-forward so new scripts ran. The
   program is the same binary before and after; it reads the config again after the fast-forward and goes on. A
   newer `schemaVersion` is phase 9's check.
8. **"Move a change?"** After the block and the new-setting questions, `push` asks `Move a change? Type its number,
or press Enter to go on:` until an empty answer. A number asks `Move it to? 1) all machines  2) <Os> machines
3) profile <p>  4) this machine [<current>]`. A `json` key moved narrower is written into the new layer and left
   unchanged in the old one (design case 1: an override); moved wider, it's written into the new layer and removed
   from the old one. A whole file moves as a whole. The block prints again after each move. `--yes` and a machine
   without a record don't ask. The profile-value rule and the guard run after the moves.
9. **Linked folders.** An entry with `detectLinkedPaths` (v1) or `linked: true` (v2) is read for folder paths the
   same way the PowerShell engine's `Find-LinkedPaths` reads them. Each existing folder no entry syncs is asked once,
   with the design's line and suggestion. A yes adds a `dir` entry to the profile file's new `entries` list (layer
   `profile`) or the record's (layer `machine`), `repoPath` `profiles/<p>/linked/<folder name>/` or
   `machines/<m>/linked/<folder name>/`; a no stores `"linked: <localPath>": "no"` in the profile's `destinations`.
   `mksync status` lists unasked folders as `Linked folder not synced: <path> (mksync setup asks)` and asks nothing.
10. **The survey still doesn't block.** Steps 1 to 26 don't need it. Step 27 stops `/next` if the answer isn't in.

## Step 1: The contract and design for phase 8 `[inline: contract and design text, written from the decisions above]`

Files: `docs/sync-contract.md`, `docs/design-layers.md`, `docs/plan-single-engine.md`.

Write decisions 1 to 10 into the contract: "The program" (the new verbs and commands, the usage line as it will be at
the end of the phase, and "Not in the program yet" emptied of what this phase adds), "Diff" (program note: no temp
folder), "Checks before pushing" (the history check), "dconf entries" and "Package drift" (the program follows the
same rules), "Front door" (a program column where its behavior differs: no re-run, the doctor's checks, the `drift`
line, pull-only push), a new "Move a change (program only)" section, and "Linked folders" (the program's question
and the `entries` field). The design: "Decided in phase 8" with the decisions as rules and one example each, and the
Open items this plan settles marked with their step. The roadmap's phase 8: the port goes to
`docs/plan-single-engine-8-port.md`.

Test: `npx prettier --check docs/sync-contract.md docs/design-layers.md docs/plan-single-engine.md`.

## Step 2: The export flow out of `main.ts` `[worker]`

Files: `src/main.ts`, `src/app/export.ts` (new), `src/adapters/git.ts`.

Behavior-preserving move (design Open, "Left by the phase 7 finish review"). Move `runExport`, `executeExport`,
`applyExportPlan`, `askSettings`, `storeItemDestinations`, `exportRefusal`, `printBlock`, `exportGuard`, the first
backup functions (`askBackupQuestions`, `askFirstBackup`, `withWrittenFiles`, `finishFirstBackup`) and the constants
only they use into `src/app/export.ts`, exporting `executeExport`. Move `runGitText`, `readOrigin` and
`readTrackedPaths` into `src/adapters/git.ts`, exported. `main.ts` imports them; no line it prints changes. No other
file changes.

Test: `bun run lint && bun test src && bun run build && tests/parity/run.sh --engine dist/mksync`.

## Step 3: Runner: a sync point and an origin ahead `[worker]`

Files: `tests/parity/run.sh`, `tests/parity/run.ps1`, `tests/parity/README.md`.

Two optional case fields, both requiring `"git": "remote"`: `"syncPoint": true` writes the repo's `HEAD` SHA (after
the initial commit and push) to the state folder's `last-sync`, before any `state/` copy; an `origin/` folder in the
case is a tree of repo files that the runner commits on top of `master` in a second clone (`git -c user.name=parity
-c user.email=parity@example.com commit -m origin`), pushes to the bare origin, then runs `git fetch origin` in the
repo, so `origin/master` is one commit ahead and the repo's `master` isn't. Either field without `"git": "remote"` is
a case error (`die`). Both runners alike; README documents both fields under the case table.

Test: `tests/parity/run.sh && tests/parity/run.sh --engine dist/mksync` (no case uses them yet: same counts as before).

## Step 4: Shared cases for the diff `[worker]`

Files: `tests/parity/cases/diff-*/` (new cases), `tests/parity/run.sh`, `tests/parity/run.ps1`.

Cases from the contract's "Diff" table, each `"git": "remote"`, `"syncPoint": true` except the first:
`diff-no-sync-point` exists already; add `diff-agree` (nothing differs, exit 0), `diff-in` (an `origin/` change,
exit 3, `IN`), `diff-out` (a `home/` change, `OUT`), `diff-both` (both changed, differently: `BOTH`), `diff-same-change`
(both changed the same way: no label, exit 0), `diff-only` (two `OUT` files, `"only"` picks one: one label). Expect
files are written from the contract, not from a run. In both runners, the program's command map gains
`diff) args=(./mksync export --diff)` and the phase 8 skip drops `diff` (keeps `commit`). The bash engine passes all
of them.

Test: `tests/parity/run.sh diff` (all pass on bash; the program fails them until step 6).

## Step 5: The diff in the core `[worker]`

Files: `src/core/plan/diff.ts` (new), `src/core/plan/diff.test.ts` (new).

`labelDiff(input)`: `input` has `owned` (the paths this OS's entries own, after `--only`), `base`, `theirs`, `mine`
(maps path → bytes, a missing path absent) and `hasSyncPoint`. Returns the labels sorted by code unit (`IN`, `OUT`,
`BOTH`, `?`) per the contract's table, and `diffText(labels, header)` returns the lines of the contract's example:
header (`Last sync  : …` or `none recorded on this machine`, `Repo       : origin/master <short>` or `HEAD <short>`),
the status lines through the existing status formatter, the separator, the summary and the hint lines, and the exit
code (0, 3). `ownedPaths(entries)` gives the owned set: a file or dconf entry its `repoPath`, a file entry also the
`<repoPath>.linked/` prefix, a dir entry the `<repoPath>/` prefix. Unit tests: every row of the table, the no-sync-point
summary, the agree line, the hint for each label mix, `--only` narrowing, a path in only one tree.

Test: `bun test src/core/plan/diff.test.ts && bun run lint`.

## Step 6: `export --diff` `[worker]`

Files: `src/app/diff.ts` (new), `src/adapters/git.ts`, `src/cli/parse.ts`.

Decision 2. `readTreeAt(repoRoot, ref)` in the git adapter (the `readHeadTree` reader for any ref, `dotfiles/` only)
and `readSyncPoint` (the 40-hex rule and `commitExists`). `src/app/diff.ts` builds `base` (the sync point's tree, or
`theirs` without one), `theirs` (`origin/master` when the ref exists, else `HEAD`), plans an export against `base` as
the repo side and applies its writes to a copy of `base` in memory for `mine`, then prints `labelDiff`/`diffText`.
The parser accepts `export --diff [--only …]`; `--diff` with `--preview` or `--yes` prints the contract's error, exit

1. Nothing is written. A plan error prints the export's lines and `ERROR: the export for the diff failed; see above.`,
   exit 1. Usage line and its pin (`src/cli/parse.test.ts`) updated.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync diff && bun test src/cli`.

## Step 7: Shared cases for commit `[worker]`

Files: `tests/parity/cases/commit-*/` (new cases), `tests/parity/run.sh`, `tests/parity/run.ps1`.

From `commit.sh` and the contract ("Checks before pushing", "Sync point"): `commit-outside-paths` (a change outside
`dotfiles/` and the config: refused, exit 1, no branch), `commit-leak-hit` (a home path in a synced file: the leak
scan's line, exit 1), `commit-cached-value` (a `.user-values.json` value in a changed file: `ERROR: a cached value for
<PLACEHOLDER> is in <file>; nothing was committed.`), `commit-partial` (`"partial": true`: PR opens, no sync point),
`commit-sync-point` (after the PR, `last-sync` holds the branch's parent: expect it equal to the case's starting
`HEAD`, which the runner writes into the expected file before comparing; document that substitution in the README).
Runner: a `partial` and a `message` option for `commit`, the program's map `commit) args=(./mksync commit)`, and the
phase 8 skip removed. Every case stubs `gh`.

Test: `tests/parity/run.sh commit` (bash passes them all).

## Step 8: Commit in the core `[worker]`

Files: `src/core/plan/commit.ts` (new), `src/core/plan/commit.test.ts` (new), `src/core/guard.ts`.

Pure parts of decision 3. `branchName(os, machine, stamp)`; `commitMessage(message, os, machine)` and `prBody(…)` as
`commit.sh` writes them, plus `Profile: <p>` when given; `outsidePaths(porcelain)` (the paths outside `dotfiles/`
and the config files, as `commit.sh` decides); `cachedValueHits(files, values)` (case-insensitive, the
backslash-doubled form, a placeholder alone passes; returns placeholder and file, never the value). In `guard.ts`,
`historyRefusals(visibility, commits)` where `commits` lists the paths each unpushed commit adds or changes: any under
`STATE_FOLDER_ROOTS` while public is refused. Unit tests for each function, including a value with a backslash and a
state path committed then removed from the index.

Test: `bun test src/core/plan/commit.test.ts src/core/guard.test.ts && bun run lint`.

## Step 9: `mksync commit` `[worker]`

Files: `src/app/commit.ts` (new), `src/adapters/gh.ts` (new), `src/adapters/git.ts`.

Wire step 8 in `commit.sh`'s order: porcelain, outside paths, the guard (tracked and `git log --name-only
origin/master..HEAD`), the leak scan (`bash scripts/ci/leak-scan.sh <paths>`; no `bash` or any exit other than 0 and
1 is "could not run"), cached values, then branch, add, commit, push, `gh pr create`, back to `master`, and the sync
point (the branch's parent) unless `--partial`. A failure before the PR leaves no branch. `gh` runs with the 5-second
limit `adapters/visibility.ts` uses for API calls, but `pr create` with 60 seconds. `src/cli/parse.ts` and `main.ts`
dispatch `commit [-m <msg>] [--partial]` (add both to the step's files if the dispatch needs them; still one concern).

Test: `bun run build && tests/parity/run.sh --engine dist/mksync commit && bun test src/adapters`.

## Step 10: The up-to-date check `[worker]`

Files: `src/core/plan/uptodate.ts` (new), `src/app/export.ts`, `tests/parity/cases/uptodate-*/` (new cases).

Contract "Up-to-date check" for `export` and `import` (not check, preview or diff). Core: `upToDateAction(facts)`
from `{isRepo, hasOrigin, branch, fetchOk, behind, terminal}` to none, a note, a warning, or ask. The ask path pulls
with `git pull --ff-only` and prints the contract's lines. Cases (`"git": "remote"` with an `origin/` change):
`uptodate-behind-warns` (no terminal: the warning line, the run goes on), `uptodate-current` (no line). The import
side calls the same function from `main.ts`. Unit tests for every row.

Test: `bun test src/core/plan/uptodate.test.ts && bun run build && tests/parity/run.sh --engine dist/mksync uptodate`.

## Step 11: `import --reset-values` `[worker:low]`

Files: `src/cli/parse.ts`, `src/main.ts`, `tests/parity/cases/reset-values-*/` (new cases).

Contract "Sanitize and hydrate": `--reset-values` asks again for every placeholder and skips inference; with a
record, the answers go through `placeValue` as new values do. `--reset-values` with `--check` (import) or `--preview`
(export) is the contract's error, exit 1. Cases: `reset-values-asks` (a cached value replaced by a piped answer),
`reset-values-check-refused`.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync reset-values && bun test src/cli`.

## Step 12: Runner stubs for dconf and getent `[worker]`

Files: `tests/parity/run.sh`, `tests/parity/run.ps1`, `tests/parity/README.md`.

Decision 5. `"stubs"` accepts `dconf` and `getent` besides `gh`. The `dconf` stub (bash script written into the
stub folder): `dump <path>` prints `dconf/<name>.ini` from the case (`<name>` is the path with `/` as `-`, trimmed),
or nothing; `load <path>` appends `load <path>` and stdin to `dconf.log` beside `gh.log`; anything else exits 1. The
`getent` stub answers `passwd <user>` with a line whose home field is the case's `HOME`. `expect/dconf.log` is
compared like `gh.log`. `run.ps1` rejects `dconf`/`getent` stubs (the cases are Linux only).

Test: `tests/parity/run.sh && tests/parity/run.sh --engine dist/mksync` (no case uses them yet).

## Step 13: dconf in the core `[worker]`

Files: `src/core/merge/dconf.ts` (new), `src/core/merge/dconf.test.ts` (new), `src/core/merge/strategy.ts`.

Contract "dconf entries": parse an `.ini` dump into sections and keys; `filterKeys(dump, keys)` (shell globs, `*`
matches `/`, a section left empty dropped, no `keys` keeps all); export compares bytes with the repo file, an empty
filtered dump is `SKIPPED`; import counts as a change only a key whose value the repo file would set differently
(keys only the machine has don't count). `strategyFor("dconf")` returns it. Unit tests: every rule above plus the
`keys` cases of `docs/design-test-moves.md`'s dconf row that are pure (glob, section drop, order).

Test: `bun test src/core/merge/dconf.test.ts && bun run lint`.

## Step 14: dconf on Linux `[worker]`

Files: `src/adapters/dconf.ts` (new), `src/core/plan/export.ts`, `src/core/plan/import.ts`.

`dump(path)` and `load(path, text)` through `dconf` on `PATH`, `loginHome()` through `getent passwd $USER`. Import
refuses to load when `HOME` isn't the login home, with the contract's line; a failed load is `ERROR` with `dconf
load failed`; the check runs dump only. Export and import plan dconf entries through `strategyFor` and the snapshot
carries each entry's dump (read in `adapters/snapshot.ts` if the plan needs it there; still one concern). Windows and
macOS: the entry stays `SKIPPED` as today. Adapter tests run a fake `dconf` from a temp `PATH`.

Test: `bun test src/adapters/dconf.test.ts src/core/plan && bun run lint`.

## Step 15: dconf shared cases, part 1 `[worker]`

Files: `tests/parity/cases/dconf-*/` (new cases).

Port the first half (alphabetical) of the "dconf rule through the CLI" row of `docs/design-test-moves.md` (45 bash
cases) as shared cases, `"os": ["linux"]`, `"stubs": ["dconf", "getent"]`, expect from the contract's "dconf
entries". Each runs against bash and the program. A case the stub can't express (a real session bus) stays in
`tests/linux/engine.sh` and is listed in the step's summary.

Test: `bun run build && tests/parity/run.sh dconf && tests/parity/run.sh --engine dist/mksync dconf`.

## Step 16: dconf shared cases, part 2 `[worker]`

Files: `tests/parity/cases/dconf-*/` (new cases).

The second half of the same row, same rules as step 15.

Test: `bun run build && tests/parity/run.sh dconf && tests/parity/run.sh --engine dist/mksync dconf`.

## Step 17: Package drift in the core `[worker]`

Files: `src/core/drift.ts` (new), `src/core/drift.test.ts` (new).

Contract "Package drift": `driftLines(lists, installed, ignore)` where `lists` are the parsed `packages/linux/`
files, `installed` per manager is `{present, chosen}` or `{skipped: "<tool> not installed" | "<tool> failed"}`, and
`ignore` is `drift-ignore.txt`. Returns the `DRIFT` and `SKIPPED` lines in the contract's order and wording (two
sources for apt, `:arch` dropped, `@scope/name`, apt-source and apt-key by content, no "chosen" check for keys). Unit
tests: the 49 cases of the drift row in `docs/design-test-moves.md`, one test each, named after the bash case.

Test: `bun test src/core/drift.test.ts && bun run lint`.

## Step 18: Package drift on Linux `[worker]`

Files: `src/adapters/packages.ts` (new), `src/adapters/packages.test.ts` (new), `src/app/export.ts`.

Read each manager as the contract's table says (`dpkg-query`, `apt-mark showmanual`, `snap list`, the newest nvm
`lib/node_modules` by version order, `pipx list --short`, `code --list-extensions`, the font and extension folders,
`DRIFT_ROOT` for apt sources and keys), each behind an injectable `run`, so tests never reach a real manager. Export
and preview print `driftLines` right after the orphan report on Linux with a `packages/linux/` folder; nothing else
changes (no count, no exit code). Adapter tests with a fake `run` for each manager, a failing tool and a missing one.

Test: `bun test src/adapters/packages.test.ts && bun run lint`.

## Step 19: Runner: front-door commands `[worker]`

Files: `tests/parity/run.sh`, `tests/parity/run.ps1`, `tests/parity/README.md`.

Commands `status`, `doctor`, `pull`, `push`, `front-diff`: bash runs `./sync <cmd>` (`front-diff` as `./sync diff`),
PowerShell `.\sync.cmd <cmd>`, the program `./mksync <cmd>` (`front-diff` as `./mksync diff`). Options `yes`, `force`,
`message` (`-m`) and `paths` (positional). The runner copies `sync`, `sync.cmd`, `scripts/linux/front.sh` and
`scripts/windows/Front.ps1` for the old engines as it copies the entry points. `status` output is compared on its
`Next` line only: the runner keeps lines starting `Next` in the compared status lines (README says so).

Test: `tests/parity/run.sh && tests/parity/run.sh --engine dist/mksync` (no case uses them yet).

## Step 20: `mksync status` `[worker]`

Files: `src/core/front/status.ts` (new), `src/app/status.ts` (new), `tests/parity/cases/status-*/` (new cases).

Contract "Front door", the status table and its precedence. Core: `statusLines(facts)` from OS, repo, origin,
unsent (porcelain of the sync paths), machine (the check's count and, with a sync point, the diff's summary), pull-only
(never suggests push), and the linked-folder lines of decision 9 (empty until step 25). App: gathers the facts
(`git fetch origin master` with a 15-second limit, the check plan, `labelDiff`). Cases, one per row of the table:
`status-no-origin`, `status-origin-ahead`, `status-unsent`, `status-differs`, `status-nothing`. Usage line updated.

Test: `bun test src/core/front && bun run build && tests/parity/run.sh --engine dist/mksync status`.

## Step 21: `mksync doctor` `[worker]`

Files: `src/core/front/doctor.ts` (new), `src/app/doctor.ts` (new), `src/core/front/doctor.test.ts` (new).

Contract "Front door", program column (step 1): one `OK`, `WARN` or `MISSING` line per check: `git`, `gh` and its
sign-in (`gh auth status`, 5 seconds), the origin remote, the machine record, unset values, `bash` (needed by the
leak scan, decision 4: `WARN` when missing), and decision 6's `drift` line on Linux. A `MISSING` line names the
install command (`winget install --id …` when `winget` is on `PATH`, `sudo apt-get install …` on Ubuntu). Exit 1 with
any `MISSING`. Facts gathered in the app, lines built in the core; unit tests per check and OS. Usage line updated.

Test: `bun test src/core/front/doctor.test.ts && bun run lint`.

## Step 22: `mksync pull` `[worker]`

Files: `src/app/pull.ts` (new), `tests/parity/cases/pull-*/` (new cases), `src/cli/parse.ts`.

Contract "Front door", `pull`, with decision 7: refuse with unsent changes; fetch and fast-forward `master`; read the
config again; the import check with its grouped block; nothing to change: run the import (records the sync point);
changes with no sync point: `--yes` refuses, a terminal asks `[y/N]`; else unless `--force` the diff stops on `OUT`
or `BOTH` with the contract's lines; then `Apply these changes? [Y/n]` and the import with `--force`. Paths become
`--only`. Pull-only machines pull as any other. Cases: `pull-clean` (origin ahead, applies, sync point written),
`pull-guard-out` (an `OUT` file stops it), `pull-force`, `pull-unsent-refused`, `pull-no-sync-point-yes`.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync pull && bun test src/cli`.

## Step 23: `mksync push` `[worker]`

Files: `src/app/push.ts` (new), `tests/parity/cases/push-front-*/` (new cases), `src/cli/parse.ts`.

Contract "Front door", `push`, without moving (step 24): pull-only refuses with `this machine is pull-only (see
mksync machine show)`, exit 1; the export (grouped block, new-setting questions, profile-value rule, guard) with
paths as `--only`; nothing changed: `Nothing to send`; else `git status --short`, `Open a PR with these changes?
[Y/n]` (`--yes` answers), then the commit of step 9 (`--partial` with paths, `-m` passed on). Cases:
`push-front-nothing`, `push-front-opens-pr` (`gh` stub), `push-front-pull-only`, `push-front-partial`.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync push-front && bun test src/cli`.

## Step 24: Move a change `[worker:high: reasoning: moving a json key between layers must keep every other layer's merge result the same, which the spec can't list case by case]`

Files: `src/core/plan/move.ts` (new), `src/core/plan/move.test.ts` (new), `src/app/push.ts`.

Decision 8. `moveChange(plan, line, toLayer)` returns a new export plan: a `json` key moved narrower is written into
the target layer and the source layer is left as it was; moved wider, written into the target and removed from the
source; a whole file or side file moves whole; the change's line number stays. Invariant the tests check for every
case: merging the layers after the move gives the same local file as before, for this machine. `push` asks `Move a
change?` and `Move it to?` as decision 8 says, prints the block again after each move, and runs the profile-value
rule and the guard after the last one. Unit tests: base key to profile (override), profile key to base (moved),
array item, whole file, a number out of range (`Pick 1 to <n>.`), Enter at once (no move), `--yes`, no record.

Test: `bun test src/core/plan/move.test.ts && bun run lint`.

## Step 25: Linked folders in the core `[worker]`

Files: `src/core/machine/linked.ts` (new), `src/core/machine/linked.test.ts` (new), `src/core/config/v2.ts`.

Decision 9. `linkedFolders(text, home)`: the folder paths an entry's file references, read as
`scripts/windows/` `Find-LinkedPaths` reads them (the worker reads that function and mirrors its patterns, `~`,
`$HOME` and `%USERPROFILE%` forms). `unaskedFolders(found, entries, destinations)`: existing folders no entry syncs
and no `linked: …` destination answered. `suggestLinked(count, bytes, underHome)`: `profile` under 1000 files and 10
MB in the home, else `no`. `v2.ts` accepts `linked: true` on a file entry, and a profile or record `entries` list of
`dir` entries. Unit tests for each function and the v2 field.

Test: `bun test src/core/machine/linked.test.ts src/core/config && bun run lint`.

## Step 26: Linked folders in setup and status `[worker]`

Files: `src/wizard/setup.ts`, `src/app/status.ts`, `src/adapters/store.ts`.

Setup asks each unasked folder after its four questions with the design's line (`<file> uses <path> (<n> files,
<size>). Sync it as a folder? 1) this profile  2) this machine  3) no [<s>]`), adds the `dir` entry to the profile's
or record's `entries`, or stores the no in `destinations`; `--yes` takes the suggestion. The selection
(`core/layers/select.ts` callers) includes profile and record `entries`. Status prints decision 9's line per unasked
folder. Shared cases `setup-linked-yes`, `setup-linked-no`, `status-linked` (add their folders to the step's files).

Test: `bun run build && tests/parity/run.sh --engine dist/mksync linked && bun test src/wizard`.

## Step 27: The Windows answers in the design `[inline: needs the user's survey report from work machine #1]`

Files: `docs/design-layers.md`, `docs/windows-survey.md`, `docs/plan-single-engine-8.md`.

Needs the answer to `docs/windows-survey.md`'s prompt. If it isn't in the conversation or under that file's "Answer",
push-notify and stop here. Redact it (`work-tool-1`), show the redacted text to the user, save it under "Answer",
then settle "Confirm on Windows": shell, Git Bash and `jq` (and so decision 4's leak scan), `$HOME` in commands, the
current layout, the unsigned program, which hooks the work machines need. Write the Windows overlay's keys into
step 28's spec (a plan edit) and the `~` versus `<HOME>` Open item.

Test: `npx prettier --check docs/design-layers.md docs/windows-survey.md docs/plan-single-engine-8.md`.

## Step 28: The Claude layout tool `[worker]`

Files: `tools/claude-layout.ts` (new), `tools/claude-layout.test.ts` (new).

Design "Decided in phase 7", the Claude layout: `bun tools/claude-layout.ts <repo folder>` writes the base and Linux
`settings.json` layers, the Windows overlay with the keys step 27 lists, and the v2 entries widened to Windows, and
drops the v1 entries' Claude rows only when given `--cutover`. The test runs it on a temp copy of the repo and merges
the Linux layers with `mergeJson`: the result equals `dotfiles/linux/claude/settings.json` except `statusLine`, which
is `{"type": "command", "command": "mksync statusline"}`. Not run on the real repo in this phase.

Test: `bun test tools/claude-layout.test.ts && bun run lint`.

## Step 29: Docs `[inline: docs step]`

Files: `docs/sync-contract.md`, `docs/design-layers.md`, `docs/daily-workflow.md`, `README.md`.

The contract as built: every line steps 2 to 28 print that step 1 didn't fix, the program's usage line, and "Not in
the program yet" removed. The design: "As built in phase 8" under "Code layout" (`src/app/`, the new core and adapter
files), "Tests" (the new runner fields and stubs, the case counts), Open updated (settled items marked, new leftovers
added). `docs/daily-workflow.md` and `README.md`: a note that `dist/mksync` now runs every front-door command, still
not installed by the installers until phase 9.

Test: `npx prettier --check docs README.md && bun run lint`.
