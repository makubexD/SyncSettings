# Safety fixes

Fixes from the inspection of the sync engines, done before phase 3 of `docs/plan-restructure.md`. Goal: import never
loses a local file, nothing unsanitized reaches the repo, and both engines agree. No hooks and no git configuration:
every check runs inside the scripts.

## Decisions to confirm in review

1. **Import never deletes, in any entry type.** Linked folders adopt the rule `dir` entries already follow: a local
   file the repo doesn't have is reported as `EXTRA` and kept.
2. **An empty answer at a value prompt stops the run**, at a terminal too, the same as a missing value without one.
3. **A failed or unavailable leak scan stops the commit.** Skipping it is not an option, in `commit` or in `preview`.
4. **`localPath` must start with `~`.** Every entry in the config already does, so absolute paths stop being a
   documented form.
5. **Keep or drop `detectLinkedPaths`?** Step 3 makes it safe on import. Replacing it with explicit `type: dir` entries
   would also make export explicit and shrink a Node port. Recommendation: drop it in phase 3 and add one `dir` entry
   for each folder that matters.

## Open questions

These touch `.github/` or the review gate, so they are decisions for the maintainer. No step below changes them.

1. **Repository access:** is the current collaborator list what you want?
2. **Approval rules:** should changes to `.github/`, `scripts/ci/` and `docs/review-gate.md` need a human approval that
   a PR cannot change, through a ruleset or CODEOWNERS?
3. **Review evidence:** should the gate record which commit was reviewed, so a label cannot apply to a newer one?
4. **Lint:** should `ci.yml` reject `..`, absolute paths and an invalid `defaultEnv` name, matching steps 11 to 13?
5. **Leak scan rules:** should `scripts/ci/leak-scan.sh` cover more path and token formats, handle binary and UTF-16
   files, and scan every tracked file and each PR commit?
6. **Claude auto-approval:** should its excluded paths grow to include `scripts/ci/`, `sync-config.json` and synced
   Claude settings and hooks? That section of `CLAUDE.md` is outside auto-approval.
7. **Workflow pinning:** should actions be pinned by commit SHA?
8. **`docs/review-gate.md`:** should it be updated to match the answers above?

## Shared rules

- One branch, one commit per step, one PR at the end. Commits carry the `Plan-Step` and `Route` trailers.
- Bash and PowerShell rules from `docs/plan-restructure-2.md` apply. Every behavior change adds fixture cases.
- PowerShell steps are checked by `engine-windows`: open the PR as a draft at step 3. A red job counts as a rejection.
- Workers use `tests/fixtures/user-values.json` only. They never open, copy or print a repo's `.user-values.json`. Tests
  seed their own copy in a temp folder. Step 1 runs first so this is enforced.
- Test output and error messages name the placeholder, never its value.

## Steps

### 1. Keep the worker away from the values file `[inline: touches .user-values.json]`

Files: `~/.claude-worker/settings.json`, then `./sync export` for its repo copy.

Add `Read(**/.user-values.json)`, `Edit(**/.user-values.json)` and `Bash(gh:*)` to `permissions.deny`.

Test: a throwaway repo holding a dummy `.user-values.json`, plus `mk-exec` asked to read it → the read is denied. `/mk-check`
still passes.

### 2. Contract `[inline: contract design]`

Files: `docs/sync-contract.md`.

Write the rules from the decisions above and from steps 3 to 13. Linked folders: import follows the same compare, prompt
and `.bak` rules as a plain entry. Fix the `localPath` table. Text with no valid UTF-8 is listed as a known difference
until the Node decision.

### 3. Linked import never deletes `[worker:high]`

Files: `scripts/windows/SyncHelpers.ps1`, `scripts/windows/Import-Settings.ps1`, `tests/windows/Engine.Tests.ps1`.

Import stops calling `Sync-LinkedDirectory` and gets `Import-LinkedDirectory`: each repo file goes through
`Copy-RepoFileToLocal`, so it follows the prompt and `.bak` rules; a local file the repo doesn't have prints `EXTRA` with
`not in repo; kept`. `-Force` skips only the prompt. Export keeps `Sync-LinkedDirectory` unchanged.

Cases, with a test folder outside the filtered system paths:
- `import-linked-keeps-local`: a differing file, a local-only file and an excluded file → with `-Force`: `UPDATED`,
  `.bak` written, `EXTRA` for the local-only file, the excluded file untouched, exit 0.
- `import-linked-answer-no`: mock `Read-Host` as `n` → `SKIPPED (user skipped)`, same bytes, no `.bak`.

### 4. Case-sensitive compare, PowerShell `[worker]`

Files: `scripts/windows/SyncHelpers.ps1`, `tests/windows/Engine.Tests.ps1`, `tests/linux/engine.sh`.

`Compare-NormalizedContent` uses `-ceq`.

Case `sanitized-case-change`, in both engines: repo `editor = vim`, local `EDITOR = VIM` → export `MODIFIED (sanitized)`.

### 5. Stop on an empty answer, bash `[worker]`

Files: `scripts/linux/sync.sh`, `tests/linux/engine.sh`.

`request_values`: with no value after the prompt, print `missing value for <PLACEHOLDER>: add it to .user-values.json`
and exit 1, with or without a terminal.

Case `prompt-empty-stops`: on a pseudo-terminal answering with Enter, no default → exit 1, the message printed, no file
written, repo unchanged.

### 6. Stop on an empty answer, PowerShell `[worker]`

Files: `scripts/windows/SyncHelpers.ps1`, `tests/windows/Engine.Tests.ps1`.

`Request-MissingValues`: same rule, through `throw`. Update `no default leaves value unset` to expect the stop.

Case: mock `Test-Interactive` as `$true` and `Read-Host` as `''` → throws the message, no value stored.

### 7. Scan before pushing, bash `[worker:high]`

Files: `commit.sh`, `scripts/linux/sync.sh`, `tests/linux/engine.sh`.

After the outside-changes check and before any branch or commit, `commit.sh` runs `scripts/ci/leak-scan.sh` on the sync
paths. Exit 1 → `ERROR: the leak scan found the lines above; nothing was committed.` exit 1. Missing script or any other
exit code → `ERROR: leak scan could not run; nothing was committed.` exit 1. `run_preview`: a scanner that cannot run
stops with the same reason and prints no diff.

Cases, with a bare origin and a stub `GH` that logs calls:
- `commit-happy`: one `sync/linux-<alias>-*` branch, origin `master` unmoved, HEAD back on `master`, stub called once.
- `commit-leak-blocked`: a home-style path in a synced file → exit 1, no branch, nothing pushed, stub not called.
- `commit-scan-missing`: script removed → exit 1, no branch.
- `commit-outside-changes`: a change outside the sync paths → exit 1, no branch.
- `preview-scan-missing`: script removed → exit 1, no diff in the output.

### 8. Scan before pushing, PowerShell `[worker:high]`

Files: `scripts/windows/Commit-Settings.ps1`, `scripts/windows/SyncHelpers.ps1`, `tests/windows/Engine.Tests.ps1`.

Same rules and messages. Find Git's `bash.exe` as `Invoke-ExportPreview` does, moved to a helper `Find-GitBash`. No bash
is "could not run", in commit and in preview. Same five cases.

### 9. Check cached values before pushing, bash `[inline: touches .user-values.json]`

Files: `commit.sh`, `tests/linux/engine.sh`.

Before the push, search the changed sync files for each cached value, ignoring case and including the backslash-doubled
form. A match → `ERROR: a cached value for <PLACEHOLDER> is in <file>; nothing was committed.` exit 1. The value is passed
to `grep` through `-f` on a temp file with mode 600 and never appears in arguments or output.

Cases: `commit-value-blocked`, `commit-value-case-variant`, `commit-value-placeholder-only` (the placeholder alone passes),
and `commit-value-not-printed` (the output never contains the value).

### 10. Check cached values before pushing, PowerShell `[inline: touches .user-values.json]`

Files: `scripts/windows/Commit-Settings.ps1`, `tests/windows/Engine.Tests.ps1`.

Same rule and messages. Same four cases.

### 11. Contain paths, bash `[worker:high]`

Files: `scripts/linux/sync.sh`, `tests/linux/engine.sh`.

`check_paths`, run right after `check_platforms`, over every entry: `repoPath` must start with `dotfiles/` and have no
`..` segment; `localPath` must start with `~/` or `~\` and have no `..` segment. It also stops on any symlink under
`dotfiles/`. Failure → `ERROR: sync-config.json: entry <repoPath> has an unsafe path.` exit 1, before any file is touched.

Cases, each with no file touched: `path-repo-traversal`, `path-repo-outside`, `path-local-traversal`, `path-local-absolute`,
`path-repo-symlink`, and `path-real-config` (the repo's own `sync-config.json` passes).

### 12. Contain paths, PowerShell `[worker:high]`

Files: `scripts/windows/SyncHelpers.ps1`, `scripts/windows/Export-Settings.ps1`, `scripts/windows/Import-Settings.ps1`.
Cases in `tests/windows/Engine.Tests.ps1`, a 4th file.

`Assert-SafePaths`, called after `Assert-ValidPlatform`. Same rules, message and cases.

### 13. Check `defaultEnv` names, bash `[worker:low]`

Files: `scripts/linux/sync.sh`, `tests/linux/engine.sh`.

Inside `check_paths`: `defaultEnv` must match `^[A-Za-z_][A-Za-z0-9_]*$`. Failure → `ERROR: sync-config.json: entry
<repoPath> has an invalid defaultEnv.` exit 1. PowerShell reads the name as plain data, so it needs no change.

Cases: `defaultenv-invalid` (exit 1, no file touched), `defaultenv-valid` (the prompt default works).

### 14. Private mode for the values file `[inline: touches .user-values.json]`

Files: `scripts/linux/sync.sh`, `scripts/windows/SyncHelpers.ps1`, `tests/linux/engine.sh`.

`save_values` writes with `umask 077` in a subshell, and tightens an existing file to 600 on every save.
`Save-UserValues` removes inherited access so that only the current user has it.

Cases: `values-mode-new`, `values-mode-tightened`, both asserting 600. Check the Windows side through a Pester case in
`engine-windows`.

### 15. More excluded file types `[worker:low]`

Files: `sync-config.json`, `.gitignore`, `tests/linux/engine.sh`.

Add `.git-credentials`, `.netrc`, `.npmrc`, `.pgpass`, `hosts.yml`, `auth.json`, `secrets.yaml`, `token`, `*.env` and
`id_dsa*` to both lists.

Case `excluded-credentials`: each name in a `dir` entry → `SKIPPED (matches exclude pattern)`, not in the repo.

### 16. Stop tracking local settings `[inline: repo settings]`

Files: `.claude/settings.local.json`, `.gitignore`.

`git rm --cached .claude/settings.local.json`, then ignore it. The file stays on disk.

Test: `git ls-files .claude` no longer lists it, and the file still exists.

### 17. Docs `[inline: user-facing copy]`

Files: `docs/configuration.md`, `README.md`, `docs/daily-workflow.md`.

Remove the absolute `localPath` form. Keep "import always keeps a `.bak`", now true for every entry type. Add the new
commit stops to the "When `commit.sh` stops" table.

### 18. Verify and PR `[inline: final review]`

1. `tests/linux/engine.sh` green; shellcheck clean.
2. Throwaway clone and empty `HOME`: `./sync import`, then `./sync preview` shows nothing to send.
3. Mark the PR ready. `leak-scan`, `lint`, `engine-linux`, `engine-windows` green.
4. Review the whole diff with `/agent-skills:review`.
5. Windows machine after merge: `export.bat`, then `import.bat` → no changes.

## Not in this plan

- Tests for gaps that carry no safety risk: inference cases on PowerShell, `commit.sh` title edge cases, entry order.
- Refusing to empty a `dir` entry when the local folder is empty. Phase 3 adds the first `dir` entries, so it goes there.
- Non-UTF-8 text in PowerShell, which a Node engine would replace.

## Node verdict

**Conditional go: port the engine to Node with no dependencies, after this plan and before phase 5.** It gives one engine
and one test suite that runs locally. It doesn't change the commands, because `./sync` already hides the OS.

| Measure | Result |
|---|---|
| Duplication | 27 engine commits since phase 2, split evenly between the two engines |
| Drift | At least 4 real differences survived the parity phase |
| Windows testing | Pester runs only in CI, about 2.5 minutes per try |
| Spike | 19 of 19 byte-exact checks passed, 38 lines against 108 of bash |
| Restore cost | None on Linux, where Node replaces `jq`; one extra `winget` command on Windows |
| Future savings | Modest: phases 3 and 4 are data, and phases 5, 6 and 8 are mostly OS-specific |

Estimated size is 700 to 900 lines, extrapolated from a small spike. The plan is `docs/plan-node-engine.md`, written once
this plan has merged.
