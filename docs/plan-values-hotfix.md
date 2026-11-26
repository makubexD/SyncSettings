# Values hotfix: push and preview read values from this machine's files (`v1.1.6`)

Found 2026-11-26 on work #2 (`docs/plan-work-machines.md`, step 9), on `v1.1.5`. `mksync setup` answered `3) stop`
writes the record and profile but asks no value, since values are asked only by the import that `stop` skips.
`mksync preview` then stops with `missing value for <YOUR_NAME>: add it to profile work2 or machine <host>`, and push
would too: export never infers a value, though the machine's own files hold every one it needs. The doctor's
`5 value(s) not set; mksync setup asks for them` is wrong for a machine that already has a record. Work #1 never hit
this: its values came from an older `.user-values.json`. The plan's rule ("A bug stops the plan") holds
`docs/plan-work-machines.md` at step 9 until this is on work #2 (a `git pull` in its clone). Contract:
`docs/sync-contract.md` ("Sanitize and hydrate", "Profile values", "Front door", "Linked folders"). Branch
`engine/values-hotfix`.

## The bugs

1. **Export never infers.** Import infers a value from a local file against the repo's placeholder text ("Inference on
   import", `collectRules` in `src/core/plan/import.ts`); export calls `resolveValues(rules, snapshot.values, {}, …)`
   (`src/core/plan/export.ts`), so a machine with no cached value can't preview or push. Export already saves the
   values it resolved (`valuesPrepare`), as import does.
2. **The profile guard sees only cached values.** `profileValueHits` (`src/core/plan/profilevalues.ts`) searches
   `snapshot.profile.values`. Once export infers, a profile value found in this run (an email inferred from
   `.gitconfig`) would not be searched for in a shared file that holds it without a rule.
3. **The doctor's hint.** With a record, setup no longer asks (only its import does), so "mksync setup asks for them"
   sends the user round in circles.
4. **The linked-folder suggestion.** `~/.nvm` (458 files, 2 MB) is suggested `1) this profile`, so Enter would sync a
   tool's install folder (`suggestLinked`, `src/core/machine/linked.ts`).

## Decided (proposed, for review)

1. **Export infers like import.** The same rule ("Inference on import": line by line, prefix and suffix,
   `escapeBackslashes`), for each selected entry with rules whose local and repo files both exist, `--only` or not. A
   cached value still wins; an inferred one comes before `default` and `defaultEnv`. One home for it: the loop moves
   out of `import.ts` into `src/core/plan/infer.ts` (`inferredValues(snapshot, selected)`), and both plans call it.
   Export still never asks: a value nothing fills stops as today.
2. **Saved as today.** Push saves the values it resolved, inferred ones included, where import would
   (`valuesPrepare`: the record and profile by the "Values on a machine" table, else `.user-values.json`). `preview`
   and `export --preview` write nothing, as now.
3. **The guard searches the values this run saves.** `profileValueHits` takes the profile from the plan's
   `writeMachineValues` action when there is one, else the snapshot's, so an inferred profile value is refused in a
   shared file exactly like a cached one.
4. **Doctor hint by record.** Without a record the line stays `<n> value(s) not set; mksync setup asks for them`. With
   one it reads `<n> value(s) not saved yet; mksync push or pull reads them from this machine's files`.
5. **A hidden folder is never suggested.** A linked folder whose name starts with `.` (`~/.nvm`, `~/.cargo`) is
   suggested `3) no`, whatever its size; `--yes` takes that. The other rules stay.
6. **Not in this hotfix.** A push that asks for a value nothing fills, in a terminal, goes in the design's "Open".

## Step 1: Shared cases for export inference `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `tests/parity/cases/export-infers-value/`, `tests/parity/cases/export-infers-value-record/`,
`tests/parity/cases/preview-infers-value/`, `tests/parity/cases/profilevalue-inferred/`,
`tests/parity/cases/only-skips-unpicked-values-export/`.

Written from the contract, as decided above:

- `export-infers-value`: no record; entry `parity/a.conf` (`whole`, rule `<YOUR_NAME>`); repo
  `name = <YOUR_NAME>\ncolor = red\n`, local `name = Ana Lopez\ncolor = blue\n`; `export`. Expect exit 0, the line
  `MODIFIED dotfiles/common/parity/a.conf sanitized`, repo file `name = <YOUR_NAME>\ncolor = blue\n`, `values.json`
  `{"<YOUR_NAME>": "Ana Lopez"}`.
- `export-infers-value-record`: record `wk1-laptop`, profile `work-1` with empty `values`; entry `parity/git.conf`
  with rules `<YOUR_EMAIL>` and `<HOME>` (no `defaultEnv`); repo `email = <YOUR_EMAIL>\nhome = <HOME>\nx = 1\n`,
  local `email = jane@work1.example.com\nhome = /home/jane\nx = 2\n`; `export`. Expect exit 0, the repo file
  `email = <YOUR_EMAIL>\nhome = <HOME>\nx = 2\n`, the profile's values `{"<YOUR_EMAIL>": "jane@work1.example.com"}`
  and the record's `{"<HOME>": "/home/jane"}`, by the "Values on a machine" table.
- `preview-infers-value`: the same as `export-infers-value-record` with `preview`. Expect exit 0, the block's change
  line `x = 1 -> x = 2` (no real value printed), the repo file and both state files unchanged.
- `profilevalue-inferred`: record and empty profile as above; entries `parity/git.conf` (rule `<YOUR_EMAIL>`, repo
  `email = <YOUR_EMAIL>\n`, local `email = jane@work1.example.com\n`) and `parity/settings.json` (`json`, no rules,
  repo `{"email": "old@example.com"}`, local `{"email": "jane@work1.example.com"}`); `export`, `output: all`. Expect
  exit 1, the two `refused:` lines for `<YOUR_EMAIL>` in `settings.json`, nothing written.
- `only-skips-unpicked-values-export`: the local `san.conf` becomes `user=local` (no line pairs with `name=<MISSING>`),
  so the second export still stops on `<MISSING>`; the description says why.

Test: `tests/parity/run.sh --engine dist/mksync infers` and `… profilevalue-inferred` fail on the current build
for the right reason (`missing value`, or no refusal); `… only-skips-unpicked` passes.

## Step 2: Export infers, the guard sees it `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/core/plan/infer.ts` (new), `src/core/plan/import.ts`, `src/core/plan/export.ts`,
`src/core/plan/profilevalues.ts`.

- `infer.ts`: `inferredValues(snapshot, selected): Values`, the inference half of `collectRules` (first value per
  placeholder wins, `dir` and `dconf` skipped). `collectRules` keeps the rules and calls it.
- `export.ts`: `resolveValues(rules, snapshot.values, inferredValues(snapshot, selected.value), …)`.
- `profilevalues.ts`: the profile is the plan's `writeMachineValues` action's `profile` when present (decision 3).
- Unit tests: `infer.test.ts` (an inferred value; a cached value present still infers, `resolveValues` keeps the
  cached one; a missing local file infers nothing; `dir` skipped); `profilevalues.test.ts` (a value only in the
  prepare action's profile is a hit).
- Contract, "Sanitize and hydrate": item 2 reads "Values inferred from the existing local file (below), on import and
  export"; the heading "Inference on import" becomes "Inference"; "Profile values": the values searched include those
  the run saves.

Test: `bun test src/core/plan`, `bun run lint`, `bun run build`, then `tests/parity/run.sh --engine dist/mksync`
with the filters of step 1, `values`, `infer`, `profilevalue` and `only`.

## Step 3: The doctor's hint with a record `[inline: user-facing copy]`

Files: `src/core/front/doctor.ts`, `src/core/front/doctor.test.ts`, `docs/sync-contract.md`.

- `valuesLine(unsetValues, record)`: decision 4's two texts.
- Unit cases: 2 unset, no record → the old text; 2 unset, record → the new text; 0 → `OK values` either way.
- Contract, "Front door", `doctor`'s `values` item names both texts.

Test: `bun test src/core/front/doctor.test.ts`, `bun run lint`, `tests/parity/run.sh --engine dist/mksync doctor`
and `… setup-value` (no change: those runs have no record).

## Step 4: A hidden linked folder is suggested no `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/core/machine/linked.ts`, `src/core/machine/linked.test.ts`, `src/adapters/store.ts`,
`docs/sync-contract.md`.

- `suggestLinked(count, bytes, underHome, name)`: `"no"` when `name` starts with `.`; the caller passes
  `pathBase(path)`.
- Unit cases: `.nvm`, 458 files, 2 MB, under home → `no`; `scripts`, 1 file → `profile`; `scripts`, 1000 files →
  `no`; outside home → `no`.
- Contract, "Linked folders": the suggestion line adds "and whose name doesn't start with `.`".

Test: `bun test src/core/machine/linked.test.ts`, `bun run lint`, `tests/parity/run.sh --engine dist/mksync linked`.

## Step 5: Docs and PR `[inline: release notes and docs need judgment]`

Files: `package.json`, `CHANGELOG.md`, `docs/design-layers.md`, `docs/plan-work-machines.md`.

- Bump to `1.1.6`; a changelog entry naming bugs 1 to 4.
- Design "Open": "Push asks for a value nothing fills" (decision 6), and this hotfix's decisions under the work #2
  results.
- `docs/plan-work-machines.md` step 9: `git pull`, then `mksync doctor` (`OK values` or the new hint), `mksync preview`
  and `mksync push`; no hand-filled values; steps 10 to 12 expect `1.1.6`.
- `tests/all.sh`, `leak-scan`, review (`ts-code-reviewer`), push, PR, `reviewed` label, `pr-ready`, merge. Work #2
  runs from its clone, so the merge is what it needs; the `v1.1.6` tag waits for the user's OK.

Test: `npx prettier --check docs/*.md CHANGELOG.md` and `tests/all.sh`.
