# One engine, phase 10: private repo and review

Roadmap: `docs/plan-single-engine.md`, phase 10 (the final step). Decision: `docs/decision-private-repo.md`. Design:
`docs/design-layers.md` ("Release and update", "Public-repo guard"). Contract: `docs/sync-contract.md`. Goal: the repo
is private, the docs describe the finished program rather than its history, CI fits a free plan's minutes, and the
review goes back to the user.

## Shared rules

- **The account is on GitHub Free** (the user, 2026-11-20). On a private repo that means:
  - branch protection and rulesets are not enforced, so `review-gate` turns red but no longer blocks a merge;
  - artifact attestations aren't made (they need Enterprise Cloud for a private repo);
  - Actions minutes are limited (2,000 a month; macOS counts 10x, Windows 2x).
- **Order matters.** `v1.0.1` refuses an update whose asset has no attestation. So part A ships `v1.0.2` without the
  attestation check while the repo is still public and the release workflow still attests. Every machine moves to
  `v1.0.2`. Only then does part B drop the attest step, and part C flip the visibility.
- **Three branches, three PRs:**
  - Part A: `engine/private-switch`. The PR touches no workflow, so Claude may label and merge it once `pr-ready`
    exits 0. Step 7 then tags `v1.0.2`; the user's GO for this plan covers that tag (2026-11-20).
  - Part B: `engine/private-ci` touches workflows, so step 12 stops for the user's `reviewed` label.
  - Part D: `engine/private-after` touches the gate, so the plan's finish stops for the user's label.
- **The switch is the user's** (step 13). Claude never changes the repo's visibility.
- **Contract first** (CLAUDE.md rule 2). Until step 13 the repo is public: fixtures use `example.com`, `/home/user`,
  `C:\Users\user`, and `leak-scan` stays green.
- **Never the real machine or the real GitHub in tests.** `gh` is always a stub (`GH=` for the installers, a stub on
  `PATH` for the program). Release checks run the program with `HOME=$(mktemp -d)`.
- Each worker step: about 3 files, one concern. Test commands run that step's tests only. `tests/all.sh` runs before
  each PR (steps 7 and 12) and in the finish.

## Decided

1. **No attestation check.** The installers and `mksync update` stop running `gh attestation verify`. They keep the
   `SHA256SUMS` check, and both files come from the same release through a signed-in `gh` (or HTTPS while public).
   The checksum stops a broken download. A private repo with only the owner's token is the trust boundary that the
   attestation used to prove.
2. **CI minutes rule.** `ci.yml` jobs run as follows:
   - On every PR: the Linux jobs (`leak-scan`, `lint`, `program-build`, `bootstrap-check`).
   - Also on a PR that touches `src/`, `tests/`, `install.sh`, `install.ps1`, `bootstrap/`, `mksync`, `mksync.cmd`,
     `package.json`, `bun.lock`, `scripts/ci/` or `.github/workflows/ci.yml`: the macOS and Windows jobs
     (`macos-checks`, `program-macos`, `program-windows`).
   - Always on a push to `master` and on `workflow_dispatch`: every job.
   - `single-engine-probe.yml` (a research branch that no longer exists) is deleted.
3. **New settings get a comment.** `review-gate.yml` gains a job that posts one comment listing the PR's new settings.
   It updates the same comment on each push. The label check is unchanged, and every PR still waits for `reviewed`. A
   new setting is any of:
   - an entry in `sync-config.json`;
   - a file under `dotfiles/`, `profiles/` or `machines/`;
   - a JSON key path in a changed `.json` file under those folders.
4. **The guard needs no code change.** It reads the visibility through `gh` on every export, so it opens by itself
   once the repo is private. Step 14 checks that, and the user's first push makes the first backup.
5. **The docs drop the history.** User docs describe the program as it is. Finished plans and research notes move to
   `docs/archive/`. The README gains a "Develop" section, and `CHANGELOG.md` starts at `v0.9.0`.

## Part A: while the repo is public (`engine/private-switch`)

## Step 1: Contract and design: no attestation check `[inline: contract wording needs judgment]`

Files: `docs/sync-contract.md`, `docs/design-layers.md`.

- Contract, "Install" and "update": delete the `gh attestation verify` sentences and the two lines
  `ERROR: <asset>: attestation check failed.` and `ERROR: <asset>: attestation check failed; nothing changed.`.
  `SHA256SUMS` stays the only check.
- Design, "Release and update": decision 1 replaces the attestation rule. The release workflow keeps attesting until
  part B (step 11), so `v1.0.1` can still update to `v1.0.2`.

Test: `npx prettier --check docs/sync-contract.md docs/design-layers.md`.

## Step 2: `mksync update` drops the attestation check `[worker]`

Files: `src/app/update.ts`, `src/app/update.test.ts`.

- Remove the attestation dependency from `UpdateDeps` (the `verify` member and its `skipped | verified | failed`
  result), its default (the `gh auth status` plus `gh attestation verify` runner) and the `attestation check failed`
  error.
- Keep `RELEASE_REPO` only if something else still uses it.
- Tests:
  - Delete the attestation tests ("should refuse a failed attestation…" and any test of `skipped`/`verified`).
  - Every other update test passes unchanged, apart from dropping the stub's attestation answer.
  - No test may still mention `attestation`.

Test: `bun test src/app/update.test.ts && bun run lint`.

## Step 3: The installers drop the attestation check `[worker]`

Files: `install.sh`, `install.ps1`, `tests/linux/install.sh`, `tests/windows-vm/install-check.ps1`.

- `install.sh` `install_program`: remove the `attestation verify` block and its `attestation check failed` line, and
  update the function comment ("checked against SHA256SUMS").
- `install.ps1`: remove the `$verify = @('attestation', 'verify', …)` block and its `throw`.
- Tests:
  - Any stub branch or expectation for `attestation` goes.
  - The existing checksum-mismatch case still fails as before.
  - No test may still mention `attestation`.

Test: `tests/linux/install.sh`; and when `tests/windows-vm/vm.sh status` is 0, `tests/windows-vm/vm.sh run
'powershell -NoProfile -ExecutionPolicy Bypass -File tests/windows-vm/install-check.ps1'` (if the VM is down, say so
in the review).

## Step 4: Move history out of `docs/` `[inline: one git mv plus a link rewrite across about 10 files, no code]`

Files: `docs/archive/` (target), and the docs that link to moved files.

- `git mv` into `docs/archive/`:
  - every `docs/plan-*.md` except `plan-single-engine.md` (the roadmap) and `plan-single-engine-10.md` (this plan);
  - `single-engine-research.md`, `macos-research.md`, `windows-survey.md`, `design-test-moves.md` and
    `port-inventory.tsv`.
- Rewrite each link to a moved file in the docs that stay: `docs/design-layers.md`, `docs/sync-contract.md`,
  `docs/windows-cutover-run.md`, the roadmap. The moved files' links to each other keep working because they move
  together. Their links to files that stay get `../`.
- `CLAUDE.md` and the README name no moved file.

Test: a link check over `README.md CLAUDE.md docs/*.md docs/archive/*.md` (every relative `.md` link resolves; a short
`ctx_execute` script, printed result only) and `npx prettier --check docs/*.md`.

## Step 5: README for the finished program `[inline: user-facing docs]`

Files: `README.md`.

- **Install:** drop "The repo is going private… before and after the switch". The lines stay as they are, and one
  sentence says why `gh` is needed (the repo is private). Drop "On a machine set up before v1.0.0…".
- **Run from a clone:** `gh repo clone makubexD/SyncSettings` replaces `git clone https://…`.
- **New "Develop" section,** replacing the one contributors line:
  - `bun install --frozen-lockfile`
  - `./mksync <command>` to run from the clone
  - `bun test src` and `bun run lint`
  - `bun run build` (`dist/mksync`)
  - `tests/all.sh` before a PR
  - a link to `tests/windows-vm/README.md`
  - how a release is made: bump `package.json`, add a `CHANGELOG.md` entry, tag `v<x.y.z>` on `master`, and the
    release workflow does the rest.
- **Read next:** "Sync contract: the rules the program follows"; "Design: how modules, profiles and layers work";
  add `CHANGELOG.md`. Drop the `docs/archive/` line's "the scripts were built from" history.

Test: `npx prettier --check README.md && scripts/ci/leak-scan.sh`.

## Step 6: CHANGELOG, version and the leftover history lines `[inline: user-facing docs]`

Files: `CHANGELOG.md` (new), `package.json`, `docs/layout.md`, `docs/daily-workflow.md`.

- `CHANGELOG.md`: newest first, one section per tag:
  - the `v0.9.0`, `v1.0.0` and `v1.0.1` sections come from `git tag -l --format='%(contents)'`;
  - `v1.0.2` says: no attestation check; `SHA256SUMS` through `gh`; docs reorganized.
- `package.json`: version `1.0.2`.
- `docs/layout.md`: "(phase 7)" goes.
- `docs/daily-workflow.md`: "Moving a machine to the new layout" stays (work #2 and #3 may still need it). Its title
  becomes "Moving a machine from the old layout".

Test: `npx prettier --check CHANGELOG.md docs/layout.md docs/daily-workflow.md && bun run lint`.

## Step 7: PR, merge and release `v1.0.2` `[inline: release run and its verification need judgment]`

- `tests/all.sh`, then `/agent-skills:review` of the branch (one round of fixes).
- Push, open the PR, add `reviewed` after the review, and wait for checks. Merge if `pr-ready` exits 0.
- On `master`, tag `v1.0.2` with its CHANGELOG section as the message, then watch the release run. Check the Linux
  asset: `SHA256SUMS`, `--version` prints `1.0.2`, and `gh attestation verify` still passes (the workflow still
  attests).
- Run `mksync update` from a real `v1.0.1` program in a temp home: once with the signed-in `gh` on `PATH`, once with
  no `gh`. Both reach `1.0.2`.
- Commit the results to the roadmap (phase 10, part A done) with this step's trailer.

Test: the release checks above, and the two update runs print `1.0.2`.

## Part B: CI on a free plan (`engine/private-ci`)

## Step 8: Contract for the new-settings comment `[inline: contract wording needs judgment]`

Files: `docs/review-gate.md`.

- New section "New settings" (decision 3): what counts as new, the comment's exact format and when it updates. The
  label check is unchanged.
- Format:
  - the heading `New settings in this PR`;
  - one line per setting, sorted: `entry <file>`, `file <path>` or `key <path>: <dotted.key>`;
  - or the single line `No new settings.`
- "Repo settings the gate relies on" says that on a free plan with a private repo, branch protection isn't enforced,
  so the label is a habit, not a lock.

Test: `npx prettier --check docs/review-gate.md`.

## Step 9: `tools/new-settings.ts` `[worker]`

Files: `tools/new-settings.ts`, `tools/new-settings.test.ts`.

- A dev-only Bun script: `bun tools/new-settings.ts <base-ref> <head-ref>`.
- It reads both trees with `git show <ref>:<path>` and `git ls-tree -r --name-only <ref>`, and prints the comment body
  from step 8 to stdout, exit 0. A git failure prints `ERROR: <reason>`, exit 2.
- JSON keys:
  - Objects recurse.
  - An array is a leaf, and a new array item counts as its key being new only when the key is new.
  - A file that doesn't parse as JSON on either side lists no keys.
- Test cases, each in a temp git repo with two commits:
  1. No change: `No new settings.`.
  2. A new entry in `sync-config.json`: `entry dotfiles/linux/.tmux.conf`.
  3. A new file under `dotfiles/`: `file dotfiles/linux/new.conf`, and no key lines for it.
  4. A new key in a changed JSON file: `key dotfiles/linux/x.json: a.b`, and nothing for an unchanged key.
  5. A new file under `profiles/` and `machines/`: one `file` line each.
  6. An unparsable JSON file on the head side: no key lines, exit 0.
  7. Lines come out sorted.
  8. An unknown ref: `ERROR:` and exit 2.

Test: `bun test tools/new-settings.test.ts && bun run lint`.

## Step 10: `review-gate.yml` posts the comment `[inline: workflow change, the PR waits for the user's label]`

Files: `.github/workflows/review-gate.yml`.

- New job `new-settings`, on `opened`, `reopened` and `synchronize`:
  - checkout with `fetch-depth: 0`, then Bun 1.4.4, both pinned by SHA as in `release.yml`;
  - `bun tools/new-settings.ts origin/$BASE $HEAD_SHA` writes the body;
  - one comment is created, or edited if one with the marker `<!-- new-settings -->` exists (`gh api`).
- Permissions: `pull-requests: write`, `contents: read`. The `review-gate` job is unchanged.

Test: `python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]))' .github/workflows/review-gate.yml`, and step
12's PR shows the comment.

## Step 11: CI minutes rule and no attestation in releases `[inline: workflow change, the PR waits for the user's label]`

Files: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/workflows/single-engine-probe.yml`
(deleted), `docs/design-layers.md`.

- `ci.yml`:
  - Add a `workflow_dispatch` trigger.
  - Add a `changes` job that sets an output when decision 2's paths changed. It uses
    `git diff --name-only origin/$BASE...HEAD` with `fetch-depth: 0`, and on push or dispatch it is always true.
  - `macos-checks`, `program-macos` and `program-windows` run only `if:` that output is true.
- `release.yml`: drop the "Attest the programs" step, the `id-token` and `attestations` permissions, and "attests
  them" from the header comment.
- Delete `single-engine-probe.yml`.
- Design: the release section says releases are no longer attested, from `v1.0.3` on.

Test: the yaml parse above on both files, then step 12's PR. Its run shows the macOS and Windows jobs because
`ci.yml` changed. A docs-only PR would skip them, which the finish checks on part D's PR.

## Step 12: PR for part B `[inline: workflows, the user adds the label]`

- `tests/all.sh`, `/agent-skills:review` of the branch, push and open the PR.
- The PR doesn't get Claude's label (it touches `.github/workflows/`). Push-notify with the link, and stop:
  "Review and label PR #<n>, then /next".
- On the next `/next`: once it's merged, `git switch master && git pull`, and commit "part B done" to the roadmap with
  this step's trailer.

Test: `pr-ready <n>` exits 0 after the user's label; the merge lands.

## Part C: the switch (the user)

## Step 13: Update every machine, then make the repo private `[inline: the user's machines and the user's switch]`

Claude push-notifies the checklist and stops. The user, on each machine:

1. `gh auth login` (once) and `gh auth status` shows signed in.
2. Personal Linux and any machine with the downloaded program: `mksync update`, and `mksync --version` prints
   `1.0.2`. Work machines that run from the clone: `git -C ~/SyncSettings pull` (Git Credential Manager signed in on
   Windows).
3. When every machine is done, on github.com: Settings → General → Danger Zone → Change visibility → Private. Or run
   `gh repo edit makubexD/SyncSettings --visibility private --accept-visibility-change-consequences`.
4. Tell Claude it's done (`/next`).

Claude then checks `gh repo view makubexD/SyncSettings --json visibility` reads `PRIVATE`. It records the date in
`docs/decision-private-repo.md` ("Switched on <date>") and commits it on `engine/private-after` with this step's
trailer.

Test: the `gh repo view` above prints `PRIVATE`.

## Part D: after the switch (`engine/private-after`)

## Step 14: The guard opens `[inline: read-only check against the real repo]`

- In a temp home with a throwaway clone of the real repo (`gh repo clone`, `GH_CONFIG_DIR` pointing at the real `gh`
  config), with a test machine record: `mksync preview` ends with the "First backup" lines, not "held until the repo
  is private". Nothing is pushed.
- Then the user runs `mksync push` on personal Linux. That is the first backup, a sync PR. Claude reviews its diff:
  - no token or password;
  - only names, emails, usernames and paths in values;
  - `leak-scan` green on `dotfiles/`.
- The user labels and merges it.

Test: the preview lines above; the user's sync PR merged.

## Step 15: The private-repo wording `[inline: user-facing docs]`

Files: `docs/decision-private-repo.md`, `CLAUDE.md`, `docs/configuration.md`, `docs/sync-contract.md`.

- Decision doc:
  - rewrite "What changes" in the past tense, as what happened;
  - state what may be committed now (names, emails, usernames, paths, profiles, machine records) and what never may
    (tokens, keys, `.credentials.json`);
  - close "Follow-ups" or move what's left to the design's "Open" list.
- `CLAUDE.md`:
  - rule 1 becomes "The repo is private: profiles, machine records and values are committed. Never commit secrets;
    `leak-scan` and the sanitize rules stay, and history stays clean as if the repo could go public again";
  - drop the cut-over history sentence and the phase numbers that point at finished work.
- Configuration and contract: where "the repo is public" is the reason for an allowlist, the reason becomes "the repo
  history should stay clean". The allowlists stay.

Test: `npx prettier --check docs/decision-private-repo.md docs/configuration.md docs/sync-contract.md CLAUDE.md &&
scripts/ci/leak-scan.sh`.

## Step 16: Roll back Claude's auto-approval `[inline: touches the gate, the user adds the label]`

Files: `CLAUDE.md`, `docs/review-gate.md`, `TODO.md`.

- `CLAUDE.md`: delete "Claude auto-approval (temporary, development stage)".
- `docs/review-gate.md`: delete "Claude auto-approval (temporary)".
- `TODO.md`: delete the rollback item. `.claude/settings.json` has no `gh pr edit`/`gh pr merge` allow rules (its
  allow list is `Bash(*)` and the tools), so it stays as it is. The macOS M4 item stays.
- The project memory's "auto-merge plan PRs" note is updated: Claude no longer labels or merges.

Test: `grep -rn 'auto-approval' CLAUDE.md docs/review-gate.md TODO.md` prints nothing, and `npx prettier --check`
on the three files passes.

## Step 17: Docs `[inline: docs need judgment]`

Files: `docs/plan-single-engine.md`, `docs/design-layers.md`, `README.md` (only if a line still says "going private").

- Roadmap: phase 10 marked **Done**, with parts A to D and their PRs and the release. "What's left" lists the M4 check
  and the Windows run sheet's extra checks on work #2 and #3.
- Design: "Release and update" and "Public-repo guard" say what's true now. Any "Open" item this phase settled is
  closed with its step.

Test: `npx prettier --check docs/plan-single-engine.md docs/design-layers.md README.md && scripts/ci/leak-scan.sh`.
