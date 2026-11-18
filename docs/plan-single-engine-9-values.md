# One engine, phase 9: ask for missing values

Roadmap: `docs/plan-single-engine.md`, phase 9, a fix inside `docs/plan-single-engine-9.md`'s PR (#80). Contract:
`docs/sync-contract.md` ("Sanitize and hydrate", "Values on a machine", "Known differences"). Design:
`docs/design-layers.md` ("Moving `.user-values.json`").

**Problem.** The program asks for values only under `import --reset-values`. On a fresh machine, the import that
`mksync setup` and `mksync pull` run has no value for `<YOUR_NAME>` and the rest. It stops with
`missing value for <YOUR_NAME>: …`, exit 1, so a new machine never finishes setup (CI `macos-checks`, M1). The
contract's step 3 ("A prompt…") and the doctor's hint ("mksync setup asks for them") say it asks, and so does bash.
A second bug: under `--reset-values` the program reads every value answer first and prints the prompts afterwards, so
at a real terminal the user types without seeing a question.

## Shared rules

- Branch `engine/cutover-prep`, one commit per step, merged with PR #80. Old engines frozen, as in
  `docs/plan-single-engine-9.md` ("Shared rules"); bash already asks, so its expectations don't change.
- Contract first: the contract text (step 1) and the shared cases (step 2) come before the code.
- Public repo: fixtures use `Jane Doe`, `example.com`, profile `work-1`, machine `wk1-laptop`, as the existing cases.
- Shared-case test command: `bun run build && tests/parity/run.sh --engine dist/mksync <filter>`; the bash engine:
  `tests/parity/run.sh <filter>`.

## Decided

1. **The program asks only for what it can't fill.** A placeholder is asked for when it has no value after the
   cached value (or the record and profile), inference, the rule's `default` and `defaultEnv`. Bash asks for every
   uncached placeholder, showing that default in brackets; the program takes the default without asking. That goes
   in "Known differences".
2. **Prompt text as bash.** Before the first question:
   `\n  Enter values to fill the placeholders in the config files:\n\n`, then ` <prompt>:` per question (no default
   to show, by decision 1), and one `\n` after the last answer. Each prompt is printed before its answer is read; the
   same holds for `--reset-values`.
3. **No answer stops.** An empty answer or end of input leaves the value missing: the prompts printed so far stay, then
   the existing missing-value line on stderr, exit 1, no file written. So a run with no input still stops, as today.
4. **Saved as `--reset-values` saves.** Without a record, in `.user-values.json`. With a record, by the table in
   "Values on a machine" (`<YOUR_NAME>` on the profile, `<HOME>` on the machine), through the existing
   `valuesPrepare`.
5. **Never asked:** `--check`, `preview`, `status`, `diff` and export keep today's behavior.

## Step 1: Contract and design text `[inline: contract wording]`

- `docs/sync-contract.md`, "Sanitize and hydrate": after step 3, add the program rule from decisions 1-3 (asks only
  what it can't fill; prompt printed before its answer; empty answer or end of input stops). After the
  `--reset-values` paragraph: the program prints each prompt before reading its answer.
- "Values on a machine": an answered value is saved by the table, as `--reset-values` saves (decision 4); add
  `values-record-missing-asked` to the sentence that lists its cases, if there is one.
- "Known differences": a row `Value prompt with a default`: bash asks and shows the default in brackets; PowerShell as
  bash; the program takes the default without asking.
- `docs/design-layers.md`, "Moving `.user-values.json`": one line that a pull or setup asks for a value nothing else
  fills, saved by the same rule (the existing sentence names pulls; add setup and the decision-1 condition).
- Test: `npx prettier --check docs/sync-contract.md docs/design-layers.md`.

## Step 2: Shared cases `[worker]`

Files: `tests/parity/cases/values-missing-asked/`, `tests/parity/cases/values-record-missing-asked/`,
`tests/parity/cases/values-record-missing/expect/output.txt`. Model the layouts on `reset-values-asks` (v1, piped
answer, `values.json`) and `values-record-missing` (v2, record in `state/`). Expectations come from the contract text
of step 1, not from engine output.

- `values-missing-asked` (new; `"os": ["linux", "macos"]`, as `reset-values-asks`, since PowerShell doesn't read a
  value answer from redirected input): config v1, one entry `dotfiles/common/parity/a.conf` with
  `name = <YOUR_NAME>` and the rule `{ "placeholder": "<YOUR_NAME>", "prompt": "Full name" }`, no `values`, command
  `import` with `force`, `stdin` `"Jane Doe\n"`, output captured. Expect: exit 0; the local file holds
  `name = Jane Doe`; `values.json` is `{"<YOUR_NAME>": "Jane Doe"}` in the format `reset-values-asks` expects; the
  output starts with `\n  Enter values to fill the placeholders in the config files:\n\n  Full name: \n` followed by
  the import's usual lines. Runs on both the program and bash.
- `values-record-missing-asked` (new; `"os": ["linux"]`, `oldEngines: ["none"]`, description says it covers decision 4
  of `docs/plan-single-engine-9-values.md`): copy `values-record-missing`'s config, env and `state/`, add
  `"stdin": "Jane Doe\n"`. Expect: exit 0; the local file holds `name = Jane Doe` (as the repo file's line); the
  profile file `work-1.json` gains `"<YOUR_NAME>": "Jane Doe"` in its `values`, the machine record is unchanged; the
  output starts with the same prompt text as above.
- `values-record-missing` (update `expect/output.txt` only): no stdin, so end of input. Expected output is the prompt
  text `\n  Enter values to fill the placeholders in the config files:\n\n  Full name: ` followed by the existing line
  `missing value for <YOUR_NAME>: add it to profile work-1 or machine wk1-laptop\n` (keep the case's stdout/stderr
  order as the runner records it). Exit stays 1; no file written.
- Expected before step 3: `values-missing-asked` passes on bash and fails on the program;
  `values-record-missing-asked` and `values-record-missing` fail on the program.
- Test: `tests/parity/run.sh values-missing-asked` passes; `bun run build && tests/parity/run.sh --engine dist/mksync
values-` fails only on the three cases above.

## Step 3: Core asks for the missing values `[worker]`

Files: `src/core/values/hydrate.ts`, `src/core/plan/import.ts`, their tests (`hydrate.test.ts`, `import.test.ts`).

- `hydrate.ts`: add `missingPlaceholders(rules, cached, inferred, env): readonly SanitizeRule[]`: the first rule of
  each placeholder that `resolveValues` would stop on (no cached, inferred, `default` or `defaultEnv` value), in rule
  order. `resolveValues` stays as it is.
- `import.ts`: replace `importValueAnswerCount` with `importValueQuestions(snapshot): readonly string[] | RunPlan`:
  the text printed before each value answer. The first question's text starts with the header (`ASK_HEADER`, exported
  from `hydrate.ts` or rebuilt there). Under `--reset-values`, one per placeholder as `askValues` prints it (with the
  `[default]` part); otherwise one per `missingPlaceholders` rule, ` <prompt>:`; none under `--check` (the check
  path never asks).
- `resolveImportValues(snapshot, answers)`: without `--reset-values`, when `missingPlaceholders` is not empty, fill
  each from its answer (trimmed with `trimAnswer`); an empty or absent answer returns the existing missing-value
  error plan (with `missing`). The asked values join the resolved ones before `valuesPrepare`, so they are saved
  (decision 4). Return `prompt: undefined` in every case: the app prints the questions now (step 4), and the closing
  `\n` is the last question's caller's job (step 4).
- Keep `planImport` (the one-list form) working: it splits the list as before, using the question count.
- Unit tests, each with its expected result: (a) no rules → no questions; (b) a cached value → no question;
  (c) an inferred value → no question; (d) a rule `default` → no question, value is the default; (e) `defaultEnv`
  set → no question; (f) one missing placeholder → one question `"\n  Enter values to fill the placeholders in the
config files:\n\n  Full name: "`, answer `"Jane Doe"` → values hold it and the plan's prepare writes it;
  (g) same, answer `""` → error plan, exit 1, `missing: "<YOUR_NAME>"`; (h) two rules for the same placeholder → one
  question; (i) `--reset-values` → one question per placeholder with `[cached]` in brackets, as today's text;
  (j) `check: true` with a missing value → no question.
- Test: `bun test src/core/values src/core/plan/import && bun run lint`.

## Step 4: The import prints each value question before reading it `[worker]`

Files: `src/app/import.ts`, `src/app/import.test.ts` (create it next to the file if it doesn't exist).

- `planWithAnswers`: for each text of `importValueQuestions`, `io.write(text)` then read one line (end of input is
  `""`); after the last question, `io.write("\n")`, unless the answers stopped the run (decision 3: the error line
  follows the last prompt directly). Then `resolveImportValues` with the answers, as now.
- Nothing else in the flow changes: overwrite questions follow as before.
- Unit tests with a fake `ImportIo` that records writes and reads in one ordered log: (a) a missing value: the log is
  write(header + ` Full name:`), read, write(`\n`), then the overwrite flow; (b) end of input on that read: no
  closing `\n`, exit 1, the missing-value line; (c) `--reset-values` with two placeholders: write, read, write, read,
  write(`\n`) in that order.
- Test: `bun test src/app/import && bun run build && tests/parity/run.sh --engine dist/mksync values- && tests/parity/run.sh --engine dist/mksync reset-values && tests/parity/run.sh --engine dist/mksync setup-`.

## Step 5: macOS checks pass on CI `[inline: CI-only check]`

- Push the branch and watch `macos-checks` on PR #80. The CI answers file feeds `y` to every value question
  (`.github/workflows/ci.yml`, step "Answer the installer and setup"); update its comment to say the values are
  asked and answered `y`. M1 and M2 must pass; M3 already does; M4 stays INFO.
- If a further failure shows, fix it on this branch only when it is the same flow; otherwise stop and report.
- Test: `gh pr checks 80` shows `macos-checks` pass.

## Step 6: Docs `[inline: docs wording]`

- `docs/plan-single-engine.md`, phase 9: one line that fresh-machine setup asks for missing values (this plan).
- `docs/configuration.md` or wherever `prompt` is described for a sanitize rule: say the program asks only when
  nothing else gives a value (link the Known differences row).
- `TODO.md`: nothing to add unless step 5 left something.
- Test: `npx prettier --check docs/*.md`.
