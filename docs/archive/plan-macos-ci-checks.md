# Plan: macOS checks on a CI runner

No one has a Mac, so M1-M3 in `TODO.md` run on GitHub's `macos-latest` runner instead. It's a real macOS VM with
Homebrew, free for this public repo. `tests/macos/manual-checks.sh` already runs all four checks. This plan makes it
lint clean, lets it test the PR's own `install.sh` and branch, has it exit non-zero on a `FAIL`, and runs it in a new
`macos-checks` job. M4 (RTK's config folder) needs RTK installed, so it stays manual and becomes low priority.

All steps are small and touch CI or a test harness. The steps are inline, so the user's request is the approval.

## Step 1: Lint the macOS check script `[inline: three-line fix plus one CI line]`

Files: `tests/macos/manual-checks.sh`, `.github/workflows/ci.yml`.

- Lines 147 and 209: `# shellcheck disable=SC2016` with a reason. `$1` is expanded by the inner `sh -c`, not the
  caller.
- Line 193: `# shellcheck disable=SC2088` with a reason. The pattern matches the literal `~/` in `localPaths.macos`.
- `ci.yml` `lint` job: add `tests/macos/*.sh` to the ShellCheck line.

Test: `shellcheck -x tests/macos/*.sh` exits 0.

## Step 2: CI mode for the check script `[inline: harness for a runner no one can reach locally]`

File: `tests/macos/manual-checks.sh`.

- `INSTALL_URL=${SYNCSETTINGS_INSTALL_URL:-<the master URL>}`, so CI can pass `file://$PWD/install.sh`. The
  installer already reads `SYNCSETTINGS_REPO_URL`, `SYNCSETTINGS_REF` and `SYNCSETTINGS_TTY` from the environment, and
  the pipe passes them through.
- Exit 1 when any check in the summary is `FAIL`, else 0. `INFO` and `SKIP` don't fail. Update the header comment.
- Stays bash 3.2 compatible.

Test: `shellcheck -x tests/macos/manual-checks.sh` exits 0, and `bash -n` passes. The script itself only runs on
macOS (step 3).

## Step 3: `macos-checks` CI job `[inline: CI wiring, judged on the run]`

File: `.github/workflows/ci.yml`. A new job on `macos-latest`, after `engine-macos`:

- `brew uninstall --ignore-dependencies bash jq || true`, so M1 sees the installer's `brew install bash jq` question.
- Answers file: 50 lines of `y`. `SYNCSETTINGS_TTY` points at it, so the brew question, setup's "Apply" and any value
  prompts all get `y`.
- Env: `SYNCSETTINGS_INSTALL_URL=file://$GITHUB_WORKSPACE/install.sh`,
  `SYNCSETTINGS_REPO_URL=https://github.com/${{ github.repository }}.git`,
  `SYNCSETTINGS_REF=${{ github.head_ref || github.ref_name }}`, and `SYNCSETTINGS_DIR=$RUNNER_TEMP/SyncSettings`.
- Run `/bin/bash tests/macos/manual-checks.sh`, which is the stock bash 3.2, as on a new Mac.
- Upload `~/mksync-macos-checks-*.txt` as an artifact, `if: always()`.

Test: push the branch. `macos-checks` is green, and the report shows M1, M2 and M3 `PASS`.

## Step 4: Docs, TODO and memory `[inline: docs]`

- `TODO.md`: M1-M3 are proven by the `macos-checks` job on a CI runner (link the run). Only M4 stays, under a
  low-priority "needs a real Mac" note.
- `tests/macos/manual-checks.sh` header and `docs/restore.md` (macOS): CI runs the checks in the `macos-checks` job.
- Project memory: macOS checks are on CI; M4 is low priority.

Test: `git diff --check` is clean.
