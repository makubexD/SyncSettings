# Values ask: no placeholder stops a push from a terminal (`v1.1.7`)

Found 2026-11-26 on work #2 (`docs/plan-work-machines.md`, step 9), on `v1.1.6`. `mksync preview` and `mksync push`
stop with `missing value for <HOME>: add it to profile work2 or machine <host>`. `<HOME>` appears only in
`~/.claude/settings.json`, a Linux and Windows entry with no `dotfiles/windows/` copy yet, so there is nothing to infer
from. Its rule falls back to `defaultEnv: HOME`, which Windows doesn't set (`docs/configuration.md`, "`HOME` is usually
unset on Windows"). The only way out today is editing a state file by hand or setting `$env:HOME`. Work #3 would hit
the same stop. Branch `engine/values-ask`. Contract: `docs/sync-contract.md` ("Sanitize and hydrate", "Values on a
machine", "Front door").

## The gaps

1. **`defaultEnv: HOME` means nothing on Windows.** The program's home there is `USERPROFILE` (`homeFolder`,
   `src/adapters/paths.ts`), but `resolveValues`, `askValues` and `missingPlaceholders` read `env.HOME` as it is.
2. **Push never asks.** Pull asks for a value nothing fills (`planWithAnswers`, `src/app/import.ts`). Push stops,
   though it already asks other questions in a terminal (new settings, public name, "Move a change").
3. **The stop names no command.** `add it to profile … or machine …` and `add it to .user-values.json` send the user
   to edit JSON by hand.
4. **The doctor counts `<HOME>` as unset** on Windows, for the same reason as gap 1.

## Decided (proposed, for review)

1. **`HOME` is the home folder.** A rule's `defaultEnv: "HOME"` takes the program's home folder on every OS: `$HOME`
   on Linux and macOS (unchanged), `%USERPROFILE%` on Windows. One home for it: `valueEnv(snapshot)` in
   `src/core/values/env.ts` returns the snapshot's environment with `HOME` set to `snapshot.home`. Every reader of a
   `defaultEnv` uses it: import, export (`resolveValues`, `exportInferredValues`'s `defaultEnv` check) and the
   doctor's count. Other variable names are read as they are. `<HOME>` then never stops a run, and pull never asks for
   it.
2. **Push asks, as pull does.** In a terminal, without `--yes`, push asks for each value that nothing fills (saved,
   inferred, `default`, `defaultEnv`). It uses pull's header and `<prompt>: ` lines, in rule order, before the change
   list. It asks only for the placeholders of the entries it exports (`--only` and skips respected). The answers are
   saved as inferred values are: on the record and profile by the "Values on a machine" table, else in
   `.user-values.json`. An empty answer stops the run at once with the missing-value line and exit 1, as pull's does.
   `--yes`, no terminal, `preview`, `export --preview`, `diff` and `check` never ask.
3. **The stop names the way out.** With or without a record:
   `missing value for <PLACEHOLDER>: run mksync push or pull in a terminal to enter it`. This replaces both old lines.
4. **Doctor.** The count uses `valueEnv`. With a record, the line reads
   `<n> value(s) not saved yet; mksync push or pull fills them from this machine's files or asks for them`. Without a
   record, it stays `<n> value(s) not set; mksync setup asks for them`.
5. **Not in this plan.** Import's positional inference and a stale cached value stay in the design's "Open".

## Step 1: Contract `[inline: contract wording]`

Files: `docs/sync-contract.md`, `docs/configuration.md`.

- "Sanitize and hydrate": the value order says `defaultEnv: HOME` is the home folder on every OS (decision 1).
  "Missing value" gets the new line (decision 3). A new paragraph, "**Push asks.**", covers decision 2: when push asks,
  where the answers go, and which commands never ask.
- "Values on a machine": the missing-value line becomes decision 3's.
- "Front door", doctor: decision 4's line.
- `docs/configuration.md`: replace "`HOME` is usually unset on Windows, so a rule … prompts there with no default"
  with decision 1.

Test: `rtk grep -n "add it to .user-values.json\|add it to profile" docs/sync-contract.md docs/configuration.md` prints
nothing.

## Step 2: Shared cases for push asking `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `tests/parity/cases/push-asks-value/`, `tests/parity/cases/push-asks-value-empty/`,
`tests/parity/cases/push-yes-no-ask/`, `tests/parity/cases/preview-missing-value/`, and the `expect/` lines of the
cases that print the old missing-value line (`rtk grep -rl "missing value for" tests/parity/cases`).

Each case has one `whole` entry `parity/a.conf` with rule `<YOUR_NAME>` (prompt `Full name`). The repo file is
`name = <YOUR_NAME>`, and the local file is `color = blue`, so nothing infers a value. No record.

- `push-asks-value`: `export`, stdin `Ana Lopez\n`, `output: all`. The output holds the header and
  ` Full name:`, exit 0, and `expect/values.json` is `{"<YOUR_NAME>": "Ana Lopez"}`. The repo file is the local text
  sanitized.
- `push-asks-value-empty`: the same, stdin `\n`. It prints the question, then
  `missing value for <YOUR_NAME>: run mksync push or pull in a terminal to enter it`, exit 1. No file changes.
- `push-yes-no-ask`: `export --yes`, no stdin. There is no question, the same missing-value line, exit 1.
- `preview-missing-value`: `preview`. There is no question, the same missing-value line, exit 1, and no state is
  written.
- Existing cases with the old line take the new one, `expect/` only.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync push-asks` and `… preview-missing` fail on the missing
question or the old line, not on fixtures.

## Step 3: `HOME` is the home folder `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/core/values/env.ts` (new, with `env.test.ts`), `src/core/plan/import.ts`, `src/core/plan/export.ts`,
`src/core/plan/infer.ts`.

`valueEnv(snapshot)` returns `{ ...snapshot.env, HOME: snapshot.home }` when `snapshot.home` is not empty, else
`snapshot.env`. Import and export pass it wherever they pass `snapshot.env` to `resolveValues`, `askValues`,
`missingPlaceholders` and `exportInferredValues`'s `defaultEnv` check.

Unit cases:

1. A Windows snapshot with no `HOME` and home `C:\Users\u` gives `HOME` = `C:\Users\u`.
2. Linux keeps `snapshot.home`.
3. An empty home leaves the environment as it is.
4. A `<HOME>` rule with `defaultEnv: HOME` and no `HOME` variable resolves through `planExport` on a Windows snapshot.

Test: `bun test src/core/values/env.test.ts src/core/plan`.

## Step 4: The stop names the way out; the doctor's line `[inline: user-facing copy]`

Files: `src/core/values/hydrate.ts` (`missingValueMessage`), `src/core/front/doctor.ts`, `src/app/doctor.ts`
(`unsetValueCount` uses `valueEnv`), and their tests.

Test: `bun test src/core/values src/core/front src/app/doctor.test.ts`, then
`tests/parity/run.sh --engine dist/mksync missing` passes `preview-missing-value` and the updated cases.

## Step 5: Push asks for a missing value `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/core/plan/export.ts`, `src/app/export.ts`, `src/app/export.test.ts`.

Core: `exportValueQuestions(snapshot)` lists the rules that nothing fills, as `importValueQuestions` does, for the
entries export picks (`--only`, skips). `planExport` takes the answers (`snapshot`'s value answers, the way import gets
them) and puts them before `resolveValues`'s cached values. App: when export runs in a terminal without `--yes` and
not as a preview, it prints `ASK_HEADER` and each question, reads one line per question and stops at the first empty
answer, as `planWithAnswers` does. It asks before the change list, on the terminal it shares with its other questions.

Unit cases: the questions list only unfilled placeholders; `--yes` asks nothing; an answer is saved by
`valuesPrepare`; an empty answer stops with the step 4 line.

Test: `bun test src/app/export.test.ts src/core/plan`, then
`tests/parity/run.sh --engine dist/mksync push-asks push-yes preview-missing`.

## Step 6: Docs, PR and release `v1.1.7` `[inline: release notes and docs need judgment]`

Files: `package.json`, `CHANGELOG.md`, `docs/design-layers.md`, `docs/plan-work-machines.md`,
`docs/daily-workflow.md`.

- Design "Open": "Push asks for a value nothing fills" is done in `v1.1.7`, and a new "Values on Windows" item is done.
- `docs/plan-work-machines.md` step 9: after `git pull` (`mksync --version` prints `1.1.7`), push needs no shell
  variable. Steps 10 to 12 expect `1.1.7`.
- `docs/daily-workflow.md`: the missing-value row says push or pull asks in a terminal.
- Bump to `1.1.7`, with a changelog entry for gaps 1 to 4.
- `tests/all.sh`, `leak-scan`, review (`ts-code-reviewer`, `ts-security-auditor` for values), PR, `reviewed`,
  `pr-ready`, merge. Tag `v1.1.7` after the user's OK, then check `SHA256SUMS` and `mksync --version`.

Test: `tests/all.sh` exits 0.
