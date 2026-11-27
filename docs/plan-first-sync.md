# First sync of an existing machine: every file chosen, every known value caught (`v1.1.9`)

Found 2026-11-26 on work #2 (`docs/plan-work-machines.md`, step 9), on `v1.1.8`, the first push of a machine whose
settings predate the sync. Its `~/.gitconfig` held the git credential sections inline, with the employer's GitHub
organization in a URL, and no `[include]` of `~/.gitconfig.local`. The push would have put that organization into the
shared `.gitconfig`, in a public repo, and replaced the repo's newer `RTK.md` and terminal settings with older copies.
Nothing in the program caught either. The user then fixed it by hand, file by file. Branch `engine/first-sync`.
Contract: `docs/sync-contract.md` ("Cached values", "Export preview", "Diff", "Compare", "Front door" push, "Checks
before pushing").

## The gaps

1. **A value in a file without its rule goes out.** Each file is sanitized with its own entry's rules only. The
   organization is `<YOUR_GH_ORG>` in Windows' `.gitconfig.local`, but it was in `.gitconfig`, whose rules are name and
   email. The commit's cached-value search would have stopped it, but only for a saved value. Push asks only for the
   values of the files it sends, and `.gitconfig.local` was skipped (no local file), so the value was never asked and
   never saved. `preview` doesn't run that search at all. The leak scan's patterns can't know an organization name.
2. **A first sync sends everything.** With no sync point push prints
   `WARNING: no sync is recorded on this machine, so this sends every file that differs.` and does. The newer side of
   each file is unknown, yet there is no way to keep the repo's copy of one file and send another, short of running
   `mksync pull <path>` by hand. Setup's `backup` or `keep` takes one side for every file.
3. **`diff` stops on a missing value.** `missing value for <YOUR_GH_OWNER>` and
   `ERROR: the export for the diff failed; see above.`, while `preview` (v1.1.8) marks the file `SKIPPED … needs` and
   goes on. Push's guard runs that diff before push asks for any value, so with a sync point a missing value stops a
   push with "could not tell which side is newer" instead of asking it.
4. **Line endings alone are a change under `dotfiles/windows/`.** Those files are compared byte for byte, so a CRLF
   copy of an LF repo file (Git for Windows writes `.bash_profile` with CRLF) is `MODIFIED … 0 line(s) changed`.
5. **The leak scan flags `git@github.com`.** `[url "https://github.com/"] insteadOf = git@github.com:` is an SSH
   address, not a person's email.

## Decided (proposed, for review)

1. **Push knows every value this machine uses.** Push asks, besides the sent files' values, for every placeholder of
   the entries this machine syncs (this OS, its profile's layers) that nothing fills, naming the files that need it, as
   v1.1.8 names them. A file this machine lacks is named too: pull would need the value for it. The answers are saved
   as today. `--yes` asks nothing, as today.
2. **Every export is searched for every known value.** The commit's cached-value search ("Checks before pushing")
   also runs in `preview`, after the leak scan, over the files the preview would change. It searches the record's and
   the profile's values (`.user-values.json` without a record) and the machine's hostname. The hostname is matched as a
   whole word, ignoring case, in its full and short form. A hit prints the existing line,
   `ERROR: a cached value for <PLACEHOLDER> is in <file>; nothing was committed.` (preview: `…; nothing was written.`),
   or `ERROR: this machine's hostname is in <file>; …`, then one hint line:
   `  Keep that line in a file the repo doesn't sync (~/.gitconfig.machine, ~/.bashrc.local), or add the placeholder's rule to the file's entry.`
   The preview leaves its diff out and exits 1, as for a leak scan hit. The value is never printed.
3. **Values before the guard.** Push asks its value questions (decision 1) before its diff guard runs, so the guard
   sees every value. The export then finds them saved and asks nothing more.
4. **A first sync asks per file.** An interactive push with no sync point prints, after the value questions, each file
   the diff labels `?` with its line count, and asks for each:

   ```text
     No sync is recorded on this machine, so the newer side of each file is unknown. mksync preview shows each change.

     dotfiles/common/claude/RTK.md  28 line(s) changed
     Send this machine's version (s), take the repo's (r) or skip (k)? [s/r/k]
   ```

   `s` sends the file; `r` overwrites the local file with the repo's (`import --force --only`, keeping a `.bak`); `k`
   leaves both sides. Any other answer prints `  Pick s, r or k.` and asks again; end of input is `k` for that file and
   every one after it. The `r` files are imported first, then the export runs with the `r` and `k` files skipped, then
   commit and PR as today. No `s` file: `  Nothing to send.`, exit 0, no PR. `--yes` keeps today's warning and sends
   everything: a PR is reviewed before it reaches anyone. Setup's `keep` and `backup` stay as they are.

5. **`diff` carries on past a missing value.** A file whose placeholder has no value prints
   `SKIPPED <file>  (needs <PLACEHOLDER>: mksync push or pull asks for it)` among the labels, sorted with them. The
   summary adds `  <n> file(s) need a value first; mksync push or pull asks for it.`, and the diff exits 3, since it
   can't say the sides agree.
6. **Line endings alone are no change on Windows.** A text file (no NUL byte) under `dotfiles/windows/` is compared
   with CRLF folded to LF, as a shared file is. Writes don't change: export writes the local bytes and import the
   repo's, so `.gitattributes`'s `-text` still keeps them.
7. **SSH addresses of the big Git hosts pass the leak scan.** `git@github.com`, `git@gitlab.com`, `git@bitbucket.org`
   and `git@ssh.dev.azure.com` are allowed, as `users.noreply.github.com` is. `git@` at any other host is still a hit:
   a company's own Git server names the company.
8. **Not in this plan.** A list of words a profile must never send (an employer's name that's in no value), the
   record's domain in the search, a diff view inside the picker, and per-file choices in setup go in the design's
   "Open".

## Step 1: Contract `[inline: contract wording]`

Files: `docs/sync-contract.md`, `docs/design-layers.md`.

- "Front door", push: decision 4's block, answers and order; decision 3's order; `--yes` unchanged.
- "Sanitize and hydrate", "Push asks": decision 1, which placeholders push asks for.
- "Checks before pushing", "Cached values": decision 2's sources (record, profile, hostname), the hostname line and
  the hint line; "Export preview": the same search after the leak scan, its `nothing was written` line and exit 1.
- "Diff": decision 5's line, summary line and exit code.
- "Compare": decision 6 for `dotfiles/windows/**`, and the comparison table row.
- `docs/design-layers.md`: "Open" gets decision 8's items; the item "Only an entry's own rules sanitize it … A guard
  that stops an export holding any known value" notes that preview and push now search every known value.

Test: `rtk grep -n "Pick s, r or k\|need a value first\|this machine's hostname is in" docs/sync-contract.md` finds
each, and `npx prettier --check docs/*.md` passes.

## Step 2: Shared cases for SSH addresses `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `tests/parity/cases/preview-leak-ssh-host/`, `tests/parity/cases/preview-leak-ssh-other-host/`.

Copy `preview-leak-found`'s setup (one `whole` entry `parity/a.conf`, a git repo with a commit).

- `preview-leak-ssh-host`: the local file holds `[url "https://github.com/"]` and `insteadOf = git@github.com:`.
  `export --preview`: exit 0, `Leak scan: clean.`, the file `MODIFIED`.
- `preview-leak-ssh-other-host`: `insteadOf = git@git.parity.test:`. Exit 1, the hit line
  `dotfiles/common/parity/a.conf:2: email` and the leak warning, as `preview-leak-found` expects them.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync preview-leak-ssh` fails on `preview-leak-ssh-host`
only (the scan flags it today).

## Step 3: The leak scan allows the big hosts' SSH addresses `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `scripts/ci/leak-scan.sh`.

In `scan_email`'s address loop, an address that is exactly `git@github.com`, `git@gitlab.com`, `git@bitbucket.org` or
`git@ssh.dev.azure.com` (after the existing lower-casing) is allowed, next to `*@users.noreply.github.com`. A comment
says why the four are safe and other hosts aren't.

Test: `tests/parity/run.sh --engine dist/mksync preview-leak` passes; `scripts/ci/leak-scan.sh` exits 0;
`shellcheck scripts/ci/leak-scan.sh` is clean.

## Step 4: Unit cases for Windows line endings `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/core/compare.test.ts`, `tests/parity/cases/windows-crlf-only-unchanged/`.

- `compare.test.ts`: the test "should not fold CRLF for a file under dotfiles/windows on Windows" becomes "should fold
  CRLF for a text file under dotfiles/windows on Windows" (same bytes apart from CRLF: same). New: "should keep a
  dotfiles/windows file with a NUL byte byte for byte" (CRLF and LF copies with a NUL: different), and "should still
  call a dotfiles/windows file with a changed line different".
- `windows-crlf-only-unchanged` (`"os": ["windows"]`): a `whole` entry `shell/.bash_profile` with `"os": ["windows"]`,
  the repo file `dotfiles/windows/shell/.bash_profile` in LF, the local file the same lines in CRLF. `export`: exit 0,
  `UNCHANGED dotfiles/windows/shell/.bash_profile`, the repo file unchanged.

Test: `bun test src/core/compare.test.ts` fails on the first new case only.

## Step 5: Compare Windows text files without line endings `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/core/compare.ts`.

`same()` folds CRLF for a text file (no NUL) on Windows whether or not it's `shared`; a file with a NUL stays byte for
byte. Writes are untouched (`repoBytes` in `src/core/plan/export.ts` still folds only shared files).

Test: `bun test src/core/compare.test.ts src/core/plan` passes. The shared case runs in the VM in the finish.

## Step 6: Shared cases for a diff with a missing value `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `tests/parity/cases/diff-needs-value/`, `tests/parity/cases/diff-needs-value-only/`.

Copy `diff-no-sync-point`'s setup, with a sync point.

- `diff-needs-value`: two entries. `parity/a.conf` has a rule `<YOUR_NAME>` with no value; its repo file is
  `name = <YOUR_NAME>`. `parity/b.conf` has no rule and differs from the sync point locally. `diff`: exit 3, lines
  `OUT        dotfiles/common/parity/b.conf` and
  `SKIPPED    dotfiles/common/parity/a.conf  (needs <YOUR_NAME>: mksync push or pull asks for it)` in path order, the
  summary `1 file(s) differ: 0 in, 1 out, 0 both.` and `1 file(s) need a value first; mksync push or pull asks for it.`
- `diff-needs-value-only`: `a.conf` alone. Exit 3, the `SKIPPED` line and the need-a-value line, no "agree" line.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync diff-needs-value` fails on both (exit 1 today).

## Step 7: The diff carries on past a missing value `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/core/plan/diff.ts`, `src/app/diff.ts`, `src/core/plan/export.ts`.

The diff's export plan uses the preview's skip for a missing value (v1.1.8's `SKIPPED … needs` path in
`src/core/plan/export.ts`) instead of failing, with the `push or pull` note. The diff keeps the skipped files apart from
the labels, prints their lines with the labels in path order, adds the summary line, and exits 3 when any file was
skipped. `DiffReport` gains `skipped: readonly string[]` so push's guard can see them.

Test: `tests/parity/run.sh --engine dist/mksync diff` passes; `bun test src/core/plan/diff.test.ts src/app` passes.

## Step 8: Shared cases for values push asks and finds `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `tests/parity/cases/push-asks-unsent-value/`, `tests/parity/cases/commit-cached-value-elsewhere/`,
`tests/parity/cases/preview-cached-value/`, `tests/parity/cases/preview-hostname/`.

- `push-asks-unsent-value`: `parity/a.conf` (no rule) differs; `parity/b.conf` has a rule `<YOUR_GH_ORG>` (prompt
  `GitHub organization`) and no local file. `export`, stdin `Parity Org\n`: the question
  `GitHub organization (~/.config/parity/b.conf):` is printed, exit 0, `a.conf` `MODIFIED`, and `expect/values.json`
  holds `"<YOUR_GH_ORG>": "Parity Org"`.
- `commit-cached-value-elsewhere`: as `commit-cached-value`, but the value is `<YOUR_GH_ORG>` of `b.conf`'s rule and
  it appears in `a.conf`, which has no rule. Exit 1, the cached-value line for `<YOUR_GH_ORG>` in
  `dotfiles/common/parity/a.conf` and the hint line, nothing committed.
- `preview-cached-value`: the same files, the value saved. `export --preview`: exit 1, `Leak scan: clean.`, the
  preview's cached-value line and the hint, no diff.
- `preview-hostname`: a machine record whose `hostname` is `parity-host`, and `a.conf` holding `server parity-host`.
  `export --preview`: exit 1, `ERROR: this machine's hostname is in dotfiles/common/parity/a.conf; nothing was written.`
  and the hint. A second command with `a.conf` holding `parity-hostess` passes (whole word only).

Test: `bun run build && tests/parity/run.sh --engine dist/mksync "push-asks-unsent|cached-value|preview-hostname"`
fails on all four for the reason each describes.

## Step 9: Push asks for every value this machine uses `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/core/plan/export.ts`, `src/app/export.ts`.

The rules export asks for (`askExportValues`' list) become every rule of the entries this machine syncs whose
placeholder nothing fills, not only those of the planned files; the files named are those entries' `localPath`s, as
v1.1.8 names them. `--yes` is unchanged.

Test: `tests/parity/run.sh --engine dist/mksync "push-asks|push-ask|values-"` passes; `bun test src/core/plan/export.test.ts`.

## Step 10: Preview searches the known values `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/app/export.ts`, `src/app/commit.ts`, `src/core/plan/commit.ts`.

- `src/core/plan/commit.ts`: `cachedValueHits` takes the hostname too (full and short form, whole word, ignoring
  case) and reports which kind matched. The hint line is one constant shared by commit and preview.
- `src/app/commit.ts`: the hostname comes from the machine record; the hint line follows the error.
- `src/app/export.ts`: the preview runs the same search after a clean leak scan, over the files it would change, with
  the preview's `nothing was written` wording; a hit leaves the diff out and exits 1.

Test: `tests/parity/run.sh --engine dist/mksync "cached-value|preview-hostname|preview-leak"` passes;
`bun test src/core/plan/commit.test.ts src/app`.

## Step 11: Shared cases for values before the guard `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `tests/parity/cases/push-guard-asks-value/`.

A sync point, `a.conf` with a rule `<YOUR_NAME>` and no value, changed locally since the sync point. `push`, stdin
`Ana Lopez\n`: the value question first, then the push goes on as for an `OUT` file (exit 0, `gh.log` holds the PR
calls), and `expect/values.json` holds the answer. Today it stops with "could not tell which side is newer".

Test: `bun run build && tests/parity/run.sh --engine dist/mksync push-guard-asks-value` fails with exit 1.

## Step 12: Push asks before its guard `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/app/push.ts`, `src/main.ts`, `src/app/export.ts`.

`PushDeps` gains `askValues: () => Promise<Result | undefined>`, which runs the export's value questions (step 9) on
the push's terminal and saves the answers; `main.ts` wires it. `executePush` calls it before `guardPush` unless
`--yes`; a stop (empty answer, end of input) returns its result. The export after it finds the values saved.

Test: `tests/parity/run.sh --engine dist/mksync push` passes; `bun test src/app/push.test.ts`.

## Step 13: Shared cases for the first-sync picker `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `tests/parity/cases/push-first-sync-pick/`, `tests/parity/cases/push-first-sync-eof/`,
`tests/parity/cases/push-first-sync-bad-answer/`, `tests/parity/cases/push-first-sync-yes/`.

No sync point, three `whole` entries `parity/a.conf`, `b.conf`, `c.conf`, each differing between repo and local, a git
remote and the `gh` stub.

- `push-first-sync-pick`: stdin `s\nr\nk\n`. The block of decision 4 with each file's line, in path order; exit 0; the
  repo's `a.conf` is the local one (sent, PR calls in `gh.log`); the local `b.conf` is the repo's with a `.bak`; `c.conf`
  is unchanged on both sides.
- `push-first-sync-eof`: no stdin. Every file `k`, `Nothing to send.`, exit 0, no `gh` call, no file changed.
- `push-first-sync-bad-answer`: stdin `x\ns\nk\nk\n`. `Pick s, r or k.` once, then `a.conf` sent.
- `push-first-sync-yes`: `--yes`. Today's warning, all three sent, no question.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync push-first-sync` fails on the three interactive
cases only.

## Step 14: The first-sync picker `[inline: DeepSeek balance is out; Claude runs worker steps]`

Files: `src/app/push.ts`, `src/main.ts`, `src/app/push.test.ts`.

In `guardPush`, with no sync point and not `--yes`: run the diff (`deps.runDiff`), take its `?` paths, print the
block, ask each with `deps.ask`'s terminal (a new `askChoice` that reads one line and returns `s`, `r`, `k`, or
undefined at end of input), and return the `r` paths as `take` and the `r` and `k` paths as `skip`. `executePush`
runs `deps.runImport(take)` (`main.ts`: `pullImportCommand(false, true, take)`) before the export; a failed import
stops the push with its code. No `s` path prints `  Nothing to send.` and returns 0 before the export. Unit tests in
`push.test.ts` cover each answer, the retry and end of input.

Test: `tests/parity/run.sh --engine dist/mksync push` passes; `bun test src/app/push.test.ts`.

## Step 15: Docs and release `v1.1.9` `[inline: release notes and docs need judgment]`

Files: `package.json`, `CHANGELOG.md`, `docs/daily-workflow.md`, `docs/plan-work-machines.md`, `docs/design-layers.md`.

- `docs/daily-workflow.md`: the first sync of a machine that already has settings (the picker, what each answer
  does); the cached-value and hostname stop and what to do; machine-only lines go to `~/.gitconfig.machine` and
  `~/.bashrc.local`.
- `docs/plan-work-machines.md` step 9: work #2 updates to `1.1.9` and runs `mksync preview`, then `mksync push`
  (the picker: `r` for `RTK.md` and the terminal settings, `r` for `.bashrc` after moving its nvm lines to
  `~/.bashrc.local`), then `mksync diff` agrees.
- Bump to `1.1.9`, with a changelog entry for gaps 1 to 5.
- `tests/all.sh` (the Windows VM runs `windows-crlf-only-unchanged`), `leak-scan`, review (`ts-code-reviewer`,
  `ts-security-auditor` for the value search, the hostname and the leak scan), PR, `reviewed`, `pr-ready`, merge.
  Tag `v1.1.9` after the user's OK, then check `SHA256SUMS` and `mksync --version`.

Test: `tests/all.sh` exits 0.
