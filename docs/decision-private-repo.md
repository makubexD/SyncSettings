# Decision: keep the repo private, one user

Date: 2026-11-09. Status: accepted.

## Decision

The repo becomes private and stays a single person's sync repo. The engine and the personal data stay in one repo. A
split for several users is written down below so it isn't lost, and isn't built until a second user exists.

## Why

Windows check W0 found machine edits that would have put a home path in `dotfiles/` and copied a whole unrelated
project in through `detectLinkedPaths`. A public repo makes every such slip permanent: switching a repo from private to
public later publishes its whole history, not only the current files.

The other goal is a new machine with no manual setup. Today `.user-values.json` is gitignored, so each machine asks for
the values again. In a private repo those values can be committed (see "Follow-ups").

## What changes when the repo goes private

Check these before switching the visibility; they come from GitHub's plans, not from this repo:

- **Branch protection.** `docs/review-gate.md` relies on branch protection on `master` requiring `review-gate`,
  `leak-scan` and `lint`. On a free personal account, branch protection and rulesets don't apply to private repos;
  they need GitHub Pro. Without it the checks still run, but nothing stops a merge or a push to `master`, so the review
  gate becomes a habit, not a rule.
- **Actions minutes.** Public repos run Actions for free. Private repos on the free plan get a monthly quota, and
  Windows and macOS runners count at a multiple of Linux minutes (macOS the most). `ci.yml` runs `engine-macos` and
  `engine-windows` on every push and PR, so those two jobs use most of the quota.
- **Still needed.** `leak-scan` and the sanitize rules stay. Real secrets never belong in any repo, and placeholders
  such as `<HOME>` and `<GH_CLI_PATH>` exist because machines differ, not only for privacy. Keep the history clean as
  if the repo could go public again.

## Follow-ups

- Committed values: let both engines read the placeholder values from a committed file in the private repo, so a new
  machine needs no prompts. Names, emails, usernames and paths only; tokens stay in the gh keyring and the Windows
  credential store.
- Wording: `CLAUDE.md`, `docs/configuration.md` and `docs/sync-contract.md` say "the repo is public" as the reason for
  allowlists. The allowlists stay; reword the reason when the repo is private.
- `detectLinkedPaths`: it syncs any folder whose path appears in a file, which is how W0 picked up an unrelated
  project. Consider an explicit list of linked folders instead.

## Not chosen yet: several users

For the record, if the repo ever serves more than one person. The rule for all three: the engine repo holds no personal
file, only examples, and the engine code never names a specific user's files.

### A. Public engine repo, private data repo it points to

The engine reads `sync-config.json`, `dotfiles/`, `packages/` and the values from a second clone.

| Pros | Cons |
|---|---|
| Clean split; engine fixes arrive with a normal `git pull` | Every entry point, both installers, the tests and `docs/sync-contract.md` assume the data is in the same repo; all need a data-root setting |
| The data repo holds real values: no sanitizing for privacy, no prompts | `sync-config.json` is the contract and belongs with the data, so a config-format change must land in both repos at once, or a newer engine breaks on older data |
| | Two clones, two PR flows, and CI and a review gate in both |
| | The installer must sign in to a private repo before anything runs |

### B. Template: each user makes a private copy

The engine repo is a GitHub template; each user creates a private repo from it and keeps config, dotfiles and values
there.

| Pros | Cons |
|---|---|
| One repo per user, private, no prompts | A GitHub fork of a public repo stays public, so users must use "Use this template", not fork |
| No runtime link between repos; the engine barely changes | A template copy shares no history with the engine, so pulling engine updates means merging unrelated histories. Cloning and pushing to a new private repo keeps history, but users still merge engine changes by hand |

### C. Private data repo with the engine as a git submodule

The user's private repo holds config, dotfiles and values, and pins an engine version in a submodule.

| Pros | Cons |
|---|---|
| The pin keeps engine and data in step, fixing A's version drift | Submodule friction: `--recursive` clones, detached HEADs, bumping the pin by hand |
| Engine updates are one deliberate pin bump, reviewed in the data repo | Harder on Windows and for users new to git; the installers must handle the submodule |

### When to revisit

When a second person wants to use it. Start from B or C, with the engine repo emptied of personal files. A is the
largest change and only pays off if users want engine updates without touching their own repo.

### Automatic sync

Whichever shape: automatic export and opening the PR are fine. Automatic import is not. One bad push would land on
every machine without anyone looking, which is what the PR, the review gate and the pull guard prevent.
