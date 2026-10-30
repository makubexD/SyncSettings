# Review gate

Every change to this repo lands through a pull request. A required check, `review-gate`, stays red until the
PR carries the `reviewed` label. Two more checks, `leak-scan` and `lint`, run on every PR and must pass too.

## What the checks do

| Check | Workflow | Passes when |
|---|---|---|
| `review-gate` | `.github/workflows/review-gate.yml` | The PR has the `reviewed` label and no commits were pushed since it was added |
| `leak-scan` | `.github/workflows/ci.yml` | `scripts/ci/leak-scan.sh` finds no home paths, Windows profile paths, personal emails, private keys or tokens in `dotfiles/`, `sync-config.json` (and `packages/`) |
| `lint` | `.github/workflows/ci.yml` | shellcheck, the `sync-config.json` sanity checks and PSScriptAnalyzer are clean |

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

1. `commit.sh` / `commit.bat` opens the PR. `review-gate` fails: "Review pending: review the PR, then add the
   'reviewed' label."
2. You read the diff on GitHub and go through the checklist in the PR description.
3. You add the `reviewed` label. `review-gate` runs again and passes.
4. With `leak-scan` and `lint` green too, the PR can be merged.
5. A new commit on the PR removes the label; go back to step 2.

Add the label from the PR page (Labels → `reviewed`) or from a terminal:

```bash
gh pr edit <number> --add-label reviewed
```

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
