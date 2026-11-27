# Smart first run, phase 1: guess every value and picker answer (`v1.2.0`)

Roadmap: `docs/plan-smart-first-run.md` (decisions 1 to 6). Branch `engine/smart-first-run`. Contract:
`docs/sync-contract.md` ("Sanitize and hydrate", "No sync point, interactive", push's public name, "Profile values");
config fields: `docs/configuration.md`. No command, flag or exit code changes: each new guess is a suggestion in
brackets that Enter takes, or a value nothing asks for.

Every step's test runs on stubs in throwaway folders; nothing reads the real `~/.config/gh` or the real passwd entry.

## Step 1: Contract and config docs `[inline: contract wording]`

Files: `docs/sync-contract.md`, `docs/configuration.md`.

- "Sanitize and hydrate": `suggest` takes one source or a list; the first source that answers is the suggestion. New
  sources, each run with no shell under the same 5 s limit: `origin-owner` (the owner in the clone's `origin` when it
  is a `github.com` address, read with `git remote get-url origin`; nothing for another host), `gh-hosts-login`
  (`gh config get -h github.com user`, no network), `passwd-name` (Linux and macOS: the full-name field, up to its
  first comma, of `getent passwd <user>`; nothing on Windows or when empty), `gh-path` (`gh` found on `PATH`, as the
  doctor's lookup finds it).
- A rule with `default` and `suggest` `gh-path`: the found path wins over the default and is saved as a machine value;
  neither is asked.
- "No sync point, interactive": a file that offers no `p` suggests `s` on `personal` and `k` on any other profile
  (`[s/r/k] [k]`); an empty answer takes it. Without a record, unchanged (no suggestion).
- Push's public name: the suggestion is `<profile>-<os>` (`work2-windows`), checked as today (`checkAlias`); no
  suggestion without a record.
- "Profile values": a value is a hit only as a whole token: the characters next to it, if any, are not ASCII letters,
  digits, `-` or `_`. The refusal names the change's number as the block above it prints it.
- `docs/configuration.md`: the `suggest` row and its source list.

Test: `rtk grep -n "origin-owner\|gh-hosts-login\|passwd-name\|gh-path\|whole token\|<profile>-<os>" docs/sync-contract.md docs/configuration.md`
finds each.

## Step 2: Config accepts a list of suggest sources `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/core/config/types.ts`, `src/core/config/v2.ts`, `src/core/config/v2.test.ts`.

`SUGGEST_SOURCES` gains `origin-owner`, `gh-hosts-login`, `passwd-name`, `gh-path`. A rule's `suggest` parses as one
source or a non-empty array of distinct sources, kept as `readonly SuggestSource[]`; anything else stops with today's
`ERROR: sync-config.json: entry <file> has an invalid suggest.`, exit 1. Unit cases: a string, a list of two, an empty
list (invalid), a repeated source (invalid), an unknown name (invalid).

Test: `bun test src/core/config` passes; `tests/parity/run.sh --engine dist/mksync suggest-invalid` passes after
`bun run build`.

## Step 3: Run the new sources, first answer wins `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/adapters/suggest.ts`, `src/adapters/suggest.test.ts`.

`sourceCommand` returns the argv for each new source: `origin-owner` runs `git -C <repoRoot> remote get-url origin`
and keeps the owner through the same parser `src/adapters/visibility.ts` uses (export it if it isn't); `gh-hosts-login`
runs `<gh> config get -h github.com user`; `passwd-name` runs `getent passwd <user>` and keeps field 5 up to its first
comma (on macOS, `id -F`); `gh-path` needs no run: the doctor's `which("gh")`. `suggestions` tries a rule's sources in
order and stops at the first answer. Unit cases with the injected runner: each source's argv; a parsed owner from an
`https` and an `ssh` origin; no owner for a non-GitHub host; a passwd line with commas; an empty field; first source
fails, second answers; every source fails (no suggestion).

Test: `bun test src/adapters/suggest.test.ts` passes.

## Step 4: Shared cases for the owner and name guesses `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `tests/parity/cases/pull-suggest-origin-owner/`, `tests/parity/cases/push-suggest-gh-hosts/`.

- `pull-suggest-origin-owner`: `git` remote whose URL is `https://github.com/parity-owner/SyncSettings.git` (the
  runner's remote mode, URL set with `git remote set-url`), a sync point, one `json` entry with `<YOUR_GH_OWNER>` and
  `suggest: ["origin-owner"]`. stdin `\n` then `y\n`. Expect the question
  `GitHub owner of your own repos (~/.config/parity/settings.json) [parity-owner]: `, the value saved, exit 0.
- `push-suggest-gh-hosts`: the `gh` stub answers `config get -h github.com user` with `parity-user` and fails
  `api user`; `suggest: ["gh-hosts-login", "gh-login"]`. Expect `[parity-user]` and no `api user` call in the stub's
  log.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync "pull-suggest-origin-owner|push-suggest-gh-hosts"`
fails (no suggestion shown).

## Step 5: Wire the guesses into `sync-config.json` `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `sync-config.json`, `tests/parity/stubs/gh` (only if it lacks `config get`).

`<YOUR_GH_OWNER>` gets `"suggest": ["origin-owner"]`; `<YOUR_GH_USERNAME>` `["gh-hosts-login", "gh-login"]`;
`<YOUR_NAME>` `["git-user-name", "passwd-name"]`. Nothing else changes.

Test: step 4's cases pass; `tests/parity/run.sh --engine dist/mksync suggest` passes; `bun run lint` is clean.

## Step 6: `<GH_CLI_PATH>` from `PATH` `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/core/values/hydrate.ts`, `src/app/export.ts`, `src/core/values/hydrate.test.ts`, `sync-config.json`.

A rule with `default` and `suggest` containing `gh-path`: when the run has a found `gh` path it is the value (before
the default), and it is saved with the machine's values as an inferred value is. Not asked either way.
`<GH_CLI_PATH>` gets `"suggest": ["gh-path"]`. Unit cases: found path wins and is saved; none found takes the default
and saves nothing; a saved value still wins over both.

Test: `bun test src/core/values src/app` passes.

## Step 7: Shared cases for the picker default `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `tests/parity/cases/push-first-sync-default-work/`, `tests/parity/cases/push-first-sync-default-personal/`.

As `push-first-sync-profile`'s setup, plus a `whole` entry and a `dir` entry that both differ, no sync point. Profile
`work-1`, stdin `\n\n\n`: the `json` file `[p]`, the `dir` file `[s/r/k] [k]` taken as `k`, nothing sent, no sync
point written (a `k` file). Profile `personal`, stdin `\n\n\nn\n`: the `dir` file `[s/r/k] [s]` taken as `s`; the PR
question answered `n`; exit 0.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync push-first-sync-default` fails (`Pick s, r or k.`).

## Step 8: The picker suggests by profile `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/app/push.ts`, `src/app/push.test.ts`.

`offerFor` gives a file with no `p` the suggestion `s` on `personal` and `k` on any other profile, with a record; none
without one. The question prints `[s/r/k] [<choice>]`; `pickChoice` takes an empty answer as the suggestion when there
is one. `--yes` with no sync point is unchanged (it sends, or keeps the `p` files). Unit cases: both profiles, no
record, a typed answer over the suggestion.

Test: `bun test src/app/push.test.ts` passes; `tests/parity/run.sh --engine dist/mksync push-first-sync` passes.

## Step 9: Shared cases for whole-token profile values `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `tests/parity/cases/profile-value-token/`, `tests/parity/cases/profile-value-token-hit/`.

A profile value `A4`. `profile-value-token`: a new base key holding `"#90a4ae"` is not refused. `profile-value-token-hit`:
a new base key `"team A4 tools"` is refused, and the `refused:` line names the change number the block printed
(`refused: change 2 (...)`), exit 1.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync profile-value-token` fails.

## Step 10: Whole-token match and the refusal's number `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/core/plan/profilevalues.ts`, `src/core/plan/profilevalues.test.ts`, `src/app/push.ts` (only if the number
comes from there).

The search folds case as today, then checks the characters on both sides of each hit. The refusal takes its number
from the same number map the block uses (`src/core/plan/groups.ts`). Unit cases: inside a hex color (no hit), between
spaces (hit), next to `-` (no hit), at the start and end of the text (hit), JSON-escaped forms as today.

Test: `bun test src/core/plan` passes; `tests/parity/run.sh --engine dist/mksync profile-value` passes.

## Step 11: Shared case for the public-name guess `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `tests/parity/cases/push-alias-suggest-profile/`.

A record with profile `work-1` on Linux and no alias, a change to send, the `gh` stub; stdin `y\n\n`. Expect
`Public name for this machine's push branches [work-1-linux]: `, the record saved with `"alias": "work-1-linux"`, the
branch `sync/linux-work-1-linux-<stamp>` in the stub's log (the runner's stamp rewrite).

Test: `bun run build && tests/parity/run.sh --engine dist/mksync push-alias-suggest-profile` fails (the login is
suggested).

## Step 12: Suggest `<profile>-<os>` `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/core/plan/commit.ts`, `src/app/commit.ts`, `src/core/plan/commit.test.ts`.

`suggestAlias(profile, os, hostname)` returns `<profile>-<os>` in alias form, or undefined when it fails `checkAlias`
(it names the hostname, or is too long). `src/app/commit.ts` passes the record's profile and OS; the login is no longer
read. Unit cases: `work2` on Windows, `personal` on Linux, a profile equal to the hostname (none), no record (none).

Test: `bun test src/core/plan/commit.test.ts src/app` passes; `tests/parity/run.sh --engine dist/mksync push-record`
passes.

## Step 13: Docs and release `v1.2.0` `[inline: release notes and docs need judgment]`

Files: `package.json`, `CHANGELOG.md`, `docs/daily-workflow.md`, `docs/plan-smart-first-run.md`.

- `docs/daily-workflow.md`: the first run's questions and where each guess comes from; Enter takes it.
- Roadmap: phase 1 marked **Done**.
- Bump to `1.2.0` (new config sources and suggestions), changelog.
- `tests/all.sh` (the Windows VM layer when up), `leak-scan`, review (`ts-code-reviewer`; `ts-security-auditor`, since
  guesses feed values and branch names), PR, `reviewed`, `pr-ready`, merge. Tag `v1.2.0` after the user's OK, then
  `SHA256SUMS`, `mksync --version`, and `mksync update` on the Linux machine.

Test: `tests/all.sh` exits 0.
