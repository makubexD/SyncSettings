# Smart first run, phase 2: setup asks once, up front, with everything guessed (`v1.3.0`)

Roadmap: `docs/plan-smart-first-run.md` (phase 2: WIZ-1, WIZ-2's question at setup, WIZ-7, WIZ-11, a profile label, and the
wizard-standard gaps "Review", "`Same as:`" and "`--yes`" of the 2026-11-27 audit). Branch `engine/setup-asks-once`.
Contract: `docs/sync-contract.md` ("Setup": scan, answers, profile suggestion, summary and `Same as:`, confirm,
bootstrap, replace; "Sanitize and hydrate": when a suggestion may fill a value; "The PR": the public name). Design: `docs/design-layers.md` ("First run", the suggested answers, item 1).

The user said yes to this phase on 2026-11-27 ("choose the best option ... make it right and carefully"), after the
private switch was put on hold so that development finishes while the repo is public. The plan was reviewed by the
project's `wizard-auditor` the same day; its findings are folded into the decisions below.

**Breaking.** Setup guesses the profile, its value questions move before the confirm, and `setup --yes` takes guesses. Every step's test runs on stubs in throwaway folders, as the
shared cases do.

## Decided (proposed, for review)

1. **The profile guess** comes only from the scan, never from the domain's name, and only when no `--profile`,
   `--replace` or same-hostname record decides it:
   - Linux with no domain: `personal`.
   - A domain, or any OS that isn't Linux: a new profile `work<n>`. Only Windows reports a domain on a real machine
     (`USERDNSDOMAIN`); on Linux and macOS a domain comes only from `SYNC_DOMAIN`, which the shared cases set.
   - `<n>` is one more than the largest number of any profile named `work<n>` or `work-<n>` that this machine knows
     (repo profiles, retired ones included, and local ones), else 1. Retired profiles count so that a new profile
     never reuses a retired profile's file. The form `work<n>` (no dash) matches the profiles the work machines
     already use; the design's and the contract's examples change to match (test fixtures keep their names).
   - A line before question 1 names the guess and why, without the domain's name: `Guess: personal (Linux, no
domain).`, `Guess: new profile work<n> (Windows).`, `(macOS)`, `(Linux, joined to a domain)`. While the repo is
     public the work line adds `; other machines' profiles can't be seen while the repo is public, so check the
number`, because a fresh machine knows no other profile and guesses `work1`.
   - Interactive, the guess is question 1's suggestion and Enter takes it.
   - **`--yes` takes the guess only when it is `work<n>` and the repo is private.** A `personal` guess, or any guess
     while the repo is public, still stops with `ERROR: missing --profile`, exit 2, after the guess line. A wrong
     `personal` would put a work machine's settings in the shared layers; a wrong `work<n>` only keeps them out
     (`k`). `install.sh --yes` runs `setup --yes`, so it keeps stopping on a personal machine and asks for
     `--profile` as today.
   - Kept in design "Open": a work laptop running Linux with no domain is guessed `personal` interactively. The guess
     is printed before question 1, the summary shows the profile, and push keeps its preview, the leak scan and its
     `[y/N]`.
2. **The public name is not a question at setup.** It's guessed as `<profile>-<os>` (`suggestAlias`, as push does),
   shown in the summary as `Public name: <alias>` and saved in the record with it; `--alias <name>` sets it, checked
   with `checkAlias` before any question (its refusal, exit 2). On `--replace` the old record's alias is kept unless
   `--alias` is given. A pull-only machine gets none, and so does a refused guess (push asks later, as today).
   `push --yes` with a record that has no alias takes the guess without asking and prints `Saved public name:
<alias>` as today. With no terminal and no `--yes` it still stops with today's error.
3. **Bootstrap flags:** `--no-bootstrap` answers no without asking; `--yes` alone means no (today it still asks, a
   bug); `--bootstrap` with `--no-bootstrap` is `ERROR: --bootstrap and --no-bootstrap can't be used together`, exit 2. Off Ubuntu, where bootstrap isn't offered, `--no-bootstrap` is accepted and does nothing (`--bootstrap` keeps
   its refusal). When bootstrap is offered, `Same as:` ends with ` --bootstrap` or ` --no-bootstrap`.
4. **Values before the confirm.** After the linked-folder questions and before the summary, setup asks every value
   that this run's writes would ask: the import's (built from the chosen profile, record and entries while they are
   still in memory) and, for `keep`, the export's. Each is asked once, in the import's words, with its guess in
   brackets. The `.user-values.json` "kept on" question (only for placeholders the value table leaves as `ask`) and
   the `--replace` re-ask (decision 6) move there too. After the confirm setup asks nothing. The summary, in order:

   ```
   Machine <name>: profile <p>, <claude>, <mode>.
   Public name: <alias>
   Values:
     <YOUR_NAME> = Jane Doe (git-user-name)
     <YOUR_EMAIL> = jane@example.com (typed)
   Same as: mksync setup ...
   <guard block, when there is one>
   ```

   `Public name:` is left out when there is none, `Values:` when nothing was asked. The source in brackets is the
   `suggest` source that answered, `typed`, `--value`, `--value, replaces the saved value` or `old machine`. A
   declined or unanswered confirm writes nothing, values included. After a yes the values are saved with the record
   (placed by the value table, as today), before the import, the keep export and the bootstrap script run, so none of
   them asks again.

5. **`--value KEY=VALUE`** (repeatable) answers a value question without asking. `KEY` is the placeholder with or
   without its `<` `>` (`--value YOUR_NAME=Jane` and `--value '<YOUR_NAME>=Jane'` are the same), because a bare `<`
   is a shell redirect. Refusals, exit 2: a key no rule uses (`ERROR: --value <KEY>: no rule uses this
placeholder`), an empty value (`ERROR: --value <KEY>: empty value`), a value holding placeholder text (the typed
   value's refusal, word for word). `--value` also replaces a saved value, and the `Values:` block says so.
   `Same as:` prints ` --value KEY=VALUE` for every typed and `--value` answer (a guess reproduces itself). The whole
   token is quoted when it has a character outside `A-Za-z0-9._@/:+=-`: single quotes, with `'` written `'\''` on
   Linux and macOS and `''` on Windows (the Windows line targets PowerShell). A Windows value holding `"` is left out
   of `Same as:` with one line after it: `Same as: leaves out --value KEY (its value holds a ").`
6. **Replace (WIZ-11):** each machine value is asked with a fresh guess for this machine as the suggestion (its
   rule's `suggest` sources, then its `defaultEnv`), else the old machine's value (`old machine`).
7. **`setup --yes` asks nothing.** It takes the profile guess only as decision 1 allows, and it takes every value
   guess. This is the one place a suggestion fills a value without its prompt (beside `gh-path`'s default): the
   `Values:` block prints each one before anything is written, and the values stay on this machine. Push and pull
   under `--yes` still run no source. A value with no guess and no `--value` stops before anything is written:
   `ERROR: missing value for <KEY>; pass --value KEY=<value>`, exit 2 (a missing flag, as `missing --profile`).
   Interactive, end of input at a value never takes its guess: it stops with `ERROR: missing value for <KEY>`, exit 1,
   nothing written.
8. **A profile label** to find a profile quickly (asked 2026-11-27): an optional short note such as the employer's
   short name. It's a new optional profile key `label`, written after the existing keys: 1 to 30 characters of
   letters, digits, spaces and `.-_&`, no placeholder text (refused with exit 2 otherwise:
   `ERROR: --label: use 1 to 30 letters, digits, spaces or .-_&`). Setup asks it only when it creates a profile other
   than `personal`, after question 1: ` Label for <profile>, to find it in lists (optional):`; Enter or end of input
   leaves none, and `--yes` doesn't ask. `--label <text>` sets it without asking; with a profile that already exists it
   is `ERROR: --label names a new profile; <profile> already exists`, exit 2. It shows in setup's profile list
   (`  2) work1  (acme)`), in the summary (`profile work3 (acme)`), and in `Same as:` (` --label <text>`, quoted as
   `--value` is). It is private: it lives in the profile file, which stays in local state while the repo is public,
   and it never goes into a branch name, a commit message or a PR. Unlabelled profiles print as today. The user
   also decided (2026-11-27) that pull's `Apply these changes?` defaults to yes and push's PR question stays `[y/N]`;
   that change moves to phase 4 (help and messages) to keep this plan within 20 steps.
9. **Version `v1.3.0`,** not `v2.0.0`: the owner is the only user of the interface, the changes take fewer answers,
   and scripts already pass `--yes`. `CHANGELOG.md` lists the changes under "Changed".

## Step 1: Contract and design `[inline: contract wording]`

Files: `docs/sync-contract.md`, `docs/design-layers.md`.

- Contract "Setup": the profile guess, its line and `--yes` (decision 1); `Public name:` and `--alias` (2); the
  bootstrap flags (3); the values before the summary, the summary's order and "after the confirm setup asks nothing"
  (4); `--value` and its refusals (5); replace's fresh guess (6); `--yes` and end of input (7); the profile label (8); the usage line with
  `--alias`, `--label`, `--value`, `--bootstrap`, `--no-bootstrap`. Rewrite "Values after the answers", "Answers" and "No
  suggestion" (the lines that say value questions come after the confirm, that there is no profile suggestion before
  the switch, and that end of input takes a setup suggestion for a value). Examples use `work<n>`.
- Contract "Sanitize and hydrate": the paragraph saying a suggestion is never used without its prompt names setup's
  `--yes` as the exception, with decision 7's reason.
- Contract "The PR": `push --yes` takes the public-name guess (2).
- Design "First run", item 1: the guess replaces "no suggestion and no scoring" for the no-match case; the hostname
  match still comes first; examples use `work<n>`. "Open": the Linux-work-laptop risk and the public-repo numbering
  (decision 1), and the roadmap's leftovers this phase doesn't take (back navigation `<`, the public-name check
  moved before push's export).

Test: `npx prettier --check docs/sync-contract.md docs/design-layers.md`; `grep -n "no scoring" docs/design-layers.md`
prints nothing.

## Step 2: Shared cases for the profile guess `[worker]`

Files: `tests/parity/cases/setup-guess-personal/`, `tests/parity/cases/setup-guess-work-domain/`,
`tests/parity/cases/setup-yes-guess-personal/`, `tests/parity/cases/setup-yes-guess-work/`.

Write each case's `expect/` from the contract (step 1), not from the program's output. All four are `os` linux (a
case for another OS is skipped on this machine); the non-Linux guesses are unit tests in step 3.

- `setup-guess-personal`: no `SYNC_DOMAIN`, public, no local profiles, stdin Enter at question 1 then the other
  answers. Expect `Guess: personal (Linux, no domain).` before question 1, the question ending `[1] `, the record's
  profile `personal`, exit 0.
- `setup-guess-work-domain`: `SYNC_DOMAIN=corp.example`, public, a local profile `work-3`. Expect
  `Guess: new profile work4 (Linux, joined to a domain); other machines' profiles can't be seen while the repo is
public, so check the number`, the question ending `[work4] `, `expect/state/profiles/work4.json`, exit 0;
  `corp.example` appears only in the scan's `Domain` line.
- `setup-yes-guess-personal`: `setup --yes --name <n>`, no `--profile`, no domain. Expect the guess line, then
  `ERROR: missing --profile`, exit 2, no `machine.json`. This is what `install.sh --yes` runs.
- `setup-yes-guess-work`: `MKSYNC_VISIBILITY=private`, `SYNC_DOMAIN=corp.example`, the repo holding profiles
  `work1` and a retired `work2`, `setup --yes --name <n>`. Expect `Guess: new profile work3 (Linux, joined to a
domain).`, no question 1, profile `work3`, exit 0.
- Existing cases that expected `ERROR: missing --profile` under `--yes` (for example `setup-missing-flag`) keep it
  when the decision 1 rule still refuses; their output gains the guess line. Update their `expect/` from the contract
  and name each in the commit message.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync "setup-guess|setup-yes-guess"` reports 4 failed and
0 skipped (no guess line yet).

## Step 3: Setup guesses the profile `[worker]`

Files: `src/wizard/setup.ts`, `src/wizard/setup.test.ts`.

- A pure `guessProfile(scan, knownProfiles, visibility)` returning `{ name, reason, takenByYes }` (decision 1).
  `knownProfiles` is every profile name the store and local state hold, retired ones included; the listed profiles
  stay as they are.
- In `runSetup`, when `profileName` is undefined after `--replace` and `--profile`, and `hostnameMatch` gives nothing,
  print the guess line and ask question 1 with the guess as its suggestion. `ask` takes a suggestion that is a list
  number or a new profile name: the prompt shows `[<n>]` for a listed profile and `[<name>]` for a new one, and Enter
  returns it. Under `--yes` take the guess only when `takenByYes`, else stop with `ERROR: missing --profile`, exit 2.
- Unit tests: `personal` on linux without a domain; `work1` with a domain; `work1` on windows and on macos with no
  domain; the next number past `work1`, `work-3` and a retired `work4` is `work5`; `workbench` and `work-x` don't
  count; the public note only when public; `takenByYes` only for `work<n>` and private; the hostname match still wins.

Test: `bun test src/wizard/setup.test.ts` passes; step 2's cases pass.

## Step 4: Shared cases for the public name `[worker]`

Files: `tests/parity/cases/setup-alias-guess/`, `tests/parity/cases/setup-alias-flag/`,
`tests/parity/cases/setup-alias-bad/`, `tests/parity/cases/push-yes-alias-guess/`.

All `os` linux.

- `setup-alias-guess`: interactive setup, `--profile work1`, mode push. Expect `Public name: work1-linux` after the
  `Machine …` line, ` --alias work1-linux` in `Same as:`, `"alias": "work1-linux"` in `expect/state/machine.json`.
- `setup-alias-flag`: `--alias desk-a`. Expect `Public name: desk-a` and the alias saved.
- `setup-alias-bad`: `--alias` set to the case's `SYNC_HOSTNAME`. Expect `checkAlias`'s hostname refusal word for
  word, exit 2, no question asked, no `machine.json`.
- `push-yes-alias-guess`: a record with profile `work1` and no alias, `push --yes`. Expect `Saved public name:
work1-linux`, the alias in the record, and the branch `sync/linux-work1-linux-<stamp>` in `gh.log` (the stamp
  masked as the runner masks it today), exit 0.
- Existing setup cases in push mode gain the `Public name:` line and ` --alias` in `Same as:`; pull-only ones
  don't. Update their `expect/` from the contract and name each in the commit message.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync "setup-alias|push-yes-alias"` reports 4 failed and 0
skipped.

## Step 5: `--alias` and the guessed public name at setup `[worker]`

Files: `src/cli/parse.ts`, `src/cli/parse.test.ts`, `src/wizard/setup.ts`, `src/wizard/setup.test.ts`.

- `--alias <name>` in setup's value flags and `SetupFlags`, checked with `checkAlias` before any question (exit 2).
- `runSetup` puts the alias in the record it returns (decision 2) and prints `Public name: <alias>` after the
  `Machine …` line; `Same as:` adds ` --alias <alias>` after `--existing`.
- Unit tests: the flag parses; a bad alias exits 2 before any question; the guess; the flag; a kept replace alias;
  `--alias` over a kept one; pull-only with none; a refused guess with none.

Test: `bun test src/cli/parse.test.ts src/wizard/setup.test.ts` passes; the `setup-alias` cases pass.

## Step 6: Shared cases for the profile label `[worker]`

Files: `tests/parity/cases/setup-label-asked/`, `tests/parity/cases/setup-label-flag/`,
`tests/parity/cases/setup-label-listed/`, `tests/parity/cases/setup-label-existing/`.

All `os` linux, written from the contract (decision 8).

- `setup-label-asked`: `SYNC_DOMAIN=corp.example`, public, no local profiles; stdin Enter at question 1 (the guess
  `work1`), `acme` at the label question, then the other answers. Expect ` Label for work1, to find it in lists
(optional):` right after question 1, `profile work1 (acme)` in the summary, ` --label acme` in `Same as:`,
  `"label": "acme"` in `expect/state/profiles/work1.json` after its other keys, exit 0.
- `setup-label-flag`: `--profile work5 --label "Big Co"`. Expect no label question, `profile work5 (Big Co)`,
  `--label 'Big Co'` in `Same as:`. A second command with `--profile work6 --label "a/b"` expects
  `ERROR: --label: use 1 to 30 letters, digits, spaces or .-_&`, exit 2, no `work6.json`.
- `setup-label-listed`: local profiles `work1` with label `acme` and `work2` with none. Expect the list lines
  `  2) work1  (acme)` and `  3) work2`.
- `setup-label-existing`: a local profile `work1`, `--profile work1 --label acme`. Expect
  `ERROR: --label names a new profile; work1 already exists`, exit 2, nothing written.
- No existing case changes: a profile without a label prints as today, and `personal` is never asked.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync "setup-label"` reports 4 failed and 0 skipped.

## Step 7: The profile file and the parser learn the label `[worker]`

Files: `src/core/config/profile.ts`, `src/core/config/profile.test.ts`, `src/cli/parse.ts`, `src/cli/parse.test.ts`.

- `Profile` gets `label?: string`, read and written as the last key; a label that breaks decision 8's character rule
  is refused when the profile is read (the error the other profile fields use) and by the parser.
- `--label <text>` in setup's value flags and `SetupFlags`, checked with decision 8's line (exit 2).
- Unit tests: a profile with and without a label round-trips byte for byte; a bad label is refused on read; the flag
  parses; a 31-character, an empty and a `/` label exit 2.

Test: `bun test src/core/config/profile.test.ts src/cli/parse.test.ts` passes.

## Step 8: Setup asks, lists and shows the label `[worker]`

Files: `src/wizard/setup.ts`, `src/wizard/setup.test.ts`.

- `renderProfiles` adds `  (<label>)` after a labelled profile; the label question follows question 1 only when the
  profile is new and not `personal`, and not under `--yes` or `--label`; `--label` with an existing profile stops with
  decision 8's line before any question; the summary prints `profile <p> (<label>)`; `Same as:` adds ` --label <text>`
  after `--profile <p>`, quoted as decision 5 says.
- Unit tests: asked for a new work profile, not for `personal`, not for an existing one; Enter and end of input leave
  none; `--yes` doesn't ask; `--label` with an existing profile exits 2 before any question; the list, summary and
  `Same as:` with and without a label.

Test: `bun test src/wizard/setup.test.ts` passes; step 6's cases pass.

## Step 9: `commit` learns `--yes` from push `[worker]`

Files: `src/cli/parse.ts`, `src/main.ts`, `src/app/push.ts`, `src/cli/parse.test.ts`.

- `CommitCommand` gets `yes: boolean`; a `commit` parsed on its own keeps `yes: false`, and push passes its
  own `--yes` through `runCommit` (`src/app/push.ts`, `src/main.ts`). No behavior changes in this step.
- Unit test: a parsed `commit` has `yes: false`.

Test: `bun test src/cli/parse.test.ts src/app/push.test.ts` passes; `bun run lint`.

## Step 10: Push takes the public-name guess under `--yes` `[worker]`

Files: `src/app/commit.ts`, `src/app/commit.test.ts`.

- `resolveMachineAlias`: with `yes` and no alias in the record, take `suggestAlias(...)` without asking, save it and
  print `Saved public name: <alias>` as today. With no guess, or with no terminal and no `yes`, today's
  `noPublicNameError` stays.
- Unit tests: `yes` takes the guess and never calls `askAlias`; a terminal without `yes` still asks; no terminal
  without `yes` still errors; `yes` with no guess still errors.

Test: `bun test src/app/commit.test.ts` passes; `tests/parity/run.sh --engine dist/mksync push-yes-alias-guess`
passes.

## Step 11: Shared cases for the bootstrap flags `[worker]`

Files: `tests/parity/cases/setup-no-bootstrap/`, `tests/parity/cases/setup-yes-no-bootstrap/`,
`tests/parity/cases/setup-bootstrap-both/`, `tests/parity/cases/setup-bootstrap-question/`.

- `setup-no-bootstrap`: linux, bootstrap offered, `--no-bootstrap`. Expect no bootstrap question, ` --no-bootstrap`
  at the end of `Same as:`, and no bootstrap run (the stubs' log has no `apt-get`).
- `setup-yes-no-bootstrap`: `--yes --profile personal`, bootstrap offered, stdin empty. Expect no bootstrap question
  and ` --no-bootstrap` (today the question prints).
- `setup-bootstrap-both`: `--bootstrap --no-bootstrap`. Expect `ERROR: --bootstrap and --no-bootstrap can't be used
together`, exit 2, nothing written.
- `setup-bootstrap-question` (existing): answered `n`, its `Same as:` now ends with ` --no-bootstrap`.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync "setup-no-bootstrap|setup-yes-no-bootstrap|setup-bootstrap-both|setup-bootstrap-question"`
reports 4 failed and 0 skipped.

## Step 12: The bootstrap flags `[worker]`

Files: `src/cli/parse.ts`, `src/cli/parse.test.ts`, `src/wizard/setup.ts`, `src/wizard/setup.test.ts`.

- `--no-bootstrap` boolean; both flags together exit 2 with decision 3's line; accepted off Ubuntu.
- The bootstrap question is skipped under `--yes` and `--no-bootstrap` (answer no); `Same as:` prints the answer's
  flag whenever bootstrap was offered.
- Unit tests: `--yes` never reads stdin for bootstrap; `--no-bootstrap`; both flags; off Ubuntu; `Same as:` for yes,
  no, and not offered.

Test: `bun test src/cli/parse.test.ts src/wizard/setup.test.ts` passes; step 11's cases pass.

## Step 13: Suggestions say which source answered `[worker]`

Files: `src/adapters/suggest.ts`, `src/adapters/suggest.test.ts`.

- A `suggestionSources(rules, context)` returning, per placeholder, `{ value, source }` for the first source that
  answered; `suggestions()` keeps its signature and maps it to values, so no caller changes in this step.
- Unit tests: the source of a first answer, of a fallback answer, none when nothing answers; `suggestions()` returns
  the same values as before.

Test: `bun test src/adapters/suggest.test.ts` passes.

## Step 14: Shared cases for values before the confirm `[worker]`

Files: `tests/parity/cases/setup-values-before-confirm/`, `tests/parity/cases/setup-values-declined/`,
`tests/parity/cases/setup-value-flag/`, `tests/parity/cases/setup-yes-missing-value/`.

All `os` linux. Value questions are in the import's words; copy the wording from `setup-value-asked`'s current
`expect/output.txt`.

- `setup-values-before-confirm`: one rule with `suggest: ["git-user-name"]` (the git stub answers `Jane Doe`) and one
  with no source. stdin: the four answers, Enter at the first value, `jane@example.com` at the second, Enter at the
  confirm. Expect both questions before `Machine …`, the summary in decision 4's order with `(git-user-name)` and
  `(typed)`, ` --value YOUR_EMAIL=jane@example.com` in `Same as:`, no question after the confirm, both values hydrated
  in the imported file, exit 0.
- `setup-values-declined`: the same, `n` at the confirm. Expect `Stopped: nothing was written.`, no `machine.json`,
  no profile file, no saved values, the exit `setup-confirm-declined` expects today.
- `setup-value-flag`: `--yes --profile personal --value YOUR_EMAIL=jane@example.com --value "YOUR_NAME=Jane Doe"`.
  Expect no question, `(--value)` for both, `Same as:` holding `--value 'YOUR_NAME=Jane Doe'`, exit 0. A second
  command, `--value NOT_A_KEY=x`, expects `ERROR: --value NOT_A_KEY: no rule uses this placeholder`, exit 2.
- `setup-yes-missing-value`: `--yes --profile personal`, a rule with no source and no `--value`. Expect
  `ERROR: missing value for <YOUR_EMAIL>; pass --value YOUR_EMAIL=<value>`, exit 2, no `machine.json`.
- Existing `setup-value-asked`, `setup-values-piped`, `setup-values-move`, `setup-values-unknown`,
  `setup-answer-trimmed`, `setup-bootstrap-keep`, `setup-keep-*`: their value lines move before the summary and gain
  the `Values:` block. Update their `expect/` from the contract and name each in the commit message.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync "setup-values-before-confirm|setup-values-declined|setup-value-flag|setup-yes-missing-value"`
reports 4 failed and 0 skipped.

## Step 15: The import's value questions from layers in memory `[worker:high: reasoning: the questions come from a snapshot that buildRun reads from disk, and setup must get the same list from a record, profile and entries that exist only in memory, without changing what pull and import ask]`

Files: `src/adapters/snapshot.ts`, `src/core/plan/import.ts`, `src/app/import.ts`, `src/core/plan/import.test.ts`.

- A way to build the import's snapshot from in-memory layers (record, profile, linked-folder entries) instead of the
  store on disk, and a function returning `importValueQuestions` for it: each missing placeholder after inference,
  rule defaults and `defaultEnv`, with its question text. Pull and import keep reading from disk through the same
  code.
- Unit tests: the in-memory list equals the on-disk list for the same layers; a value inferred from local files or a
  `defaultEnv` isn't listed; a value already in the record or profile isn't listed.

Test: `bun test src/core/plan/import.test.ts src/app/import.test.ts` passes.

## Step 16: Setup asks the values before the summary `[worker]`

Files: `src/wizard/setup.ts`, `src/wizard/setup.test.ts`, `src/app/setup.ts`, `src/app/export.ts`.

- `runSetup` gets a dependency that, given the chosen profile, record, entries, mode and action, returns the value
  questions this run would ask: step 15's list, plus for `keep` the export's missing values for the same layers
  (from `src/app/export.ts`, the list `askExportValues` asks today), deduped by placeholder, each with its guess and
  source from step 13, plus the "kept on" question for `.user-values.json` placeholders the value table leaves as
  `ask`.
- `runSetup` asks them after the linked-folder questions (`--yes`: decision 7; end of input: decision 7), prints the
  summary in decision 4's order, and returns the answers with the record. `src/app/setup.ts` wires the dependency
  only; the writes don't change in this step.
- Unit tests: the questions come before the summary; `--yes` takes a guess and stops on a missing one before
  returning a record; end of input never takes a guess; a value already saved isn't asked; the `Values:` sources.

Test: `bun test src/wizard/setup.test.ts` passes.

## Step 17: Setup writes the answers after the confirm `[worker]`

Files: `src/app/setup.ts`, `src/app/setup.test.ts`.

- `executeSetup` saves the answers with the record and profile after the confirm, placed by the value table, before
  `exportKeep`, `importAfterSetup` and the bootstrap script run; the old `valueAnswers` and `replaceValues` calls
  after the confirm go (their questions are in step 16's list). Nothing is saved on a decline or end of input.
- Unit tests: a decline saves nothing; the import, the keep export and the bootstrap path ask nothing after the
  confirm; a value placed on the machine goes to the record, one placed on the profile to the profile.

Test: `bun test src/app/setup.test.ts` passes; step 14's cases and `setup-bootstrap-keep` pass.

## Step 18: `--value` `[worker]`

Files: `src/cli/parse.ts`, `src/cli/parse.test.ts`, `src/wizard/setup.ts`, `src/wizard/setup.test.ts`.

- `--value KEY=VALUE`, repeatable, the key with or without `<` `>`; the refusals in decision 5 (the unknown key is
  checked against the config's rules in `runSetup`, the others in the parser).
- `Same as:` prints ` --value KEY=VALUE` for typed and `--value` answers, the whole token quoted per decision 5
  (Windows quoting when the run's OS is windows, and the leave-out line for a `"`).
- Unit tests: both key forms; an empty value; placeholder text; an unknown key; a saved value replaced and marked;
  quoting a value with a space and with a `'` on linux and on windows; a `"` on windows; a guessed value left out of
  `Same as:`.

Test: `bun test src/cli/parse.test.ts src/wizard/setup.test.ts` passes; `tests/parity/run.sh --engine dist/mksync
setup-value-flag` passes.

## Step 19: The replace guess `[worker]`

Files: `tests/parity/cases/setup-replace-fresh-guess/`, `tests/parity/cases/setup-replace-public/`,
`src/app/setup.ts`, `src/app/setup.test.ts`.

The cases first, their `expect/` from the contract, and run once to see them fail; then the code.

- `setup-replace-fresh-guess` (`os` linux): an old record with `<GH_CLI_PATH>` = `/old/bin/gh` and a `gh` stub on
  this machine's `PATH`; `--replace <old>`, Enter at the value. Expect the question with this machine's `gh` path in
  brackets, `(gh-path)` in the `Values:` block, the new path in the record.
- `setup-replace-public` (existing): the re-ask moves before the summary; a value with no source still suggests the
  old one, `(old machine)`. Update its `expect/` from the contract.

- In step 16's dependency, a taken-over machine value's suggestion is this machine's guess (its rule's sources, then
  `defaultEnv`), else the old value with the source `old machine`; `--yes` takes it.
- Unit tests: a fresh guess wins; no source keeps the old value; `--yes` takes the fresh guess.

Test: `bun test src/app/setup.test.ts` passes; `tests/parity/run.sh --engine dist/mksync "setup-replace-fresh-guess|setup-replace-public"`
passes (and failed before the code change).

## Step 20: Docs, changelog and version `[inline: user-facing docs]`

Files: `README.md`, `docs/daily-workflow.md`, `docs/windows-cutover-run.md`, `docs/plan-work-machines.md`,
`install.sh`, `CHANGELOG.md`, `package.json`, `docs/plan-smart-first-run.md`.

- README and daily workflow: a first run on a new machine takes Enter at each guess, an unattended one needs
  `--profile` and `--value`, and the `Same as:` line repeats it.
- The runbooks' `missing --profile` lines, and `install.sh`'s help text for `--yes`.
- `CHANGELOG.md` `v1.3.0` under "Changed" (decisions 1 to 8), `package.json` `1.3.0`.
- Roadmap: phase 2 **Done** with the date and PR; phase 3 next.

Test: `npx prettier --check README.md docs/*.md CHANGELOG.md`; `bun run lint`; `shellcheck install.sh`.
