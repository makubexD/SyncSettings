# One engine, phase 1: research

Roadmap: `docs/plan-single-engine.md`. Goal: decide, with evidence, whether one compiled TypeScript engine replaces the
bash and PowerShell engines, and with which runtime. This phase changes no engine code. Its output is
`docs/single-engine-research.md`, a probe, three draft shared cases, and one decision from the user.

## Shared rules

- Branch `research/single-engine`, one commit per step, one PR at the end. The PR adds a workflow, so it waits for the
  user's `reviewed` label (CLAUDE.md, auto-approval rule 3).
- The probe workflow runs on `workflow_dispatch` and on pushes to `research/single-engine`, is never a required check,
  and always ends green.
- Never `[worker]` a step whose output is judgment (classifying, designing, choosing); the worker may write the probe
  and the runner.
- The research doc cites `file:line` for every claim about the code, and the probe run's URL for every measurement.

## Step 1: Inventory `[inline: research]`

Files: `docs/single-engine-research.md` (new).

- One row per `docs/sync-contract.md` section: lines of code in each engine (`file:line` ranges), cases in
  `tests/linux/engine.sh` and `tests/windows/Engine.Tests.ps1`, and the outside tools it calls (`git`, `gh`, `jq`, `cmp`,
  `dconf`, `cygpath`, `Start-Process -Verb RunAs`).
- The cost of two engines, from `git log --since=2026-10-01`: commits that touch both `scripts/linux` and
  `scripts/windows` (or their tests) for one behavior, and plan steps that exist twice (bash step, PowerShell step).
- Each "Known differences" row classed as forced by the OS or accidental, with the behavior one engine would pick.

Test: every `file:line` resolves (`grep -n` spot check); the case counts add up to `grep -c '^case_'` and
`grep -c "It '"`.

## Step 2: Probe program `[worker]`

Files: `probe/single-engine/main.ts` (new), `probe/single-engine/README.md` (new, five lines: what it is, how to build
it with each runtime).

One TypeScript file using only `node:` imports (`node:fs`, `node:path`, `node:crypto`, `node:child_process`,
`node:os`), so Bun and Deno both build it unchanged. Given a repo folder as its only argument, it:

1. reads `<repo>/sync-config.json` and prints the number of `files` entries;
2. prints the SHA256 of `<repo>/sync-config.json`;
3. compares two strings, `"a\r\nb\n"` and `"a\nb\n"`, after folding CRLF to LF, and prints `crlf-fold: equal`;
4. runs `git --version` and prints its first line;
5. prints `os: <process.platform>-<process.arch>`.

Each on its own line, as `key: value`; exit 0. Exit 1 with `ERROR: <message>` when the config can't be read.

Test: `bun run probe/single-engine/main.ts tests/fixtures/repo` if Bun is installed, else `deno run -A …`, else skip
with a note in the summary (the workflow in step 3 builds it for real). Expected lines: `entries: <n>` matching
`jq '.files | length' tests/fixtures/repo/sync-config.json`, `crlf-fold: equal`, a `git version` line.

## Step 3: Probe workflow `[worker]`

Files: `.github/workflows/single-engine-probe.yml` (new).

`on: workflow_dispatch` and `push` to `research/single-engine`. Every step `continue-on-error: true`. Matrix,
`fail-fast: false`: `os` in `ubuntu-latest`, `ubuntu-24.04-arm`, `macos-latest`, `windows-latest` × `runtime` in `bun`,
`deno` (setup with `oven-sh/setup-bun@v2` and `denoland/setup-deno@v2`, pinned to a full version).

Each leg: compile `probe/single-engine/main.ts` to one program (`bun build --compile`, `deno compile -A`), then write
`probe-<os>-<runtime>.txt` with the runtime version, the program's size in bytes, the time of 20 runs on
`tests/fixtures/repo` (total and per run), and the program's output. Upload it as artifact
`probe-<os>-<runtime>`. On `ubuntu-latest` only, also cross-compile for the other three targets and record those sizes.

Test: `actionlint .github/workflows/single-engine-probe.yml` if installed, else
`python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]))' .github/workflows/single-engine-probe.yml`. The push of
the branch runs it; step 4 reads that run.

## Step 4: Run and record `[inline: research]`

Files: `docs/single-engine-research.md`.

Push, wait for the probe, `gh run download` every artifact. One table: OS, runtime, built (yes/no and the first error
line), size, time per run, output correct. Notes on what the runner can't show: Windows SmartScreen and macOS
Gatekeeper on an unsigned downloaded program, and what signing would cost.

Test: every leg in the matrix has a row, and each row links the run.

## Step 5: Shared case format `[inline: design]`

Files: `docs/single-engine-research.md`, `tests/parity/README.md` (new), `tests/parity/cases/` (three cases, new).

Design a case as a folder: `case.json` (config entries, values, command and arguments, which OS it applies to),
`home/` and `repo/` trees before, and `expect/` (exit code, output lines, the trees after). Output is compared after a
normalizing pass (status word and label only, so the Windows `[WORD ] label` layout and the bash layout read the same).

Sample 40 cases from the two suites (every tenth bash case, every sixth Pester `It`) and class each: fits the format,
fits with a stub (prompts, `gh`, `git` remote), or engine-internal (stays a unit test). Write three cases that fit:
an export that adds a file, an import check with one change, and a sanitized file round trip.

Test: the sample table has 40 rows; the three cases follow the README's format.

## Step 6: Case runner for bash `[worker]`

Files: `tests/parity/run.sh` (new).

Runs every case in `tests/parity/cases/` against the bash engine: copies `home/` and `repo/` and the engine scripts
into a temp folder, runs the case's command with `HOME` set to the temp home and `< /dev/null`, normalizes the output
as the README says, and compares exit code, output lines and both trees with `expect/`. Prints `ok <case>` or
`FAIL <case>: <first difference>`, then `<n> passed, <m> failed`; exit 1 on any failure. Optional argument: a name
filter, as `tests/linux/engine.sh` takes.

Test: `tests/parity/run.sh` prints `3 passed, 0 failed`; changing one expected line in a temp copy of a case makes that
case fail with the line named. `shellcheck -x tests/parity/run.sh` is clean.

## Step 7: Options and recommendation `[inline: decision]`

Files: `docs/single-engine-research.md`.

With the numbers from steps 1-6:

- **A. Go:** one TypeScript engine, with the runtime the probe favors. Cost: the phase 3-5 estimate in steps and the
  share of cases that move to the shared format. Gain: one change per behavior from then on.
- **B. Shared cases only:** do phase 2, keep both engines. Halves the test work, not the engine work.
- **C. Stop:** keep things as they are.

Recommend one, with the reason. Then stop and ask the user to choose.

Test: each option names its cost and gain in numbers from the doc.

## Step 8: Docs `[inline: docs]`

Files: `docs/plan-single-engine.md`, `docs/plan-easy-install.md` (phase 5 points here), `TODO.md` if the decision
leaves a manual check, `CLAUDE.md` (one line on `probe/` and `tests/parity/` if they stay).

Record the user's decision in the roadmap, and mark phase 1 done.

Test: `grep -n "single-engine" docs/plan-easy-install.md` shows the link; `plan-next --check docs/plan-single-engine-1.md`.
