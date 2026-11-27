# Plan: package drift in preview and push (v1.2.1)

On the personal Linux machine (11-27), `mksync doctor` says `WARN drift: 25 package(s) differ; run mksync preview`, but
`mksync preview` prints no `DRIFT` line. The contract ("Package drift") puts the report right after the orphan report
of an export and a preview; phase 8 step 18 built the adapter (`src/adapters/packages.ts`) but never wired it into
the export plan, and no shared case could catch it because the package managers had no stub. This plan wires it in,
gives the runners a `packages` stub so a shared case covers it, and makes an unknown `suggest` source point at
`mksync update` (a 1.1.10 program stopped on the 1.2.0 config with only "has an invalid suggest").

Decided:

- The program reads drift once per export or preview on Linux, when `packages/linux/` exists and no path is picked
  (`--only` or push paths), and the plan prints the lines after the orphan report. No count, no exit code, no write.
- `doctor` and export share one reader, so the doctor's count is always the number of lines preview prints.
- The `packages` stub puts `dpkg-query`, `apt-mark`, `snap`, `pipx` and `code` first on `PATH`; each prints the case's
  `tools/<name>.txt` (nothing when missing) and exits 0. The runner sets `DRIFT_ROOT` to an empty folder in the case,
  and refuses a case whose `repo/` has `packages/linux/` without the stub, so no case reads the real machine.

## Step 1: Runner `packages` stub `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `tests/parity/run.sh`, `tests/parity/run.ps1`, `tests/parity/README.md`.

`run.sh`: accept `packages` in `stubs`; write the five stubs into `$t/bin`; set `DRIFT_ROOT=$t/drift-root` (created
empty) for the case's commands; refuse a case with `repo/packages/linux/` and no `packages` stub
(`packages/linux/ needs the packages stub`). `run.ps1`: accept `packages` as a Linux-only stub like `dconf`. README:
the stub, `tools/`, the guard; drop "the package managers have no stub yet".

Test: `tests/parity/run.sh --engine dist/mksync dconf` still passes; `bash -n tests/parity/run.sh`.

## Step 2: Shared cases for drift `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `tests/parity/cases/preview-drift/`, `tests/parity/cases/export-drift/`, `tests/parity/cases/preview-drift-only/`.

All `"os": ["linux"]`, `"stubs": ["packages"]`, home with `.nvm/versions/node/v24.0.0/lib/node_modules/{listed,extra}`
and `.local/share/gnome-shell/extensions/extra@x`, `packages/linux/npm.txt` listing `listed` and `missing`,
`gnome-extensions.txt` empty, `tools/dpkg-query.txt` empty.

- `preview-drift`: `preview`; output has `DRIFT npm/extra (installed, not in packages/linux/npm.txt)`,
  `DRIFT npm/missing (in packages/linux/npm.txt, not installed)` and the extension line after the file lines; exit 0;
  nothing written.
- `export-drift`: `export --force`: the same lines; exit 0; files written as without drift.
- `preview-drift-only`: `preview` with `--only` a file: no `DRIFT` line (`! DRIFT` in `lines.txt`).

Test: `bun run build && tests/parity/run.sh --engine dist/mksync drift` fails on `preview-drift` and `export-drift`.

## Step 3: Wire drift into the export plan `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/core/plan/types.ts`, `src/core/plan/export.ts`, `src/app/export.ts` (or the snapshot reader),
`src/app/doctor.ts`, plus their tests.

`Snapshot.drift?: readonly string[]`, the report's lines, read by one app function (`readDriftReport(repoRoot, os,
home, env)`, moved out of `doctor.ts`) on Linux with `packages/linux/` and no picked path. `planExport` appends them to
the lines right after `orphanReport`, without touching `hits`, `skipped` or the code. `doctor` counts the `DRIFT`
lines of the same function.

Test: `bun test src/core/plan src/app && bun run build && tests/parity/run.sh --engine dist/mksync drift` passes.

## Step 4: Unknown `suggest` source names `mksync update` `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: the config check for `suggest`, its tests, `tests/parity/cases/suggest-invalid/` (expect only, if its message
changes), a new case `suggest-unknown-source`.

A `suggest` that is a string or list of strings, with a name this program doesn't know, stops with
`ERROR: sync-config.json: entry <file> has an unknown suggest source <name>; if the config is newer, run mksync update.`,
exit 2. A wrong shape keeps today's message.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync suggest` passes.

## Step 5: Docs and v1.2.1 `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `docs/sync-contract.md` ("Package drift": when the report is read, `--only` and push paths skip it; the doctor's
count equals preview's lines; the unknown-source message), `CHANGELOG.md` (v1.2.1), `package.json` (1.2.1),
`docs/daily-workflow.md` if it mentions drift.

Test: `npx prettier --check docs CHANGELOG.md && bun run lint`.
