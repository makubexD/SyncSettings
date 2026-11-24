# Setup hotfix: keep mine keeps only this machine's changes (`v1.1.1`)

Found 2026-11-23 on the user's real `mksync setup --replace` run on the personal Linux machine, after `v1.1.0`. Runs
before phase 10 part D: the work machines update straight to `v1.1.1`, then the private switch. Contract:
`docs/sync-contract.md` ("`mksync setup`", "Front door", "`json` entries"). Branch `engine/setup-hotfix`, one PR, then
release `v1.1.1`.

## The bugs

1. **Keep mine reverts the repo.** "Keep mine" (`--existing keep`, answer 2) runs a full `export` before its import,
   so every differing file goes from this machine into the repo folder, `IN` files (changed only in the repo) included.
   The working tree then undoes the repo's newer changes, and a push would send them back. The bootstrap's `keep` does
   the same.
2. **No terminal takes the confirm's yes.** Run from Claude Code's `!` (stdin is not a terminal and empty), setup took
   every suggestion, the confirm's `Y` included, and wrote and imported with nobody answering.
3. **A pull dropped a local-only JSON item.** `mksync pull` replaced `~/.claude/settings.json` and lost a
   `hooks.PreToolUse` entry that only this machine had (put back by hand from the `.bak`). Import makes a `json` entry
   equal to the repo's layers, by design; the diff should mark such a file `OUT` and the pull guard stop. Why it didn't
   that time is unclear (bug 1's export, then a hand revert of the repo folder, can turn it into an `IN`).

## Decided (user, 2026-11-23)

1. **Keep exports only `OUT` and `BOTH`.** With a sync point and a diff that ran, keep exports only the files the diff
   labels `OUT` or `BOTH` (`export --only <repo path>` for each), then runs `import --force`, which brings the `IN`
   files. No `OUT` or `BOTH` file: no export and no `Pushed into the repo folder` line, only the import. Without a sync
   point, or after a failed diff, keep exports everything, as today (the newer side is unknown, and keep means mine).
2. **The bootstrap's keep.** Setup runs keep's export itself, before the bootstrap, and a failed export stops setup
   before the script (the record and profile stay written, as after any failure). The script's `keep` case then runs
   only `import --force`: the export is done.
3. **End of input at the confirm means no.** `Write the record and apply? [Y/n]` answered by end of input prints
   `Stopped: nothing was written.`, exit 0, as a typed `n` does. An empty line still takes `Y`. Every other question
   keeps taking its suggestion at end of input, and piped answers keep working. `--yes` is unchanged. This replaces
   the roadmap's "refuse without a terminal" (WIZ-4 stays in the design's "Open" list).
4. **The JSON import rule stays.** Import keeps making a `json` entry equal to the merged layers, so a removal on
   another machine still reaches this one. A shared case proves the guard stops a pull over a local-only array item
   (`OUT`) and over one next to a repo change (`BOTH`); the contract says so in the `json` entries section.

## Shared rules

- **Contract first** (CLAUDE.md rule 2): each concern's case comes before its code; `expect/` is written from the
  rules above, never from engine output. A case the code disagrees with is fixed in the code.
- **Never the real machine.** Cases run with a temp `HOME` and the `bootstrap` and `gh` stubs; `tests/linux/bootstrap.sh`
  runs on its stubs.
- The repo is public: fixtures use `example.com`, `/home/user`, `wk1-laptop`; `leak-scan` stays green.
- `tests/parity/run.sh` takes one substring filter: several filters run as a loop. Engine runs need
  `bun run build` first.
- Each step updates the contract section it changes. `tests/all.sh` runs once, before the PR (step 8).

## Step 1: Cases for keep `[worker]`

Files: `tests/parity/cases/setup-keep-out-only/`, `tests/parity/cases/setup-keep-in-only/`.

Model both on `tests/parity/cases/setup-existing-suggests-keep/` (sync point, a diff with labels). Both run
`mksync setup` with flags `--profile personal --claude none --mode push --existing keep --yes`, a recorded sync point
and two `whole` entries `a` and `b`:

- `setup-keep-out-only`: `a` changed only in the repo since the sync point (`IN`), `b` changed only on the machine
  (`OUT`). Expect: exit 0; the repo folder's `b` holds the machine's text, its `a` the repo's text (unchanged); the
  machine's `a` holds the repo's text with an `a.bak` of the old one; stdout has `Pushed into the repo folder; commit
it with mksync push.` once, between the export's and the import's output.
- `setup-keep-in-only`: only `a`, `IN`. Expect: exit 0; no `EXPORTED`/`MODIFIED` repo line and no `Pushed into` line;
  the repo folder unchanged; the machine's `a` takes the repo's text with a `.bak`.

The `case.json` descriptions cite decision 1 and "`mksync setup`", "Then".

Test: `for f in setup-keep-out-only setup-keep-in-only; do tests/parity/run.sh $f; done` fails now:
`setup-keep-out-only` for the repo's `a` overwritten with the machine's text, `setup-keep-in-only` for the export lines
(not a fixture error).

## Step 2: Keep exports only `OUT` and `BOTH` `[worker]`

Files: `src/app/guard.ts`, `src/app/guard.test.ts`, `src/app/setup.ts`, `docs/sync-contract.md`.

- `guard.ts`: add `blockedPaths(diff: Result): readonly string[]`, the repo path of each `OUT` and `BOTH` line
  (`blockedLines` keeps its lines; the path is the text after the label word and its padding, as
  `src/core/plan/diff.ts` prints it). Unit tests: an `OUT` and a `BOTH` line give their paths in order; `IN` and `?`
  lines and the summary lines give none; a path with a space comes back whole.
- `setup.ts`: `SetupDiffer`'s ok diff carries `paths` (from `blockedPaths`). `importAfterSetup` takes them: for
  `keep` with an ok diff, no paths runs only the import (no export, no `Pushed into` line), else `export` with
  `only: paths`; with no sync point or a failed diff, the full export as today.
- Contract "`mksync setup`", "Then": decision 1's wording.

Test: `bun test src/app/guard.test.ts src/app/setup.test.ts && bun run lint && bun run build && for f in setup-keep
setup-existing; do tests/parity/run.sh --engine dist/mksync $f; done`, all green.

## Step 3: The bootstrap's keep `[worker]`

Files: `src/app/setup.ts`, `bootstrap/linux.sh`, `tests/linux/bootstrap.sh`, `docs/sync-contract.md`.

- `setup.ts`: with the bootstrap chosen and answer `keep`, run keep's export (step 2's rule, the same function, no
  second copy) before `runBootstrap`; a non-zero export returns its result and the script doesn't run. The script still
  gets `MKSYNC_SETUP_EXISTING=keep`.
- `bootstrap/linux.sh`, `step_import`: the `keep)` case drops `"$MKSYNC" export` and its `Pushed into` line and sets
  `import_args=(--force)`, like `backup`. The comment says setup exported first.
- `tests/linux/bootstrap.sh`: the keep test now expects no `export` call on the `mksync` stub and one
  `import --force`.
- Contract "`mksync setup`", "Bootstrap": `keep` runs `import --force`, setup having exported (decision 2).

Test: `tests/linux/bootstrap.sh import && bun test src/app/setup.test.ts && bun run lint && bun run build &&
tests/parity/run.sh --engine dist/mksync setup-bootstrap`, all green.

## Step 4: Case for end of input at the confirm `[worker]`

Files: `tests/parity/cases/setup-confirm-eof/`, and the `stdin` of existing `setup*` cases that end before the
confirm.

- `setup-confirm-eof`: stdin answers the four questions (`1`, `1`, `1`, `1`) and ends. Expect: exit 0, stdout ends
  with `Write the record and apply? [Y/n] Stopped: nothing was written.`; no record, profile, `.bak` or imported
  file.
- Every existing `setup*` case whose stdin ends before the confirm and expects a write: add a `y` line for the
  confirm. Find them by reading each case's stdin against the questions its `expect/` stdout asks before
  `Write the record and apply?`; list them in the commit message. No `expect/` changes: piped answers aren't echoed.

Test: `tests/parity/run.sh setup-confirm-eof` fails now for the missing `Stopped:` line, and
`tests/parity/run.sh setup` passes every other case.

## Step 5: End of input at the confirm means no `[worker]`

Files: `src/wizard/setup.ts`, `src/wizard/setup.test.ts`, `docs/sync-contract.md`.

- `src/wizard/setup.ts`: the confirm (`CONFIRM_QUESTION`, line 151) treats `readLine()` returning `undefined` as no
  (the declined outcome); an empty line stays yes. The guarded `[y/N]` confirm is unchanged (end of input already no).
- Unit tests: end of input at the confirm gives the declined outcome; an empty line gives yes; `--yes` never reads.
- Contract "`mksync setup`", "Answers" and "Confirm": decision 3, naming the `!` / no-terminal case.

Test: `bun test src/wizard && bun run lint && bun run build && tests/parity/run.sh --engine dist/mksync setup`, all
green.

## Step 6: Case for the JSON pull guard `[worker]`

Files: `tests/parity/cases/pull-guard-json-item/`, `tests/parity/cases/pull-guard-json-both/`.

Model on `tests/parity/cases/pull-guard-out/`, with one `json` entry (`app/settings.json`, an object holding
`hooks.PreToolUse` as an array of objects) and a recorded sync point equal to `HEAD`:

- `pull-guard-json-item`: the machine's file adds one item to `hooks.PreToolUse`, the repo unchanged. Expect: the
  `OUT` line for the file, the guard's `ERROR` and `Run mksync push first …` lines, exit 1, the machine's file
  unchanged and no `.bak`.
- `pull-guard-json-both`: the same machine change, and a new repo commit after the sync point changing another key.
  Expect: the `BOTH` line, the same `ERROR`, exit 1, nothing written.

Test: `for f in pull-guard-json-item pull-guard-json-both; do tests/parity/run.sh $f; done`. Expected green (the guard
already does this). If either fails, stop: it is bug 3's cause, and the fix needs its own step.

## Step 7: Docs `[inline: docs need judgment]`

Files: `docs/sync-contract.md`, `docs/plan-setup-wizard.md`, `docs/design-layers.md`, `README.md` if it shows keep.

- Contract `json` entries, import: a key or array item only this machine has is replaced by the import; the diff marks
  the file `OUT` (or `BOTH`) and the pull and setup guards stop; `mksync push` first (decision 4).
- Re-read "`mksync setup`" end to end against decisions 1 to 3; "Front door" row for setup.
- Roadmap: a line under phase 1 for this hotfix and `v1.1.1`; "Not planned" keeps WIZ-4, noting decision 3.
- Design "Open": WIZ-4 note updated; the sync of the `ctx-print-guard` hook (a `sync-config.json` entry for the script
  and Linux-layer wiring) added as later work.

Test: `npx prettier --check docs/sync-contract.md docs/plan-setup-wizard.md docs/design-layers.md`.

## Step 8: PR and release `v1.1.1` `[inline: release run and its verification need judgment]`

Files: `package.json`, `CHANGELOG.md`, and wherever `1.1.0` is the program's version (`rtk grep -rn '1\.1\.0' src
package.json`).

- Bump to `1.1.1`; a changelog entry naming bugs 1 to 3.
- `tests/all.sh`, `leak-scan`, review (`ts-code-reviewer`), push, PR, `reviewed` label, `pr-ready`, merge.
- Tag `v1.1.1` and release as `v1.1.0` was; check `SHA256SUMS` and `mksync --version`; `mksync update` on this
  machine.

Test: the release checks above; on this machine `mksync setup --replace <this machine> --existing keep` from `!` stops
at the confirm with `Stopped: nothing was written.`
