# Setup wizard, phase 1: setup keeps this machine's changes

Roadmap: `docs/plan-setup-wizard.md`, phase 1. Contract: `docs/sync-contract.md` ("Front door", "`mksync setup`",
"Sync point", "Diff"). Branch `engine/setup-safety`, one PR, then release `v1.1.0`.

## Shared rules

- **Contract first** (CLAUDE.md rule 2): step 1 writes the rules, steps 2 to 5 write the shared cases' `expect/` from
  them, and only then the code changes. A case whose `expect/` the code disagrees with is fixed in the code, not in the
  case, unless the case contradicts the contract.
- **Never the real machine.** Cases run with a temp `HOME` and the `bootstrap` and `gh` stubs; `tests/linux/bootstrap.sh`
  runs on its stubs. Nothing reaches the real `sudo`, `apt-get`, `snap`, `dconf` or `curl`.
- **The pull guard is reused, not copied.** Setup calls the same diff (`runDiff`) and the same `OUT`/`BOTH` line filter
  as `src/app/pull.ts`; a helper both use moves to one module.
- The repo is public: fixtures use `example.com`, `/home/user`, `wk1-laptop`, and `leak-scan` stays green.
- Each worker step: one concern, at most 4 files. Test commands run that step's tests only; `tests/all.sh` runs before
  the PR (step 10).

## Decided

1. **Order.** Doctor, scan, profile list, questions 1 to 4, the bootstrap question (Ubuntu only, as today), then the
   summary and `Same as:`, then the guard block (decision 3), then the confirm (decision 4). Only after a yes: the
   record and the profile are written, the bootstrap runs (it skips its own import, decision 5), then setup acts on
   answer 4 as today. The value questions (`<KEY>: kept on …`) stay where they are, after the confirm: they choose
   where a value is stored and overwrite nothing.
2. **Question 4 says what differs.** Setup runs the import check before question 4 and, when it finds changes and a
   sync point exists, the diff. Above question 4 it prints one line:
   - with a sync point: `  <n> file(s) differ: <i> in, <o> out, <b> both.`
   - without one: `  <n> file(s) differ. No sync is recorded on this machine, so the newer side is unknown.`
   - nothing differs: no line. A failed diff prints `  <n> file(s) differ; could not tell which side is newer.`
     The suggestion is `2` (keep mine) when the diff has an `OUT` or `BOTH` file and the mode is push, else `1`.
3. **The guard block.** When answer 4 is `backup`, a sync point exists and the diff has `OUT` or `BOTH` files, setup
   prints those diff lines after `Same as:`, then
   `  <n> file(s) changed on this machine since the last sync; back up and replace overwrites them (each keeps a .bak).`
   A failed diff with `backup` and a sync point prints
   `  Could not tell which side is newer; back up and replace may overwrite files changed here (each keeps a .bak).`
4. **The confirm.** `Write the record and apply? [Y/n] `, or `[y/N] ` after a guard block. A no prints
   `Stopped: nothing was written.` and exits 0, with no record, profile, bootstrap or import. `--yes` answers yes,
   except after a guard block: there it stops before anything is written with
   `ERROR: <n> file(s) changed on this machine since the last sync, and setup would overwrite them.` and
   `Run mksync setup --existing keep to push them first, or run it without --yes to confirm.`, exit 1 (after a failed
   diff: `ERROR: could not tell which side is newer; run mksync diff to see why, or mksync setup --existing keep.`,
   exit 1).
5. **The bootstrap keeps answer 4.** Setup runs `bootstrap/linux.sh` with `MKSYNC_SETUP=1`. With it set, the script's
   import step prints `  SKIPPED    import (mksync setup imports next)` and runs no import. A bootstrap that exits 0
   lets setup go on to answer 4; one that fails ends setup with its exit code, before any import. `--bootstrap` now
   shows in `Same as:` when the bootstrap runs.
6. **Exit codes** stay as the contract has them; the only new ones are decision 4's exit 1 with `--yes` and its exit 0
   on a declined confirm.

## Step 1: Contract `[inline: contract wording needs judgment]`

Files: `docs/sync-contract.md`.

- "`mksync setup`": the opening paragraph and the example follow decision 1 (the bootstrap question before the summary,
  the confirm after it). Add bullets for decisions 2, 3 and 4. "Bootstrap" and "Then" follow decisions 1 and 5.
- "Front door": rewrite row 706 to the same order (WIZ-16), and change "`mksync setup` and `bootstrap/linux.sh` run
  the import directly" (line 722) to say setup runs the guard of decisions 3 and 4, and the bootstrap skips its import
  under setup.
- The bootstrap's own section (search `step_import` / "import" under the Ubuntu bootstrap): the `MKSYNC_SETUP=1` line.

Test: `npx prettier --check docs/sync-contract.md`.

## Step 2: Cases for the guard `[worker]`

Files: `tests/parity/cases/setup-guard-yes-refused/`, `tests/parity/cases/setup-guard-declined/`,
`tests/parity/cases/setup-guard-confirmed/`.

Model them on `pull-guard-out` (`"git": "remote"`, `"syncPoint": true`, a home file that differs from the repo so the
diff labels it `OUT`) and on `setup-flags` for the setup options. Linux only. Every `expect/` is written from step 1's
contract:

1. `setup-guard-yes-refused`: `--profile personal --name box1 --existing backup --yes`. Output ends with the `OUT` line
   and decision 4's two `--yes` lines; exit 1; `expect/home` equals the starting home (no record, no profile, the file
   unchanged, no `.bak`).
2. `setup-guard-declined`: the same flags without `--yes`, stdin `n`. The guard block, then
   `Write the record and apply? [y/N] Stopped: nothing was written.`; exit 0; home unchanged.
3. `setup-guard-confirmed`: stdin `y`. The guard block, the confirm, then the import's lines; exit 0; the record and
   profile are written, the file holds the repo's content and `<file>.bak` the old one.

Test: `tests/parity/run.sh setup-guard` fails now, each case for the missing guard block (not a fixture error).

## Step 3: Cases for question 4 and the confirm `[worker]`

Files: `tests/parity/cases/setup-existing-suggests-keep/`, `tests/parity/cases/setup-confirm-declined/`,
`tests/parity/cases/setup-no-sync-point-note/`.

1. `setup-existing-suggests-keep`: sync point, one `OUT` file, `--profile personal --name box1 --claude none --mode
push`, stdin empty. Above question 4: `  1 file(s) differ: 0 in, 1 out, 0 both.`; question 4 ends `[2]`; end of
   input takes keep, so `Same as:` has `--existing keep`; the confirm is `[Y/n]` (no guard: keep isn't backup); the
   export line `Pushed into the repo folder; commit it with mksync push.`; exit 0.
2. `setup-confirm-declined`: no file differs, all four flags, stdin `n`. No differ line; the confirm `[Y/n]`, then
   `Stopped: nothing was written.`; exit 0; home unchanged.
3. `setup-no-sync-point-note`: no sync point, one differing file, all flags but `--existing`, stdin empty. Above
   question 4: `  1 file(s) differ. No sync is recorded on this machine, so the newer side is unknown.`; suggestion
   `[1]`; no guard block; confirm `[Y/n]`; the import runs; exit 0.

Test: `tests/parity/run.sh 'setup-(existing-suggests|confirm-declined|no-sync-point)'` fails now for the missing lines.

## Step 4: Case and bootstrap test: the bootstrap keeps answer 4 `[worker]`

Files: `tests/parity/cases/setup-bootstrap-question/` (its `expect/`), `tests/linux/bootstrap.sh`.

- `setup-bootstrap-question`: after `BOOTSTRAP RAN`, setup goes on with answer 4 (the import's lines), and the
  bootstrap question now comes before the summary, with `--bootstrap` in `Same as:`.
- `tests/linux/bootstrap.sh`: a new case `import-skipped-under-setup`: `MKSYNC_SETUP=1` makes the import step print
  `  SKIPPED    import (mksync setup imports next)` and never call the program (the stub's call log has no `import`).
  The existing import cases run unchanged without the variable.

Test: `tests/parity/run.sh setup-bootstrap-question; tests/linux/bootstrap.sh import-skipped-under-setup`, both
failing now for the new lines.

## Step 5: The other setup cases follow the new order `[inline: about 25 expect files edited by hand against the contract]`

Files: `tests/parity/cases/{setup-*,sync-setup-*}/expect/output.txt`, and `case.json` `stdin` where a case needs one
more answer.

- Each case that reaches the write gains the confirm line (`Write the record and apply? [Y/n] `). With piped answers
  an empty line or end of input answers it; a case whose stdin goes on into value or import answers gets one empty line
  inserted for the confirm.
- `sync-setup-offers-bootstrap`: the bootstrap question moves before the summary.
- Cases that stop before the write (doctor fails, flag errors, missing flag, retired profile, name errors) don't
  change; the step lists which ones changed and why in its commit message.

Test: `tests/parity/run.sh setup` reports every changed case failing only on the new lines (diff checked by hand).

## Step 6: Setup asks everything first, then confirms `[worker]`

Files: `src/wizard/setup.ts`, `src/wizard/setup.test.ts`, `src/app/setup.ts`, `src/app/setup.test.ts`.

- Move the bootstrap question before the summary; add `--bootstrap` to `Same as:` when it is yes.
- Add the confirm of decision 4 (without the guard block yet): a no prints `Stopped: nothing was written.`, exit 0,
  before the record is written; `--yes` answers yes.
- Unit tests: the confirm's yes, no and end of input; `--yes` skips it; the bootstrap question's new place.

Test: `bun test src/wizard src/app/setup.test.ts && bun run lint && tests/parity/run.sh --engine dist/mksync setup`
after `bun run build`: step 5's cases and `setup-confirm-declined` pass.

## Step 7: Question 4 and the guard `[worker:high: reasoning: reusing pull's guard across the setup flow without a second copy of its rules]`

Files: `src/app/setup.ts`, `src/app/pull.ts`, `src/app/guard.ts` (new), `src/app/guard.test.ts` (new).

- Move pull's diff-label filter (`blockedLines`) and its count into `src/app/guard.ts`; `pull.ts` imports them and
  prints exactly what it printed before (its cases are the check).
- Setup runs the import check and, with changes and a sync point, the diff before question 4 (decision 2), prints the
  differ line and sets the suggestion; after `Same as:` prints the guard block (decision 3); the confirm turns `[y/N]`
  after it, and `--yes` refuses (decision 4).
- Unit tests in `guard.test.ts`: the filter keeps `OUT` and `BOTH` lines, drops `IN` and `?`, and counts them.

Test: `bun test src/app && bun run lint`, then `bun run build && tests/parity/run.sh --engine dist/mksync
'setup|pull-guard'`: steps 2 and 3's cases pass, and every `pull-guard-*` case still passes.

## Step 8: The bootstrap skips its import under setup `[worker]`

Files: `bootstrap/linux.sh`, `src/app/setup.ts`.

- `bootstrap/linux.sh` `step_import`: with `MKSYNC_SETUP=1`, print `boot_skipped`'s line
  `import (mksync setup imports next)` and return 0 before the import.
- `src/app/setup.ts` `runBootstrap`: pass `MKSYNC_SETUP=1` in the script's environment; on exit 0 return `undefined`
  so setup goes on to answer 4; on a failure return the script's result as today.

Test: `tests/linux/bootstrap.sh && bun run build && tests/parity/run.sh --engine dist/mksync setup-bootstrap`, and
`shellcheck -x bootstrap/linux.sh`.

## Step 9: Docs `[inline: docs need judgment]`

Files: `docs/restore.md`, `docs/daily-workflow.md`, `docs/design-layers.md`, `README.md` (only if it describes setup's
questions).

- Describe the new order, the differ line, the guard and the confirm where these docs walk through setup, and what to
  answer on a machine that already has changes (keep mine).
- Design "Open": WIZ-4, WIZ-5 and WIZ-15 (roadmap "Not planned"), with one line each.
- `docs/plan-setup-wizard.md`: phase 1 done.

Test: `npx prettier --check docs/*.md README.md` (apart from `docs/review-gate.md`, which already fails on `master`).

## Step 10: PR and release `v1.1.0` `[inline: release run and its verification need judgment]`

- `CHANGELOG.md` `v1.1.0` section; `package.json` version `1.1.0`.
- `tests/all.sh`, the `ts-code-reviewer` and `wizard-auditor` on the branch (one round of fixes), push, PR. It touches
  no workflow, so Claude may label and merge once `pr-ready` exits 0.
- Tag `v1.1.0` on `master` with the CHANGELOG section as an annotated message; check the release (SHA256SUMS,
  `--version` prints `1.1.0`); `mksync update` on the personal Linux machine.
- Re-run setup on the personal Linux machine with the user, as `mksync setup --replace <its name>` (the cancelled run
  of 2026-11-22 left its record): the differ line shows the `OUT` and `BOTH` files and question 4 suggests keep.

Test: the release checks above; the user's setup run shows the differ line.
