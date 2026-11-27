# Smart first run, phase 2: setup asks once, up front, with everything guessed (`v1.3.0`)

Roadmap: `docs/plan-smart-first-run.md` (phase 2: WIZ-1, WIZ-2's question at setup, WIZ-7, WIZ-10, WIZ-11, and the
wizard-standard gaps "Review", "`Same as:`" and "`--yes`" of the 2026-11-27 audit). Branch `engine/setup-asks-once`.
Contract: `docs/sync-contract.md` ("Setup": scan, answers, profile suggestion, summary and `Same as:`, confirm,
bootstrap, replace; "The PR": the public name; pull's and push's confirms). Design: `docs/design-layers.md` ("First
run", the suggested answers, item 1).

The user said yes to this phase on 2026-11-27 ("choose the best option ... make it right and carefully"), after the
private switch was put on hold so that development finishes while the repo is public.

**Breaking.** `setup --yes` without `--profile` starts succeeding; Enter at pull's `Apply these changes?` and at push's
PR question starts meaning yes; value questions move before setup's confirm. Every step's test runs on stubs in
throwaway folders, as the shared cases do.

## Decided (proposed, for review)

1. **The profile guess** comes only from the scan, never from the domain's name, and only when no `--profile`,
   `--replace` or same-hostname record decides it:
   - Linux with no domain: `personal`.
   - A domain (Windows `USERDNSDOMAIN`, `SYNC_DOMAIN` in tests), or any OS that isn't Linux: a new profile `work<n>`.
     `<n>` is one more than the largest number of any profile named `work<n>` or `work-<n>` that this machine knows
     (repo profiles, retired ones included, and local ones), else 1. Retired profiles count so that a new profile never
     reuses a retired profile's file.
   - The form `work<n>` (no dash) matches the profiles the work machines already use; the design's examples
     (`work-1`) are changed to match.
   - A line before question 1 names the guess and why, without the domain's name: `Guess: personal (Linux, no
domain).` or `Guess: new profile work<n> (Windows).`, `(macOS)`, `(Linux, joined to a domain)`. It prints under
     `--yes` too, where question 1 isn't asked.
   - Risk, kept in design "Open": a work laptop running Linux with no domain is guessed `personal`. The guess is
     shown before anything is written, push still shows its preview and runs the leak scan, and `--profile` decides.
2. **The public name is not a question at setup.** It's guessed as `<profile>-<os>` (phase 1's `suggestAlias`),
   shown in the summary as `Public name: <alias>` and saved in the record with it; `--alias <name>` sets it (checked
   with `checkAlias`, exit 2 on a refusal). On `--replace` the old record's alias is kept unless `--alias` is given.
   A pull-only machine gets no alias. Push still asks when the record has none; under `--yes`, or with no terminal,
   push takes the guess instead of stopping, and says `Saved public name: <alias>` as today.
3. **Bootstrap flags:** `--no-bootstrap` answers no without asking; `--yes` alone means no; `--bootstrap` with
   `--no-bootstrap` is `ERROR: --bootstrap and --no-bootstrap can't be used together`, exit 2. When bootstrap is
   offered, `Same as:` ends with ` --bootstrap` or ` --no-bootstrap`.
4. **Values before the confirm.** After the linked-folder questions and before the summary, setup asks every value
   that this run's writes would ask (the import, and the export for `keep`), each once, in the import's words, with
   the guess in brackets. The "kept on" question and the `--replace` re-ask (decision 6) move there too. After the
   confirm setup asks nothing. The summary lists what was asked:

   ```
   Values:
     <YOUR_NAME> = Jane Doe (git-user-name)
     <YOUR_EMAIL> = jane@example.com (typed)
   ```

   The source in brackets is the `suggest` source that answered, `typed`, `--value`, or `old machine`. Values
   already saved aren't listed. A declined or unanswered confirm writes nothing, values included. After a yes the
   values are saved with the record (machine values in the record, profile values in the profile, as today), then the
   import runs and finds nothing to ask.

5. **`--value KEY=VALUE`** (repeatable) answers a value question without asking. `KEY` is the placeholder with or
   without its `<` `>` (`--value YOUR_NAME=Jane` and `--value '<YOUR_NAME>=Jane'` are the same), because a bare `<`
   is a shell redirect. Refusals, exit 2: a key no rule uses (`ERROR: --value <KEY>: no rule uses this
placeholder`), an empty value (`ERROR: --value <KEY>: empty value`), a value holding placeholder text (the typed
   value's refusal, word for word). `--value` also replaces a value already saved. `Same as:` prints
   ` --value KEY=VALUE` for typed answers only (a guess reproduces itself), quoted when the value has a character
   outside `A-Za-z0-9._@/:+-`: in single quotes, with `'` written `'\''` on Linux and macOS and `''` on Windows.
6. **Replace (WIZ-11):** each machine value is asked with a fresh guess for this machine as the suggestion (its rule's
   `suggest` sources, or its `defaultEnv`), else the old machine's value. `--yes` takes that suggestion.
7. **`setup --yes`** asks nothing: it takes every guess. A value with no guess and no `--value` stops before anything
   is written: `ERROR: missing value for <KEY>; pass --value KEY=<value>`, exit 2 (a missing flag, as
   `missing --profile`). Interactive, end of input at a value with no guess stops the same way, exit 1, nothing
   written.
8. **Confirms (WIZ-10):** pull's `Apply these changes? [Y/n] ` (the guard already refused every `OUT` and `BOTH`
   file, so only `IN` changes are left); push's `Open a PR with these changes? [Y/n] ` when nothing was left out, and
   `[y/N]` as today when an `IN` file was skipped or `--force` went past a `BOTH` file. Enter is yes at `[Y/n]`, `n`
   is no, and end of input is always no. The no-sync-point questions keep `[y/N]`.
9. **Version `v1.3.0`,** not `v2.0.0`: the owner is the only user of the interface, the changes take fewer answers,
   and scripts already pass `--yes`. `CHANGELOG.md` lists the changes under "Changed".

## Step 1: Contract and design `[inline: contract wording]`

Files: `docs/sync-contract.md`, `docs/design-layers.md`.

- Contract "Setup": the profile guess and its line (decision 1), `Public name:` in the summary and `--alias`
  (2), the bootstrap flags (3), the values block before the summary and "after the confirm setup asks nothing"
  (4), `--value` and its refusals (5), replace's fresh guess (6), `--yes` (7), the usage line with `--alias`,
  `--value`, `--bootstrap`, `--no-bootstrap`. Rewrite the lines that say value questions come after the confirm and
  that there is no profile suggestion before the switch.
- Contract "The PR": push under `--yes` or with no terminal takes the public-name guess (2). Pull's and push's
  confirms (8), in the table and the text.
- Design "First run", item 1: the guess replaces "no suggestion and no scoring" for the no-match case; the hostname
  match still comes first. Examples use `work<n>`. "Open": the Linux-work-laptop risk (decision 1), and the
  roadmap's leftovers this phase doesn't take (back navigation `<`, the public-name check moved before push's export).

Test: `npx prettier --check docs/sync-contract.md docs/design-layers.md`; `grep -n "no suggestion and no scoring"
docs/design-layers.md` prints nothing.

## Step 2: Shared cases for the profile guess `[worker]`

Files: `tests/parity/cases/setup-guess-personal/`, `tests/parity/cases/setup-guess-work-domain/`,
`tests/parity/cases/setup-guess-work-next/`, `tests/parity/cases/setup-yes-guess/`.

Write each case's `expect/` from the contract (step 1), not from the program's output:

- `setup-guess-personal`: `os` linux, no `SYNC_DOMAIN`, no local profiles, stdin Enter at question 1 then the other
  answers. Expect `Guess: personal (Linux, no domain).` before question 1, the question ending `[1] `, the record's
  profile `personal`, exit 0.
- `setup-guess-work-domain`: `os` linux, `SYNC_DOMAIN=corp.example`. Expect `Guess: new profile work1 (Linux,
joined to a domain).`, the question ending `[work1] `, `expect/state/profiles/work1.json`, exit 0; `corp.example`
  appears nowhere in `output.txt`.
- `setup-guess-work-next`: `os` windows, local profiles `work1` and `work-3` and a retired `work4`. Expect
  `Guess: new profile work5 (Windows).` and the profile `work5`.
- `setup-yes-guess`: `setup --yes --name <n>` with no `--profile` on linux, no domain. Expect the guess line, no
  question 1, profile `personal`, exit 0.
- Existing cases that expected `ERROR: missing --profile` under `--yes` with no match (for example
  `setup-missing-flag`): change their `expect/` to the guess, or give them `--profile` where the case tests
  something else. Name each changed case in the commit message.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync "setup-guess|setup-yes-guess"` fails (no guess line).

## Step 3: Setup guesses the profile `[worker]`

Files: `src/wizard/setup.ts`, `src/wizard/setup.test.ts`.

- A pure `guessProfile(scan, knownProfiles)` returning `{ name, reason }` (decision 1). `knownProfiles` is every
  profile name the store and local state hold, retired ones included; the listed profiles stay as they are.
- In `runSetup`, when `profileName` is undefined after `--replace` and `--profile`, and `hostnameMatch` gives nothing,
  use the guess: print the guess line, then ask question 1 with the guess as the suggestion. `ask` takes a suggestion
  that is a list number or a new profile name: the prompt shows `[<n>]` for a listed profile and `[<name>]` for a new
  one, and Enter returns it. Under `--yes` take the guess without asking; `ERROR: missing --profile` stays only for
  the path where no guess exists (none, after this step, but keep the guard).
- Unit tests: personal on linux without a domain; `work1` with a domain; `work1` on windows and on macos with no
  domain; the next number past `work1`, `work-3` and a retired `work4` is `work5`; a profile named `workbench` doesn't
  count; the hostname match still wins over the guess.

Test: `bun test src/wizard/setup.test.ts` passes; step 2's cases pass.

## Step 4: Shared cases for the public name at setup `[worker]`

Files: `tests/parity/cases/setup-alias-guess/`, `tests/parity/cases/setup-alias-flag/`,
`tests/parity/cases/setup-alias-bad/`, `tests/parity/cases/push-yes-alias-guess/`.

- `setup-alias-guess`: interactive setup, profile `work1`, os windows, mode push. Expect `Public name:
work1-windows` in the summary before `Same as:`, `--alias work1-windows` in `Same as:`, `"alias": "work1-windows"`
  in `expect/state/machine.json`.
- `setup-alias-flag`: `--alias desk-a`. Expect `Public name: desk-a` and the alias saved.
- `setup-alias-bad`: `--alias` set to the case's `SYNC_HOSTNAME`. Expect `checkAlias`'s refusal for the hostname,
  exit 2, no `machine.json`.
- `push-yes-alias-guess`: a record with no alias, `push --yes` with no terminal. Expect `Saved public name:
<profile>-<os>` and the branch `sync/<os>-<profile>-<os>-<stamp>` in `gh.log` (the stamp masked as the runner
  masks it today), exit 0.
- Existing setup cases in push mode gain the `Public name:` line and ` --alias` in `Same as:`; pull-only ones don't.
  Update their `expect/` from the contract and name each in the commit message.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync "setup-alias|push-yes-alias"` fails.

## Step 5: `--alias` and the guessed public name at setup `[worker]`

Files: `src/cli/parse.ts`, `src/cli/parse.test.ts`, `src/wizard/setup.ts`, `src/wizard/setup.test.ts`.

- `--alias <name>` in setup's value flags and `SetupFlags`; checked with `checkAlias` before any question (exit 2).
- `runSetup` puts the alias in the record it returns (decision 2) and prints `Public name: <alias>` after the
  `Machine …` line; `Same as:` adds ` --alias <alias>` after `--existing`. No alias when the mode is pull-only or the
  guess is refused.
- Unit tests: the flag parses; a bad alias exits 2; the guess, the flag, a kept replace alias, pull-only with none.

Test: `bun test src/cli/parse.test.ts src/wizard/setup.test.ts` passes; the `setup-alias` cases pass.

## Step 6: Push takes the public-name guess under `--yes` `[worker]`

Files: `src/app/commit.ts`, `src/app/commit.test.ts`.

- `resolveMachineAlias`: when the record has no alias and the run has `--yes`, or `askOnTerminal` has no terminal,
  take `suggestAlias(...)` without asking, save it and print `Saved public name: <alias>` as today. With no guess, the
  current `noPublicNameError` stays.
- Unit tests: `--yes` takes the guess; no terminal takes the guess; a terminal still asks; no guess still errors.

Test: `bun test src/app/commit.test.ts` passes; `tests/parity/run.sh --engine dist/mksync push-yes-alias-guess`
passes.

## Step 7: Shared cases for the bootstrap flags `[worker]`

Files: `tests/parity/cases/setup-no-bootstrap/`, `tests/parity/cases/setup-yes-no-bootstrap/`,
`tests/parity/cases/setup-bootstrap-both/`.

- `setup-no-bootstrap`: linux, bootstrap offered, `--no-bootstrap`. Expect no bootstrap question, ` --no-bootstrap`
  at the end of `Same as:`, no bootstrap run (the stubs' log has no `apt-get`).
- `setup-yes-no-bootstrap`: `--yes --profile personal`. Expect no bootstrap question and ` --no-bootstrap`.
- `setup-bootstrap-both`: `--bootstrap --no-bootstrap`. Expect `ERROR: --bootstrap and --no-bootstrap can't be used
together`, exit 2, nothing written.
- `setup-bootstrap-question` (existing): answered `n`, its `Same as:` now ends with ` --no-bootstrap`.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync "setup-no-bootstrap|setup-yes-no-bootstrap|setup-bootstrap-both"`
fails.

## Step 8: The bootstrap flags `[worker]`

Files: `src/cli/parse.ts`, `src/cli/parse.test.ts`, `src/wizard/setup.ts`, `src/wizard/setup.test.ts`.

- `--no-bootstrap` boolean; both flags together exit 2 with decision 3's line.
- The bootstrap question is skipped under `--yes` and `--no-bootstrap` (answer no); `Same as:` prints the answer's
  flag whenever bootstrap was offered.
- Unit tests for each path.

Test: `bun test src/cli/parse.test.ts src/wizard/setup.test.ts` passes; step 7's cases pass.

## Step 9: Suggestions say which source answered `[worker]`

Files: `src/adapters/suggest.ts`, `src/adapters/suggest.test.ts`.

- A `suggestionSources(rules, context)` returning, per placeholder, `{ value, source }` for the first source that
  answered; `suggestions()` keeps its signature and maps it to values, so no caller changes in this step.
- Unit tests: the source of a first answer, of a fallback answer, none when nothing answers; `suggestions()` returns
  the same values as before.

Test: `bun test src/adapters/suggest.test.ts` passes.

## Step 10: Shared cases for values before the confirm `[worker]`

Files: `tests/parity/cases/setup-values-before-confirm/`, `tests/parity/cases/setup-values-declined/`,
`tests/parity/cases/setup-value-flag/`, `tests/parity/cases/setup-yes-missing-value/`.

- `setup-values-before-confirm`: one rule with `suggest: ["git-user-name"]` (the git stub answers `Jane Doe`) and one
  with no source. stdin: the four answers, Enter at the first value, `jane@example.com` at the second, Enter at the
  confirm. Expect both questions before `Machine …`, the `Values:` block with `(git-user-name)` and `(typed)`,
  `--value YOUR_EMAIL=jane@example.com` in `Same as:`, no value question after the confirm, both values hydrated in
  the imported file, exit 0.
- `setup-values-declined`: the same, `n` at the confirm. Expect `Stopped: nothing was written.`, no `machine.json`,
  no profile file, no saved values, exit as `setup-confirm-declined` today.
- `setup-value-flag`: `--yes --profile personal --value YOUR_EMAIL=jane@example.com --value "YOUR_NAME=Jane Doe"`.
  Expect no question, `(--value)` for both in the `Values:` block, exit 0; a second command with `--value
NOT_A_KEY=x` expects `ERROR: --value NOT_A_KEY: no rule uses this placeholder`, exit 2.
- `setup-yes-missing-value`: `--yes --profile personal`, a rule with no source and no `--value`. Expect
  `ERROR: missing value for <YOUR_EMAIL>; pass --value YOUR_EMAIL=<value>`, exit 2, no `machine.json`.
- Existing `setup-value-asked`, `setup-values-piped`, `setup-values-move`, `setup-values-unknown`,
  `setup-answer-trimmed`: their value lines move before the summary and gain the `Values:` block; update their
  `expect/` from the contract and name each in the commit message.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync "setup-value"` fails.

## Step 11: Setup asks values before the confirm `[worker:high: reasoning: the values depend on the profile chosen inside runSetup, the writes after the confirm (record, profile, values, import) must keep their order, and neither the import nor the keep export may ask again]`

Files: `src/app/setup.ts`, `src/app/setup.test.ts`, `src/wizard/setup.ts`, `src/wizard/setup.test.ts`.

- `runSetup` gets a dependency that, given the chosen profile, mode and action, returns the value questions this run
  would ask: the import's `importValueQuestions` for the profile and modules, plus the export's for `keep`, deduped
  by placeholder, each with its guess and source from step 9 (and the "kept on" place question for `ask` rules).
- `runSetup` asks them after the linked-folder questions and before the summary (`--yes`: takes the guesses and
  stops with decision 7's line when one has none), prints the `Values:` block after `Public name:`, and returns the
  answers with the record.
- `executeSetup` writes the answers with the record and profile after the confirm (the current `valueAnswers` and
  `replaceValues` calls move into the dependency), then runs `importAfterSetup` and `exportKeep` with the values
  known, so their questions are empty. Nothing is saved on a decline or end of input.
- Unit tests: questions come before the summary; a decline saves nothing; the import asks nothing after the confirm;
  `--yes` takes a guess and stops on a missing one before any write; a value already saved isn't asked.

Test: `bun test src/app/setup.test.ts src/wizard/setup.test.ts` passes; `tests/parity/run.sh --engine dist/mksync
"setup-values-before-confirm|setup-values-declined|setup-yes-missing-value|setup-value-asked|setup-values"` passes.

## Step 12: `--value` `[worker]`

Files: `src/cli/parse.ts`, `src/cli/parse.test.ts`, `src/wizard/setup.ts`, `src/wizard/setup.test.ts`.

- `--value KEY=VALUE`, repeatable, the key with or without `<` `>`; the refusals in decision 5 (the unknown key is
  checked against the config's rules in `runSetup`, the others in the parser).
- `Same as:` prints ` --value KEY=VALUE` for typed answers, quoted per decision 5 (Windows quoting when the run's
  OS is windows).
- Unit tests: both key forms; empty value; placeholder text; an unknown key; quoting a value with a space and with a
  `'` on linux and on windows; a guessed value not in `Same as:`.

Test: `bun test src/cli/parse.test.ts src/wizard/setup.test.ts` passes; `tests/parity/run.sh --engine dist/mksync
setup-value-flag` passes.

## Step 13: Shared cases for the replace guess `[worker]`

Files: `tests/parity/cases/setup-replace-fresh-guess/`, `tests/parity/cases/setup-replace-public/`.

- `setup-replace-fresh-guess`: an old record with `<GH_CLI_PATH>` = `C:/old/gh.exe` and a `gh` stub on this
  machine's `PATH`; `--replace <old>`, Enter at the value. Expect the question with this machine's `gh` path in
  brackets, `(gh-path)` in the `Values:` block, the new path in the record.
- `setup-replace-public` (existing): the re-ask moves before the summary; a value with no source still suggests the
  old one, `(old machine)`. Update its `expect/` from the contract.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync setup-replace` fails.

## Step 14: Replace suggests a fresh guess `[worker]`

Files: `src/app/setup.ts`, `src/app/setup.test.ts`.

- In the value-question dependency from step 11, a taken-over machine value's suggestion is this machine's guess
  (its rule's sources, then `defaultEnv`), else the old value; `--yes` takes it.
- Unit tests: a fresh guess wins; no source keeps the old value; `--yes` takes the fresh guess.

Test: `bun test src/app/setup.test.ts` passes; step 13's cases pass.

## Step 15: Shared cases for the confirms `[worker]`

Files: `tests/parity/cases/pull-default-yes/`, `tests/parity/cases/pull-default-no/`,
`tests/parity/cases/push-pr-default-yes/`, `tests/parity/cases/push-pr-partial-no/`.

- `pull-default-yes` (new): `IN` changes, stdin Enter. Expect `Apply these changes? [Y/n] `, the files applied,
  exit 0.
- `pull-default-no` (existing): stdin empty (end of input). Expect the `[Y/n]` question, nothing applied, its exit
  as today. Linux-only like `pull-suggest-eof`, since `run.ps1` pipes `''` as Enter.
- `push-pr-default-yes`: only `OUT` files, stdin Enter at the PR question. Expect `[Y/n] ` and a `pr create` line
  in `gh.log`.
- `push-pr-partial-no`: one `IN` file skipped, stdin Enter. Expect `[y/N] ` and no `pr create`.
- Existing pull and push cases that show `[y/N]` at these questions: update their `expect/` from the contract and
  name each in the commit message.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync "pull-default|push-pr-"` fails.

## Step 16: The confirms default to yes `[worker]`

Files: `src/app/pull.ts`, `src/app/pull.test.ts`, `src/app/push.ts`, `src/app/push.test.ts`.

- `APPLY_QUESTION` becomes `[Y/n]` with `defaultYes` true; end of input is no. `PR_QUESTION` takes `[Y/n]` and yes
  unless the run is partial or `--force` went past a `BOTH` file, then `[y/N]`; end of input is no.
- Unit tests for Enter, `n`, end of input, and the partial push.

Test: `bun test src/app/pull.test.ts src/app/push.test.ts` passes; step 15's cases pass.

## Step 17: Docs, changelog and version `[inline: user-facing docs]`

Files: `README.md`, `docs/daily-workflow.md`, `CHANGELOG.md`, `package.json`, `docs/plan-smart-first-run.md`.

- README and daily workflow: a first run on a new machine needs only Enter (the guesses), `setup --yes` with
  `--value` for an unattended one, and the `Same as:` line to repeat it.
- `CHANGELOG.md` `v1.3.0` under "Changed" (decisions 1 to 8), `package.json` `1.3.0`.
- Roadmap: phase 2 **Done** with the date and PR; phase 3 next.

Test: `npx prettier --check README.md docs/*.md CHANGELOG.md`; `bun run lint`.
