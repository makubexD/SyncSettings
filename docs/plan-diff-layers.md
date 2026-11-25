# Diff sees every layer of an entry (`v1.1.2`)

Found 2026-11-25 on the personal Linux machine with `v1.1.1`. Runs before phase 10 part D: the work machines wait for
`v1.1.2`. Contract: `docs/sync-contract.md` ("Diff", "Layers", "New settings", "Front door"). Branch
`engine/diff-layers`, one PR, then release `v1.1.2`.

## The bug

`mksync diff` says `This machine and the repo agree.` while `mksync check` says a pull would drop a setting. The pull
guard, setup's guard, "keep mine" and the status split all read the diff, so `mksync pull --yes` exits 0 and drops it.

Proven in a throwaway repo: a `json` entry with a base file (`theme`) and a Linux file (`hooks: ["a"]`), a local file
with `hooks: ["a", "mine"]`, profile `personal`, sync point at `HEAD`. `diff` exits 0; `pull --yes` ends with
`hooks: ["a"]`, the old file only in its backup.

Cause: `src/app/diff.ts` owns one path per entry, `primaryRepoPath` (the last layer that exists). The export puts a new
key or item in another layer (the base for `personal`, the profile otherwise), a path the diff doesn't own. Read from
the code, not yet run: a change in the repo to the entry's base file is missed as `IN` too, and profile and machine
layers are in no tree, since `readTreeAt` reads `dotfiles/` only.

## Proposed (approved by `/next`)

1. **One label per entry.** A layered entry keeps printing its label (`primaryRepoPath`), so `--only`, "keep mine" and
   the counts keep working. Its verdict folds all its layer files: any `BOTH`, or an `OUT` with an `IN`, is `BOTH`;
   else `OUT`, `IN`, `?` or nothing.
   Not chosen: a line per layer file. `--only` refuses those paths, so keep would fall back to the whole export.
2. **Private layers.** Profile and machine layer files, read from the snapshot, are added alike to `base` and `theirs`,
   and so to `mine` before the export's writes. A new setting bound for one gives `OUT`; an unchanged one gives nothing.
3. **Hook of this machine.** `ctx-print-guard` is synced for Linux only: the script as a `sync-config.json` entry, its
   wiring in `dotfiles/linux/claude/settings.json`.

## Shared rules

- Public repo: no real names, hostnames, emails or home paths; fixtures use `wk1-laptop`, `box1`, `work-1`.
- Step tests run only the named filters. `expect/` is written from this plan, never from engine output.
- `lines.txt` never mixes stdout and stderr lines: Windows reorders them.
- Until step 7 is done, no `pull`, `push` or applied `setup` on the real machine.

## Step 1: Contract, "Diff" `[inline: contract wording needs judgment]`

Files: `docs/sync-contract.md`. Rewrite the "Only paths this OS's entries own" paragraph and the `base`/`theirs`
bullets with proposals 1 and 2, and the fold as a table.

Test: `rtk grep -n 'layer' docs/sync-contract.md` shows the new text in "Diff".

## Step 2: Cases for a new item in the base layer `[worker]`

Files: new `tests/parity/cases/diff-layers-out/`, `tests/parity/cases/pull-guard-layers/`,
`tests/parity/cases/setup-keep-layers/` (models: `newsetting-yes-personal` for the state, `pull-guard-json-item`,
`setup-keep-out-only`). OS `linux`, sync point set, personal profile. Entry `settings.json`, merge `json`, with
`dotfiles/common/…` = `{"theme":"dark"}` and `dotfiles/linux/…` = `{"hooks":["a"]}`; local =
`{"theme":"dark","hooks":["a","mine"]}`.

- `diff-layers-out`: `diff` prints one `OUT` for the Linux label, `1 file(s) differ: 0 in, 1 out, 0 both.`, exit 3.
- `pull-guard-layers`: `pull --yes` prints `UPDATE` and `OUT` for the Linux label and the guard's two lines, exit 1;
  the local file is unchanged.
- `setup-keep-layers`: `setup --existing keep --yes` ends with `mine` still in the local file and `mine` in the repo
  folder's base file (the suggestion for `personal`), the `Pushed into` line printed, exit 0.

Test: `tests/parity/run.sh --engine dist/mksync layers`: all three fail, the first two because no `OUT` is printed, the
third because `mine` is gone.

## Step 3: Cases for IN, BOTH and the profile layer `[worker]`

Files: new `tests/parity/cases/diff-layers-in/`, `diff-layers-both/`, `diff-layers-profile/`,
`diff-layers-profile-agree/` (same entry).

- `diff-layers-in`: local matches the sync point, `origin` changes the base file's `theme` to `light`: one `IN` for the
  Linux label, exit 3.
- `diff-layers-both`: that `origin` change plus the local item `mine`: one `BOTH` for the Linux label, exit 3.
- `diff-layers-profile`: record with profile `work-1`, whose stored layer holds `{"font":12}`; the local file has that
  `font` and the item `mine` (the suggestion is the profile): one `OUT` for the Linux label, exit 3.
- `diff-layers-profile-agree`: the same without `mine`: no label, `This machine and the repo agree.`, exit 0.

Test: `tests/parity/run.sh --engine dist/mksync diff-layers`: the new cases fail on the missing label, not on setup.

## Step 4: Fold layers into one label `[worker]`

Files: `src/core/plan/diff.ts`, `src/core/plan/diff.test.ts`.

`OwnedEntry` gains optional `layerPaths: readonly string[]`. `labelDiff` labels each path as today, then folds the
verdicts of an entry's `layerPaths` into one line at its `repoPath`; entries without it are unchanged. Output stays
sorted by code unit. Unit tests, layers `[base, os]` with label `os`: base `OUT` gives `OUT`; base `IN` gives `IN`;
base `OUT` with os `IN` gives `BOTH`; any `BOTH` gives `BOTH`; both `OUT` gives one `OUT`; no change gives nothing; no
sync point and base differs gives `?`; no `layerPaths` gives today's result.

Test: `bun test src/core/plan/diff.test.ts` and `bun run lint`.

## Step 5: Diff uses every layer `[worker]`

Files: `src/app/diff.ts` (and its unit test, if one exists).

Pass each `json` entry's `slots` repo paths as `layerPaths`. Copy the snapshot's `profiles/…` and `machines/…` layer
files into both `base` and `theirs` before selecting and planning. `primaryRepoPath` for a label must pick a
`dotfiles/` path: the last layer among base and OS that exists, else `<writeRoot><file>`. `dir`, `dconf` and `whole`
entries keep today's paths.

Test: `bun run lint && bun run build && tests/parity/run.sh --engine dist/mksync layers`, then filters `diff-`,
`pull-guard`, `setup-keep`, `status-`: all pass.

## Step 6: Sync this machine's hook `[inline: real settings, checked against the machine]`

Files: `sync-config.json`, `dotfiles/linux/claude/hooks/ctx-print-guard.sh`, `dotfiles/linux/claude/settings.json`.

Read the script first; placeholders for any home path. Add its entry next to the other Linux hooks and the wiring as in
the local file. Test: `mksync check` from this clone lists `UNCHANGED` for both; `leak-scan` green;
`grep -rl "$HOME" dotfiles/` prints nothing.

## Step 7: Docs, PR and release `v1.1.2` `[inline: docs and release need judgment]`

- `docs/restore.md`, `docs/daily-workflow.md` where they describe `diff`; design "Open": the hook item closed, a note
  that keep with a selection change stays open; roadmap `docs/plan-setup-wizard.md`: the `v1.1.2` hotfix; `1.1.2` in
  `package.json` and `CHANGELOG.md`.
- The finish runs the full suite, review, PR and merge. Before it, restart the Windows VM (`vm.sh down`, `vm.sh up`).
- Then tag and release as `v1.1.1` was, with the user's OK; check `SHA256SUMS` and `--version`; `mksync update`.

Test: on this machine `mksync diff` and `mksync check` both report no difference.
