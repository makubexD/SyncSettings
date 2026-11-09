# Easy install, phase 3: macOS research

Roadmap: `docs/plan-easy-install.md`. Goal: decide how SyncSettings runs on macOS, with evidence from a real macOS run,
then write the build plan. This phase changes no engine code. Its output is `docs/macos-research.md`, one decision from
the user, and the next plan file.

## Shared rules

- Branch `research/macos`, one commit per step, one PR at the end (auto-merged when every check is green).
- No macOS machine is at hand, so the evidence comes from GitHub's `macos-latest` runner. The probe runs on
  `workflow_dispatch` and on pushes to `research/macos`, is never a required check, and always ends green.
- Never `[worker]` a step whose output is judgment (classifying failures, choosing an option); the worker may write the
  probe workflow.
- The research doc cites `file:line` for every claim about the code, and the probe run's URL for every claim about
  macOS.

## Steps

### 1. Inventory `[inline: research]`

Files: `docs/macos-research.md` (new).

List every bash-4 feature and GNU-only flag the bash side uses, with `file:line`, what it does there, and the portable
equivalent if one exists. A first scan (2026-11-08) found: `declare -A` (1, `scripts/linux/sync.sh`), `mapfile` (6,
`commit.sh`, `scripts/linux/sync.sh`), `chmod --reference` (2, `export.sh`, `import.sh`), `readlink -f` (6, `sync`,
`install.sh`, `scripts/linux/front.sh`), `find -printf` (2), `sort -V` (2), `sha256sum` (1, bootstrap only). Check also
what the scan can't see: `cp -p` semantics, `mktemp` templates, `stat`, `cmp`, `sed`, `date` and `printf %q` behavior,
and `jq` availability.

Separate section: what is Linux by design and has no macOS meaning (dconf, apt, snap, GNOME, `bootstrap/linux.sh`), and
what macOS would want instead (`defaults` domains, Homebrew `Brewfile`), only as notes for the decision.

Test: every `file:line` in the doc resolves (`grep -n` spot check of each).

### 2. Probe workflow `[worker]`

Files: `.github/workflows/macos-probe.yml` (new).

`on: workflow_dispatch` and `push` to `research/macos` only: GitHub can dispatch a workflow only once it is on the default
branch, so the branch push is what runs it during this phase. Every step is `continue-on-error: true`, so the job is
always green and never blocks a PR. One job on `macos-latest`, a matrix of two legs, `fail-fast: false`:

- `system`: macOS's own `/bin/bash` 3.2 and BSD tools. `brew install jq` only (the engine needs it either way).
- `gnu`: `brew install bash coreutils findutils gnu-sed jq`, with the `gnubin` folders and Homebrew's `bash` first on
  `PATH`.

Each leg prints `bash --version`, then runs `tests/linux/engine.sh` and `tests/linux/bootstrap.sh` with output tee'd to
`probe-<leg>-engine.log` and `probe-<leg>-bootstrap.log`, and uploads the logs as an artifact `probe-<leg>`. The
`sync` front door: `./sync doctor` and `./sync` (status), also logged.

Test: `actionlint .github/workflows/macos-probe.yml` if installed, else
`python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]))' .github/workflows/macos-probe.yml`. The push of the
branch runs it; step 3 reads that run.

### 3. Run and classify `[inline: research]`

Files: `docs/macos-research.md`.

Dispatch the probe, download both artifacts (`gh run download`), and classify every failing case into one of:
bash 3.2, BSD tool, Linux-only by design (dconf, apt, snap), test harness only (stubs, temp paths), or other. One table
per leg with the case name, the first error line, and the class. The `gnu` leg's failures that remain are the cost of
option A; the `system` leg's bash-3.2 and BSD failures are the cost of option B.

Test: the counts in the tables add up to the failing totals in each log.

### 4. Options and the contract `[inline: decision]`

Files: `docs/macos-research.md`.

Write the options with their cost from step 3, and a recommendation:

- **A. Homebrew bash and GNU tools as dependencies.** The installer runs `brew install bash coreutils …` (asking first)
  and the scripts find them (`gnubin` on `PATH`, or the `sync` entry re-execs under Homebrew bash). Least code change;
  Homebrew becomes required.
- **B. Portable code.** Rewrite each spot from step 1 to work on bash 3.2 and BSD tools. No new dependency; every
  future change has to stay portable, and CI needs a macOS engine job to keep it so.
- **C. Hybrid.** Require Homebrew bash (bash 4 features stay) but drop GNU-only flags for portable ones.

And the config contract: a `macos` platform value, whether `common` entries apply on macOS as they are, the macOS
`localPath`s for the tools already synced (VS Code's `~/Library/Application Support/Code/User`, Claude Code, shell, git),
`dotfiles/macos/<tool>/`, and what `mksync setup` and `doctor` check there.

Then stop and ask the user, in one message: the option, whether a Mac is actually in use (and which macOS and chip), and
which tools to sync first. This is the phase's one decision.

Test: none; the user's answer is the gate.

### 5. Build plan `[inline: plan]`

Files: `docs/plan-easy-install-4.md` (new), `docs/plan-easy-install.md`.

From the decision, write the step-level macOS build plan (contract, engine changes, `install.sh` on macOS, `mksync`
checks, a `macos` CI engine job, docs), committed for review like every plan. Renumber the roadmap: macOS build is phase
4, and the optional single-engine phase becomes 5. Mark phase 3 done.

Test: `plan-next --check docs/plan-easy-install-4.md`.
