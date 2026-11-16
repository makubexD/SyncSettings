# One engine, phase 8: review fixes

Roadmap: `docs/plan-single-engine.md`, phase 8. Follows `docs/plan-single-engine-8.md`: its finish review (2026-11-16,
four `ts-code-reviewer` passes over `master...engine/front-door`) found 14 Required findings and a set of Optional
ones. This plan fixes the Required ones and the cheap Optional ones that touch safety or the contract. The rest goes to
the design's "Open" list (step 1) with the phase that takes it.

## Shared rules

The rules of `docs/plan-single-engine-8.md` hold: branch `engine/front-door`, one commit per step, old engines
frozen, contract first, public-repo fixtures, `src/core/` pure, no new dependencies, messages copied from the contract.
Each worker step: about 3 files, one concern, tests in the same step. The full suite runs once, in the finish.

## Out of this plan (step 1 writes each into the design's "Open" list)

- **The first push from a private repo** (`profiles/`, `machines/`, `sync-config.v2.json` are outside commit's sync
  paths, so that push stops with `commit or stash changes outside dotfiles/ first.`): phase 10, when the repo goes
  private.
- **One flow in `app/export.ts`** (its three branches repeat plan, moves, refusal, block, first backup) and the
  helpers held in several files (`refusedText`, the `[Y/n]` rule, the no-prompt git env, `VALUES_FILE`,
  `LINKED_DESTINATION_PREFIX`, `sameBytes`, `hasKeyPath`, `byCodeUnit` versus `compareC`, `RunCommand` literals),
  and splitting `core/plan/move.ts` into path, slot and plan files: a cleanup plan after phase 9.
- **Typed answers trimmed the way bash `read -r` trims them** (`core/values/hydrate.ts`): decide in phase 9 with the
  Windows answer rule, since PowerShell `Read-Host` trims differently.
- **Atomic writes for profiles and records** (`adapters/store.ts` `writePrivateFile`): write a 0600 temp file and
  rename it. Phase 9, with the installers.
- **Windows-only adapter notes** under "Confirm on Windows": the leak scan's bare `bash` (WSL may come first on
  `PATH`) and the OS caption's code page.

## Step 1: The review's rules in the contract and design `[inline: contract and design text, written from the review]`

Files: `docs/sync-contract.md`, `docs/design-layers.md`.

Contract:

- "Package drift": when `dpkg-query` works and `apt-mark` is missing or fails, the `apt` block prints the
  `in packages/linux/<file>, not installed` lines first, then `SKIPPED packages/linux/apt.txt (apt-mark …)`, as bash
  does.
- "Front door", program notes: `mksync pull` prints `  Pulled <n> commit(s).` after a fast-forward of `n > 0` commits
  and runs no `git pull` when origin has nothing new. `mksync push` checks the clone (`ERROR: push needs the repo clone
on master with an origin remote.`) before the export, and a push whose up-to-date check pulled stops there, exit 0,
  after `Pulled <n> commit(s); run the command again.`
- "Checks before pushing" (commit): a git step that fails prints git's own error lines and exits 1; a commit that
  succeeded is never undone, even when reading its parent fails.
- "Linked folders": a found folder whose name is `.` or `..`, or the home folder itself, is never offered; a `dir`
  entry's `file` with a `.` or `..` part is `outside linked/`.

Design: the v2 config error `ERROR: sync-config.v2.json: entry <file> needs a dconfPath like /org/gnome/shell/.` next
to the other v2 messages ("has linked other than true"), for a `dconf` entry whose `dconfPath` is missing or isn't
`/` plus one or more `[A-Za-z0-9._-]+/` parts (the v1 rule); and each item of "Out of this plan" above in "Open".

Test: `npx prettier --check docs/design-layers.md` (`docs/sync-contract.md` keeps its compact tables and isn't
Prettier-formatted, as on `master`; check it with `git diff --check`).

## Step 2: Shared cases for the review's rules `[worker]`

Files: new folders under `tests/parity/cases/`, `case.json` and `expect/` written from the contract as step 1 leaves
it, each modeled on the named neighbor.

- `push-not-master` (like `push-front-nothing`, `os: ["linux"]`): the clone on a branch `feature`; `mksync push`
  prints `ERROR: push needs the repo clone on master with an origin remote.`, exit 1, and `dotfiles/` is unchanged.
- `pull-count` (like `pull-clean`): origin one commit ahead; `mksync pull --yes` prints `  Pulled 1 commit(s).` among
  its lines, exit 0.
- `dconf-v2-path-root` (like `dconf-path-root`, `configV2`): a `dconf` entry with `"dconfPath": "/"`; any command
  prints the step 1 design message, exit 1.
- `drift-apt-mark-fails` (like the drift cases with an `apt-mark` stub): `dpkg-query` lists none of `apt.txt`'s two
  packages and `apt-mark` exits 1; the report prints both `DRIFT apt/<x>` lines, then the `SKIPPED` line.

Test: `tests/parity/run.sh --engine dist/mksync 'push-not-master|pull-count|dconf-v2-path-root|drift-apt-mark-fails'`
after `bun run build`: all four fail before steps 3, 5, 6 and 9, for the reason each names (not a case error).

## Step 3: Push checks the clone and stops after a pull `[worker]`

Files: `src/app/push.ts`, `src/app/push.test.ts`, `src/main.ts`.

- `PushDeps` gains `cloneReady` (as `PullDeps` has it). `executePush` calls it first and refuses with the push form of
  `CLONE_ERROR`, before the record check and the export.
- `executePush` stops when the up-to-date check pulled: the export result carries `stopped: true` (set where
  `ensureUpToDate` returns `stop`), and push returns its code and output at once, with no PR question.
- When `git status` fails, the result keeps `exported.stderr` ahead of `STATUS_FAILED`.

Unit tests: off master refused before export (export dep never called); a stopped export returns exit 0 with no PR
question; status failure keeps the export's stderr.

Test: `bun test src/app/push.test.ts && bun run build && tests/parity/run.sh --engine dist/mksync 'push-'`.

## Step 4: Commit shows git's errors and keeps a made commit `[worker]`

Files: `src/app/commit.ts`, `src/app/commit.test.ts` (new).

- Each path in `executeCommit` that now returns `done(1, "")` (symbolic-ref, fetch, rev-list, `switch -c`, parent SHA,
  switch back) returns git's stderr, trimmed, as the error text, exit 1.
- A failed `readParentSha` keeps the branch and its commit (no `cleanupBranch`), exit 1 with git's error.

Unit tests with a stub git: a failing fetch prints its stderr; a failing parent read keeps the branch (no
`branch -D` call).

Test: `bun test src/app/commit.test.ts && bun run build && tests/parity/run.sh --engine dist/mksync 'commit-'`.

## Step 5: Pull counts what it pulls `[worker]`

Files: `src/main.ts`, `src/app/pull.ts`, `src/app/pull.test.ts`.

After the fetch, read `HEAD..origin/master` with `readAheadBehind`. Behind 0: no merge. Behind `n`: `git merge
--ff-only origin/master`, then print `  Pulled <n> commit(s).`; a failed merge keeps `ERROR: pull failed; resolve it
and rerun.` Unit tests: behind 0 runs no merge; behind 2 prints the line.

Test: `bun test src/app/pull.test.ts && bun run build && tests/parity/run.sh --engine dist/mksync 'pull-'`.

## Step 6: v2 checks dconfPath `[worker]`

Files: `src/core/config/v1.ts`, `src/core/config/v2.ts`, `src/adapters/dconf.ts` (plus their tests).

Export `isValidDconfPath` from `v1.ts` (or move it to `core/config/dconf-path.ts`); `parseV2` rejects a `dconf`
entry whose `dconfPath` fails it, with the step 1 design message, exit 1. `dconfDump` and `dconfLoad` refuse a path
that fails it (returning their `failed` result) before spawning. Tests: `/`, `--version`, missing, and
`/org/gnome/shell/` accepted.

Test: `bun test src/core/config src/adapters/dconf.test.ts && bun run build && tests/parity/run.sh --engine
dist/mksync 'dconf-'`.

## Step 7: The guard reads unpushed history with -z `[worker]`

Files: `src/adapters/git.ts`, `src/adapters/git.test.ts`.

`readUnpushedHistory` runs `git log -z --name-only --format=%x00 --diff-filter=ACMRT` and splits records on NUL.
Test in a temp repo: an unpushed commit adding `profiles/josé.json` is listed as that path, unquoted.

Test: `bun test src/adapters/git.test.ts`.

## Step 8: Linked folders refuse dot names `[worker]`

Files: `src/adapters/store.ts`, `src/core/config/profile.ts`, their tests.

`linkedFolders` normalizes each found path (`posix.normalize` after `homeForm`) and drops `~` and any path with a `.`
or `..` part. `linkedEntry` in `profile.ts` rejects a `file` with an empty, `.` or `..` segment or a `\` with
`entry <file> is outside linked/`, and builds the entry from its checked fields only. Tests: `~/proj/..` and `~/.`
dropped; `linked/../parity/settings.json` refused.

Test: `bun test src/adapters/store.test.ts src/core/config/profile.test.ts`.

## Step 9: apt drift keeps the missing lines when apt-mark fails `[worker]`

Files: `src/core/drift.ts`, `src/adapters/packages.ts`, their tests.

apt's result carries `present` and `chosen` separately, `chosen` being the names or a skip. `aptBlock` prints the
missing lines from `present`, then the extras or the `SKIPPED` line. Unit tests for both orders.

Test: `bun test src/core/drift.test.ts src/adapters/packages.test.ts && bun run build && tests/parity/run.sh --engine
dist/mksync 'drift-'`.

## Step 10: Move a nested key whose name has a dot `[worker]`

Files: `src/core/plan/move.ts`, `src/core/plan/changes.ts`, `src/core/plan/move.test.ts`.

`MoveSource` gains `keyPath: readonly string[]`, filled from `DraftLine.keyPath`; `moveJsonChange` and
`sourceAsInRepo` use it instead of `segmentsFor`. Test: `{"[python]": {"editor.formatOnSave": true}}` moves from base
to machine.

Test: `bun test src/core/plan/move.test.ts`.

## Step 11: A move keeps the merged result `[worker:high: reasoning: which layers to merge before and after a move, in both directions, and what an unchanged merge allows]`

Files: `src/core/plan/move.ts`, `src/core/plan/move.test.ts`.

Contract "Move a change": the merged result of every file is the same after a move as before it. `moveJsonChange`
merges all slots (`mergeJsonValues`) before and after the move; when they differ, it refuses the way `moveWholeFile`
does. After a move it removes parent objects the removal left empty. Tests: base `{"a":{"b":1},"c":5}`, os `{"a":7}`,
machine `{"a":{"b":2}}`, moving `a.b` machine → base is refused; base `k:1`, os `k:2`, base → machine is refused; a
move leaving `"a": {}` prunes it.

Test: `bun test src/core/plan/move.test.ts`.

## Step 12: A move's new line goes before the orphan report `[worker]`

Files: `src/core/plan/move.ts`, `src/core/plan/move.test.ts`.

`applyMove` inserts a new layer file's `ADDED`/`MODIFIED` line after the last line of its entry's steps, before any
`ORPHAN` line. Tests pin `.lines` for each branch: MODIFIED in place, REMOVED rewrite, a line dropped, a new line with
an orphan present.

Test: `bun test src/core/plan/move.test.ts`.

## Step 13: The Claude layout tool refuses a second run `[worker]`

Files: `tools/claude-layout.ts`, `tools/claude-layout.test.ts`, `tools/fixtures/claude-layout/` (new).

- Refuse with `ERROR: the Claude layout is already split.`, exit 1, when `dotfiles/common/claude/settings.json`
  exists.
- Without `--cutover`, print the planned writes and change nothing; `--cutover` writes the layers, widens v2 and drops
  the v1 rows. A write error prints `ERROR: <message>` and exits 1.
- Tests use frozen fixtures, not the live repo: a second `--cutover` run refused; `checkV1V2` passes on the
  `--cutover` output; `dropClaudeConfigRows` keeps every other byte of the config.

Test: `bun test tools/claude-layout.test.ts && bun run lint`.

## Step 14: The Windows runner matches the bash runner `[worker]`

Files: `tests/parity/run.ps1`, `tests/parity/README.md`.

- The `dconf`/`getent` stub check runs after the OS skip, so Linux-only cases are skipped on Windows.
- `resetValues` is validated as a boolean on `import`/`check` and passed as `-ResetValues` (PowerShell engine) or
  `--reset-values` (program); the README's options paragraph lists it.
- `Get-StatusLines` keeps `Linked folder not synced:` lines.
- Copied home files get `LastWriteTime` set to now, as `run.sh` touches them.

PowerShell 5.1 only (no `??`, no ternary).

Test: `pwsh -NoProfile -File tests/parity/run.ps1 'dconf-|reset-values-'` prints no FAIL caused by the runner (the
dconf cases are skipped).

## Step 15: The runners keep cases off the real machine `[worker]`

Files: `tests/parity/run.sh`, `tests/parity/run.ps1`, `tests/parity/cases/push-front-move/case.json`.

- `run.sh` refuses a case that stubs `getent` without `dconf`.
- Engine runs unset `DBUS_SESSION_BUS_ADDRESS`, `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GH_TOKEN` and
  `GITHUB_TOKEN`, and set `GIT_CEILING_DIRECTORIES` to the case's temp folder (both runners).
- `push-front-move` adds `"stubs": ["gh"]` (its `expect/` doesn't change).

Test: `tests/parity/run.sh --engine dist/mksync 'push-|pull-|dconf-'` and `tests/parity/run.sh 'dconf-'`.

## Step 16: dconf uses the plan's environment and the real uid `[worker]`

Files: `src/adapters/snapshot.ts`, `src/adapters/fs.ts`, their tests.

The login-home lookup runs `getent passwd <uid>` with `process.getuid()`. `RunContext` carries the `env` the snapshot
used, and the dconf load passes `context.env` instead of `process.env`.

Test: `bun test src/adapters && bun run build && tests/parity/run.sh --engine dist/mksync 'dconf-'`.

## Step 17: Setup, retire and shadow move out of main.ts `[worker]`

Files: `src/main.ts`, `src/app/setup.ts` (new), `src/app/retire.ts` (new), `src/app/shadow.ts` (new).

Plan rule "`main.ts` only dispatches". Move `executeSetup`, the retire code and `executeShadow` into their files
unchanged, with their imports; `main.ts` calls them. No behavior change.

Test: `bun run lint && bun test src && bun run build && tests/parity/run.sh --engine dist/mksync 'setup|retire|shadow'`.

## Step 18: The export and import run moves out of main.ts `[worker]`

Files: `src/main.ts`, `src/app/export.ts`, `src/app/import.ts` (new).

Move the export/import run (up-to-date check, record check, `exportGuard` and its refusal, `readBackupSides`, the
preview's first backup, `heldText`) into `app/export.ts` and `app/import.ts`. `execute` becomes a switch over
`command.kind`. No behavior change.

Test: `bun run lint && bun test src && bun run build && tests/parity/run.sh --engine dist/mksync`.

## Step 19: Docs `[inline: docs step]`

Files: `docs/sync-contract.md`, `docs/design-layers.md`, `docs/plan-single-engine.md`, `tests/parity/README.md`.

The contract and design as built: each rule of step 1 checked against the code, the "Code layout" section naming
`app/setup.ts`, `app/retire.ts`, `app/shadow.ts` and `app/import.ts`, the runners' safety rules in the README, and the
roadmap's phase 8 entry listing this plan.

Test: `npx prettier --check docs/design-layers.md docs/plan-single-engine.md && git diff --check` (the README, like
the contract, isn't Prettier-formatted on `master`).
