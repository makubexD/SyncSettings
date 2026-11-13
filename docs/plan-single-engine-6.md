# One engine, phase 6: machines

Roadmap: `docs/plan-single-engine.md`, phase 6. Design: `docs/design-layers.md` ("Machine records", "First run",
"Replace and retire", "Public-repo guard", "Values", "Modules and profiles"). Goal: a machine record replaces
`SYNC_PROFILE` and `SYNC_MACHINE`; `mksync setup` scans, asks four questions, writes the record and runs the first
pull; `mksync machine show` prints the record; values live on the profile and the machine; a machine can be replaced and a
machine or profile retired; and the public-repo guard keeps profiles, records and values out of the repo.

## Shared rules

- Branch `engine/machines`, one commit per step, one PR at the end.
- **Old engines frozen.** No change to `export.sh`, `import.sh`, `commit.sh`, `scripts/linux/`, `scripts/windows/`.
  The bash front door's `mksync setup` stays as it is until phase 8. The runners (`tests/parity/run.sh`, `run.ps1`)
  may change; no existing case's `expect/` changes.
- **Contract first** (CLAUDE.md rule 2): step 2 writes this phase's rules into the contract; steps 4 to 6 add the
  shared cases before the code that makes them pass.
- **Public repo.** Fixtures use `example.com`, `/home/user`, `C:\Users\user`, profile `work-1`, machines `wk1-laptop`
  and `wk1-new`, domain `corp.example.com`. `leak-scan` stays green. The scan never stores the git email; it only
  shows it.
- **Layout** from the design's "Code layout": `src/core/` stays pure (the boundary grep in "As built in phase 4"
  prints nothing). Records, modules and values go in `src/core/machine/`; the guard's decision in `src/core/guard.ts`;
  the scan and the visibility reader in `src/adapters/`; command parsing in `src/cli/`; the first-run flow in
  `src/wizard/`. Tests sit next to their file.
- **No new dependencies.** Prompts use `node:readline` as the overwrite prompt does.
- **Messages are the contract's.** Every line steps 7 to 19 print is copied from `docs/sync-contract.md` as step 2
  writes it. A worker spec names the section to copy from.
- Each worker step: about 3 files, one concern, tests in the same step. Test commands run that step's tests only.

## Out of this phase

- The push preview grouped by receiver, the "where does this new setting go?" question and the first-backup group in
  the preview: phase 7. This phase builds the guard's decision and the merge of profile copies as pure functions and
  shows only the "held" line in `export --preview`.
- `commit`, the PR per profile, and the bash front door handing `setup` and `machine show` to the program: phase 8. Until
  then the commands run as `dist/mksync setup` and `dist/mksync machine show`.
- Making the repo private and lifting the guard: phase 10. Nothing in this phase writes `profiles/` or `machines/`
  into the repo.
- What goes in `work-base`, the Claude layers in use: phase 7.

## Decisions to confirm in review

Proposals; the review of this plan confirms or changes them before `/next`. Step 2 writes them into the contract and
the design.

1. **The record replaces the two variables.** The program reads `<state>/machine.json`. With no record (every machine
   today, and every v1 shared case) it behaves as in phase 5 with the variables unset: no profile or machine layer,
   every module on, values from `.user-values.json`. `SYNC_PROFILE` and `SYNC_MACHINE` are removed; the v2 cases that
   set them get a `state/machine.json` instead (input only, `expect/` unchanged). This settles the design's Open item.
2. **Test overrides for the scan.** As `SYNC_OS` does for the OS: `SYNC_HOSTNAME`, `SYNC_DOMAIN` (empty means `null`)
   and `SYNC_TOOLS` (a comma list of the tools found) replace what the scan reads, so shared cases print the same scan
   on every runner. The runner allows them, `MKSYNC_VISIBILITY` and the existing two in a `configV2` case's `env`.
3. **Where records live.** While public: `<state>/machine.json` and `<state>/profiles/<name>.json`, as the design
   says. The move to the repo is written into local state once (`machine.json` becomes `{"name": …, "home": "repo"}`)
   by the first private push (phase 7/8), so reading a record never needs the network; only the guard does. This
   phase builds both stores; the repo store is tested with fixtures only.
4. **Values.** With a record, a value comes from the machine's `values`, then the profile's; `.user-values.json` is not
   read. `setup` copies `.user-values.json` once by the design's table and leaves the file as it is (the old engine and
   shadow still use it). A placeholder not in the table is asked once: `<P>: kept on 1) this profile 2) this machine
[1]`; with `--yes` and no terminal it goes on the profile. A value asked for during a pull is saved by the same
   rule. The table is a constant in `src/core/machine/values.ts`.
5. **Command names**, reviewed by the `cli` skill in step 1:
   `mksync setup [--name <machine>] [--profile <name>] [--replace <machine>] [--claude none|claude|claude-deepseek]
[--mode push|pull-only] [--existing backup|keep|stop] [--yes]`, `mksync machine show`,
   `mksync machine retire <name> [--yes]`, `mksync profile retire <name> [--yes]`. The review's changes to the
   proposal:
   - `whoami` became `mksync machine show`. The top level already has eight verbs for daily work, and `machine` is a
     noun group anyway (`retire`), so the record's reader is a verb in it. Nothing shipped, so no alias.
   - `--push | --pull-only` became `--mode push|pull-only`: one question, one option taking a value, like `--claude`
     and `--existing`. `setup --push` also read as "push after setup", which `--existing keep` really does.
   - A question takes its flag; without one, it's asked; an empty answer or end of input takes the suggestion in
     brackets. `--yes` takes the suggestions without asking, as it answers `[Y/n]` today. A question with no
     suggestion (the profile, unless a record has this hostname) that gets end of input, or `--yes` and no flag, stops
     with `ERROR: missing --<flag>`, exit 2, before anything is written.
   - Retire asks `[y/N]` first (the contract's "Retire" has both questions); `--yes` answers it.
     No answer, or end of input, retires nothing: exit 1.
   - `--name` with `--replace` (the record keeps the replaced name) stops with
     `ERROR: --name and --replace can't be used together.`, exit 1, as `--preview` with `--only` does today. Unknown
     options stay `Unknown option: <arg>`, exit 1. Exit 2 stays for a missing command and a missing answer.
   - Kept: `setup`, `--name`, `--profile`, `--replace`, `--claude` and its values, `--existing` and its values, and
     the noun groups `machine` and `profile` (rejected: a top-level `mksync retire <machine>`, which leaves no place
     for `profile retire`). `setup --bootstrap` stays in the front door; the program takes it over in phase 8.
6. **Replace while public.** A new machine has no local records, so `--replace <name>` finds nothing:
   `ERROR: no machine <name> here; records are shared once the repo is private.`, exit 1. A rerun of `setup` on a
   machine that already has a record is `ERROR: this machine is already <name>; use --replace to take over another
record.`, exit 1 (the `cli` review: these are the machine's state, not a usage error). Replace proper runs against the repo store and is tested with `MKSYNC_VISIBILITY=private`
   fixtures.
7. **Retire.** `machine retire` marks a record; a retired record can't push (`this machine is retired`, exit 1) and
   isn't offered for `--replace`. `profile retire` is refused while a non-retired record in the store uses it
   (`profile <name> is used by machine <m>`, exit 1); this settles the Open item. **Two records, one hostname:** the
   suggestion names the one non-retired record with that hostname; with two or more, no suggestion.
8. **Hostname check.** `machine show` and `import` print the warning on stderr and go on; `export` (the push side) stops on
   it with exit 1, as do a pull-only and a retired record. `export --preview` and `import --check` only warn.
9. **"Keep mine" before the program can commit.** Answer 4's "keep mine" runs `export` then `import`; the PR waits for
   phase 8, so `setup` prints `pushed into the repo folder; commit it with mksync push`.
10. **The guard in this phase.** `src/adapters/visibility.ts` reads the visibility as the design says (`gh repo view`,
    then the public API, failing closed; `MKSYNC_VISIBILITY` only for an origin that isn't `github.com`).
    `src/core/guard.ts` decides held and refused paths. Wired now: `export --preview` prints `held until the repo is
private: <n> files` and the paths; `export` stops with the design's `refused:` lines when the repo tree already
    holds `profiles/` or `machines/` while public. Merging two machines' copies of one profile (Open, "Two copies of
    one profile") is a pure function with unit tests, wired with the first backup in phase 7.

## Step 1: Review the new command names `[inline: cli skill review of contract names]`

Files: `docs/design-layers.md`.

Run the `cli` skill in design mode over decision 5's commands and flags against today's front door. Write its verdict
into decision 5 of this plan (as a plan edit) and the design's Open item "New commands and flags" (settled, or the
renames it asks for as a migration note).

Test: `grep -c 'whoami' docs/design-layers.md` is at least 2; `npx prettier --check docs/plan-single-engine-6.md`.

## Step 2: This phase's rules in the contract `[inline: contract decisions]`

Files: `docs/sync-contract.md`, `docs/design-layers.md`.

- Contract: a "Machines (program only)" section: the record's fields and checks, where it's kept (decision 3), the
  scan and its overrides (decision 2), `setup` with its four questions, suggestions, flags and exact output, `machine show`
  and the hostname warning, replace, retire, values on profile and machine (decision 4), and every `ERROR:`, warning
  and refusal line with its exit code. "Profile and machine, until phase 6" is replaced. A "Public-repo guard
  (program only)" section with the held and refused lines (decision 10). The front door table gets the program's
  `setup` and `machine show` rows, marked "program only until phase 8".
- Design: decisions 1 to 10 as rules with an example where the design has none; the settled Open items taken out.

Test: `grep -c 'machine show' docs/sync-contract.md` is at least 2; `grep -c 'held until the repo is private'
docs/sync-contract.md` is at least 1; `! grep -n 'SYNC_PROFILE' docs/sync-contract.md | grep -v 'removed'`.

## Step 3: Runner for records and the new commands `[worker]`

Files: `tests/parity/run.sh`, `tests/parity/run.ps1`, `tests/parity/README.md`.

- `command` may also be `setup`, `machine-show`, `machine-retire`, `profile-retire`; with an engine other than the program
  they print `SKIP <case>: <command> is program only` and count as skipped.
- `options` adds `name`, `profile`, `replace`, `claude`, `mode`, `existing`, `yes: true` and
  `target` (the retire argument), spelled as decision 5.
- `env` in a `configV2` case may set `SYNC_HOSTNAME`, `SYNC_DOMAIN`, `SYNC_TOOLS`, `MKSYNC_VISIBILITY`; anything
  else stays a runner error.
- `stderr: true` on a command adds its stderr lines to `output.txt` after its stdout lines (for the warnings).
- Follow-up (found in review: the runner keeps only `WORD label` status lines, so the six `machine show` lines, the
  scan block and the `ERROR:`, `held` and `refused:` lines would be dropped): a command's stdout is kept whole (every
  line, ANSI codes and `\r` removed) for `setup`, `machine-show`, `machine-retire`, `profile-retire`, and for any
  command with `"output": "all"`; the rest keep status lines as today.

Test: `tests/parity/run.sh --engine dist/mksync` passes as before (51 passed); a scratch case using `machine-show` against
bash prints the skip line (made in the scratchpad, not committed).

## Step 4: Shared cases for records `[worker]`

Files: `tests/parity/cases/machine-*/` (new), and the v2 cases that set `SYNC_PROFILE` or `SYNC_MACHINE`.

The v2 cases: replace their `env` with `state/machine.json` naming the same profile and machine; `expect/` unchanged.
New cases, each `configV2`, `expect/` from step 2's contract:

| Case                     | Input                                                                      | Expected                                            |
| ------------------------ | -------------------------------------------------------------------------- | --------------------------------------------------- |
| `machine-none`           | no record, `import --force`                                                | as phase 5: every module on, exit 0                 |
| `machine-show`           | record `wk1-laptop`, profile `work-1`, `machine-show`                      | the six lines of the contract, exit 0               |
| `machine-show-moved`     | `SYNC_HOSTNAME=wk1-new`, `machine-show` with `stderr`                      | the six lines, then the two warning lines, exit 0   |
| `machine-claude-none`    | record `claude: none`, entries in `claude` and `git`                       | `claude` entries get no line, `git` imports         |
| `machine-module-remove`  | record `modules.remove: ["other"]`                                         | `other` gets no line                                |
| `machine-pull-only`      | record `pullOnly: true`, `export`                                          | `this machine is pull-only`, exit 1, repo unchanged |
| `machine-moved-export`   | `SYNC_HOSTNAME=wk1-new`, `export`                                          | the warning and exit 1, repo unchanged              |
| `machine-retired-export` | record `retired: true`, `export`                                           | `this machine is retired`, exit 1                   |
| `machine-values`         | profile value `<YOUR_EMAIL>`, machine value `<HOME>`, both also in profile | file hydrated with the machine's `<HOME>`           |
| `machine-bad-record`     | `machine.json` with `profile: "Work 1"`                                    | the contract's record error, exit 2                 |

Test: `ls -d tests/parity/cases/machine-* | wc -l` is 10; each new case fails against today's program for the reason
in its row (`tests/parity/run.sh --engine dist/mksync machine-` shows 10 failures, the v2 cases still pass after the
next steps).

## Step 5: Shared cases for setup, replace and retire `[worker]`

Files: `tests/parity/cases/setup-*/`, `tests/parity/cases/retire-*/` (new).

| Case                    | Input                                                                                                     | Expected                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `setup-flags`           | no record, `setup --yes --name wk1-laptop --profile work-1 --claude claude --mode push --existing backup` | scan block, summary, `Same as:` line; `state/machine.json` and `state/profiles/work-1.json` written; import lines; exit 0       |
| `setup-missing-flag`    | `setup --yes` without `--profile`                                                                         | `missing --profile`, exit 2, nothing written                                                                                    |
| `setup-stdin`           | answers `work-1\n2\n1\n1\n` on stdin                                                                      | same record as `setup-flags`                                                                                                    |
| `setup-values-move`     | `.user-values.json` with `<YOUR_EMAIL>` and `<HOME>`                                                      | email on the profile, home on the record, `.user-values.json` unchanged                                                         |
| `setup-values-unknown`  | `.user-values.json` with `<OTHER>`, `--yes`                                                               | `<OTHER>` on the profile                                                                                                        |
| `setup-existing-stop`   | `--existing stop`                                                                                         | record written, no file imported, exit 0                                                                                        |
| `setup-again`           | a record already there                                                                                    | the contract's `already` error, exit 1                                                                                          |
| `setup-replace-public`  | `--replace wk1-laptop`, public                                                                            | the contract's `no machine` error, exit 1                                                                                       |
| `setup-replace-private` | `MKSYNC_VISIBILITY=private`, repo store holds `machines/wk1-laptop.json`, `SYNC_HOSTNAME=wk1-new`         | record kept, `hostname: wk1-new`, one `replaced` line                                                                           |
| `setup-suggest`         | private store, one record with this hostname, stdin `\n…`                                                 | the `This looks like` line, the suggested profile taken                                                                         |
| `retire-machine`        | `machine retire wk1-laptop --yes`, then `export`                                                          | record `retired: true`; export exit 1                                                                                           |
| `retire-profile-used`   | `profile retire work-1 --yes` while the record uses it                                                    | the contract's refusal, exit 1                                                                                                  |
| `retire-declined`       | `machine retire wk1-laptop`, end of input                                                                 | record unchanged, exit 1                                                                                                        |
| `setup-name-replace`    | `setup --name a --replace wk1-laptop`                                                                     | the contract's `can't be used together` error, exit 1, nothing written                                                          |
| `setup-yes-suggests`    | `setup --yes --profile work-1`, no other flag                                                             | the suggestions taken: name from `SYNC_HOSTNAME`, `claude` when `SYNC_TOOLS` has it, `--mode push`, `--existing backup`; exit 0 |

The `replaced` line's date: the cases set `SOURCE_DATE_EPOCH`-style `SYNC_DATE` if step 2's contract adds it; else
the case compares the record without the date (the step writes which).

Test: `tests/parity/run.sh --engine dist/mksync 'setup-|retire-'` shows 15 failures for the reasons above.

## Step 6: Shared cases for the guard `[worker]`

Files: `tests/parity/cases/guard-*/` (new).

| Case                     | Input                                                                             | Expected                                                   |
| ------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `guard-preview-held`     | record and profile in state, `git: remote`, `MKSYNC_VISIBILITY=public`, `preview` | `held until the repo is private: 2 file(s)` and both paths |
| `guard-refuse-committed` | repo holds `machines/wk1-laptop.json` committed, public, `export`                 | the two `refused:` lines, exit 1, repo unchanged           |
| `guard-private`          | same as `guard-preview-held` with `private`                                       | no held line                                               |
| `guard-default-public`   | `MKSYNC_VISIBILITY` unset, local origin                                           | the held line                                              |

Test: `tests/parity/run.sh --engine dist/mksync guard-` shows 4 failures.

## Step 7: The machine record `[worker]`

Files: `src/core/machine/record.ts`, `src/core/machine/record.test.ts`.

`parseRecord(text)`: the design's fields, checked (names lowercase letters, digits, `-`; `os`; `claude`; `modules.add`
and `remove` lists of module names; `values` strings; `replaced` items; booleans), with the contract's error lines.
`recordText(record)`: the design's key order, two-space indent, trailing newline. Unit cases: a full record, each
bad field, unknown key, round trip byte-exact.

Test: `bun test src/core/machine/record.test.ts && bun run lint`.

## Step 8: Modules and values from profile and record `[worker]`

Files: `src/core/machine/scope.ts`, `src/core/machine/scope.test.ts`, `src/core/plan/pick.ts`.

`machineScope(profile, record, os)`: the profile's modules, plus `add`, minus `remove`, minus `claude` and
`claude-worker` by the Claude mode, minus modules limited to other OSes, with the reason for each module turned off
(for `machine show`). `machineValues(profile, record)`: machine wins. `pick.ts` takes the scope instead of building it (this
closes the Open item "four copies of the same three lines"). Unit cases: each source of "off", an `add` of another
OS's module, a value on both.

Test: `bun test src/core/machine src/core/plan && bun run lint`.

## Step 9: Where a value is kept `[worker]`

Files: `src/core/machine/values.ts`, `src/core/machine/values.test.ts`.

The design's table as a constant; `placeValue(placeholder)` returns `profile`, `machine` or `ask`;
`moveUserValues(values, answers)` splits `.user-values.json` into profile and machine values. Unit cases: every table
row, an unknown placeholder with each answer, an empty file.

Test: `bun test src/core/machine/values.test.ts && bun run lint`.

## Step 10: Record store and the variables removed `[worker]`

Files: `src/adapters/store.ts`, `src/adapters/store.test.ts`, `src/adapters/snapshot.ts`.

Decision 3. `readStore(state, repo)`: the record, its profile and every local profile, from local state, or from the
repo's `machines/` and `profiles/` when the record says `home: repo`. `snapshot.ts` reads the profile and machine
layers from the record instead of `SYNC_PROFILE` and `SYNC_MACHINE`, and values per decision 4. Unit cases with temp
folders: no record, local record, repo home, missing profile.

Test: `bun test src/adapters && bun run lint && bun run build && tests/parity/run.sh --engine dist/mksync` (the v2
cases moved in step 4 and `machine-none`, `machine-claude-none`, `machine-module-remove`, `machine-values`,
`machine-bad-record` pass).

## Step 11: Push and pull check the record `[worker]`

Files: `src/main.ts`, `src/core/machine/check.ts`, `src/core/machine/check.test.ts`.

Decision 8: `checkRecord(record, scan)` returns the hostname warning and the pull-only and retired refusals; `export`
stops on them (exit 1, before any write), `import` and the checks print the warning on stderr and go on.

Test: `bun test src/core/machine && bun run build && tests/parity/run.sh --engine dist/mksync machine-`.

## Step 12: The scan `[worker]`

Files: `src/adapters/scan.ts`, `src/adapters/scan.test.ts`.

OS, hostname, domain (`USERDNSDOMAIN` on Windows, else `null`), the global git email, the tools on `PATH` from the
contract's list, and how many of this OS's entries exist locally; decision 2's overrides. Unit cases use the
overrides and a temp `PATH`.

Test: `bun test src/adapters/scan.test.ts && bun run lint`.

## Step 13: `mksync machine show` `[worker]`

Files: `src/cli/parse.ts`, `src/cli/parse.test.ts`, `src/main.ts`.

Parse `machine show`; print the contract's lines from the store and `machineScope`; no record: the contract's line and exit.
Hostname warning from step 11.

Test: `bun test src/cli && bun run build && tests/parity/run.sh --engine dist/mksync machine-show`.

## Step 14: The first-run flow `[inline: user-facing prompts, wizard skill]`

Files: `src/wizard/setup.ts`, `src/wizard/setup.test.ts`.

Built with the `wizard` skill. A pure flow over the scan and the store: the four questions with their suggestions
(design "First run", decisions 6 and 7), answers from flags first, then stdin or the terminal, the suggestion on an empty answer, end of
input or `--yes`, `missing --<flag>` where there is no suggestion, the summary and the `Same as:` line. It returns the record, the profile and the actions
(`backup`, `keep`, `stop`); it writes nothing. Unit cases: each question's suggestion, each flag, a typed new profile,
the missing-flag stop, back to a question on a bad answer.

Test: `bun test src/wizard && bun run lint`.

## Step 15: `mksync setup` `[worker]`

Files: `src/cli/parse.ts`, `src/main.ts`, `src/adapters/store.ts`.

Parse decision 5's flags; run the scan, the flow, then write the record and profile, move `.user-values.json`
(step 9), and run the existing-files action (decision 9) and the first import.

Test: `bun test src/cli && bun run build && tests/parity/run.sh --engine dist/mksync setup-`.

## Step 16: Replace and retire `[worker]`

Files: `src/core/machine/replace.ts`, `src/core/machine/replace.test.ts`, `src/main.ts`.

`replaceRecord(old, scan, date)`: keep name, profile, mode and modules; new hostname and domain; old pair to
`replaced`; machine values asked again with the old as suggestion. `machine retire` and `profile retire` with
decision 7's refusal.

Test: `bun test src/core/machine && bun run build && tests/parity/run.sh --engine dist/mksync 'setup-replace|retire-'`.

## Step 17: Reading the visibility `[worker]`

Files: `src/adapters/visibility.ts`, `src/adapters/visibility.test.ts`.

Decision 10: `github.com` origin → `gh repo view --json visibility` when signed in, else `GET /repos/<owner>/<repo>`;
any failure is public. Other origins → `MKSYNC_VISIBILITY`, default public; the variable is ignored for `github.com`.
Unit cases with an injected runner and fetch: each answer, each failure, the ignored variable. No test reaches the
network.

Test: `bun test src/adapters/visibility.test.ts && bun run lint`.

## Step 18: The guard in export `[worker]`

Files: `src/core/guard.ts`, `src/core/guard.test.ts`, `src/main.ts`.

`guard(visibility, repoPaths, localRecords)`: held paths (local profiles and record) and refused paths (`profiles/` or
`machines/` in the repo tree while public). `export --preview` prints the held line; `export` stops on refused
paths. The constant naming `profiles/` and `machines/` moves here from `core/plan/preview.ts` and `adapters/fs.ts`
(closes that Open item).

Test: `bun test src/core/guard.test.ts && bun run build && tests/parity/run.sh --engine dist/mksync guard-`.

## Step 19: Merging two copies of a profile `[worker]`

Files: `src/core/machine/copies.ts`, `src/core/machine/copies.test.ts`.

`mergeProfileCopies(copies)`: modules joined in first-seen order, `destinations` joined, `retired` true if any copy
says so; a value or destination that differs between copies is returned as a question, not picked. Unit cases: two
equal copies, a module only in one, a differing value, a differing destination.

Test: `bun test src/core/machine/copies.test.ts && bun run lint`.

## Step 20: Audits `[inline: review of user-facing work]`

Run `wizard-auditor` on `setup`, `cli-auditor` on `setup`, `machine show` and the retire commands, and
`ts-security-auditor` on the store, the guard and the visibility reader. Fixes become steps 21 to 27, with shared
cases first where they change output; what's left goes in the design's Open. The docs step moves to the end (28).

Test: `tests/all.sh`.

## Step 21: The audits' decisions in the contract `[inline: contract wording decided from the audits]`

Files: `docs/sync-contract.md`, `docs/design-layers.md`.

Contract lines, written before their cases:

- Front door usage: `mksync export [--preview] [--only <path>...]` (no `--force`, which export refuses).
- Setup flag errors, exit 1 like an unknown option: `ERROR: <flag> needs a value.`, `ERROR: <flag> is repeated.`,
  `ERROR: <flag> must be one of <a>, <b>, <c>.`
- Setup refuses before writing: a retired profile named by `--profile` or typed at question 1,
  `ERROR: profile <name> is retired; pick another name.`, exit 1; `--existing keep` (or answer 2) with a pull-only
  mode, `ERROR: --existing keep pushes first, so it can't be used with --mode pull-only.`, exit 1.
- Taking over the record the hostname suggests is a replace: machine values are asked again, as with `--replace`.
- Retire: `Profile <name> is already retired.`, exit 0.
- Open: retire against the repo store once private (phase 7, with the pointer write); unpushed history under
  `profiles/` or `machines/`; old machine values printed on a piped replace; a `__proto__` placeholder dropped;
  profile and retire names not checked against the layer-name rule; unknown verb in a group exits 1 but an unknown
  command exits 2; no `--help` or `--name=value`; `--profile`, `--claude` and `--mode` ignored with `--replace`.

Test: `npx prettier --check docs/plan-single-engine-6.md`.

## Step 22: Shared cases for usage and retire `[worker]`

Files: `tests/parity/cases/usage-line/`, `tests/parity/cases/retire-profile/`,
`tests/parity/cases/retire-profile-already/`, `tests/parity/cases/retire-machine-already/`.

From step 21's lines: no command prints the usage line (exit 2); `profile retire work-1 --yes` with no record using
it retires it; each already-retired case prints its line, exit 0, state unchanged. Follow `retire-machine`'s layout.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync retire-` (the usage case fails until step 27).

## Step 23: Shared cases for setup `[worker]`

Files: `tests/parity/cases/setup-flag-errors/`, `tests/parity/cases/setup-retired-profile/`,
`tests/parity/cases/setup-pullonly-keep/`, `tests/parity/cases/setup-values-piped/`.

From step 21's lines and the contract's "mksync setup": a repeated and a bad-choice flag (exit 1); `--profile` naming a
retired profile (exit 1, no state written); `--mode pull-only --existing keep` (exit 1, no state written); an unknown
placeholder answered `2` on piped stdin, saved on the machine.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync setup-` (the new cases fail until steps 24 and 25).

## Step 24: Setup refusals in the flow `[worker]`

Files: `src/wizard/setup.ts`, `src/wizard/setup.test.ts`.

Refuse a retired profile (flag or typed) and pull-only with keep, before the outcome; the outcome carries
`replaced: boolean`, true for `--replace` and for the hostname suggestion taken.

Test: `bun test src/wizard && bun run lint`.

## Step 25: Setup writes and answers `[worker]`

Files: `src/main.ts`.

Write the profile before the record (the record marks the machine as set up), naming the file that failed; ask
unknown placeholders from piped stdin as the contract says (only `--yes` skips); ask machine values again when
`outcome.replaced`.

Test: `bun test src && bun run build && tests/parity/run.sh --engine dist/mksync setup-`.

## Step 26: Visibility hardening `[worker]`

Files: `src/adapters/visibility.ts`, `src/adapters/visibility.test.ts`.

`gh repo view github.com/<owner>/<repo>` (never another host); an owner starting with `-` is not parsed (public); an
SSH origin's host alias resolved with `ssh -G <host>` (its `hostname`), so an alias of `github.com` is asked as
github.com and never reads `MKSYNC_VISIBILITY`; a failing `ssh -G` on an SSH origin is public.

Test: `bun test src/adapters/visibility.test.ts && bun run lint`.

## Step 27: Guard and usage fixes `[worker]`

Files: `src/core/guard.ts`, `src/core/guard.test.ts`, `src/main.ts`, `src/cli/parse.ts`, `src/cli/parse.test.ts`.

The guard compares `profiles/` and `machines/` case-insensitively; the origin is the push URL
(`git remote get-url --push origin`); the usage line drops `export --force`.

Test: `bun test src/core/guard.test.ts src/cli && bun run build && tests/parity/run.sh --engine dist/mksync usage-line && tests/parity/run.sh --engine dist/mksync guard-`.

## Step 28: Docs `[inline: docs step, enriched per the docs rule]`

Files: `docs/sync-contract.md`, `docs/design-layers.md`, `docs/configuration.md`, `docs/layout.md`,
`docs/daily-workflow.md`, `docs/plan-single-engine.md`.

Contract: every line steps 3 to 27 rely on matches the program. Design: "As built in phase 6" under "Code layout"
(`core/machine/`, `core/guard.ts`, `adapters/store.ts`, `adapters/scan.ts`, `adapters/visibility.ts`, `wizard/`);
settled Open items out, what's left in. `configuration.md`: the record and profile files with a worked example;
`layout.md`: `machine.json` in the state folder; `daily-workflow.md`: running `dist/mksync setup` on a machine to
try the record before phase 8. Roadmap: phase 6 marked done with the PR.

Test: `grep -c '^\*\*Done' docs/plan-single-engine.md` grows by one; `npx prettier --check docs/plan-single-engine-6.md`.
