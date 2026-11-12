# One engine, phase 5: layers

Roadmap: `docs/plan-single-engine.md`, phase 5. Design: `docs/design-layers.md` ("Layers", "Modules and profiles",
"Merge and split", "Config v2"). Goal: the program merges an entry's layers on import and splits a changed file back
into them on export, for `json` and `import` entries; it reads profiles (modules and layer files) beside config v2;
and every worked example of "Layers" and "Merge and split" is a unit test.

## Shared rules

- Branch `engine/layers`, one commit per step, one PR at the end.
- **Old engines frozen.** No change to `export.sh`, `import.sh`, `commit.sh`, `scripts/linux/`, `scripts/windows/`.
  The runners (`tests/parity/run.sh`, `run.ps1`) may change; no existing case's `expect/` changes.
- **Contract first** (CLAUDE.md rule 2): step 1 writes this phase's rules into the contract; steps 7 and 8 add the
  shared cases before the code that makes them pass.
- **Public repo.** Fixtures use `example.com`, `/home/user`, `C:\Users\user`, profile `work-1`. `leak-scan` stays green.
- **Layout** from the design's "Code layout": `src/core/` stays pure (the boundary grep in "As built in phase 4"
  prints nothing). New strategies go in `src/core/merge/`, one file per merge type. Tests sit next to their file.
- **No new dependencies.** The JSON parser is our own (decision 4).
- **Messages are the contract's.** Every status, note and `ERROR:` line is copied from `docs/sync-contract.md` as step
  1 writes it. A worker spec names the section to copy from.
- Each worker step: about 3 files, one concern, tests in the same step. Test commands run that step's tests only.

## Out of this phase

- Machine records, the first run, `mksync whoami`, values on the profile and the machine (`.user-values.json` stays the
  only values source), the public-repo guard: phase 6.
- The push preview grouped by receiver and the "where does this new setting go?" question: phase 7. Until then a new
  setting with no destination stops that file (decision 3).
- The Claude layers in use (`settings.json` base part, Windows `~/.claude`), `mksync statusline`: phase 7. This phase
  builds the strategies; no real entry gets a second layer.
- dconf export and import: phase 8 (still `SKIPPED`, `not supported yet`).
- Removing a key in a later layer, machine-state keys (`localOnlyKeys` is supported, the lists stay empty), a profile
  without a value: still "Open".

## Decisions to confirm in review

Proposals; the review of this plan confirms or changes them before `/next`. Step 1 writes them into the contract and
the design.

1. **Choosing the profile and machine before phase 6.** Two environment variables, as `SYNC_OS` does: `SYNC_PROFILE`
   and `SYNC_MACHINE`. Unset (every real machine today): no profile or machine layer, every module on, behavior as in
   phase 4. Set: the profile's `modules` turn modules on and off, and the profile and machine layers are read.
   Phase 6 replaces both variables with the machine record; the contract marks them "until phase 6".
2. **Where profile and machine files live.** In local state, as the design's "Public-repo guard" says until the repo is
   private: `<state>/profiles/<name>.json` and the layer root `<state>/profiles/<name>/`; `<state>/machines/<name>/`
   for the machine layer (no machine record file yet). `<state>` is the state folder the program already uses. The
   program never reads `profiles/` or `machines/` from the repo in this phase.
3. **Export of a multi-layer `json` entry.** A changed or removed key and a removed array item go to their layer
   ("Splitting a changed file"). A new key or a new array item goes where the profile's `destinations` says; with no
   answer the file gets status `ERROR` with the note `new setting <key path>: needs a destination` and nothing of
   that file is written; the run goes on and exits 0, as every `ERROR`. A single-layer `json` entry has nowhere else to go: every change
   goes to its one layer, as `whole` does today, so no real entry changes behavior.
4. **JSON parsing and layout.** An own parser keeps each number's source text (`1.0` stays `1.0`, big integers
   aren't rounded), keeps key order, refuses duplicate keys, comments and trailing commas (`ERROR`, note `not valid
JSON`), and stores keys in a `Map` (no `__proto__` surprises). Output follows the design's layout rule 4, CRLF on
   Windows. VS Code's comments (JSONC) go in "Open": refused until a real file needs them.
5. **Repo JSON files normalized once.** `dotfiles/linux/claude-worker/settings.json` writes short arrays on one line
   and `dotfiles/common/vscode/settings.json` differs from the layout in its last bytes. Step 17 rewrites both in the
   layout, so the first pull of the new code writes the same bytes as the repo, and the old engines (byte copies)
   keep agreeing with the program.
6. **Shared cases for v2.** A case may give `configV2` instead of `config`, plus `env` (only `SYNC_PROFILE`,
   `SYNC_MACHINE`) and a `state/` tree copied into the state folder. The old engines can't read v2, so the runners
   skip such cases for them with `SKIP <case>: v2 only`. The program runs them on Linux, macOS and Windows.
7. **`import` entries.** Pull writes the base text, then the marker line and one `@<importName>` line per layer file
   that exists (OS, profile, machine), and writes each of those layer files next to the local base file under its
   `importName`. Push compares the text above the marker with the base layer (CRLF folded); an edit inside the block
   prints the note `import block is written by mksync, edit not pushed`. The layer files next to it are their own
   files: an edit to `CLAUDE.work-1.md` goes to the profile layer as a whole file.

## Step 1: This phase's rules in the contract `[inline: contract decisions]`

Files: `docs/sync-contract.md`, `docs/design-layers.md`.

- Contract: `SYNC_PROFILE` and `SYNC_MACHINE` next to `SYNC_OS` ("Which system"), marked "until phase 6"; profile
  modules turning modules off; the `json` merge and split rules and the `import` block (decisions 3, 4 and 7) with
  their exact status and note lines; the layout and line endings of a written JSON file; the v2-only shared cases
  (decision 6).
- Design: decisions 1, 2 and 6 as rules with an example in "Config v2" and "Tests"; JSONC and the variables' removal
  in phase 6 in "Open".

Test: `grep -c 'SYNC_PROFILE' docs/sync-contract.md` is at least 1; `grep -c 'needs a destination' docs/sync-contract.md`
is at least 1; `grep -c 'edit not pushed' docs/sync-contract.md` is at least 1.

## Step 2: One home-path expansion `[worker]`

Files: `src/core/paths.ts`, `src/core/paths.test.ts`, `src/core/plan/export.ts`, `src/core/plan/import.ts`.

The boundaries review's first leftover. Move the `~/` and `~\` expansion from `export.ts` and `import.ts` into one pure
`expandHome(path, home, os)` in `src/core/paths.ts`: `~\` counts as home on Windows only (today's core copies accept it
everywhere; the adapter's `pathFor` already doesn't). Both plans call it. `adapters/paths.ts` keeps only the env
lookups. Unit cases: `~/a` on Linux and Windows, `~\a` on Windows (home) and on Linux (left as is), `~` alone, a path
with no `~`, a home with a trailing separator.

Test: `bun test src/core/paths.test.ts src/core/plan && bun run lint && tests/parity/run.sh --engine dist/mksync` after
`bun run build`.

## Step 3: Shared file picking for export and import `[worker]`

Files: `src/core/plan/pick.ts`, `src/core/plan/export.ts`, `src/core/plan/import.ts`.

The about 260 lines `export.ts` and `import.ts` share word for word (`--only` matching, exclude globs, error plans)
move to `pick.ts`, unchanged in behavior. `isExcluded` compiles its patterns once per run, not per file. No new
tests: the plans' tests and the shared cases cover it.

Test: `bun test src/core/plan && bun run lint && bun run build && tests/parity/run.sh --engine dist/mksync`.

## Step 4: Merge strategies for today's types `[worker]`

Files: `src/core/merge/types.ts`, `src/core/merge/whole.ts`, `src/core/merge/whole.test.ts`.

The interface from the design's "Code layout": `merge(layers) → file` and `split(file, layers) → changes per layer`,
with `layers` in layer order (base, OS, profile, machine), each a repo path and its bytes. `whole`: merge returns the
last layer's bytes; split puts the whole file in the last layer. A strategy is picked by `merge` type through one
exhaustive `switch` (`strategyFor`); `dir` and `dconf` stay handled by the plans for now (dir's per-file layering is
phase 8), so `strategyFor` returns `undefined` for them. Unit cases: one layer, two layers (last wins), split into
the last layer, split with no layer (the write root).

Test: `bun test src/core/merge && bun run lint`.

## Step 5: Snapshot reading out of `main.ts` `[worker]`

Files: `src/adapters/snapshot.ts`, `src/adapters/snapshot.test.ts`, `src/main.ts`.

The boundaries review's `main.ts` leftover: reading the config, the repo tree, local files and `.user-values.json`
moves to `adapters/snapshot.ts`; `resolveOs` becomes pure (it takes `SYNC_OS` and the platform as arguments);
`parseValuesFile` sits next to `valuesFileText` in `src/core/values/file.ts`. `main.ts` only wires. Behavior
unchanged.

Test: `bun test src && bun run lint && bun run build && tests/parity/run.sh --engine dist/mksync`.

## Step 6: v2 cases in the runners `[worker]`

Files: `tests/parity/run.sh`, `tests/parity/run.ps1`, `tests/parity/README.md`.

Decision 6. A case's `case.json` holds `config` or `configV2` (exactly one; both or neither is a runner error). With
`configV2` the runner writes it as `sync-config.v2.json` and no `sync-config.json`, and an engine other than the
program prints `SKIP <case>: v2 only` and counts as skipped. `env` may set only `SYNC_PROFILE` and `SYNC_MACHINE`
(anything else is a runner error). A `state/` folder in the case is copied into the program's state folder
(`XDG_STATE_HOME` on Linux and macOS, `LOCALAPPDATA` on Windows, both pointed into the case's temp dir) before the
first command, and `expect/state/` is compared like `expect/home/` when present. README: the three fields under "A
case" and the skip under "Running another engine". Add no case in this step; check with a throwaway v2 case in
`$TMPDIR` that the program runs it and bash skips it.

Test: `bash -n tests/parity/run.sh && tests/parity/run.sh --engine dist/mksync && tests/parity/run.sh` (both 44
passed; no new case yet).

## Step 7: Shared cases for pull `[worker]`

Files: `tests/parity/cases/json-merge-layers/`, `tests/parity/cases/json-merge-profile/`,
`tests/parity/cases/import-block-written/`.

v2 cases, `expect/` written from the contract (step 1), never from engine output. They fail on the program until
step 14.

- `json-merge-layers`: entry `parity/settings.json`, `merge: json`, module `parity`. Base layer
  `{"a": 1, "list": ["x"], "obj": {"k": "base"}}`, Linux layer `{"list": ["y", "x"], "obj": {"k2": "os"}, "b": 2}`.
  `import --force`: local file is `{"a": 1, "list": ["x", "y"], "obj": {"k": "base", "k2": "os"}, "b": 2}` in the
  layout, LF, status `CREATED`; exit 0. `expect.windows/` (with `differences: ["Entry selection"]`, Windows layer
  instead of Linux) has the same file with CRLF.
- `json-merge-profile`: same entry plus module `other` with entry `other/a.txt`; `env` `SYNC_PROFILE=work-1`;
  `state/profiles/work-1.json` lists only `parity`; `state/profiles/work-1/parity/settings.json` sets `{"a": 3}`.
  Local file has `"a": 3` in the base's key position; `other/a.txt` is not imported and not listed.
- `import-block-written`: entry `claude/CLAUDE.md`, `merge: import`, `importName` `CLAUDE.{layer}.md`. Base text
  `# Base\n@RTK.md\n`, Linux layer `# Linux\n`. Local `CLAUDE.md` is the base text, the marker line, `@CLAUDE.linux.md`;
  `CLAUDE.linux.md` beside it holds `# Linux\n`. Both `CREATED`.

Test: `tests/parity/run.sh --engine dist/mksync json-` and `import-block` run and fail (not yet implemented, a status
or file mismatch, not a runner error); `tests/parity/run.sh` prints `SKIP` for the three.

## Step 8: Shared cases for push `[worker]`

Files: `tests/parity/cases/json-export-to-layer/`, `tests/parity/cases/json-new-setting-refused/`,
`tests/parity/cases/import-block-edit-not-pushed/`.

As step 7, failing until step 15.

- `json-export-to-layer`: layers as `json-merge-layers`; local file changes `"b": 2` to `"b": 5` and `"obj".k` to
  `"base2"`, with CRLF and keys reordered. `export`: the Linux layer gets `"b": 5`, the base gets `"k": "base2"`, both
  in the layout with LF; status per the contract; exit 0.
- `json-new-setting-refused`: same layers; local adds `"c": true`. `export`: status `ERROR`, note
  `new setting c: needs a destination`, no layer file changes, exit 0 (an `ERROR` affects only its file).
- `import-block-edit-not-pushed`: local `CLAUDE.md` from `import-block-written` with the block line changed to
  `@CLAUDE.other.md` and one base line edited. `export`: the base layer gets the edited line; the note
  `import block is written by mksync, edit not pushed` is printed; exit 0.

Test: as step 7, with `json-export`, `json-new-setting` and `import-block-edit`.

## Step 9: JSON values: parse and write `[worker]`

Files: `src/core/json/value.ts`, `src/core/json/value.test.ts`.

Decision 4. `parseJson(text) → Result<JsonValue>` and `writeJson(value, eol) → string`. `JsonValue` is a tagged union;
objects are `Map`s in source order; numbers keep their source text; strings are decoded. `jsonEqual(a, b)` compares
with object key order ignored. Unit cases: round trip of a file in the layout is byte-exact; `1.0`, `1e3`,
`12345678901234567890` survive; non-ASCII written raw; `\u00e9` read as `é` and written raw; empty `{}` and `[]`;
duplicate key, comment, trailing comma and trailing garbage each refused; `__proto__` and `constructor` as plain keys;
CRLF output; `jsonEqual` true for reordered keys, false for reordered array items.

Test: `bun test src/core/json && bun run lint`.

## Step 10: JSON merge `[worker]`

Files: `src/core/merge/json.ts`, `src/core/merge/json.test.ts`.

`merge(layers, eol)` per "Merging a JSON file" rules 1 to 5, on parsed layers (values already hydrated, as step
14 does). Unit cases, each a worked example: "Layers" (fontSize 14 base, proxy on `work-1`, 16 on the machine → 16 and
the proxy; personal gets 14 and no proxy); "Merging a JSON file" (`permissions.allow` git then PowerShell, `defaultMode`
from the base); rule 1 object in base and scalar in a later layer (later wins); rule 2 item equal with keys reordered
not repeated; rule 3 key order with keys only a later layer has; a layer that isn't valid JSON (`ERROR`, the
contract's note); `localOnlyKeys` taken from the local file, not the layers.

Test: `bun test src/core/merge/json.test.ts && bun run lint`.

## Step 11: JSON split `[worker:high: reasoning: attributing each change to the layer it came from across nested objects and arrays, with merge(split(x)) == x]`

Files: `src/core/merge/json.ts`, `src/core/merge/json.test.ts`.

`split(local, layers, destinations) → {perLayer, newSettings, errors}` per "Splitting a changed file": parse the
local file, compare with `merge(layers)`; a changed or removed key goes to the latest layer that sets it; a removed
array item is removed from the layer that added it; a new key or item goes to `destinations` when it names a layer,
else into `newSettings` (decision 3). `localOnlyKeys` are never in a change. Property: for every case,
`merge(apply(layers, split(...)))` equals the local file parsed. Unit cases: design cases 1 (base key), 2 (profile
key), 3 (new item, no destination → new setting; with `profile` destination → profile layer), 4 (removed base item →
base), 5 (Claude rewrites with own key order and a new allow item → only the item), 6 (new top-level key), 9 (CRLF
and reordering alone → no change); push right after pull → no change; a single layer → everything to it.

Test: `bun test src/core/merge/json.test.ts && bun run lint`.

## Step 12: `import` strategy `[worker]`

Files: `src/core/merge/import.ts`, `src/core/merge/import.test.ts`.

Decision 7 and design cases 7 and 8. `merge(layers, names, eol)` returns the local `CLAUDE.md` (base text, marker,
one `@` line per later layer present, in layer order) and the side files (`importName` with `{layer}` replaced).
`split(local, layers)` returns the base text change (CRLF folded) and `blockEdited: boolean`. Unit cases: case 7 (edit
above the marker → base), case 8 (block line changed or deleted → `blockEdited`, nothing stored), case 9 (CRLF alone →
no change), base only (no marker written), `@RTK.md` above the marker is base text, pull after push byte-exact.

Test: `bun test src/core/merge/import.test.ts && bun run lint`.

## Step 13: Profiles and layer roots `[worker]`

Files: `src/core/config/profile.ts`, `src/core/config/profile.test.ts`, `src/core/layers/select.ts`.

`parseProfile(text)` reads `modules`, `values`, `destinations`, `retired` ("Modules and profiles"); an unknown module
name or field is an error in the contract's wording. `selectEntries(config, {os, profile?, machine?}, files)` adds the
profile root `profiles/<name>/` and the machine root `machines/<name>/` after the OS root (paths as the snapshot names
them; the adapter maps them to state in step 16), and with a profile skips entries whose module the profile doesn't
list. The phase 4 `not supported yet` refusal goes. Update `src/core/layers/select.test.ts` for the new signature and
cases: no profile (as before), profile turning a module off, a module whose `os` excludes this OS staying off though
listed, four layers in order, a profile layer alone.

Test: `bun test src/core/config/profile.test.ts src/core/layers && bun run lint`.

## Step 14: Merge on import and check `[worker]`

Files: `src/core/plan/import.ts`, `src/core/plan/check.ts`, `src/core/plan/import.test.ts`.

Import and the check build a `json` or `import` entry with its strategy: each layer hydrated first, JSON-escaped for
`json` ("Values in JSON files"), then merged, CRLF on Windows; `import` also writes its side files, each with its own
status line and backup. `whole` goes through `strategyFor` too. Unit cases: two-layer JSON on Linux and on simulated
Windows (CRLF), a hydrated value with `\` and `"` in a later layer, an `import` entry with an OS layer, a layer that
isn't valid JSON (`ERROR`, other files go on).

Test: `bun test src/core/plan && bun run lint && bun run build && tests/parity/run.sh --engine dist/mksync json-merge
import-block-written`.

## Step 15: Split on export and preview `[worker]`

Files: `src/core/plan/export.ts`, `src/core/plan/preview.ts`, `src/core/plan/export.test.ts`.

Export and the preview split a `json` or `import` entry with its strategy: sanitize each changed layer before it's
written ("Values are sanitized before a change is stored"); new settings without a destination give the decision 3
`ERROR` and write nothing of that file; a block edit prints its note. Unit cases: the step 8 cases at unit level, plus
a sanitized value inside a changed key landing as its placeholder.

Test: `bun test src/core/plan && bun run lint && bun run build && tests/parity/run.sh --engine dist/mksync json-
import-block`.

## Step 16: Profile and machine from local state `[worker]`

Files: `src/adapters/snapshot.ts`, `src/adapters/snapshot.test.ts`, `src/main.ts`.

Decisions 1 and 2. Read `SYNC_PROFILE` and `SYNC_MACHINE` (names checked: lowercase letters, digits, `-`; else the
contract's `ERROR`, exit 2); load `<state>/profiles/<name>.json` and the files under `<state>/profiles/<name>/` and
`<state>/machines/<name>/` into the snapshot as `profiles/<name>/…` and `machines/<name>/…`; a missing profile file is
an error. Export writes a profile or machine layer change back to its state path. Unit cases with a temp state dir:
unset (no layers), profile with a layer file, unknown profile, bad name, machine layer.

Test: `bun test src/adapters/snapshot.test.ts && bun run lint && bun run build && tests/parity/run.sh --engine
dist/mksync`.

## Step 17: Repo JSON files in the layout `[worker:low]`

Files: `dotfiles/linux/claude-worker/settings.json`, `dotfiles/common/vscode/settings.json`.

Decision 5. Rewrite both with `writeJson(parseJson(text), "\n")` from step 9 (a throwaway `bun -e`, not committed).
Content unchanged: `jq -S . old` equals `jq -S . new`. `dotfiles/linux/claude/settings.json` is already in the layout.

Test: `for f in dotfiles/linux/claude-worker/settings.json dotfiles/common/vscode/settings.json; do diff <(git show
HEAD:$f | jq -S .) <(jq -S . $f) || exit 1; done && leak-scan && ! grep -rl "$HOME" dotfiles/`.

## Step 18: Docs `[inline: docs step, enriched per the docs rule]`

Files: `docs/sync-contract.md`, `docs/design-layers.md`, `docs/configuration.md`, `docs/layout.md`,
`docs/plan-single-engine.md`.

Contract: check every line steps 1 to 16 rely on matches the program. Design: "As built in phase 5" under "Code
layout" (`core/merge/`, `core/json/`, `core/paths.ts`, `adapters/snapshot.ts`); the boundaries review's leftovers that
steps 2 to 5 closed taken out of "Open"; what's left added. `configuration.md`: config v2 profiles and the two
variables, with a worked example; `layout.md`: the state folder's `profiles/` and `machines/`. Roadmap: phase 5 marked
done with the PR.

Test: `grep -c '^\*\*Done' docs/plan-single-engine.md` grows by one; `npx prettier --check docs/plan-single-engine-5.md`.
