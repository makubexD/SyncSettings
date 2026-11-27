# Review gate

Every change to this repo lands through a pull request. A required check, `review-gate`, stays red until the
PR carries the `reviewed` label. Three more checks, `leak-scan`, `lint` and `bootstrap-check`, run on every PR
and must pass too.

## What the checks do

| Check         | Workflow                            | Passes when                                                                                                                                                        |
| ------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `review-gate` | `.github/workflows/review-gate.yml` | The PR has the `reviewed` label and no commits were pushed since it was added                                                                                      |
| `leak-scan`   | `.github/workflows/ci.yml`          | `scripts/ci/leak-scan.sh` finds no home paths, Windows profile paths, personal emails, private keys or tokens in `dotfiles/`, `sync-config.json` (and `packages/`) |
| `lint`        | `.github/workflows/ci.yml`          | shellcheck, the `sync-config.json` sanity checks and PSScriptAnalyzer are clean                                                                                    |

`leak-scan` prints only `file:line: <rule>`, never the matched text, so a leak doesn't end up in the CI log.
Run it locally before committing:

```bash
scripts/ci/leak-scan.sh
```

## Why a label and not an approval

GitHub doesn't let the author of a PR approve it. In a repo with one maintainer, requiring an approving
review would block every PR. A label is something you can add yourself, but only on purpose: you open the PR,
read the diff, then add `reviewed`. That click is the review.

The label only counts for the commits you reviewed. When new commits are pushed to the PR, `review-gate`
removes the label and goes red again. Review the new commits, then add the label again.

## Lifecycle of one PR

1. `commit.sh` / `mksync push` opens the PR. `review-gate` fails: "Review pending: review the PR, then add the
   'reviewed' label."
2. You read the diff on GitHub and go through the checklist in the PR description.
3. You add the `reviewed` label. `review-gate` runs again and passes.
4. With `leak-scan` and `lint` green too, the PR can be merged.
5. A new commit on the PR removes the label; go back to step 2.

Add the label from the PR page (Labels → `reviewed`) or from a terminal:

```bash
gh pr edit <number> --add-label reviewed
```

## New settings

A sync PR can bring a setting that wasn't in the repo before. So that you don't have to find it in the diff, the
`new-settings` job in `.github/workflows/review-gate.yml` posts one comment on the PR listing them. It runs when the PR
is opened, reopened or pushed to, and edits its own comment (marked `<!-- new-settings -->`) instead of adding one. It
doesn't change the label check: every PR still waits for `reviewed`.

A new setting is, comparing the PR's head with the commit where it left its base (`git merge-base`), so a branch
that is behind never lists what the base has since removed:

- an entry in `sync-config.json` whose `file` the base doesn't have;
- a file under `dotfiles/`, `profiles/` or `machines/` that the base doesn't have;
- in a `.json` file under those folders that both sides have, a key path the base doesn't have. Objects are followed
  key by key; an array counts as one value, so a new item in it is not listed. A file that isn't valid JSON on either
  side lists no keys, and a new file lists only its `file` line.

The comment is the heading, a blank line, then one line per setting, sorted:

```text
New settings in this PR

entry <file>
file <path>
key <path>: <dotted.key>
```

With nothing new, the line under the heading is `No new settings.` instead. Locally,
`bun tools/new-settings.ts <base-ref> <head-ref>` prints the same text.

## Claude auto-approval (temporary)

During development, Claude may add the `reviewed` label and merge a PR itself after reviewing the full diff,
rerunning the tests and seeing every other check green. The label then means Claude reviewed the PR, not you. This
covers PRs that change the gate itself too (`.github/workflows/`, this file, `.claude/settings.json`, the
auto-approval section of `CLAUDE.md`), so nothing waits for you during development. The rules are in `CLAUDE.md`;
the rollback in `TODO.md` gives the review back to you when development is done.

## Get an email when a check fails

The red `review-gate` run on each new PR is your reminder that a review is waiting. GitHub sends workflow
notifications to the person who triggered the run, so turn them on for yourself:

1. GitHub → your avatar → **Settings** → **Notifications**.
2. Under **System** → **Actions**, choose **Email** (and/or **On GitHub**).
3. Check **Only notify for failed workflows**.

## Repo settings the gate relies on

These are set once on GitHub (plan step 8):

- The `reviewed` label exists.
- Branch protection on `master` requires `review-gate`, `leak-scan` and `lint`, and applies to admins too.
  A direct push to `master` is rejected, so a PR is the only way in.
- Merged branches are deleted automatically.

On GitHub Free, a private repo's branch protection and rulesets aren't enforced. The checks still run and
`review-gate` still turns red, but GitHub lets a PR merge anyway, and a direct push to `master` goes through. There
the label is a habit you keep, not a lock: merge only PRs with every check green.
