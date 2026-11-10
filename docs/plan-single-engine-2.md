# One engine, phase 2: shared cases

Roadmap: `docs/plan-single-engine.md`. Goal: one set of engine-neutral cases in `tests/parity/` that both current
engines pass in CI on Linux, macOS and Windows, so a contract behavior is tested once. Phase 1 left the format
(`tests/parity/README.md`), a bash runner (`tests/parity/run.sh`) and four cases. This phase adds what the sample in
`docs/single-engine-research.md` section 4 said is missing (per-OS expectations, the state and values files, a prompt
answer, a git repo and remote, a `gh` stub), a PowerShell runner, CI jobs, and the cases, then drops the old cases that
a shared one now covers.

## Shared rules

- Branch `feat/parity-cases`, one commit per step, one PR at the end. The PR changes `.github/workflows/ci.yml`; under
  the user's standing rule for plan PRs (workflow ones included) it is labelled and merged once the review and checks pass.
- No engine code changes in this phase. A case where an engine disagrees with `docs/sync-contract.md` is a finding:
  if the row is in "Known differences", the case records it in `expect.<os>/`; if it isn't, stop and report it
  (it's a bug for its own fix, not for this plan).
- A case is written against the contract, not copied from an engine's output. Each new case must pass on bash
  (`tests/parity/run.sh <name>`) before its step is committed; the Windows side is checked by CI.
- PowerShell changes can't run here (the engine calls `powershell.exe`): `pwsh` checks they parse, the CI job checks
  they work.
- Every case keeps to one behavior, names its contract section in `description`, and uses only `example.com` values
  and `~/.config/parity/` paths, so `leak-scan` stays green.

## Step 1: Format additions `[inline: design]`

Files: `tests/parity/README.md`, `.gitattributes`.

Write down the fields the later steps implement, in the README's table and "How the runner checks it":

- `expect.<os>/` (`linux`, `macos`, `windows`): holds only the files that differ from `expect/` on that OS (`exit`,
  `output.txt`, or a whole `home/` or `repo/` tree, which replaces the shared one). Allowed only for a row of "Known
  differences"; `case.json` gets `"differences": ["<row name>"]` naming it.
- `expect/values.json`: when present, the runner compares the repo's `.user-values.json` after the run as JSON (key
  order ignored).
- `expect/state/`: when present, each file in it must be in the engine's state folder with the same bytes (other
  state files, such as the sync point, are ignored). A `backups/<run>/` folder is
  renamed `backups/RUN/` first (exactly one run folder, else a failure), so the timestamp and pid don't matter.
- `commands[].stdin`: text sent to that command's stdin in place of an empty one (a prompt answer, newline-ended).
- `git`: `"none"` (default), `"committed"` (the temp repo is a git repo with everything committed on `master`), or
  `"remote"` (also a local bare `origin` it was pushed to, and `master` tracking it).
- `stubs`: `["gh"]` puts a `gh` stub first on `PATH` that logs each call's arguments, one call per line, to a file
  outside both trees, prints nothing and exits 0. `expect/gh.log` holds the wanted log; only the first two arguments of
  each call are kept, so branch names and titles don't matter.
- `commands[].command` adds `diff` (`export --diff`, `-Diff`).

Add `tests/parity/cases/** -text` to `.gitattributes`, so a Windows checkout keeps the expected bytes (CRLF cases need
it too).

Test: the README names every field above with its meaning; `git check-attr text tests/parity/cases/export-adds/case.json`
prints `unset`.

## Step 2: Bash runner: per-OS, values, state, stdin `[worker]`

Files: `tests/parity/run.sh`.

Implement `expect.<os>/` (per file: use `expect.<os>/<x>` when it exists, else `expect/<x>`; validate that
`differences` is a non-empty list of strings when `expect.<os>/` exists, and that `expect.<os>/` exists for at least
one OS when `differences` is set), `expect/values.json` (`jq -S` both sides, compare), `expect/state/` (the
`backups/RUN` rename from step 1, then each file in `expect/state/` must exist in the state folder with the same bytes
and mode; other state files, such as the sync point, are ignored), and `commands[].stdin` (written to a
temp file and redirected in place of `/dev/null`; validate it is a string). Unknown top-level `case.json` keys stay
allowed.

Test: `tests/parity/run.sh` still prints `4 passed, 0 failed`. Then, each in a temp copy under `PARITY_CASES`:
an `expect.linux/exit` holding `9` makes `export-adds` fail with `exit: want 9, got 0`; the same with `expect.macos/`
leaves it passing on Linux; `expect.linux/` without `differences` fails validation; a wrong `expect/values.json` makes
`sanitize-round-trip` fail naming `values.json`; a `stdin` of `5` (a number) fails validation. `shellcheck -x
tests/parity/run.sh` is clean.

## Step 3: Bash runner: git and the gh stub `[worker]`

Files: `tests/parity/run.sh`.

Implement `git` (`committed`: `git init -q -b master`, local `user.name Parity` / `user.email parity@example.com`, add
everything, commit; `remote`: also `git init -q --bare -b master` in the temp folder, push, set upstream), `stubs:
["gh"]` (a script in a temp `bin/`, first on `PATH`, appending `"$@"` joined by spaces to `$t/gh.log`), the `diff`
command, and `expect/gh.log` (each logged line cut to its first two words, compared line for line; a missing
`expect/gh.log` with the stub on means `gh` must not be called). The `.git` folder is left out of the repo tree
compare, and so is the bare origin, which lives outside the repo.

Test: `tests/parity/run.sh` prints `4 passed, 0 failed`. In temp copies: `export-adds` with `"git": "committed"` still
passes; a case with `"stubs": ["gh"]` and an `expect/gh.log` holding `pr create` fails with the gh line named (no call
was made); `"git": "bogus"` fails validation. `shellcheck -x tests/parity/run.sh` is clean.

## Step 4: PowerShell runner `[worker:high: Windows-only, only CI can run it]`

Files: `tests/parity/run.ps1` (new).

PS 5.1 port of `run.sh` as it stands after step 2 (no git or stubs yet): same validation, same output (`ok`, `FAIL
<case>: <reason>`, `skip`, `<n> passed, <m> failed`), same exit. Copies `sync.cmd` and `scripts/windows/` into the
temp repo; runs each command as `powershell.exe -NoProfile -ExecutionPolicy Bypass -File
scripts/windows/<Export|Import>-Settings.ps1` with `-Force`, `-Only`, `-Check`, `-Preview`, with `USERPROFILE`,
`HOME` and `LOCALAPPDATA` set to temp folders, and stdin from the case or empty (as `tests/windows/Engine.Tests.ps1:66`
does). Status lines use the same rule (`[WORD      ] label` → `WORD label`). Trees are compared by file list and
SHA256; modes are not compared. State folder: `%LOCALAPPDATA%\SyncSettings`. The OS is always `windows`. No `??`, no
ternary.

Test: `pwsh -NoProfile -Command '$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile("tests/parity/run.ps1",[ref]$null,[ref]$e); if ($e) { $e; exit 1 }'`
exits 0. The real run is step 7.

## Step 5: PowerShell runner: git and the gh stub `[worker:high: Windows-only, only CI can run it]`

Files: `tests/parity/run.ps1`.

Port step 3: `git` modes, a `gh.cmd` stub in a temp `bin` first on `PATH` (as `New-GhStub` in
`tests/windows/Engine.Tests.ps1:266`), the `diff` command (`-Diff`), `expect/gh.log`, `.git` left out of the compare.
`commit` runs `scripts/windows/Commit-Settings.ps1`.

Test: the parse check from step 4 exits 0.

## Step 6: CI jobs `[worker:low]`

Files: `.github/workflows/ci.yml`.

Add a step after the engine tests in each engine job: `engine-linux` runs `tests/parity/run.sh`, `engine-macos` runs
`/opt/homebrew/bin/bash tests/parity/run.sh`, `engine-windows` runs `powershell -NoProfile -ExecutionPolicy Bypass
-File tests/parity/run.ps1` (shell `powershell`). Add `tests/parity/run.sh` to the `shellcheck` list in `lint`.

Test: `python3 -c 'import yaml,sys; yaml.safe_load(open(".github/workflows/ci.yml"))'` exits 0;
`grep -c 'tests/parity/run' .github/workflows/ci.yml` prints 4.

## Step 7: First CI run `[inline: CI evidence]`

Files: `tests/parity/run.ps1`, `tests/parity/run.sh`, `tests/parity/cases/*/expect.<os>/` as needed.

Push the branch and read the three engine jobs. A runner bug is fixed here. An engine difference on one of the four
cases is handled by the shared rules (an `expect.<os>/` for a known difference, a stop otherwise). Record the run URL
in the commit message.

Test: `engine-linux`, `engine-macos` and `engine-windows` are green with `4 passed, 0 failed` (or `skip` lines only for
cases with an `os` list).

## Step 8: Cases: entry selection and path safety `[worker]`

Files: `tests/parity/cases/` (new case folders only).

Each case runs `export` once, with a home file and a repo file in place so "touches nothing" shows in the trees
(`expect/home` and `expect/repo` equal the inputs):

| Case | Config | Exit | Status lines |
|---|---|---|---|
| `platform-missing` | one entry without `platform` | 1 | none |
| `platform-list-common` | `"platform": ["common", "linux"]` | 1 | none |
| `platform-picks-os` | three entries: `linux`, `windows`, `common`, all local files present, repo empty | 0 | `ADDED` for `common` and the OS's own entry; `expect.windows/` and `expect.macos/` hold their lines (difference: "Entry selection") |
| `repo-path-dotdot` | `repoPath` `dotfiles/common/../x` | 1 | none |
| `local-path-absolute` | `localPath` `/tmp/parity-x` | 1 | none |
| `localpaths-bad-key` | `localPaths: { "freebsd": "~/x" }` | 1 | none |
| `dconf-path-no-slash` | a `type: dconf` entry, `platform: linux`, `path: org/parity/` | 1 | none |
| `defaultenv-invalid` | a rule with `defaultEnv: "1BAD"` | 1 | none; `expect.windows/exit` is `0` with the common entry's status line (difference: "`defaultEnv` name check") |

`platform-picks-os` is not a "Known differences" row but the contract's own per-OS table; its `differences` names
"Entry selection". Step 1's rule allows that one exception, and the README says so.

Test: `tests/parity/run.sh` prints `12 passed, 0 failed`.

## Step 9: Cases: statuses, backups, excludes, directories `[worker]`

Files: `tests/parity/cases/` (new case folders only).

| Case | Setup | Command | Exit | Status lines and files |
|---|---|---|---|---|
| `export-unchanged` | home and repo file equal | `export` | 0 | `UNCHANGED`; trees as input |
| `export-modified` | they differ | `export` | 0 | `MODIFIED`; repo file now equals home |
| `export-local-missing` | repo file only | `export` | 0 | `SKIPPED`; trees as input |
| `export-excluded` | local `x.log`, pattern `*.log` | `export` | 0 | `SKIPPED`; repo empty |
| `import-not-in-repo` | home file only | `import --force` | 0 | `SKIPPED`; trees as input |
| `import-updated-backup` | they differ | `import --force` | 0 | `UPDATED`; home file equals repo, `<file>.bak` holds the old bytes, `expect/state/backups/RUN/<repoPath>` holds them too |
| `import-eof-no-force` | they differ, no `--force`, empty stdin | `import` | 0 | bash: `UPDATED` and `.bak`; `expect.windows/` per what the contract's "End of input at the overwrite prompt" row says (difference named) |
| `import-answer-no` | they differ, `stdin` `n` | `import` | 0 | `SKIPPED`; trees as input |
| `dir-export-removed` | `type: dir`, repo has `a` and `b`, home has `a` | `export` | 0 | `UNCHANGED …/a`, `REMOVED …/b`; repo has `a` only |
| `dir-import-extra` | `type: dir`, home has an extra file | `import --force` | 0 | `EXTRA` for it; it is kept |
| `orphan-reported` | a repo file under `dotfiles/common/parity/` no entry owns | `export` | 0 | `ORPHAN` for it; it is kept |

Test: `tests/parity/run.sh` prints `23 passed, 0 failed`.

## Step 10: Cases: sanitize, compare, `--only` `[worker]`

Files: `tests/parity/cases/` (new case folders only).

| Case | Setup | Command | Exit | Result |
|---|---|---|---|---|
| `sanitize-longest-first` | values `<A>`=`ab`, `<B>`=`abc`; home holds `abc ab` | `export` | 0 | `ADDED`; repo holds `<B> <A>` |
| `hydrate-escape-backslashes` | rule `escapeBackslashes: true`, value `C:\Tools`; repo holds `path=<DIR>` | `import --force` | 0 | `CREATED`; home holds `path=C:\\Tools` |
| `missing-value-stops` | a rule, no values file, repo file present | `import --force` | 1 | none; home stays empty |
| `infer-value` | no cached value; home holds `name=Parity User`, repo `name=<YOUR_NAME>` | `import --force` | 0 | `UNCHANGED`; `expect/values.json` holds the inferred value |
| `sanitized-crlf-unchanged` | a rule; home is the hydrated repo text with CRLF and two trailing blank lines | `export` | 0 | `UNCHANGED`; repo as input |
| `common-crlf` | no rules, `dotfiles/common/`; home is the repo text with CRLF | `export` | 0 | `MODIFIED` on bash; `expect.windows/` `UNCHANGED` (difference: "Compare", shared files on Windows) |
| `only-one-file` | two entries, both differ | `import --force`, `only: [first repoPath]` | 0 | one `UPDATED`; the second home file untouched |
| `only-not-synced` | `only: ["dotfiles/common/none"]` | `import --force` | 1 | none |
| `only-dotdot` | `only: ["dotfiles/common/../x"]` | `export` | 1 | none |

Test: `tests/parity/run.sh` prints `32 passed, 0 failed`.

## Step 11: Cases: git and gh `[worker:high: cases need the git modes and the contract's commit and diff sections read closely]`

Files: `tests/parity/cases/` (new case folders only).

| Case | `git`, `stubs` | Command | Result |
|---|---|---|---|
| `preview-no-change` | `committed` | `preview` | exit 0, `UNCHANGED` line, repo tree as committed |
| `preview-only-refused` | `committed` | `preview`, `only: [a repoPath]` | exit 1, no status line |
| `diff-in` | `remote` | `diff` after a home change | the label and exit the contract's "Export preview"/diff section give; repo unchanged |
| `commit-nothing` | `remote`, `gh` | `commit` with a clean tree | the exit the contract gives; no `expect/gh.log` (gh never called) |
| `commit-opens-pr` | `remote`, `gh` | `export` then `commit` | both exit 0; `expect/gh.log` holds `pr create` |

Read the contract's "One command", "Export preview", "Checks before pushing" and commit sections for each wanted exit
code and line; where they don't settle a value, stop and report rather than take the engine's output.

Test: `tests/parity/run.sh` prints `37 passed, 0 failed`.

## Step 12: Second CI run and the old duplicates `[inline: judgment]`

Files: `tests/linux/engine.sh`, `tests/windows/Engine.Tests.ps1`, `tests/parity/README.md`, case `expect.<os>/` as needed.

Push and read the three engine jobs, handling each failure as in step 7. Then, for each shared case, find the bash and
Pester cases that test the same behavior through the same inputs and remove them; keep any that check more (a note's
text, a prompt's wording, an internal function). Add a "Moved from" table to the README: shared case → removed bash
case names and Pester `It` names. A case is removed only when its shared twin is green on all three jobs.

Test: `tests/linux/engine.sh` passes; all three engine jobs green; the README table lists every removed case.

## Step 13: Docs `[inline: docs]`

Files: `tests/parity/README.md` (drop "draft"), `docs/sync-contract.md` (a line in the intro: the shared cases are
the contract's executable form), `docs/plan-single-engine.md` (phase 2 done, the twin-step count rule for phase 3),
`CLAUDE.md` (the "Shared cases" bullet: both runners, CI jobs, how to add a case, `expect.<os>/` only for a known
difference), `docs/daily-workflow.md` (a contract change adds a shared case first), `TODO.md` if anything is left.

Enrich: a sample `run.sh` output with one `FAIL` line and how to read it, and troubleshooting for the failures a case
author hits (CRLF in a checkout, a missing `differences`, a `gh.log` mismatch).

Test: `grep -n "draft" tests/parity/README.md` prints nothing; `grep -n "run.ps1" CLAUDE.md` shows the line;
`plan-next --check docs/plan-single-engine-2.md`.
