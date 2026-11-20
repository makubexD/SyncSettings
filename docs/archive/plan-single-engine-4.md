# One engine, phase 4: core engine and test bench

Roadmap: `docs/plan-single-engine.md`, phase 4. Design: `docs/design-layers.md` (approved 2026-11-11). Goal: a Bun
program, `mksync`, whose pure core does what `export.sh` and `import.sh` do today (config, platforms, picking files,
sanitize and hydrate, compare, statuses, export, import, check, preview, backups), passes the shared cases on Linux,
in the local Windows VM and in CI on all three OSes, and runs in shadow mode next to the old engine.

## Shared rules

- Branch `engine/core`, one commit per step, one PR at the end. The PR touches `.github/workflows/`, so it waits for
  the user's `reviewed` label (CLAUDE.md, "Claude auto-approval").
- **Old engines frozen.** No change to `export.sh`, `import.sh`, `commit.sh`, `scripts/linux/`, `scripts/windows/`.
  The runners (`tests/parity/run.sh`, `run.ps1`) may change; every case's `expect/` stays as it is.
- **Contract first** (CLAUDE.md rule 2): step 2 writes the program's behavior into the contract before any code.
- **Public repo.** Fixtures use `example.com`, `/home/user`, `C:\Users\user`. `leak-scan` stays green.
- **Layout** from the design's "Code layout": `src/core/` never imports from `src/adapters/`, `node:fs`,
  `node:child_process` or `Bun.*` I/O. Tests sit next to their file (`foo.ts`, `foo.test.ts`).
- **Toolchain:** Bun 1.4.4 (as in the probe). Lint is `bun run lint` = `tsc --noEmit` with `strict`. No runtime
  dependencies; dev dependencies only `typescript` and `@types/bun`. ESLint is not added in this phase (goes in "Open").
- **Messages are the contract's.** Status words, notes, `ERROR:` lines and exit codes are copied from
  `docs/sync-contract.md`, never invented. A worker spec names the sections to copy from.
- Each worker step: at most 3 files, one concern, tests in the same step. Test commands run that step's tests only.

## Out of this phase

- `diff`, `commit`, the sync point base for `diff`, dconf export and import, package drift, linked folders, the
  `mksync` front door (status, doctor, setup, pull, push): phase 8. dconf entries are validated (config) but report
  `SKIPPED` with `not supported yet` in this phase. Shared cases for `diff` and `commit` are skipped by the runner
  for the program, each with a `SKIP` line.
- `json` and `import` merge types: phase 5. In this phase an entry with either type behaves as `whole` when exactly
  one layer holds its file, and stops with exit 1 (`ERROR: <file>: merge type json needs more than one layer; not
supported yet`) when two or more do. No entry has two layers before phase 5.
- Profiles, machines, modules turned on or off: phases 5 and 6. Every module in `sync-config.v2.json` is on.

## Decisions to confirm in review

These are proposals; the user's review of this plan confirms or changes them before `/next`. Step 2 writes them into
the contract.

1. **Engine verbs.** The program takes the old entry points' verbs and flags unchanged: `mksync export [--preview]
[--force] [--only <path>…]`, `mksync import [--check] [--force] [--only <path>…]`, plus `--version`. The runners
   spell commands for it exactly as for bash. Whether `export`/`import` stay public after cut-over goes in "Open".
2. **Config files.** The program reads `sync-config.v2.json` when it exists, else converts `sync-config.json` in
   memory with the same converter that made the v2 file. The shared cases only have v1, so they exercise the
   converter on every run.
3. **Where export writes a file no layer holds yet** (the design doesn't say; v2 entries have no `repoPath`): the base
   root when the entry has no `os` or more than one, else that OS's root. The converter fails on a v1 entry this rule
   wouldn't put back at its `repoPath`, so the config check catches any mismatch. Added to the design.
4. **Known differences** for the program. A row stays per OS only when the OS forces it:

   | Row                                   | The program                                                                                     |
   | ------------------------------------- | ----------------------------------------------------------------------------------------------- |
   | Export, local file missing            | the Linux note everywhere                                                                       |
   | Import, target folder missing         | creates the folder everywhere; the import check says `CREATE`                                   |
   | Exclude patterns                      | case-insensitive on Windows, case-sensitive elsewhere (the file system forces it)               |
   | Shared files without rules            | CRLF folded to LF on Windows, byte for byte elsewhere (kept: Git on Windows may check out CRLF) |
   | End of input at the overwrite prompt  | counts as yes everywhere                                                                        |
   | Status line layout                    | `WORD       label` everywhere, no color when stdout isn't a terminal                            |
   | Sanitized text that isn't valid UTF-8 | bytes kept everywhere                                                                           |
   | `defaultEnv` name check               | stops the run on an invalid name everywhere                                                     |
   | File modes                            | kept on Linux and macOS, not on Windows (forced)                                                |

   So the runners use a case's `expect.<os>/` for the program only for `Entry selection`, `Shared files without
rules` and `Exclude patterns`.

## Step 1: Prove the local Windows VM `[inline: time-boxed spike, 3 hours]`

Files: `tests/windows-vm/vm.sh`, `tests/windows-vm/README.md`, `docs/design-layers.md` ("Tests").

A Windows 11 evaluation image (90 days, version pinned by its ISO SHA256) in a podman container with KVM
(`dockurr/windows` at a pinned digest), 4 GB RAM, the repo mounted read-only and a scratch copy made inside. `vm.sh`:
`up` (start from the snapshot, wait for SSH or the shared-folder ready marker), `run '<powershell>'` (exit code passed
through), `down`, `status` (exit 0 only when up). Set it up once and snapshot it. Prove it by running the old
PowerShell engine's suite there: `run.ps1` and Pester, both green as in CI.

Record in "Tests": image and its SHA256, licence and expiry date, disk size, cold and snapshot start-up times. If it
doesn't work within the time box, write `Decision: no local Windows VM; Windows runs in CI and on the real-Windows
checklist.` with the reason, delete the scripts, and steps 25 and 27 drop their VM parts.

Test: `tests/windows-vm/vm.sh up && tests/windows-vm/vm.sh run 'powershell -NoProfile -ExecutionPolicy Bypass -File
tests/parity/run.ps1'`, exit 0; or `grep -c '^Decision: no local Windows VM' docs/design-layers.md` is 1.

## Step 2: The program's behavior in the contract `[inline: contract decisions]`

Files: `docs/sync-contract.md`, `docs/design-layers.md`.

- "Known differences": a third column, `mksync program`, with the table from decision 4. A sentence above the table:
  the program follows the Linux column unless its column says otherwise.
- A short section "The program" after "Front door": decision 1's verbs and flags, exit codes as the entry points',
  `--version` printing `mksync <version>`; until cut-over the front door still calls the old engines.
- Design "Config v2": decision 3 as a rule with an example (`git/.gitconfig.local`, one OS → OS root), and decision 2.
- Design "Open": whether `export`/`import` stay public after cut-over; ESLint for the TypeScript code.

Test: `grep -c 'mksync program' docs/sync-contract.md` is at least 1; `grep -c '^## The program' docs/sync-contract.md`
is 1; `grep -c 'no layer holds yet' docs/design-layers.md` is at least 1.

## Step 3: Bun in the project's TypeScript rules `[inline: .claude files; the worker can't write under .claude]`

Files: `.claude/rules/typescript-ts-npm.md`, `.claude/skills/ts-add-package/SKILL.md`.

Adapt both to Bun, as the design's "Runtime" says: `bun add -d`, `bun.lock` (text) committed, CI uses
`bun install --frozen-lockfile`, `bun audit` in place of `npm audit`, lifecycle scripts blocked by default
(`trustedDependencies` empty). Keep the vetting checklist (CVEs, types, licence, ESM) unchanged. Don't touch
`.claude/settings.json`.

Test: `grep -c 'npm ci\|npm install' .claude/rules/typescript-ts-npm.md .claude/skills/ts-add-package/SKILL.md` prints
0 for both; `grep -c 'frozen-lockfile' .claude/rules/typescript-ts-npm.md` is at least 1.

## Step 4: Project skeleton `[inline: dependency vetting with ts-add-package]`

Files: `package.json`, `tsconfig.json`, `bun.lock`, `src/main.ts`, `src/main.test.ts`, `.gitignore`.

Run `ts-add-package` for `typescript` and `@types/bun` (dev). `package.json`: `private: true`, `type: module`,
`engines.bun: 1.4.4`, scripts `test` (`bun test src`), `lint` (`tsc --noEmit`), `build` (`bun build --compile
src/main.ts --outfile dist/mksync`). `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `module`/`moduleResolution` `bundler`, `noEmit`. `src/main.ts` prints `mksync
<version>` for `--version` (version from `package.json`) and exits 2 with a usage line otherwise. `.gitignore` adds
`node_modules/` and `dist/`.

Test: `bun install --frozen-lockfile && bun run lint && bun test src && bun run build && ./dist/mksync --version`.

## Step 5: v1 config loader `[worker]`

Files: `src/core/config/types.ts`, `src/core/config/v1.ts`, `src/core/config/v1.test.ts`.

`types.ts`: the v1 shape (`docs/configuration.md`) and the v2 shape (design "Config v2", every field, `merge` as a
union). `v1.ts`: `parseV1(text: string): Result<ConfigV1, ConfigError>`, pure, with every validation rule the
contract states for the config: "Entry selection" (missing `platform`, a list's allowed names), "Path safety"
(`..` in `repoPath`, `only` paths), "`localPath`" (absolute paths, `localPaths` keys), and `defaultEnv` names
("Sanitize and hydrate"). Each error carries the contract's exact `ERROR:` text and exit code 1.

Tests: one per rule, named after the shared case that covers it where there is one (`platform-missing`,
`localpaths-bad-key`, `repo-path-dotdot`, `local-path-absolute`, `defaultenv-invalid`, `dconf-path-no-slash`), plus
invalid JSON and a valid config with one entry of each type.

Test: `bun test src/core/config/v1 && bun run lint`.

## Step 6: v2 config loader `[worker]`

Files: `src/core/config/v2.ts`, `src/core/config/v2.test.ts`.

`parseV2(text)`: design "Config v2", "Top level" and "An entry". Errors: `schemaVersion` not 2 →
`unsupported config schemaVersion <n>` (exit 2, checked before any other field); an entry's `module` not in
`modules`; `merge` not one of the five; `escapeBackslashes` on a `json` entry; `elevate` other than `false`;
`importName` without `{layer}` on an `import` entry; `localPath` with a backslash; `os` outside the module's `os`.

Tests: one per error, plus `docs/config-v2.example.json` loading clean.

Test: `bun test src/core/config/v2 && bun run lint`.

## Step 7: v1 to v2 converter `[worker]`

Files: `src/core/config/convert.ts`, `src/core/config/convert.test.ts`.

`convertV1(config: ConfigV1): Result<ConfigV2, ConfigError>`, pure, applying the design's table "v1 to v2, field by
field" and decision 3. Every converted entry gets `module: "unsorted"` and the result has one module of that name with
no `os`; step 8 sorts them by hand. v1 entries that differ only by OS folder become one entry (same `file`, same
`localPath`/`localPaths`, same sanitize rules); if they differ in anything else they stay separate, each with `os`.
A v1 entry that decision 3 wouldn't write back at its `repoPath` fails with `ERROR: <repoPath>: no v2 layer root
matches this path`.

Tests: one per table row; the three `.gitconfig.local` entries becoming one; a `["linux", "macos"]` entry under
`dotfiles/common/` (`os` set, base root); a repoPath outside `dotfiles/<platform>/` failing; `~\` and `\` rewritten.

Test: `bun test src/core/config/convert && bun run lint`.

## Step 8: Write `sync-config.v2.json` `[inline: modules and merge types are the catalog's judgment]`

Files: `sync-config.v2.json`, `tools/convert-config.ts`.

`tools/convert-config.ts` reads `sync-config.json`, runs `convertV1` and prints the v2 JSON (two-space indent,
trailing newline). Run it once. Then by hand, from the design's "Catalog" and "Modules and profiles": real module
names and descriptions in place of `unsorted`, `merge: json` and `merge: import` where the catalog says, `scanLinks`
for `detectLinkedPaths` entries. No values, no profile or machine names. `tools/` is dev-only and never compiled into
the program.

Test: `bun run tools/convert-config.ts > /dev/null && bun -e 'import {parseV2} from "./src/core/config/v2"; const r =
parseV2(await Bun.file("sync-config.v2.json").text()); if (!r.ok) { console.error(r.error); process.exit(1) }'`;
`grep -c unsorted sync-config.v2.json` is 0; `leak-scan` green.

## Step 9: v1 and v2 kept in step `[worker]`

Files: `src/core/config/check.ts`, `src/core/config/check.test.ts`, `tools/check-config.ts`.

`checkV1V2(v1, v2): string[]`, the mismatches the design's "v2 while the old engines read v1" lists: for every v1
entry a v2 entry with the same layer file, the same local path on each OS, the same placeholders and the same dconf
keys, and the reverse. One line per mismatch, naming the v1 `repoPath` or v2 `file`. `tools/check-config.ts` loads
both files, prints the lines and exits 1 when there are any.

Tests: in step; each kind of mismatch, both directions; `json` vs `whole` on the same entry is not a mismatch.

Test: `bun test src/core/config/check && bun run tools/check-config.ts && bun run lint`.

## Step 10: Which entries apply `[worker]`

Files: `src/core/layers/select.ts`, `src/core/layers/select.test.ts`.

`selectEntries(config: ConfigV2, os, files: Set<string>)`: the entries for this OS (module `os`, entry `os`), each with
its layer files in order (base, OS) found in `files`, the repo paths in the snapshot, and the root export writes to
(decision 3). Contract "Entry selection" and "Which system" for the OS name; profile and machine roots are not read yet.

Tests: each of `platform-picks-os` (all three OSes), `platform-list-common`, an entry with no layer file (applies for
export, the status depends on the plan), the base and OS layer both holding a `whole` file (OS wins), and a `json`
entry with two layers returning the phase-5 error.

Test: `bun test src/core/layers && bun run lint`.

## Step 11: Sanitize and hydrate `[worker]`

Files: `src/core/values/sanitize.ts`, `src/core/values/hydrate.ts`, `src/core/values/values.test.ts`.

Pure functions on bytes (`Uint8Array`), so invalid UTF-8 is kept (decision 4). Contract "Sanitize and hydrate":
longest value first, `escapeBackslashes`, `default`, `defaultEnv` (read from an env map passed in), inferring a value
from the local file, a missing value stopping the run with the contract's message, and for a file ending in `.json`
JSON-escaping the hydrated value (design "Values"). Values come from the v1 `.user-values.json` shape passed in.

Tests: mirror `sanitize-longest-first`, `sanitize-round-trip`, `hydrate-creates`, `hydrate-escape-backslashes`,
`infer-value`, `missing-value-stops`, `defaultenv-invalid`, plus a JSON file whose value holds `"` and `\`, and bytes
`0xff 0xfe` surviving a round trip.

Test: `bun test src/core/values && bun run lint`.

## Step 12: Compare and statuses `[worker]`

Files: `src/core/compare.ts`, `src/core/status.ts`, `src/core/compare.test.ts`.

`same(repoBytes, localBytes, {os, sanitized})`: contract "Compare", with decision 4's CRLF row (fold on Windows for
shared files without rules). `status.ts`: the status words of contract "Statuses" as a union, and `formatLine(word,
label, note?)` printing `WORD       label` (word padded as the bash engine pads it) with the note in parentheses.

Tests: mirror `common-crlf` (Linux and Windows), `sanitized-crlf-unchanged`, plus every status word formatting.

Test: `bun test src/core/compare && bun run lint`.

## Step 13: Export plan `[worker]`

Files: `src/core/plan/export.ts`, `src/core/plan/export.test.ts`, `src/core/plan/types.ts`.

`types.ts`: the snapshot (config, OS, repo files with bytes, local files with bytes and mode, values, env, `only`) and
the actions (`writeRepo`, `removeRepo`, `writeLocal`, `backup`, `mkdir`, `chmod`, `writeState`) plus output lines.
`planExport(snapshot)`: contract "Statuses › Export", "Exclude patterns", "Directory entries" (export side,
`REMOVED`), "Orphan report", `--only` from "Path safety", decision 3 for `ADDED`. dconf entries: `SKIPPED` with
`not supported yet`. The summary line as the contract's "Flow" gives it.

Tests: mirror every export shared case (`export-*`, `dir-export-removed`, `orphan-reported`, `only-dotdot`,
`platform-*`, `sanitize-longest-first`).

Test: `bun test src/core/plan/export && bun run lint`.

## Step 14: Import plan `[worker]`

Files: `src/core/plan/import.ts`, `src/core/plan/import.test.ts`.

`planImport(snapshot, answers)`: contract "Statuses › Import", "Overwrite prompt" (answers come in as a list; end of
input counts as yes), "Backups", "Directory entries" (import side, `EXTRA`), decision 4's target-folder row (`mkdir`),
and "Sync point": emit `writeState(last-sync, HEAD)` only under every condition listed there (HEAD and the porcelain
result are in the snapshot). `--force` skips the prompt, never the backup.

Tests: mirror every import shared case (`import-*`, `hydrate-*`, `dir-import-extra`, `infer-value`,
`missing-value-stops`, `only-one-file`, `only-not-synced`), plus each sync-point condition that stops the write.

Test: `bun test src/core/plan/import && bun run lint`.

## Step 15: Check and preview `[worker]`

Files: `src/core/plan/check.ts`, `src/core/plan/preview.ts`, `src/core/plan/check.test.ts`.

`planCheck(snapshot)`: contract "Import check" (`CREATE`, `UPDATE`… words, exit 3 on changes, writes nothing).
`planPreview(snapshot)`: contract "Export preview", comparing the exported result with the repo's `HEAD` bytes from
the snapshot; `--only` refused as the contract says. Both return no write actions; a test asserts it.

Tests: mirror `check-one-change`, `preview-no-change`, `preview-only-refused`, plus a preview with one change.

Test: `bun test src/core/plan/check && bun run lint`.

## Step 16: File adapter `[worker]`

Files: `src/adapters/fs.ts`, `src/adapters/paths.ts`, `src/adapters/fs.test.ts`.

`paths.ts`: `~/` to the home folder (`HOME`, or `USERPROFILE` on Windows) and `/` to `\` on Windows; the state folder
per OS (contract "Sync point"). `fs.ts`: build the snapshot from disk (only the files the selected entries name, plus
`dotfiles/` for the orphan report) and run actions: writes keep the target's mode (`chmod --reference` behavior),
backups copy mode and times (`cp -p`), modes skipped on Windows, errors per file turned into `ERROR` lines, never
thrown. Tests run in a temp folder.

The run-time rules this step first held (dated backups, a created file's mode, the sync point after an error) moved
to steps 17 to 20, together with the error model they need.

Test: `bun test src/adapters/fs && bun run lint`.

## Run, then render (steps 17 to 20)

Found reviewing step 16: the plans write every status line, the applied count, the `Sync point :` line and the exit
code before anything is written. When a write then fails, the bash engine (`import.sh`, `export.sh`) prints `ERROR`
with the repo path and a fixed reason (`cannot create backup`, `cannot write local file`, `cannot copy to repo`, …)
_in place of_ that file's line, stops working on that file (a failed `.bak` means no overwrite), leaves it out of the
count and records no sync point; the run still exits 0 (contract "Statuses"). Decision (user, 2026-11-12): the core
groups each file's actions with its label and reasons, the adapter runs the groups and reports what failed, and a pure
core function renders the lines from that result. Output stays in the core.

## Step 17: Run plan and render `[worker]`

Files: `src/core/plan/types.ts`, `src/core/plan/run.ts`, `src/core/plan/run.test.ts`.

Additive only; `Plan` and the planners stay as they are until steps 18 and 19. In `types.ts`:

- `StepAction { action: Action; failure: string }`: `failure` is the contract's reason when that action fails.
- `FileStep { label: string; line: number; counted: boolean; actions: readonly StepAction[] }`: `line` is the index
  of the file's status line in `RunPlan.lines`; `counted` means it counts towards the summary's count.
- `BackupAction` gets an optional `repoPath` (where the dated copy goes); `WriteLocalAction` gets an optional
  `modeFrom` (a repo path whose mode a created file copies, `cp -p`).
- `Summary`: `{ kind: "import"; onlyMatchedNothing: boolean; syncPoint?: string }` or
  `{ kind: "export"; onlyMatchedNothing: boolean; … }` with whatever else `summaryLines` in `export.ts` reads
  besides its count.
- `RunPlan { steps: readonly FileStep[]; finish: readonly Action[]; lines: readonly string[]; summary: Summary;
code: number }`: `lines` holds the body only; `finish` (the `writeState`) runs only when no step failed.
- `RunOutcome { failed: ReadonlyMap<number, string>; warnings: ReadonlyMap<number, readonly string[]>;
backups?: string }`, keyed by step index; `NO_FAILURES` is the empty outcome.

`run.ts`: `renderRun(plan, outcome): { lines; code }`. Body lines are copied; a failed step's line becomes
`formatLine("ERROR", label, reason)`; a step's warnings go right before its line. Then the summary, with the same
text as `summaryLines` in `import.ts` and `export.ts` today (they move here in steps 18 and 19); the count is the
counted steps that didn't fail. Import: `  Backups    : <folder>` and a blank line after the applied line when
`backups` is set, and the `Sync point :` lines only when nothing failed (order as in `import.sh`'s summary).
`code` is the plan's.

Tests: no failures renders as the planners' current output, for import and export; one failed step gets
`ERROR <label> <reason>` in place of its line and a count one lower; a failure drops `Sync point :`; a warning sits
before its step's line; `Backups    :` sits between the applied line and `Sync point :`.

Test: `bun test src/core/plan/run && bun run lint`.

## Step 18: Import plan as file steps `[worker]`

Files: `src/core/plan/import.ts`, `src/core/plan/import.test.ts`, `src/core/plan/check.ts`.

`planImport` returns a `RunPlan`: each file's `mkdir`, `backup` and `writeLocal` actions become one `FileStep` with
its status line's index, and `counted` where it added to `applied`. Reasons from `import.sh`: `mkdir` →
`cannot create <folder>`, `backup` → `cannot create backup`, `writeLocal` → `cannot write local file`. `backup` sets
`repoPath`; a `CREATED` write sets `modeFrom` to the repo path (drop the `shortcut:` comment). The `writeState` goes
in `finish`. `summaryLines` is deleted; `check.ts` renders with `renderRun(plan, NO_FAILURES)`. Tests assert
`renderRun(plan, NO_FAILURES).lines`, unchanged in content, plus the steps for an `UPDATED` and a `CREATED` file.

Test: `bun test src/core/plan/import src/core/plan/check && bun run lint`.

## Step 19: Export plan as file steps `[worker]`

Files: `src/core/plan/export.ts`, `src/core/plan/export.test.ts`, `src/core/plan/preview.ts`, `src/core/plan/types.ts`.

As step 18 for export: `mkdir` → `cannot create <folder>`, `writeRepo` → `cannot write repo file` for a sanitized
entry and `cannot copy to repo` otherwise, `chmod` → `cannot copy file mode`, `removeRepo` →
`cannot remove from repo` (reasons from `export.sh`). `preview.ts` renders with `NO_FAILURES`. Then delete the old
`Plan` type if nothing else uses it.

Test: `bun test src/core/plan && bun run lint`.

## Step 20: Run a plan's steps `[worker]`

Files: `src/adapters/fs.ts`, `src/adapters/fs.test.ts`.

`runPlan(plan: RunPlan, context): RunOutcome` replaces `runActions`. Steps run in order, each stopping at its first
failed action, which records that action's `failure` (not the system's message). `finish` runs only when no step
failed. A `backup` with `repoPath` also makes the dated copy (contract "Backups"): `<state folder>/backups/<run>/
<repoPath>`, `<run>` = `YYYYMMDD-HHMMSS-<pid>` in local time from a clock and pid in `RunContext` (so tests are
fixed), the folder created at the first copy, mode and times kept; a failed copy adds the warning
`  WARNING: could not keep a dated backup of <repoPath>.` and the step goes on; after the run the newest 20 run folders
are kept, sorted by name, and `backups` is set when a copy was made. A `writeLocal` with `modeFrom` copies that repo
file's mode (not on Windows).

Tests: a failed `.bak` stops the overwrite and reports `cannot create backup`; the next step still runs; a failure
skips `finish`; a dated copy lands under the run folder with mode and times; a failed dated copy warns and the write
still happens; 21 run folders become 20; a created file copies the repo file's mode.

Test: `bun test src/adapters/fs && bun run lint`.

## Step 21: Git adapter `[worker]`

Files: `src/adapters/git.ts`, `src/adapters/git.test.ts`.

With `Bun.spawn` and argument arrays (no shell): `HEAD` SHA, `git status --porcelain -- dotfiles sync-config.json`
empty or not, the bytes of a path at `HEAD`, and whether a SHA exists. A folder that isn't a git repo gives "no HEAD",
not an exception. Tests use a temp repo.

Test: `bun test src/adapters/git && bun run lint`.

## Step 22: Command line `[worker]`

Files: `src/cli/parse.ts`, `src/cli/parse.test.ts`, `src/main.ts`.

`parse.ts`: decision 1's verbs and flags; an unknown option prints `Unknown option: <arg>` on stderr and exits 1;
`--only` takes the paths after it as the entry points do. `main.ts`: find the repo (the folder holding
`sync-config.json` or `sync-config.v2.json`, starting at the program's working directory), load the config (decision
2), build the snapshot, run the plan, apply its actions, print its lines, exit with its code. Prompts read stdin one
line at a time; end of input counts as yes.

Test: `bun test src/cli && bun run lint && bun run build && ./dist/mksync export --bogus; test $? -eq 1`.

## Step 23: The runners take the program `[worker]`

Files: `tests/parity/run.sh`, `tests/parity/run.ps1`, `tests/parity/README.md`.

`run.sh --engine <path>` and `run.ps1 -Engine <path>`: copy that one program into the temp repo as `mksync`
(`mksync.exe`) in place of the engine scripts, spell commands as `./mksync export …` with the same options, and strip
it before comparing the repo. With a program: a case with a `diff` or `commit` command prints `SKIP <case>: <command>
comes in phase 8` and doesn't count as a failure; `expect.<os>/` is used only when the case's `differences` name
`Entry selection`, `Shared files without rules` or `Exclude patterns`; `import-eof-no-force` runs on every OS. Without
the option nothing changes. README: the option and the skip rule.

Test: `tests/parity/run.sh` (old engine, all green as before); `bun run build && tests/parity/run.sh --engine
dist/mksync export-unchanged`.

## Step 24: Shared cases green on Linux `[inline: debugging]`

Files: whatever under `src/` the failures point to.

`bun run build && tests/parity/run.sh --engine dist/mksync`. Each failure is a bug in the program unless the contract
says otherwise; fix it with a unit test that fails first. Use `ts-debugger` for a failure not settled in two tries.
`expect/` is never edited.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync` exits 0, with only the three `SKIP` lines.

## Step 25: One local test command `[worker]`

Files: `tests/all.sh`.

The design's "Tests": in order, stopping at the first failure: `bun run lint`, `bun test src`, `bun run
tools/check-config.ts`, `bun run build`, `tests/parity/run.sh --engine dist/mksync`, `tests/parity/run.sh`; then, when
`tests/windows-vm/vm.sh status` exits 0, build `dist/mksync.exe` (`--target bun-windows-x64`) and run `run.ps1
-Engine` and `run.ps1` in the VM; else print `Windows: VM not running, skipped`. Each layer prints one line with its
name and result.

Test: `tests/all.sh` exits 0.

## Step 26: CI builds and tests the program `[worker]`

Files: `.github/workflows/ci.yml`.

A job `program-build` on `ubuntu-latest`: Bun 1.4.4 (`oven-sh/setup-bun` pinned by SHA), `bun install
--frozen-lockfile`, lint, unit tests, `tools/check-config.ts`, then `bun build --compile` for `bun-linux-x64`,
`bun-linux-arm64`, `bun-darwin-arm64`, `bun-windows-x64`, uploaded as one artifact `mksync-<sha>` (14 days), and the
shared cases against the Linux program. Jobs `program-macos` and `program-windows` download that artifact and run the
shared cases against the cross-built program on their runners (settles the design's "Not measured" item about
cross-builds). The `lint` job's ShellCheck line adds `tests/all.sh` and `tests/windows-vm/vm.sh`. The existing jobs
stay as they are otherwise.

Test: `actionlint .github/workflows/ci.yml` if installed, else `python3 -c 'import yaml,sys;
yaml.safe_load(open(".github/workflows/ci.yml"))'`; the jobs go green on the branch push (checked in step 30).

## Step 27: Shared cases green on Windows `[inline: VM runs and debugging]`

Files: whatever under `src/` the failures point to.

`tests/all.sh` with the VM up. Fix failures as in step 24. A case the VM can't run goes on the real-Windows checklist
in the design's "Tests", with the reason. Without a VM (step 1's fallback), this step reads the `program-windows` CI
job instead.

Test: `tests/all.sh` with the VM up exits 0, or `program-windows` is green.

## Step 28: Shadow mode `[worker]`

Files: `src/cli/shadow.ts`, `src/cli/shadow.test.ts`, `src/main.ts`.

`mksync shadow`, hidden from help (name in "Open"): in the clone it lives in, run the program's import check and
export preview plans (no writes), run the old engine's `import.sh --check` and `export.sh --preview` (`sync.cmd` entry
points on Windows), and compare both sides as the runner does: the status word and label per file, and the
placeholders in each exported file. Print `shadow: same` or one line per difference, append them with a timestamp to
`<state folder>/shadow.log`, exit 0 when same, 3 when not. It never writes in the repo or home. Tests feed it two
canned outputs.

Test: `bun test src/cli/shadow && bun run lint`.

## Step 29: Shadow on this machine `[inline: real machine, read-only]`

Run `mksync shadow` from a fresh build in this clone (it writes only to the state folder). Explain or fix each
difference; a fix gets a unit test, and a rule the shared cases miss gets a shared case (CLAUDE.md rule 2). Record the
result, redacted, in the design's "Tests": `Shadow on personal Linux, 2026-11-<dd>: same` or the explained
differences. Windows machines run it on the real-Windows checklist (added to that list).

Test: `./dist/mksync shadow` exits 0, or every difference it prints is listed as explained in the design.

## Step 30: Boundaries review `[inline: review]`

Run `ts-architecture-reviewer` on `src/` against the design's "Code layout" and `ts-security-auditor` on
`src/core/values/` and `src/adapters/`. Fix high findings in this step; the rest go in "Open". Then push the branch
and read the CI run: every job green, including the three new ones.

Test: `! grep -rnE "from ['\"](node:fs|node:child_process|\.\./\.\./adapters|\.\./adapters)" src/core`; the CI run on
the branch is green.

## Step 31: Docs `[inline: docs]`

Files: `docs/sync-contract.md`, `docs/design-layers.md`, `docs/configuration.md`, `docs/layout.md`, `CLAUDE.md`,
`README.md`.

- Contract: anything steps 24, 27 and 29 settled; the program column checked against the code.
- Design: "Tests" (VM, shadow result, real-Windows checklist additions), "Not measured" updated from the CI run,
  "Open" with what this phase left.
- `configuration.md`: `sync-config.v2.json`, the converter and the check, and that both files change together until
  cut-over.
- `layout.md`: `src/`, `tools/`, `tests/all.sh`, `tests/windows-vm/`, `package.json`, `bun.lock`.
- `CLAUDE.md` "Tests": `tests/all.sh`, `bun test`; "TypeScript engine": the toolchain is approved and in place.
- `README.md`: one line that a compiled `mksync` is being built and isn't used by the installers yet.

Test: `grep -c 'tests/all.sh' CLAUDE.md docs/layout.md` is at least 1 each; `grep -c 'sync-config.v2.json'
docs/configuration.md` is at least 1; `tests/all.sh` exits 0.

## Review fixes (finish review, 2026-11-12)

The finish's `/agent-skills:review` (two `code-reviewer` passes on correctness, tests and performance at commit
`6d5fd1f`) left the Required findings below. The review is done: after step 40 the finish resumes at its step 3 (full
suite), not a second review. Shared cases come first where the case format can express the rule; where it can't
(write failures, symlinks in `home/`, uncommitted repo changes), unit tests cover it and step 40 records the harness
gap in "Open".

## Step 32: Shared cases for --only inference, export --force and non-string values `[worker]`

Files: `tests/parity/cases/only-infers-from-all/`, `tests/parity/cases/export-force-unknown/`,
`tests/parity/cases/values-non-string/` (format: `tests/parity/README.md`; copy `only-one-file` as the model).

- `only-infers-from-all`: two `common` entries `a.conf`, `b.conf`, both repo files hold `name=<USER>` and the config
  rule `{placeholder: "<USER>", pattern: "name=(.*)"}` style used by `infer-value` (copy its rule shape). `home/` holds
  only `b.conf` with `name=alice`; no values file. Command: `import --force --only dotfiles/common/parity/a.conf`.
  Expect exit 0, `CREATED dotfiles/common/parity/a.conf`, `home/` with `a.conf` = `name=alice` and `b.conf` untouched,
  `expect/values.json` `{"<USER>": "alice"}` (bash infers over every entry, contract "Values").
- `export-force-unknown`: one entry; command `export` with option `force: true`. Expect exit 1, no status lines, repo
  unchanged (bash `export.sh` rejects `--force` as an unknown option).
- `values-non-string`: `values` `{"<PORT>": 8080}`, one entry whose repo file holds `port=<PORT>`; `import --force`.
  Expect exit 0, `CREATED`, home file `port=8080`, `expect/values.json` `{"<PORT>": "8080"}` (bash reads values with
  jq `tostring`).

If the runner can't pass a needed option, stop and report; don't change the runner.

Test: `tests/parity/run.sh only-infers-from-all && tests/parity/run.sh export-force-unknown && tests/parity/run.sh
values-non-string` all pass on bash. Against `bun run build && tests/parity/run.sh --engine dist/mksync <name>`, the
first two fail (expected until steps 35 and 39); record the third's result in the summary.

## Step 33: `env` in shared cases, and OS and home cases `[worker]`

Files: `tests/parity/run.sh`, `tests/parity/run.ps1`, `tests/parity/README.md`, plus cases
`tests/parity/cases/sync-os-windows-off-windows/` and `tests/parity/cases/home-unset/`.

- New optional `case.json` field `env`: an object of variable name to string (set for every command) or `null`
  (unset for every command). Applied after the runner sets `HOME`/`USERPROFILE`, so `{"HOME": null}` unsets it. Same in
  `run.ps1`. README: one row in the field table.
- `sync-os-windows-off-windows`: `env {"SYNC_OS": "windows"}`, command `import --check`; expect exit 1, no status
  lines, home unchanged. It must not run on Windows: use the README's existing per-OS mechanism; if there is none, skip
  it in both runners when the harness OS is `windows` and document that in the README.
- `home-unset`: `env {"HOME": null, "USERPROFILE": null}`, command `import --force`, one entry; expect exit 1, no
  status lines, repo unchanged.

Test: `tests/parity/run.sh sync-os-windows && tests/parity/run.sh home-unset` pass on bash; the whole
`tests/parity/run.sh` still passes.

## Step 34: OS, home and values in the program `[worker]`

Files: `src/main.ts`, `src/core/layers/select.ts`, `src/adapters/git.ts`, and their tests.

- `select.ts` `pickOs(syncOs, host)` takes the host family: on a `win32` host the only accepted `SYNC_OS` is
  `windows`; elsewhere only `linux` or `macos`. Unset or empty: the host's own OS. Anything else: the existing
  `unsupportedOs` error, exit 1. `main.ts` uses it and deletes `resolveOs`.
- `main.ts`: when `homeFolder(...)` is undefined or empty, stop before planning with
  `ERROR: the home folder is not set (HOME).` (`USERPROFILE` on Windows) and exit 1.
- `main.ts` values reader: a number or boolean value becomes `String(value)`, `null` becomes `"null"`, an object or
  array `JSON.stringify(value)` (jq `tostring`), so saving the file keeps them.
- `git.ts` `readPorcelain`: add `sync-config.v2.json` to the paths.
- Unit tests: `pickOs` for each host/value pair; the values reader for 8080, true, null; porcelain path list.

Test: `bun test src/core/layers src/adapters/git.test.ts src/main.test.ts && bun run lint && bun run build &&
tests/parity/run.sh --engine dist/mksync sync-os-windows && tests/parity/run.sh --engine dist/mksync home-unset &&
tests/parity/run.sh --engine dist/mksync values-non-string`.

## Step 35: Import inference and error reasons `[worker]`

Files: `src/core/plan/import.ts`, `src/core/plan/export.ts`, and their tests.

- `import.ts` `collectRules`: infer values from every selected entry whose repo and local files exist, ignoring
  `--only`; `--only` filters only which files are planned. Inferred values from unselected entries are saved like any
  other inferred value.
- Failure reasons as bash: import plain-file and `dir`-file copy failures are `cannot copy from repo`
  (`import.sh:166,178`); hydrated writes stay `cannot write local file`. Export `dir`-file parent failures are
  `cannot create parent folder` (`export.sh:227`); export file-entry parent failures are `cannot create <absolute
repo dir>` (`export.sh:140`).
- Unit tests for each reason and for inference under `--only` (the step 32 scenario).

Test: `bun test src/core/plan && bun run lint && bun run build && tests/parity/run.sh --engine dist/mksync only-`.

## Step 36: Preview sees deletions and the config `[worker]`

Files: `src/adapters/git.ts`, `src/main.ts`, `src/core/plan/preview.ts`, and their tests.

- `git.ts`: `readHeadTree(repoRoot)` lists `git ls-tree -r -z --full-tree HEAD -- dotfiles sync-config.json` and reads
  the blobs with one `git cat-file --batch`, returning path to bytes; no process per file.
- `main.ts`: the preview's `headFiles` come from `readHeadTree`; the working tree side includes `sync-config.json`.
- `preview.ts`: a path in HEAD but not in the exported tree is a difference (already true by size; add the test), and
  `sync-config.json` is compared like any file.
- Unit tests: HEAD has a file the working tree lacks; the config differs; both equal gives "Nothing would be sent".

Test: `bun test src/core/plan/preview.test.ts src/adapters/git.test.ts && bun run lint && bun run build &&
tests/parity/run.sh --engine dist/mksync preview`.

## Step 37: A plain-file entry follows a local symlink `[worker]`

Files: `src/adapters/fs.ts`, `src/core/plan/import.ts`, `src/core/plan/export.ts`, and their tests.

Both old engines follow a symlink at a file entry's `localPath` (`[[ -f ]]`, `Test-Path`): export compares and copies
the target's bytes, import compares and writes through the link, which stays a link. Do the same: the snapshot reads a
file entry's local path through a link (a link to a missing target is "local file not found"); import writes to the
path without replacing the link. Inside `dir` entries links stay skipped as today. Unit tests: export and import
through a link, the link still a link after import, a dangling link.

Test: `bun test src/adapters/fs.test.ts src/core/plan && bun run lint`.

## Step 38: v2 validation and a full config check `[worker]`

Files: `src/core/config/v2.ts`, `src/core/config/check.ts`, and their tests.

- `parseV2`: every entry needs `file` and `localPath` as strings; `os` on an entry or module, when present, must be
  an array of `linux`, `macos`, `windows`; anything else is a load error naming the entry.
- `checkV1V2`: compare `convertV1(v1)` with v2 per (file, os) on `localPath`, `merge`, every sanitize rule field
  (placeholder, pattern, replacement form, `escapeBackslashes`), `excludePatterns`, `scanLinks`, `localOnlyKeys` and
  dconf, one line per differing field.
- Unit tests: each bad entry shape; each field difference reported; today's two config files still "in step".

Test: `bun test src/core/config && bun run lint && bun tools/check-config.ts`.

## Step 39: export --force is unknown `[worker]`

Files: `src/cli/parse.ts`, `src/cli/parse.test.ts`, `docs/sync-contract.md`.

- `FLAGS.export` is `["--preview"]`; `export --force` prints `Unknown option: --force` and exits 1 as bash does.
- Contract "Not in the program yet": add `import --reset-values`.

Test: `bun test src/cli && bun run lint && bun run build && tests/parity/run.sh --engine dist/mksync
export-force-unknown`.

## Step 40: Review fixes in the docs `[inline: docs]`

Files: `docs/sync-contract.md`, `docs/design-layers.md`, `tests/parity/README.md`.

- Contract: `SYNC_OS` per host, home folder not set, non-string values, inference over every entry, file-entry
  symlinks, preview covering deletions and the config.
- Design "Open": harness can't express write failures, symlinks in `home/` or uncommitted repo changes; order of files
  in a `dir` entry is locale-dependent in bash (`sort -z`), the program sorts by code unit (decide `LC_ALL=C`);
  `check.ts` matches its own error text; `isExcluded` compiles patterns per file; mutation survivors (inference first
  match, sanitize doubled-form order, tie-break order, `EXTRA` excludes, `\r` in inference, `paths.ts` `~\` and
  trailing separator, `elevate`); `ci.yml` artifact actions pinned by tag.

Test: `tests/all.sh` exits 0.
