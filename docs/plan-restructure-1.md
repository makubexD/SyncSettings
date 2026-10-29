# Phase 1: PR flow + review gate

Roadmap: `docs/plan-restructure.md`. Goal of this phase: every change to the repo lands through a PR that a
required check holds red until the PR carries the `reviewed` label. `commit.sh` / `commit.bat` open that PR instead
of pushing to `master`. CI also runs two real checks (leak scan, lint).

Out of scope here: the `platform` field rework, file moves, engine tests (phase 2), markdownlint/link check
(phase 9).

## Shared rules (all steps)

- Bash: `#!/usr/bin/env bash`, `set -euo pipefail`, match the style of `commit.sh` and `scripts/sync.sh`
  (4-space indent, `printf`, `(( ))` for numbers, `[[ ]]` for strings). New scripts are executable (`chmod +x`).
- PowerShell: PS 5.1 compatible (no `??`, no ternary), match `scripts/Commit-Settings.ps1`.
- Workflows: pin actions to a major tag (`actions/checkout@v4`), `permissions:` set explicitly per workflow.
- The `gh` binary is overridable for tests: bash `GH=${GH:-gh}`, PowerShell `$gh = if ($env:GH) { $env:GH } else { 'gh' }`.
- Never test in the real repo: throwaway clone + a local bare remote + a stub `gh`.

## Steps

### 1. Review gate workflow `[worker]`

File: `.github/workflows/review-gate.yml` (new).

```yaml
name: review-gate
on:
  pull_request:
    types: [opened, reopened, synchronize, labeled, unlabeled, ready_for_review]
permissions:
  pull-requests: write
concurrency:
  group: review-gate-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  review-gate:
    runs-on: ubuntu-latest
    steps:
      - name: Drop the review label after new commits
        if: github.event.action == 'synchronize' && contains(github.event.pull_request.labels.*.name, 'reviewed')
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh pr edit "${{ github.event.pull_request.number }}" --repo "${{ github.repository }}" --remove-label reviewed
      - name: Require the reviewed label
        env:
          ACTION: ${{ github.event.action }}
          REVIEWED: ${{ contains(github.event.pull_request.labels.*.name, 'reviewed') }}
        run: |
          if [[ $ACTION == synchronize || $REVIEWED != true ]]; then
            echo "::error::Review pending: review the PR, then add the 'reviewed' label."
            exit 1
          fi
          echo "Reviewed."
```

Test: `python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]))' .github/workflows/review-gate.yml` exits 0.
The live behavior is checked in step 8.

### 2. Leak scan script `[worker]`

File: `scripts/ci/leak-scan.sh` (new, executable). Usage: `scripts/ci/leak-scan.sh [path...]`, default paths
`dotfiles sync-config.json` plus `packages` when it exists. Prints `file:line: <rule>` per hit (never the matched
text, so a leak isn't echoed into CI logs) and exits 1 if any hit, 0 otherwise.

Rules (grep -rnIE, one rule per pass so the rule name can be printed):

| Rule | Pattern | Allowed |
|---|---|---|
| home-path | `/home/[a-z_][a-z0-9_-]*` | none |
| windows-profile | `[A-Za-z]:\\+Users\\+[^<%\\"]+` | none |
| email | `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}` | addresses ending `@users.noreply.github.com`, `@example.com`, `@anthropic.com` |
| private-key | `-----BEGIN [A-Z ]*PRIVATE KEY-----` | none |
| github-token | `gh[pousr]_[A-Za-z0-9]{30,}` | none |
| api-key | `sk-[A-Za-z0-9_-]{20,}` and `AKIA[0-9A-Z]{16}` | none |

Tests (run from the repo root):
- `scripts/ci/leak-scan.sh` → exit 0 (current repo is clean; checked while planning).
- `d=$(mktemp -d); printf 'x /home/alice/y\n' > $d/a; scripts/ci/leak-scan.sh $d` → exit 1, output `…/a:1: home-path`, no `alice`.
- same with `C:\\Users\\bob\\x` → exit 1 `windows-profile`.
- `jane@corp.io` → exit 1 `email`; `noreply@anthropic.com` → exit 0.
- `-----BEGIN OPENSSH PRIVATE KEY-----` → exit 1 `private-key`.
- `ghp_` + 36 letters → exit 1 `github-token`.
- `<HOME>/x` and `~/.claude` → exit 0.

### 3. Lint fixes + CI workflow `[worker]`

Files: `scripts/sync.sh`, `.github/workflows/ci.yml` (new).

- `scripts/sync.sh`: the two shellcheck warnings are intentional. Add
  `# shellcheck disable=SC2088  # literal '~/' prefix from sync-config.json` above line 22 and
  `# shellcheck disable=SC2053  # pattern is a glob on purpose` above line 37. No other change.
- `ci.yml`, `on: pull_request` + `push: branches: [master]`, `permissions: contents: read`, jobs:
  - `leak-scan` (ubuntu-latest): checkout, `scripts/ci/leak-scan.sh`.
  - `lint` (ubuntu-latest): checkout; `shellcheck -x export.sh import.sh commit.sh scripts/sync.sh scripts/ci/*.sh`;
    `jq empty sync-config.json`; config sanity with jq: every `.files[]` has non-empty `repoPath` and `localPath`,
    no duplicate `repoPath`, every entry with `platform == "linux"` has `repoPath` starting `dotfiles/linux/`
    (print the offending repoPath and exit 1 otherwise); PSScriptAnalyzer:
    `pwsh -c "Install-Module PSScriptAnalyzer -Force -Scope CurrentUser; $r = Invoke-ScriptAnalyzer -Path scripts -Severity Error; $r; if ($r) { exit 1 }"`.

Tests:
- `shellcheck -x export.sh import.sh commit.sh scripts/sync.sh scripts/ci/*.sh` → exit 0, no output.
- The jq sanity command from `ci.yml`, run locally → exit 0; with a copy of the config that duplicates one
  entry → exit 1 naming the repoPath.
- YAML parses (same python one-liner as step 1).

### 4. PR template `[worker]`

File: `.github/pull_request_template.md` (new):

```markdown
## What changed

<!-- commit.sh / commit.bat fill this in for sync PRs -->

## Review checklist

- [ ] Diff contains only the intended files
- [ ] No personal values (leak-scan is green)
- [ ] Imported on the other machine if needed

When the review is done, add the **`reviewed`** label. New commits remove it.
```

Test: file exists; no command.

### 5. `commit.sh` → branch + PR `[worker:high]`

File: `commit.sh`. Keep `build_commit_message`, `join_by`, the banner, the change listing. Replace the
commit/push section.

New usage: `commit.sh [-m <message>]`. `--push` is still accepted and ignored (prints nothing) so old habits
don't break; any other option → existing usage error.

Flow:
1. `GH=${GH:-gh}`. Require `git` (existing check) and `$GH` on PATH (`command -v`), else
   `ERROR: gh is not found in PATH. Install the GitHub CLI and run gh auth login.` exit 1.
2. Sync paths: `SYNC_PATHS=(dotfiles sync-config.json)` plus `packages` if the directory exists.
3. Changes outside the sync paths: `git status --porcelain -- . ${SYNC_PATHS[@]/#/:!}` non-empty →
   print them and `ERROR: commit or stash changes outside dotfiles/ first.` exit 1.
4. No changes in the sync paths → existing "Nothing to commit" message, exit 0.
5. Current branch must be `master` (`git symbolic-ref --short HEAD`), else
   `ERROR: run commit.sh from master (current: <branch>).` exit 1.
6. `git fetch origin master`; if `HEAD` is behind `origin/master`, `git merge --ff-only origin/master`
   (fails cleanly if it would touch changed files → print `ERROR: master is behind origin; pull first.` exit 1);
   if ahead → `ERROR: local master has unpushed commits; push or move them to a branch first.` exit 1.
7. Branch: `sync/linux-$(hostname -s)-$(date +%Y%m%d-%H%M)`; `git switch -c "$branch"`.
8. `git add -- "${SYNC_PATHS[@]}"`; `git commit -m "$commit_msg"`.
9. `git push -u origin "$branch"`. On failure: `ERROR: push failed; you are on <branch>. Fix and run: git push -u origin <branch>` exit 1.
10. Body file (mktemp, removed by `trap … EXIT`): `## What changed`, blank line, one ``- `<status line>` `` per
    changed file, blank line, `Platform: linux · Host: <hostname -s>`, blank line,
    ``When the review is done, add the **`reviewed`** label.``
11. `pr_url=$("$GH" pr create --base master --head "$branch" --title "$commit_msg" --body-file "$body")`.
    On failure: `ERROR: PR creation failed; branch <branch> is pushed. Run: gh pr create --base master --head <branch>` exit 1.
12. `git switch master`. Print `  PR opened: <url>` and `  Review it, add the 'reviewed' label, merge, then: git pull`.

Tests (throwaway setup, no network):
```bash
t=$(mktemp -d); git init -q --bare -b master $t/remote.git
git clone -q "$PWD" $t/work && git -C $t/work remote set-url origin $t/remote.git && git -C $t/work push -q origin master
printf '#!/usr/bin/env bash\necho "$@" >> %s/gh.log; echo https://github.com/x/y/pull/99\n' $t > $t/gh; chmod +x $t/gh
```
- clean tree: `GH=$t/gh ./commit.sh` in `$t/work` → "Nothing to commit", exit 0, no new branch.
- `echo x >> dotfiles/.gitconfig` → exit 0; `git -C $t/remote.git branch` lists one `sync/linux-…` branch;
  `$t/gh.log` has `pr create --base master --head sync/linux-… --title sync: update .gitconfig --body-file …`;
  work tree is back on `master` and clean; output contains `PR opened: https://github.com/x/y/pull/99`.
- `echo x >> README.md` plus a dotfiles change → exit 1 with "outside dotfiles/", no branch created.
- on a non-master branch with a dotfiles change → exit 1 "run commit.sh from master".
- local master one commit ahead of origin → exit 1 "unpushed commits".
- `GH=/nonexistent` → exit 1 "gh is not found".
- stub `gh` that exits 1 → exit 1 "PR creation failed", branch pushed, still on the sync branch.
- `-m "custom msg"` → title is `custom msg`. `--push` → accepted.
- `shellcheck -x commit.sh` → clean.

### 6. `Commit-Settings.ps1` → branch + PR `[worker:high]`

File: `scripts/Commit-Settings.ps1`. Same flow and messages as step 5, PowerShell style; branch
`sync/windows-<$env:COMPUTERNAME lowercased>-<yyyyMMdd-HHmm>`; body says `Platform: windows`. `-Push` stays as an
accepted, ignored switch. Body file written with `[IO.File]::WriteAllText` (UTF-8, no BOM). Check
`$LASTEXITCODE` after every git/gh call, as the script already does.

Tests: can't run PowerShell here (`pwsh` missing). PSScriptAnalyzer runs in CI (step 3). Manual test on Windows
after merge (step 8). Review the diff side by side with step 5 for matching messages and order.

### 7. Docs: review gate + daily workflow `[inline: user-facing copy]`

Files: `docs/review-gate.md`, `docs/daily-workflow.md` (new), `README.md` (Commit row + one "Read next" link
each; the full README rewrite is phase 9), repo `CLAUDE.md` (Entry Points table: commit opens a PR).
Content: what the gate does and why a label (no self-approval on GitHub), how to turn on Actions failure
notifications (GitHub → Settings → Notifications → Actions: "Only notify for failed workflows"), Mermaid
sequence of export → commit → PR (red) → label → green → merge → `git pull` → import on the other machine.

Test: read through; every command copy-pasteable.

### 8. GitHub settings + live check `[inline: changes repo settings on GitHub, confirm with the user first]`

After steps 1–7 are merged to `master` (this PR is the first one through the gate, merged before protection
is on):
1. `gh label create reviewed --color 0E8A16 --description "Reviewed; lets review-gate pass"`.
2. `gh repo edit --delete-branch-on-merge`.
3. Branch protection on `master` via `gh api -X PUT repos/makubexD/SyncSettings/branches/master/protection`:
   required status checks `review-gate`, `leak-scan`, `lint` (strict: false), `enforce_admins: true`,
   `required_pull_request_reviews: null`, `restrictions: null`, plus `required_linear_history: false`.
   (A PR is still required because direct pushes fail the required checks.)
4. Live test: `./commit.sh` with a harmless dotfiles change (e.g. a timestamp in a comment you choose) →
   PR opens, `review-gate` red, failure email arrives; add `reviewed` → green; push one more commit →
   label removed, red; re-add → green; merge.
5. Windows: run `commit.bat` once on the Windows machine with a small change; confirm the PR opens.

## Done when

- A PR without `reviewed` can't be merged; with it, and green leak-scan + lint, it can.
- `commit.sh` and `commit.bat` never push to `master`; they open a PR and return to `master`.
- `docs/review-gate.md` and `docs/daily-workflow.md` describe the flow.
