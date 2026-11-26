# Windows hotfix: public push name, statusline directory, `PATH`-only lookup (`v1.1.4`)

Found 2026-11-25 and 2026-11-26 on work #1 (`docs/plan-work-machines.md`, steps 3 to 6), after `v1.1.3`. The design
(`docs/design-layers.md`, "Open") requires all three fixes before work #2: `docs/plan-work-machines.md` stops at step 8
and resumes there once `v1.1.4` is released. Contract: `docs/sync-contract.md` ("The PR", "Statusline", "The
program"). Branch `engine/windows-hotfix`, cut from `engine/work-machines`, so its one PR also carries work #1's docs
commits; then release `v1.1.4`, and `engine/work-machines` starts again from `master`.

## The bugs

1. **The push branch names the hostname.** Push names its branch `sync/<os>-<record name>-<stamp>`
   (`src/app/commit.ts`, `resolveMachineAlias`), and setup names the record after the hostname. While the repo is
   public, a work machine's push publishes its hostname in the branch and the PR.
2. **Statusline directory on Windows.** `directoryName` (`src/core/statusline/format.ts`) takes the text after the last
   `/`, so Claude Code's Windows `cwd` (`C:\…\SyncSettings`) is printed in full.
3. **Commands found in the repo folder.** `run` and `runSync` (`src/adapters/process.ts`) pass a bare name to `spawn`.
   On Windows that searches the working folder first: on work #1 a `whoami.exe` copied into the clone as `git.exe` ran
   in place of git.

## Decided

1. **A public name in the record (user, 2026-11-26).** The record gets an optional `alias`, written right after `name`
   and only when it is set, so a record without one keeps the same bytes. Push names the branch
   `sync/<os>-<alias>-<stamp>`. A record with no `alias` is asked for one once, on the first push, and the answer is
   saved in the record (in the state folder, which is held while the repo is public). The prompt suggests the login
   (`os.userInfo().username`, without any `DOMAIN\` part) made into a valid alias: lowercased, each run of characters
   outside `a-z0-9` replaced by one `-`, with `-` trimmed from both ends, cut to 24 characters. The suggestion is left
   out when it is empty or equal to the hostname. The user chose the login as the suggestion knowing it is their real
   name.
2. **The hostname is never accepted (proposed, for review).** An answer equal to the record's `hostname`, or to the
   hostname up to its first dot, ignoring case, stops with
   `ERROR: '<answer>' is this machine's hostname; pick another public name.`, exit 1, and nothing is saved. A non-valid
   answer stops as it does now (`ERROR: invalid machine alias …`). An empty answer takes the suggestion, and with no
   suggestion it stops as a non-valid answer does.
3. **No terminal, no alias (proposed, for review).** As with today's git-config prompt, push without a terminal and
   with no `alias` in the record stops with
   `ERROR: machine <name> has no public name yet; run mksync push in a terminal to set one.`, exit 1, before any
   commit. No new flag or command: a work machine runs its first push from a terminal. Without a record, the
   `git config syncsettings.machine` fallback is unchanged.
4. **Statusline directory (proposed, for review).** The directory section is the text after the last `/` or `\`, with
   one trailing separator of either kind dropped first, on every OS. A Linux folder name holding a `\` is rare enough
   that splitting on both everywhere is worth it.
5. **`PATH` only (proposed, for review).** `run` and `runSync` resolve a bare name with `which` (the child's `env` when
   given, else `process.env`) and spawn the full path; not found gives the missing result (127), as a missing command
   does now. `which`'s search skips relative and empty `PATH` folders, so the working folder is never searched on any
   OS. A name holding a path separator is spawned as given, as now.

## Shared rules

- **Contract first** (CLAUDE.md rule 2): each concern's case comes before its code; `expect/` is written from the
  rules above, never from engine output. A case the code disagrees with is fixed in the code.
- **Never the real machine.** Cases run with a temp `HOME` and the `gh` stub; the Windows check runs in the local VM.
- The repo is public: fixtures use `example.com`, `/home/user`, `wk1-laptop`, alias `parity-alias`; `leak-scan` stays
  green.
- `tests/parity/run.sh` takes one substring filter: several filters run as a loop. Engine runs need `bun run build`
  first.
- Each step updates the contract section it changes. `tests/all.sh` runs once, before the PR (step 8).

## Step 1: Cases for the public name `[worker]`

Files: `tests/parity/cases/push-record-alias/`, `tests/parity/cases/push-record-no-alias/`.

Model both on `tests/parity/cases/push-front-opens-pr/` (`git: remote`, the `gh` stub, `push` with `yes`), with a record
and profile in `state/` as `tests/parity/cases/push-groups/` has them (`name` and `hostname` `wk1-laptop`, profile
`work-1`), and one changed `whole` entry:

- `push-record-alias`: the record has `"alias": "parity-alias"` right after `"name"`. Expect: exit 0; `gh.log` and
  stdout name the branch `sync/linux-parity-alias-` followed by the stamp (use the stamp the case runner already fixes
  for `push-front-opens-pr`); no `wk1-laptop` in `gh.log` apart from the PR body's `Profile:` line if the contract
  prints it there (it prints only the profile, so none is expected).
- `push-record-no-alias`: the record has no `alias`; stdin is not a terminal. Expect: exit 1; stderr
  `ERROR: machine wk1-laptop has no public name yet; run mksync push in a terminal to set one.`; no commit, no branch,
  no `gh.log` call; `state/machine.json` unchanged.

The `case.json` descriptions cite decisions 1 and 3 and the contract's "The PR".

Test: `for f in push-record-alias push-record-no-alias; do tests/parity/run.sh $f; done` fails now: the first for the
branch `sync/linux-wk1-laptop-…`, the second for exit 0 (not a fixture error).

## Step 2: The record's `alias` `[worker]`

Files: `src/core/machine/record.ts`, `src/core/machine/record.test.ts`.

- `MachineRecord` gets `readonly alias?: string`. `parseRecord` reads it: absent is fine; present, it must match
  `MACHINE_ALIAS` (`src/core/plan/commit.ts`), else the record error names the field, as other bad fields do.
- `recordValue` writes `["alias", …]` right after `["name", …]`, only when `alias` is set.
- Unit tests: a record without `alias` round-trips byte for byte; one with it writes `"alias"` as the second key; a bad
  alias (`Has Space`, 25 characters, a leading `-`) is refused by `parseRecord`.

Test: `bun test src/core/machine/record.test.ts && bun run lint`, all green.

## Step 3: Suggest and check the public name `[worker]`

Files: `src/core/plan/commit.ts`, `src/core/plan/commit.test.ts`.

- `suggestAlias(login: string, hostname: string): string | undefined`: drop everything up to the last `\` of `login`,
  then decision 1's rule; `undefined` when empty or equal to the hostname or its short form (ignoring case).
- `checkAlias(answer: string, record: { hostname: string }): { alias: string } | { error: string }`: decision 2's
  order: the hostname check first, then `MACHINE_ALIAS`, with the exact error lines of decision 2 and today's invalid
  alias line.
- Unit tests: `DOMAIN\Jane.Doe` gives `jane-doe`; `__x__` gives `x`; a 30-character login is cut to 24 with no trailing
  `-`; `***` gives `undefined`; a login equal to the hostname gives `undefined`; `checkAlias` refuses `WK1-LAPTOP` for
  hostname `wk1-laptop.example.com` with the hostname line, refuses `a b` with the invalid line, accepts `jane-doe`.

Test: `bun test src/core/plan/commit.test.ts && bun run lint`, all green.

## Step 4: Push asks once and saves it `[worker]`

Files: `src/app/commit.ts`, `src/app/commit.test.ts`, `docs/sync-contract.md`.

- `resolveMachineAlias` with a record: `record.alias` when set. Without one and no terminal: decision 3's error. With a
  terminal: ask `Public name for this machine's push branches [<suggestion>]: ` (no brackets without a suggestion) on
  stderr, check the answer with `checkAlias` (empty takes the suggestion), write the record back with `alias` set
  through the existing record writer, print `  Saved public name: <alias>` on stderr, and use it. The prompt reader is
  injectable for the unit test; the login comes from `os.userInfo().username` in the adapter, never from core.
- No record: unchanged (git config, then today's prompt).
- Unit tests: a record with `alias` uses it; without, no terminal, gives decision 3's error and writes nothing; with a
  stub terminal answering empty, the suggestion is saved and used; answering the hostname gives decision 2's error and
  writes nothing.
- Contract "The PR": the branch names the record's `alias`, asked once on the first push from a terminal, with decisions
  1 to 3; "Machine records" (wherever the record's fields are listed): the `alias` field.

Test: `bun test src/app && bun run lint && bun run build && for f in push-record push-front push-groups; do
tests/parity/run.sh --engine dist/mksync $f; done`, all green.

## Step 5: Statusline directory `[worker]`

Files: `tests/parity/cases/statusline-windows-dir/`, `src/core/statusline/format.ts`,
`src/core/statusline/format.test.ts`,
`docs/sync-contract.md`.

- Case first, modelled on `tests/parity/cases/statusline-full/` (`os` `["linux"]`, same env): stdin's `cwd` is
  `C:\\Users\\user\\parity-proj\\` (JSON-escaped). Expect the same line as `statusline-full` with directory
  `parity-proj`. Run it once before the code change and see it fail.
- `directoryName`: decision 4 (drop one trailing `/` or `\`, then the text after the last of either).
- Unit tests: `/a/b` gives `b`; `/a/b/` gives `b`; `C:\a\b` gives `b`; `C:\a\b\` gives `b`; `C:\` gives `C:`; `proj`
  gives `proj`.
- Contract "Statusline": the directory's last part, split on `/` or `\`.

Test: `bun test src/core/statusline && bun run lint && bun run build && tests/parity/run.sh --engine dist/mksync
statusline`, all green.

## Step 6: `PATH` only `[worker]`

Files: `src/adapters/process.ts`, `src/adapters/process.test.ts`, `docs/sync-contract.md`.

- Decision 5: `searchFolders` keeps only absolute folders (`path.isAbsolute`); `run` and `runSync` resolve a bare
  `file` with `which(file, options.env ?? process.env)` and spawn the result, returning `missingResult()` when it is
  `null`.
- Unit tests (POSIX, temp folders): an executable `mk-fake` in the `cwd` folder, not on `PATH`, gives `missing` from
  `run` and `runSync`; `PATH=.` with `cwd` holding it gives `missing`; the same file in an absolute `PATH` folder runs;
  `which` with `PATH` `rel:/abs` returns only the `/abs` match; a name with a `/` runs as given.
- Contract "The program": commands are found on `PATH` only, never in the working or repo folder; relative `PATH`
  folders are skipped.

Test: `bun test src/adapters/process.test.ts && bun run lint`, green. Then `bun test src` once: a caller relying on a
relative `PATH` (a test stub) shows up here; fix the stub's `PATH` to absolute, not the rule.

## Step 7: The Windows check `[inline: the VM run and its reading need judgment]`

Files: `tests/windows-vm/install-check.ps1` (or the VM case list the README names), `tests/windows-vm/README.md`.

- Add a VM check: build `dist/mksync.exe`, make a throwaway clone, copy `whoami.exe` into it as `git.exe`, run
  `mksync status` there; expect git's real output (no `Origin : not a git clone`). Statusline in the VM with a Windows
  `cwd` prints the last part.
- Run it in the VM (`tests/windows-vm/vm.sh status` is 0 today).

Test: the new VM check passes, and fails when step 6's change is reverted locally.

## Step 8: Docs, PR and release `v1.1.4` `[inline: release run and its verification need judgment]`

Files: `package.json`, `CHANGELOG.md`, the program's version (`rtk grep -rn '1\.1\.3' src package.json`),
`docs/design-layers.md`, `docs/plan-work-machines.md`, `docs/windows-cutover-run.md`, `README.md` if it shows the push
branch.

- Design "Open": the three items marked done for `v1.1.4`, with the decisions; the roadmap line for this hotfix.
- `docs/plan-work-machines.md`: steps 8 to 12 expect `1.1.4`; step 12 notes that work #1 and the Linux machine are
  asked for their public name on their next push.
- Bump to `1.1.4`; a changelog entry naming bugs 1 to 3.
- `tests/all.sh` (with the VM layer), `leak-scan`, review (`ts-code-reviewer`, and `ts-security-auditor` for step 6),
  push, PR, `reviewed` label, `pr-ready`, merge.
- Tag `v1.1.4` and release as `v1.1.3` was; check `SHA256SUMS` and `mksync --version`; `mksync update` on this machine.

Test: `npx prettier --check docs/*.md`, the release checks above, and `mksync --version` prints `1.1.4` here.
