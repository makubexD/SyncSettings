# Smart first run, phase 3: reconcile the layers (`v1.4.0`)

Roadmap: `docs/plan-smart-first-run.md` (phase 3). Branch `engine/setting-list-move`. Contract:
`docs/sync-contract.md` (a new "mksync setting" section under "Front door", next to `machine` and `profile`; it
reuses "Move a change", "Profile values" and the guard). Design: `docs/design-layers.md` ("Layers"; the "Open" item
"Promote or demote a key", which this phase settles).

The user said yes on 2026-11-27 to the noun `setting`, the verbs `list` and `move`, and a required `--to`. Each work
machine's first sync keeps its differences in its profile (`p`); this phase gives the tools to look at them and to
move one setting at a time into a wider layer, once every profile is in front of you.

**Not breaking.** Two new commands, no flag or exit code of an existing command changes. Every test runs on stubs in
throwaway folders, as the shared cases do.

## Decided (proposed, for review)

1. **Usage.**

   ```text
   mksync setting list [--profile <p>]
   mksync setting move <file> [<key>] --to base|os|profile|machine [--dry-run | --yes]
   ```

   `<file>` is the entry's `file` as `sync-config.json` writes it (`vscode/settings.json`), or for a `dir` entry
   `<file>/<name inside>`. `<key>` is a `json` key path exactly as the change block prints it (`editor.fontSize`,
   `permissions.allow[]`); it is required for a `json` entry and refused for every other kind. Usage errors exit 2:
   `ERROR: setting needs list or move`, `ERROR: unknown setting command <verb>`, `ERROR: missing --to`,
   `ERROR: --to takes base, os, profile or machine`, `ERROR: --dry-run and --yes can't be used together`,
   `ERROR: no entry <file> in sync-config.json`, `ERROR: <file> is a json entry; name a key`,
   `ERROR: <file> is not a json entry; it moves as a whole file, with no key`.

2. **`setting list`** shows, for this machine's record, every setting a layer above the base sets, from the base up:

   ```text
   Settings above the base on wk1-laptop (profile work1):

   vscode  settings.json
     editor.fontSize       all machines: 14  profile work1: 15
     window.zoomLevel      Linux machines: 1
   claude  settings.json
     permissions.allow[]   all machines: 4 item(s)  profile work1: 2 item(s)
   git     .gitconfig.local
     (whole file)          Windows machines: 12 line(s)

   Other profiles: unknown while the repo is public.
   ```

   - An entry is listed when its OS, profile or machine layer holds a file. A `json` line is a key path that one of
     those layers sets; its cells name each layer that sets it, base first, with the change block's group words
     (`all machines`, `<OS> machines`, `profile <p>`, `this machine`). A value is the sanitized compact JSON, cut to
     its first 37 characters and `...` past 40. An array path counts the items each layer holds.
   - Any other kind is one `(whole file)` line, a cell per layer that holds the file: `<n> line(s)`, or
     `same as <group>` when its bytes equal a wider layer's. An `import` side file prints under its resolved name.
   - Order: the config's entry order, then key path in code-unit order. Module and key are padded to the widest in
     the listing. Nothing above the base: one line `(none)` after the header.
   - No record: header `Settings above the base on this machine:`, the OS layer only.
   - `--profile <p>` lists that profile's layer (and this machine's OS layer) instead of the record's, header
     `Settings above the base in profile <p>:`; no machine layer. A profile this machine doesn't hold is
     `ERROR: unknown profile <p>`, exit 2.
   - The last line, while the repo is public: `Other profiles: unknown while the repo is public.` (roadmap "Open":
     never "none"). Once private, `--profile` can name every profile in the repo and the line goes.
   - Values are never printed, only their placeholders. Exit 0. `list` reads; it never writes or asks.

3. **`setting move` keeps this machine's merged result.** The source is the narrowest layer that sets the key (or
   holds the file) on this machine. The move follows "Move a change" word for word: a narrower move writes the target
   and leaves the source as it is; a wider move writes the target and removes the key from the source, unless a layer
   between them sets it. Because the source is the narrowest layer, no narrower layer can override the moved value,
   so the "Move a change" refusals (`moving <path> to <layer> would change the merged result`,
   `a layer narrower than <layer> has the file`) can't be reached from the command line; they stay in the code as
   guards, exit 1. An array path moves every item the source holds that the
   target doesn't. The target already being the source prints `<file> <key> is already in <group>; nothing to move.`,
   exit 0. A key or file no layer sets: `ERROR: no layer sets <key> in <file>`, exit 1. `--to profile` or
   `--to machine` with no record: `ERROR: --to <layer> needs a machine record; run mksync setup`, exit 2.
   - Kept in "Open": removing a key from the base for every machine (the `<YOUR_WORK_MARKETPLACE>` case), `--from`
     to move a layer that isn't the narrowest, and `--format json` for `list`.
4. **Checks on text bound for the base or an OS layer,** after sanitize, before anything is written or asked:
   - the profile-value search ("Profile values"), its two lines reworded without a change number:
     `refused: <module> <file> <key> holds a value of profile <p> (<KEY>) and would reach <group>.` and
     `Leave it in "profile <p>", or put <KEY> in the file instead.`;
   - a placeholder that the value table places in the profile (its value lives in `profiles/<p>.json`):
     `refused: <module> <file> <key> holds <KEY>, a value of profile <p>; machines outside it have no value for it.`;
   - this machine's home folder as written in the text (as it is, with `\` doubled, and with `/` for `\` on Windows),
     ignoring case on Windows and macOS: `refused: <module> <file> <key> holds this machine's home folder.` The leak
     scan's `home-path` rule covers only Linux; this check covers every OS;
   - the leak scan on a temporary copy of the clone with the move applied, as the preview runs it; a hit prints the
     scan's lines and `refused: the leak scan found the lines above.`.

   Any refusal exits 1 and writes nothing.

5. **Preview, question, writes.**

   ```text
   Move vscode settings.json editor.fontSize: 15
     from profile work1 to all machines
   MODIFIED dotfiles/common/vscode/settings.json
   MODIFIED profiles/work1/vscode/settings.json
   Move it? [y/N]
   ```

   - The status lines are the writes, in the export's words and order (`ADDED`, `MODIFIED`, `REMOVED`), with the
     paths the snapshot uses; state files are written with their `.bak`, as every state write.
   - `[y/N]`, as push's PR question: it changes what other machines receive. An empty answer, `n` or end of input
     prints `Nothing moved.` and exits 1, as `machine retire`'s decline. No terminal and no `--yes`:
     `ERROR: setting move needs a terminal or --yes`, exit 2.
   - `--dry-run` prints the preview and `Nothing written (--dry-run).`, exit 0, after the checks (a refusal still
     exits 1). `--yes` writes without asking.
   - After the writes: `Moved. mksync push sends it to the other machines.` when a base or OS file changed, else
     `Moved.` (profile and machine layers take effect at once while the repo is public).

6. **Never a write to `master`.** `setting move` commits nothing and never runs git beyond reading status. Base and
   OS writes stay in the clone's working tree; the next `mksync push` exports (the live file already equals the
   merge, so nothing else changes), commits them on its `sync/<os>-…` branch and opens its PR. A file the move would
   write in `dotfiles/` that already differs from the clone's `HEAD` stops it before anything is written:
   `refused: <path> has changes that aren't sent; run mksync push first.`, exit 1.
7. **Version `v1.4.0`** ("Added" in `CHANGELOG.md`). The tag and release wait for the user, as before.

## Step 1: Contract and design `[inline: contract wording]`

Files: `docs/sync-contract.md`, `docs/design-layers.md`.

- Contract: a section "mksync setting" under "Front door" with decisions 1 to 6 (usage, every error line and exit
  code, the listing's format, the move's rules by reference to "Move a change", the checks, the preview, the question,
  `--dry-run`, `--yes`, the push hand-off). The front door's command list and usage block gain `setting`.
- Design "Open": the "Promote or demote a key" item is settled by `setting move` (link it); add decision 3's three
  leftovers; the `<YOUR_WORK_MARKETPLACE>` line points at the first one.

Test: `npx prettier --check docs/sync-contract.md docs/design-layers.md`; `grep -n "### mksync setting"
docs/sync-contract.md` prints one line.

## Step 2: Parse `setting list` and `setting move` `[worker]`

Files: `src/cli/parse.ts`, `src/cli/parse.test.ts`.

- A `SETTING` noun constant, `ParsedCommand` kinds `setting-list` (`profile?`) and `setting-move` (`file`, `key?`,
  `to: LayerName`, `dryRun`, `yes`), a `parseArgs` branch after `profile`, and `setting` in `USAGE` (decision 1's two
  lines).
- Unit tests, each with its exact result: `setting list` → `{kind:"setting-list"}`; `setting list --profile work1`;
  `setting move vscode/settings.json editor.fontSize --to base`; the same with `--dry-run`, and with `--yes`;
  `setting move git/.gitconfig.local --to os` (no key); `setting` alone → `ERROR: setting needs list or move`, 2;
  `setting copy` → `ERROR: unknown setting command copy`, 2; no `--to` → `ERROR: missing --to`, 2; `--to all` →
  `ERROR: --to takes base, os, profile or machine`, 2; `--dry-run --yes` → its error, 2; a third positional →
  the parser's unknown-argument error, 2; `setting list x` → the same.

Test: `bun test src/cli/parse.test.ts`.

## Step 3: Shared cases for `setting list` `[worker]`

Files: `tests/parity/run.sh`, `tests/parity/run.ps1`, `tests/parity/README.md`,
`tests/parity/cases/setting-list/`.

- Runners: commands `setting-list` (`./mksync setting list`, option `profile`) and `setting-move`
  (`./mksync setting move <target> [<key>] --to <to>`, options `target`, `key`, `to`, `dryRun`, `yes`); the option
  checks name them; README's command list gains both.
- `setting-list` (`os` linux, a record with profile `work1`, public): a `json` entry whose base sets
  `editor.fontSize` 14 and profile sets 15, an OS layer setting `window.zoomLevel` 1, a profile array of 2 items over
  a base of 4, a `whole` entry with an OS layer file of 12 lines, a `whole` entry whose profile file equals the OS
  file, an entry with only a base file. Expect decision 2's listing byte for byte (header, padding, `same as Linux
machines`, the base-only entry left out, the public last line), exit 0, no file changed.

Write `expect/` from the contract (step 1), not from the program.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync setting-list` reports 1 failed (no command yet).

## Step 4: The listing, pure `[worker]`

Files: `src/core/plan/settings.ts`, `src/core/plan/settings.test.ts`.

- `settingRows(selected, snapshot, profile)` returns one row per listed key path or whole file, with its cells
  (`group`, `text`), from `rootsFor`/`layerAt` (`src/core/layers/select.ts`) and the sanitized layer bytes; the json
  key paths and their printed form come from the helpers `changes.ts` already uses for the block (export them, don't
  copy them).
- `renderSettingList(header, rows, visibility)` returns the text of decision 2.
- Unit tests: each row kind of step 3's case; a value of 41 characters cut to 37 and `...`; a value of exactly 40
  kept; a `dir` entry's file listed as `<file>/<name>`; an `import` side file by its resolved name; nothing above the
  base → `(none)`; private → no last line; a key name holding `.` prints as the block prints it.

Test: `bun test src/core/plan/settings.test.ts`.

## Step 5: `mksync setting list` `[worker]`

Files: `src/app/setting.ts`, `src/main.ts`.

- `runSettingList(command, deps)`: load the record and the snapshot as `status` does, pick the profile (`--profile`,
  else the record's), refuse an unknown one (`ERROR: unknown profile <p>`, exit 2), print `renderSettingList`, exit 0. No record: the OS layer only, decision 2's header.
- `main.ts`: the `setting-list` kind in `run()` and the exhaustive `execute` switch.

Test: `bun test src/app` and `bun run build && tests/parity/run.sh --engine dist/mksync setting-list` pass.

## Step 6: Shared cases for a move `[worker]`

Files: `tests/parity/cases/setting-move-key-wider/`, `tests/parity/cases/setting-move-key-narrower/`,
`tests/parity/cases/setting-move-whole/`, `tests/parity/cases/setting-move-refused/`.

All `os` linux, a record with profile `work1`, `--yes` unless said otherwise. Write `expect/` from the contract.

- `setting-move-key-wider`: profile sets `editor.fontSize` 15 over a base 14; `--to base`. Expect decision 5's
  preview without the question, `Moved. mksync push sends it to the other machines.`, the base file holding 15,
  the key gone from the profile file (and its `.bak` in `expect/state/`), exit 0, nothing committed (`git` HEAD
  unchanged).
- `setting-move-key-narrower`: the base sets `window.zoomLevel` 1; `--to profile`. Expect the profile file gains it,
  the base unchanged, `Moved.`, exit 0.
- `setting-move-whole`: a `whole` entry with an OS layer file and no base file; `--to base`. Expect the base file
  with the OS file's bytes and the OS file removed (`REMOVED`), exit 0.
- `setting-move-refused`: three commands. `setting move vscode/settings.json editor.tabSize --to base --yes` (no
  layer sets it) → `ERROR: no layer sets editor.tabSize in vscode/settings.json`, exit 1;
  `setting move vscode/settings.json editor.fontSize --to profile --yes` (the profile already sets it) →
  `vscode/settings.json editor.fontSize is already in profile work1; nothing to move.`, exit 0;
  `setting move vscode/settings.json --to base --yes` → `ERROR: vscode/settings.json is a json entry; name a key`,
  exit 2. Nothing written by any of them.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync setting-move` reports 4 failed.

## Step 7: Plan a move `[worker:high: reasoning: finding the source layer for a key or array path across up to four layers, and keeping the merged result, reuses move.ts internals the spec can only point at]`

Files: `src/core/plan/setting-move.ts`, `src/core/plan/setting-move.test.ts`, `src/core/plan/move.ts`.

- `planSettingMove(plan, snapshot, selected, target, key, to)` returns
  `Result<{ plan: RunPlan; source: LayerName; text: string } | { already: LayerName }, string>`: find the narrowest
  layer that sets `key` (or holds the file), then call `moveJsonChange` (per item for an array path) or
  `moveWholeFile`, `sourceAsInRepo` on a narrower move, and `withMovedSlots`, exactly as `applyMove` does. Export
  those from `move.ts` without changing them; `applyMove` keeps its behavior (its tests don't change).
- Errors, word for word from decisions 1 and 3: no layer sets it; the merged-result refusal; the narrower-file
  refusal.
- Unit tests: wider json key (removed from the source); wider past a layer that sets it (source keeps it); narrower
  (source unchanged); array path moves only the items the target lacks; whole file wider (source removed) and wider
  past a layer that holds the file (source kept); the narrowest layer is picked when three layers set the key; the
  same layer → `already`; a key with a `.` in its name moves whole; removing the last key of an object removes the
  object.

Test: `bun test src/core/plan/setting-move.test.ts src/core/plan/move.test.ts`.

## Step 8: Shared cases for the checks `[worker]`

Files: `tests/parity/cases/setting-move-profile-value/`, `tests/parity/cases/setting-move-home/`,
`tests/parity/cases/setting-move-dirty/`, `tests/parity/cases/setting-move-dry-run/`.

All `os` linux, record profile `work1`. Write `expect/` from the contract.

- `setting-move-profile-value`: the profile's values hold `team = A4`; the profile file sets `"team": "A4"`;
  `--to base --yes`. Expect decision 4's two `refused:` lines (placeholder named, never `A4`), exit 1, nothing
  written.
- `setting-move-home`: the profile file sets a key to the case's `$HOME` plus `/bin`; `--to base --yes`. Expect
  `refused: vscode settings.json <key> holds this machine's home folder.`, exit 1, nothing written.
- `setting-move-dirty`: the clone's base file already differs from `HEAD`; `--to base --yes`. Expect
  `refused: dotfiles/common/vscode/settings.json has changes that aren't sent; run mksync push first.`, exit 1.
- `setting-move-dry-run`: as `setting-move-key-wider` with `--dry-run`. Expect the preview,
  `Nothing written (--dry-run).`, exit 0, no file changed.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync "setting-move-(profile|home|dirty|dry)"` reports 4
failed.

## Step 9: Base-bound checks, pure `[worker]`

Files: `src/core/plan/setting-checks.ts`, `src/core/plan/setting-checks.test.ts`, `src/core/plan/profilevalues.ts`.

- `settingMoveRefusals(plan, snapshot, profile, home, os, label)` returns the `refused:` lines of decision 4's first
  three checks for every `writeRepo` action bound for the base or an OS layer, reusing `profileValueHits` (its
  matching stays as it is; only the wording is new) and the value table's placement for the profile-placeholder
  check. `label` is `<module> <file> <key>`.
- Unit tests: a profile value as a whole token is refused, inside `#A4B3C2` not; a profile placeholder `<WORK_X>`
  refused, a machine placeholder `<YOUR_NAME>` allowed; the home folder as is, with `\\` doubled, and on windows with
  `/`, case-insensitive on windows and macos only; a move `--to profile` runs no check; lines ordered by the
  contract's order.

Test: `bun test src/core/plan/setting-checks.test.ts src/core/plan/profilevalues.test.ts`.

## Step 10: `mksync setting move` `[worker]`

Files: `src/app/setting.ts`, `src/main.ts`.

- `runSettingMove(command, deps)`: parse-level refusals of decision 1 that need the config (unknown entry, key
  required or refused), the record (`--to profile|machine`), `planSettingMove`, the dirty-path refusal (decision 6,
  `git status --porcelain` on the paths the plan writes under `dotfiles/`), `settingMoveRefusals`, the leak scan on a
  temporary copy through the preview's `PreviewTailDeps.scan` seam, then the preview, the question or
  `--dry-run`/`--yes`, the writes through the store adapter (state writes with `.bak`), and the closing line.
- `main.ts`: the `setting-move` kind.

Test: `bun test src/app` and `bun run build && tests/parity/run.sh --engine dist/mksync setting-move` pass (steps 6
and 8).

## Step 11: Push carries a move `[worker]`

Files: `tests/parity/cases/setting-move-then-push/`, `src/app/push.ts` (only if the case fails for a reason in push).

- One case, `os` linux, record profile `work1` with an alias, a `gh` stub: `setting move vscode/settings.json
editor.fontSize --to base --yes`, then `push --yes`. Expect the move's lines, then push's: the change block lists
  nothing new for the base (the live file equals the merge), the commit on `sync/linux-…` holds the base file with
  15, `gh.log` shows one `pr create`, `master` unchanged, exit 0.
- If push drops or restores the move (`IN_BUT_DIRTY`, the declined-PR restore), stop and report: that's a contract
  question, not a fix to make here.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync setting-move-then-push`.

## Step 12: Docs, changelog and version `[inline: user-facing docs]`

Files: `docs/daily-workflow.md`, `docs/layout.md`, `README.md`, `CHANGELOG.md`, `package.json`,
`docs/plan-smart-first-run.md`.

- `docs/daily-workflow.md`: a "Reconcile the layers" section: `setting list` on each machine, `setting move ...
--to base --dry-run`, then without it, then `mksync push`; why a move never changes this machine.
- `docs/layout.md`: which folder a move writes for each `--to`, while public and once private.
- `README.md`: the command list gains `setting`.
- `CHANGELOG.md` `v1.4.0` under "Added"; `package.json` `1.4.0`.
- Roadmap: phase 3 points at this plan; its "Open" `<YOUR_WORK_MARKETPLACE>` line points at the design's new item.

Test: `npx prettier --check docs README.md CHANGELOG.md`; `grep -n '"version": "1.4.0"' package.json` prints one line.
