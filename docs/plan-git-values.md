# Git values: one meaning per placeholder, and values that explain themselves (`v1.1.8`)

Found 2026-11-26 on work #2 (`docs/plan-work-machines.md`, step 9), on `v1.1.7`. Push asked `GitHub username:` with no
file named. The question came from `~/.claude/settings.json`: Windows has no repo copy of it yet, so there was nothing
to infer from, and the login it would have taken appears nowhere in that file. Looking into why showed a real bug and
some gaps. Branch `engine/git-values`. Contract: `docs/sync-contract.md` ("Sanitize and hydrate", "Export preview",
"Front door").

## The gaps

1. **One placeholder, two meanings.** `<YOUR_GH_USERNAME>` is the git credential account in
   `dotfiles/windows/git/.gitconfig.local` (`[credential] username = …`), and the owner of the user's own repos in
   `dotfiles/linux/claude/settings.json` (`"repo": "<YOUR_GH_USERNAME>/sigil"`, "repos under
   github.com/<YOUR_GH_USERNAME> are the user's own"). A placeholder has one value per profile. On a work machine the two
   differ (the work login against the personal account), so any answer is wrong for one file, and pull hydrates it
   there.
2. **The question names no file.** ` GitHub username:` doesn't say which file needs it or why it couldn't be read.
3. **`preview` gives up.** The first missing value stops it, so the user sees no file list at all. `check` already
   carries on and marks such a file `SKIPPED … needs values`.
4. **Git config outside the synced files is invisible.** Git also reads `~/.config/git/config` (before `~/.gitconfig`)
   and every `include.path` and `includeIf.*.path` target. A missing `~/.gitconfig.local` is created by the next pull
   from the OS copy, which switches git's credential helper to `gh` at `<GH_CLI_PATH>` without a word.
5. **A first push has nothing to suggest.** Values are inferred only from this OS's repo copy, so a new OS or profile
   always asks, though `gh` knows the login and git knows `user.name` and `user.email`.

## Decided (proposed, for review)

1. **Split the placeholder.** `<YOUR_GH_USERNAME>` stays the git credential account (Windows `.gitconfig.local`). A new
   `<YOUR_GH_OWNER>` (prompt `GitHub owner of your own repos`, profile value) replaces it in `claude/settings.json`'s
   rules and in `dotfiles/linux/claude/settings.json`. No migration code: every machine still holds the owner in its
   local file, and import and export infer it from the unchanged local line against the new repo line. A saved
   `<YOUR_GH_USERNAME>` stays where it is and keeps its meaning.
2. **The question names its files.** Push and pull print `<prompt> (<file>, …):`, the `localPath` of each entry being
   sent or written that has the rule, as `sync-config.json` writes it (`~/.claude/settings.json`), in entry order. A
   value that appears in none of those files is still asked: the program can't know that without the value, and
   skipping would fail open.
3. **Preview shows every file.** A file whose placeholder has no value prints
   `SKIPPED <file>  (needs <PLACEHOLDER>: mksync push asks for it)` and the preview goes on with the rest, the leak scan
   included. It exits 1 when any file was skipped this way, so a script still sees it. `check`'s note becomes
   `needs <PLACEHOLDER>: mksync push or pull asks for it` (it still names `mksync setup` today).
4. **Doctor reads git's own view.** Four `WARN` lines, none of which changes the doctor's exit code:
   - `WARN git also reads ~/.config/git/config; mksync syncs ~/.gitconfig only` when that file exists.
   - `WARN git includes <path>, which mksync doesn't sync` for each `include.path` or `includeIf.*.path` in the global
     files other than `~/.gitconfig.local` and `~/.gitconfig.machine`, home folder written as `~`.
   - `WARN ~/.gitconfig.local is missing; mksync pull creates it from the repo` when the OS has a repo copy and the file
     is missing.
   - `WARN gh is <found path>, not <GH_CLI_PATH value>; mksync pull would point git at the wrong gh` on Windows when
     both are known and differ (case-insensitive).
5. **Suggested defaults.** A rule may name `"suggest": "gh-login" | "git-user-name" | "git-user-email"`. When it asks,
   push and pull run that source (`gh api user --jq .login`, `git config --global user.name`,
   `git config --global user.email`) and show the result as the prompt's default, `<prompt> (<files>) [<value>]:`.
   Enter takes it. A source that fails or prints nothing shows no default. A suggestion is never used without the
   prompt: `--yes`, no input and `preview` stay as they are, so it can never pick a wrong value unseen. The config check
   refuses any other `suggest` value. `sync-config.json` gives `<YOUR_GH_USERNAME>` `gh-login`, `<YOUR_NAME>`
   `git-user-name` and `<YOUR_EMAIL>` `git-user-email`.
6. **Not in this plan.** Syncing `~/.config/git/config` or include targets, and checking a typed answer against the
   files (design "Open"), stay open.

## Step 1: Contract `[inline: contract wording]`

Files: `docs/sync-contract.md`, `docs/configuration.md`, `docs/design-layers.md`.

- "Sanitize and hydrate": the prompt line is `<prompt> (<file>, …):`, with ` [<value>]` before the colon when a
  suggestion is shown (decisions 2 and 5); the suggestion sources and that a suggestion never fills a value unseen.
- "Export preview": decision 3's `SKIPPED` line and the exit code; `check`'s new note.
- "Front door", doctor: decision 4's four lines and where they go (after `values`, before `bash`).
- `docs/configuration.md`: the `suggest` field in the rule table; the placeholder table gains `<YOUR_GH_OWNER>`.
- `docs/design-layers.md`: the file table rows for `.gitconfig.local` and `claude/settings.json` (decision 1); "Open"
  gets the git-config gap as an item done in `v1.1.8`, and decision 6's two items stay open.

Test: `rtk grep -n "YOUR_GH_OWNER\|gh-login\|needs <PLACEHOLDER>" docs/sync-contract.md docs/configuration.md` finds
each, and `npx prettier --check docs/*.md` passes.

## Step 2: Shared cases for the split placeholder `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `tests/parity/cases/owner-inferred-pull/`, `tests/parity/cases/owner-inferred-export/`.

Each case has one `json` entry `parity/settings.json` with two rules, `<YOUR_GH_USERNAME>` (prompt `GitHub username`)
and `<YOUR_GH_OWNER>` (prompt `GitHub owner of your own repos`). Values: `{"<YOUR_GH_USERNAME>": "work-login"}`.

- `owner-inferred-pull`: the repo file is `{"repo": "<YOUR_GH_OWNER>/sigil"}`, and the local file is
  `{"repo": "parity-owner/sigil"}`. `import --force`, no stdin: no question, exit 0, the local file unchanged, and
  `expect/values.json` holds `"<YOUR_GH_OWNER>": "parity-owner"` next to the saved username.
- `owner-inferred-export`: the repo file `{"repo": "<YOUR_GH_OWNER>/sigil", "x": 1}`, the local file
  `{"repo": "parity-owner/sigil", "x": 2}`. `export`: no question, exit 0, and the repo file is
  `{"repo": "<YOUR_GH_OWNER>/sigil", "x": 2}`. `work-login` appears in no file. (Step 2 moved `x` into both files: a key
  added after `repo` gives the local line a trailing comma, and export infers from whole lines only.)

Test: `bun run build && tests/parity/run.sh --engine dist/mksync owner-inferred` passes: today's program already infers
a placeholder by name, so these cases pin that before the config changes.

## Step 3: Split `<YOUR_GH_USERNAME>` in the config `[inline: a public file and real values to check]`

Files: `sync-config.json`, `dotfiles/linux/claude/settings.json`.

- `claude/settings.json` (`os: ["linux", "windows"]`): its `<YOUR_GH_USERNAME>` rule becomes
  `{ "placeholder": "<YOUR_GH_OWNER>", "prompt": "GitHub owner of your own repos" }`.
- `dotfiles/linux/claude/settings.json`: every `<YOUR_GH_USERNAME>` becomes `<YOUR_GH_OWNER>`.
- `.gitconfig.local` (Windows) keeps `<YOUR_GH_USERNAME>`.

Test: `bun run build && ./mksync check` exits 0 in a throwaway clone with `HOME=$(mktemp -d)`;
`rtk grep -rn "YOUR_GH_USERNAME" dotfiles/linux` prints nothing; `scripts/ci/leak-scan.sh` exits 0.

## Step 4: Shared cases for the question naming its files `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `tests/parity/cases/push-ask-names-files/`, and the `expect/output.txt` of every case that prints a value
question (`rtk grep -rl "Enter values" tests/parity/cases/*/expect/output.txt`).

- `push-ask-names-files`: two `whole` entries, `parity/a.conf` and `parity/b.conf` (local paths
  `~/.config/parity/a.conf` and `…/b.conf`), both with rule `<YOUR_NAME>` (prompt `Full name`); nothing infers it.
  `export`, stdin `Ana Lopez\n` (`expect/lines.txt`: the full output has an OS heading): the question reads
  ` Full name (~/.config/parity/a.conf, ~/.config/parity/b.conf):`, exit 0.
- Existing cases: each `<prompt>:` line becomes `<prompt> (<localPath>):` with that case's entries, written from
  the contract, `expect/` only.

Test: `tests/parity/run.sh --engine dist/mksync push-ask-names` fails on the question line, not on fixtures.

## Step 5: The question names its files `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/core/plan/import.ts` (`importValueQuestions`), `src/core/plan/export.ts` (`exportMissingRules`),
`src/app/export.ts`, `src/app/import.ts`, and their tests.

Core: each question carries `files`, the configured `localPath` of each entry being sent (export) or written (import)
that has the rule, de-duplicated, in entry order. App: the prompt line is
`` `  ${prompt} (${files.join(", ")}): ` ``.

Unit cases: one entry gives one file; two entries with the same rule give both, in entry order; an entry skipped by
`--only` is left out.

Test: `bun test src/core/plan src/app/export.test.ts src/app/import.test.ts`, then
`tests/parity/run.sh --engine dist/mksync push-ask` and `… values`.

## Step 6: Shared cases for a preview with a missing value `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `tests/parity/cases/preview-missing-value/` (`expect/` only), `tests/parity/cases/preview-missing-lists/`.

- `preview-missing-value`: the output becomes the `SKIPPED parity/a.conf` line of decision 3 and the summary, exit 1.
- `preview-missing-lists`: two entries, `parity/a.conf` with an unfilled `<YOUR_NAME>`, `parity/b.conf` with none and
  a local change. `preview`: `SKIPPED dotfiles/common/parity/a.conf  (needs <YOUR_NAME>: mksync push asks for it)`,
  `MODIFIED dotfiles/common/parity/b.conf`, the leak scan line, exit 1, no file written.
- `check`'s cases with `needs values: run mksync setup` take decision 3's note, `expect/` only.

Test: `tests/parity/run.sh --engine dist/mksync preview-missing` fails on the missing list, not on fixtures.

## Step 7: Preview lists every file `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/core/plan/preview.ts`, `src/core/plan/check.ts` (the note), `src/core/plan/preview.test.ts`.

Preview plans the export with a sentinel for each missing value, as `importForCheck` does for check, and reports the
entries that hold one as `SKIPPED` with the note; those entries write nothing and aren't leak-scanned. Exit 1 when any
was skipped.

Unit cases: one missing value skips only its entries; two missing values name each placeholder on its own files; no
missing value leaves the preview as today.

Test: `bun test src/core/plan/preview.test.ts src/core/plan/check.test.ts`, then
`tests/parity/run.sh --engine dist/mksync preview` and `… check`.

## Step 8: Unit cases for the doctor's git lines `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/core/front/doctor.test.ts`, `src/app/doctor.test.ts`.

The doctor's git facts are an input (`gitFacts`: `xdgConfig: boolean`, `includes: string[]`, `localMissing: boolean`,
`ghPath?: string`, `ghCliValue?: string`), so the cases need no real git:

1. `xdgConfig` true prints the first line of decision 4.
2. `includes` `["~/.gitconfig.local", "~/.gitconfig.machine", "~/work/.gitconfig"]` prints one line, for
   `~/work/.gitconfig`.
3. `localMissing` true prints the third line.
4. Windows, `ghPath` `C:\Users\u\AppData\Local\gh\gh.exe` and `ghCliValue` `C:\Program Files\GitHub CLI\gh.exe` prints
   the fourth; the same paths in another case print nothing; Linux never prints it.
5. No facts print no git line, and the exit code is the same in every case.

Test: `bun test src/core/front/doctor.test.ts src/app/doctor.test.ts` fails on the missing lines.

## Step 9: The doctor's git lines `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/core/front/doctor.ts`, `src/app/doctor.ts`, `src/adapters/gitconfig.ts` (new, with its test).

Adapter: `readGitFacts(home, run)` runs `git config --global --get-all include.path` and
`git config --global --get-regexp '^includeif\..*\.path$'` (exit 1 means none), checks `~/.config/git/config` and
`~/.gitconfig.local`, writes paths under the home folder as `~/…`, and finds `gh` on `PATH` (the existing `which`).
Core: the four lines from the facts, in decision 4's order.

Test: `bun test src/core/front src/app/doctor.test.ts src/adapters/gitconfig.test.ts`.

## Step 10: The `suggest` field `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/core/config/types.ts`, `src/core/config/v2.ts`, `src/core/config/v2.test.ts`,
`tests/parity/cases/suggest-invalid/`.

`SanitizeRule.suggest?: "gh-login" | "git-user-name" | "git-user-email"`. Any other value stops the config check with
`ERROR: sync-config.json: entry <file> has an invalid suggest.`, exit 1, as an invalid `defaultEnv` does (the contract's
"Path safety"; step 1 corrected the plan's exit 2).

Unit cases: each of the three is read; `"suggest": "x"` and `"suggest": 1` are refused; no field leaves the rule as
it is. Shared case `suggest-invalid`: `check` with `"suggest": "x"` prints the line and exits 1.

Test: `bun test src/core/config`, then `tests/parity/run.sh --engine dist/mksync suggest-invalid`.

## Step 11: Shared cases for suggested defaults `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `tests/parity/run.sh`, `tests/parity/run.ps1` (the `gh` stub answers `api user --jq .login` with
`parity-user`), `tests/parity/cases/push-suggest-enter/`, `tests/parity/cases/push-suggest-typed/`.

Each case: one `whole` entry `parity/a.conf`, rule `<YOUR_GH_USERNAME>` (prompt `GitHub username`,
`suggest: "gh-login"`), repo `user = <YOUR_GH_USERNAME>`, local `color = blue`, `"stubs": ["gh"]`.

- `push-suggest-enter`: `export`, stdin `\n`: the question reads
  ` GitHub username (~/.config/parity/a.conf) [parity-user]:`, exit 0, `expect/values.json` holds `parity-user`.
- `push-suggest-typed`: stdin `other-user\n`: the same question, exit 0, the value is `other-user`.
- `push-yes-no-ask` keeps its output: `--yes` never takes a suggestion.

Test: `tests/parity/run.sh --engine dist/mksync push-suggest` fails on the question line, not on fixtures.

## Step 12: Suggested defaults `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/adapters/suggest.ts` (new, with its test), `src/app/export.ts`, `src/app/import.ts`,
`src/core/values/hydrate.ts` (`askValues` takes the suggestions as defaults after the cached value).

Adapter: `suggestions(rules, run)` runs each named source once, trims its output, and drops an empty, failing or
placeholder-holding result. App: push and pull call it only when they are about to ask, and pass the map to the
questions. An empty answer takes the suggestion; with none it stops as today.

Unit cases: each source's command; a failing `gh` gives no suggestion; Enter takes the suggestion; a typed answer wins;
`--yes` asks nothing and runs no source.

Test: `bun test src/adapters/suggest.test.ts src/app/export.test.ts src/core/values`, then
`tests/parity/run.sh --engine dist/mksync push-suggest push-yes`.

## Step 13: Suggestions in `sync-config.json` `[inline: a public file]`

Files: `sync-config.json`.

`<YOUR_GH_USERNAME>` gets `"suggest": "gh-login"`, `<YOUR_NAME>` `"git-user-name"`, `<YOUR_EMAIL>` `"git-user-email"`, on
every rule of those placeholders.

Test: `bun run build` and `./mksync check` in a throwaway clone exit 0; `scripts/ci/leak-scan.sh` exits 0.

## Step 14: Docs, PR and release `v1.1.8` `[inline: release notes and docs need judgment]`

Files: `package.json`, `CHANGELOG.md`, `docs/daily-workflow.md`, `docs/plan-work-machines.md`, `docs/design-layers.md`.

- `docs/daily-workflow.md`: the value question names its files and may suggest a value; the preview's `SKIPPED … needs`
  line; the doctor's git `WARN` lines and what to do for each.
- `docs/plan-work-machines.md` step 9: work #2 updates to `1.1.8` before its push, answers the new questions, and the
  Linux machine and work #1 run `git pull`, `mksync update` and `mksync pull` once (the owner placeholder). Steps 10
  to 12 expect `1.1.8`.
- Bump to `1.1.8`, with a changelog entry for gaps 1 to 5.
- `tests/all.sh`, `leak-scan`, review (`ts-code-reviewer`, `ts-security-auditor` for values and the doctor's git
  reads), PR, `reviewed`, `pr-ready`, merge. Tag `v1.1.8` after the user's OK, then check `SHA256SUMS` and
  `mksync --version`.

Test: `tests/all.sh` exits 0.
