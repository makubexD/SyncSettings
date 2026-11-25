# Safe push, visible conflicts, No by default (`v1.1.2`)

Approved by the user 2026-11-25, before `v1.1.2` is released. Contract: `docs/sync-contract.md` ("Sync point", "Front
door", "Diff", "Picking files"). Branch `engine/safe-push`, one PR.

## The bug

Local edit in A, repo change in B: `pull` fast-forwards, stops on A and says "push first"; `push` has no diff guard,
exports every file and stages B back to its old version.

## Decided by the user

1. Push sends only `OUT` files, leaves `IN` files alone and stops on `BOTH`.
2. On a `BOTH`, pull and push show the lines of both sides.
3. Pull and push keep their question and default it to No: `[y/N]`. No `--apply` flag; `--yes` still applies, so scripts
   keep working. The clone still fast-forwards before pull's question.
4. One docs page on the modes.
5. VM back to 4 cores and 4 GB, and the single-copy test.

## Proposed (approved by `/next`)

1. **How push skips.** It exports everything except the `IN` paths (a `skip` list), not only the `OUT` paths: files an
   earlier export left stale in the working tree are rewritten, and linked paths, which `--only` refuses, still work.
2. **Sync point.** A push that left an `IN` file commits with `--partial`. Recording it would make that `IN` read as
   `OUT` next time, and a push would undo the repo's change.
3. **`push --force`** sends `BOTH` files too (this machine's version, through the PR). It still leaves `IN` files alone
   and still asks; `--yes` answers. It also passes a failed diff, then exporting everything as today, with `--partial`.
4. **No sync point.** The newer side is unknown, so push sends everything as today, after a `WARNING` line. `--yes` is
   not refused: a PR is reviewed before it reaches anyone, unlike a pull.
5. **A declined push leaves no trace.** Enter is now No, and the export has already written the repo folder, so the next
   pull would refuse "changes not sent". If the push paths were clean before the export, No restores them; moves made
   in that run are lost with them. If they were dirty before, the files stay, with today's line.
6. **Pull is unchanged otherwise:** one `OUT` or `BOTH` still stops a whole pull. After a push and its merge it goes on;
   `pull <path>` takes single files.
7. **Setup's confirm, "Overwrite" and "Pull now" keep their `[Y/n]`.**

## Wording (fixed; the contract and `expect/` copy it)

Both questions: ` Apply these changes? [y/N]` and ` Open a PR with these changes? [y/N]`. Only an answer starting with
`y` or `Y` is yes; empty and end of input are No.

Push, after the origin check and before the export (stdout unless marked stderr):

```text
  IN         dotfiles/common/parity/b.conf
  1 file(s) are newer in the repo and were left alone; run mksync pull to take them.
```

```text
  BOTH       dotfiles/common/parity/b.conf
<conflict block>
[stderr]   ERROR: 1 file(s) changed on both sides since the last sync.
[stderr]   Merge by hand, then run mksync push --force <path>; or mksync pull --force <path> takes the repo's version (keeps a .bak).
```

- Diff failed: stderr `  ERROR: could not tell which side is newer; run mksync diff to see why, or mksync push --force.`,
  exit 1.
- No sync point: stdout `  WARNING: no sync is recorded on this machine, so this sends every file that differs.`
- Declined, restored: `  Nothing sent; the repo folder is as it was.`, exit 0. Declined, dirty before: today's line.
- Export left nothing to send: today's `Nothing to send: the repo matches this machine.`; with an `IN` it is
  `  Nothing to send.`

Conflict block, one per `BOTH` file, also in pull after its `OUT`/`BOTH` lines:

```text
  --- repo           dotfiles/common/parity/b.conf
  +++ this machine   dotfiles/common/parity/b.conf
  @@ -1 +1 @@
  -repo line
  +machine line
```

The body is git's unified diff from `theirs` to `mine`, with git's own header dropped and two spaces in front of each
line. Over 40 lines: the first 40, then `  … <n> more line(s)`. Binary: `  binary files differ`. One side missing: the
header ends with ` (missing)`. For a `json` entry, one block per `dotfiles/` layer file where `theirs` and `mine`
differ; private layers are never printed. Both sides are the sanitized repo form.

## Shared rules

- Public repo: fixtures use `wk1-laptop`, `box1`, `work-1` only.
- `expect/` is written from this plan, never from engine output. `lines.txt` never mixes stdout and stderr lines.
- Step tests run the named filters; the full suite runs once, in step 13.
- No `pull`, `push` or applied `setup` on the real machine until `v1.1.2` is installed.

## Step 1: Contract `[inline: contract wording needs judgment]`

Files: `docs/sync-contract.md`. "Front door": pull and push rows and their rules, the `--yes` sentence, the shared
lines. "Sync point": the partial push. "Diff": the conflict block. Add `--force` to push.

Test: `grep -n 'Open a PR with these changes' docs/sync-contract.md` shows only `[y/N]`.

## Step 2: Push guard cases `[worker]`

Files: new `tests/parity/cases/push-guard-in/`, `push-guard-in-only/`, `push-guard-both/` (model: `push-front-opens-pr`;
sync point and repo-newer state as in `pull-guard-json-both`). OS `linux`, two `whole` entries `a.conf`, `b.conf`.

- `push-guard-in`: A edited here, B newer in the repo, `push --yes`. The `IN` line and its sentence print; the PR's
  commit holds A; B in the repo keeps the repo's version; the sync point file is unchanged; exit 0.
- `push-guard-in-only`: only B newer. `IN` line, sentence, `  Nothing to send.`, no `gh` call, B unchanged, exit 0.
- `push-guard-both`: B changed on both sides, A edited here. Exit 1, the `BOTH` line and block, the two `ERROR` lines,
  no `gh` call, A and B in the repo unchanged.

Test: `tests/parity/run.sh --engine dist/mksync push-guard` fails on all three: exports revert B or exit 0.

## Step 3: More push cases `[worker]`

Files: new `tests/parity/cases/push-force-both/`, `push-declined-clean/`, `push-declined-dirty/`, `push-end-of-input/`.

- `push-force-both`: as `push-guard-both` with B newer file C added. `push --force --yes`: the commit holds A and B from
  this machine, C keeps the repo's version, the sync point is unchanged, exit 0.
- `push-declined-clean`: A edited, a new file in a `dir` entry, stdin `\n`. Restored line, `git status` empty, exit 0.
- `push-declined-dirty`: an edit already in the repo folder, stdin `n\n`. Today's line, files kept, exit 0.
- `push-end-of-input`: no stdin, no `--yes`. No `gh` call, restored line, exit 0.

Test: `tests/parity/run.sh --engine dist/mksync push-` fails on these four only (and step 2's three).

## Step 4: Pull cases `[worker]`

Files: new `tests/parity/cases/pull-default-no/`, `pull-both-shows-lines/`; edit `pull-guard-json-both/expect/`.

- `pull-default-no`: an `IN` file, sync point, stdin `\n`. `Nothing applied.`, local file unchanged, exit 0.
- `pull-both-shows-lines`: one `whole` file `BOTH`. The `BOTH` line, the block, the guard's two lines, exit 1, unchanged.
- `pull-guard-json-both`: the block is added to its output.

Test: `tests/parity/run.sh --engine dist/mksync pull-` fails on these three only.

## Step 5: `skip` in the export plan `[worker]`

Files: `src/core/plan/pick.ts`, `src/core/plan/export.ts`, `src/core/plan/export.test.ts`, `src/core/plan/types.ts`.
`Snapshot` gains `skip?: readonly string[]`. Beside every `onlySelected` check in `export.ts`, a path equal to a skipped
path, or under `<skipped>.linked/`, is left out: no write, remove, status line or count. A `json` entry is skipped when
any of its slots' `repoPath` or its `printedLabel` is skipped (the label can come from an older tree).

Cases: a skipped `whole` file; a skipped `dir` file, its neighbour still written; a skipped `dir` removal; a `json` entry
skipped by its base path while its primary is the OS path; a skipped dconf entry; an empty list changes nothing.

Test: `bun test src/core/plan/export.test.ts`.

## Step 6: Pass `skip` from the command `[worker]`

Files: `src/cli/parse.ts` (type only, no flag), `src/adapters/snapshot.ts`, `src/adapters/snapshot.test.ts`. `RunCommand`
gains optional `skip`; `snapshot.ts` copies it. Check `src/adapters/fs.ts` near its `only` and pass it there too.

Test: `bun run lint && bun test src/adapters/snapshot.test.ts`: a command's `skip` reaches the snapshot.

## Step 7: Conflict block, pure part `[worker]`

Files: new `src/core/plan/conflict.ts`, `src/core/plan/conflict.test.ts`. `conflictBlock(path, sides, diffBody)`
gives the lines above. Cases: a short diff; exactly 40 lines (no "more" line); 41 (`… 1 more line(s)`); binary; repo side
missing; machine side missing; CRLF lines keep no stray `\r`.

Test: `bun test src/core/plan/conflict.test.ts`.

## Step 8: Conflict block in the diff `[inline: layer and path judgment]`

Files: `src/app/diff.ts`, `src/adapters/git.ts`, `src/cli/parse.ts`. An internal `conflicts` option on the `--diff`
command appends the blocks for `BOTH` labels after the label lines; plain `mksync diff` is byte-identical to today. Text
diff through `git diff --no-index` on temp files, removed on failure too, no external diff driver or color
(`--no-ext-diff --no-color`). Structured data (labels, blocks) goes to pull and push, not parsed from text if the
`Result` can carry it.

Test: `bun test src/app/diff src/adapters/git.test.ts`, `tests/parity/run.sh --engine dist/mksync diff-`.

## Step 9: Pull `[worker]`

Files: `src/app/pull.ts`, `src/app/pull.test.ts`, `src/main.ts`. The question is `[y/N]` with default No; blocked output
includes the conflict blocks. Cases: empty answer, end of input, `n`: nothing applied; `y`, `Y`: applied; `--yes`: not
asked; `OUT` only: no block.

Test: `bun run build && bun test src/app/pull.test.ts && tests/parity/run.sh --engine dist/mksync pull-`: step 4 passes.

## Step 10: Push guard `[inline: data-loss logic]`

Files: `src/app/push.ts`, `src/app/push.test.ts`, `src/cli/parse.ts`, `src/main.ts`. Order: clone, pull-only refusal
(before the guard, as today's message), origin, guard, export with `skip`, status, question, commit. A failed fetch
leaves the guard comparing with the last one. `--force` is parsed and in the usage line; picked paths narrow the diff.
`partial` = paths given, an `IN` left alone, or a forced failed diff. Unit cases: one per row of "Wording", and force
with `IN`, `BOTH` and a failed diff.

Test: `bun run build && bun test src/app/push.test.ts src/cli && tests/parity/run.sh --engine dist/mksync push-`.

## Step 11: Declined push restores `[inline: deletes files in the repo folder]`

Files: `src/app/push.ts`, `src/app/push.test.ts`, `src/adapters/git.ts`, `src/main.ts`. Read the push paths' status before
the export. On No with a clean status: restore the tracked paths and remove only the untracked files the second status
lists, never ignored files, never outside the push paths. A failed restore prints git's error and today's line, exit 1.
Update `push-front-move`: its declined answer now leaves the repo folder clean.

Test: `tests/parity/run.sh --engine dist/mksync push-` all pass, step 3's included.

## Step 12: VM size and single-copy test `[inline: measurement]`

Files: `tests/windows-vm/vm.sh`, `tests/windows-vm/README.md`, `tests/parity/run.ps1`. Defaults `4G` and 4 cores. Then
measure `run.ps1` in the VM with one shared `mksync.exe` (a hard link per case instead of line 1003's copy) against
today's 6m27. `C:\work` and Temp are already Defender exclusions, so if links don't help, try `mksync.exe` as an
excluded process. Keep the change only if it saves at least a minute and every case passes; write the numbers in the
README either way.

Test: `vm.sh run` of the shared cases, all green.

## Step 13: Docs page and full suite `[inline: user-facing copy]`

Files: new `docs/pull-push-modes.md`, `docs/daily-workflow.md`, `README.md`, `docs/design-layers.md`. The page: what
`IN`, `OUT`, `BOTH` and `?` do in pull and push; default, `--yes`, `--force`, paths; read-only `diff`, `check` and
`preview`; how to settle a conflict; what a declined push leaves; when the sync point moves. Replace the stale lines in
the others and link the page. Then reviewers (`ts-code-reviewer`, `ts-security-auditor` on steps 8 and 11), fixes, and
`tests/all.sh` once, green. The release of `v1.1.2` still waits for the user's OK.

Test: `tests/all.sh`; `grep -rn 'changes? \[Y/n\]' docs README.md src --exclude-dir=archive` finds only
setup's, the plan's and history lines.
