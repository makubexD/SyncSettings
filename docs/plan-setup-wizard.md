# Setup wizard: safe, then friendly

Started 2026-11-22. On the personal Linux machine `mksync setup` offered to overwrite `~/.claude/CLAUDE.md` and
`mk-delegate/SKILL.md`, which `mksync diff` marks `OUT` (changed only on the machine), with `[Y/n]` and no word about
which side is newer. The user cancelled before any file was overwritten, but the record and profile were already written, so a second
`mksync setup` refuses without `--replace`. A wizard audit (2026-11-22, findings WIZ-1 to WIZ-16, summed
up below) found two paths that overwrite a machine's own changes, no review before writes, and a cramped, inconsistent
layout.

The user chose (2026-11-22): safety and look, in two phases; run now, before phase 10's switch to private, and release
it as `v1.1.0` so the work machines update straight to it. Phase 10 part D resumes after phase 1.

## Phase 1: setup keeps this machine's changes — **Done**

Plan: `docs/plan-setup-wizard-1.md`. Release `v1.1.0`.

- **WIZ-2:** a `y` to the bootstrap question no longer drops answer 4. The bootstrap skips its own import when setup
  runs it, and setup then acts on answer 4.
- **WIZ-1:** with a sync point, setup runs the pull's diff before it writes anything. `OUT` and `BOTH` files are listed,
  and "back up and replace" needs a `[y/N]` confirm (`--yes` refuses, as `mksync pull --yes` does).
- **WIZ-3, WIZ-12:** every question, the bootstrap one included, comes before one review. Declining writes nothing.
- **WIZ-9:** question 4 shows how many files differ and on which side; its suggestion is "keep mine" when any file is
  `OUT` or `BOTH`.
- **WIZ-16:** the Front-door row for setup matches the setup section.

**Hotfix `v1.1.1` — Done** (`docs/plan-setup-hotfix.md`, 2026-11-23), from the user's own setup run after `v1.1.0`: keep mine
exports only the diff's `OUT` and `BOTH` files (with the bootstrap too), end of input at setup's confirm means no, and
shared cases prove the pull guard stops over a local-only JSON array item. Keep's gaps when setup also changes
the profile or modules are in the design's "Open" list, for after the release.

**Hotfix `v1.1.2` — Done** (`docs/plan-diff-layers.md`, 2026-11-25): `mksync diff`, and so the pull guard, keep and the status
line, see every layer of a JSON file. The work machines wait for it.

**Safe push, in `v1.1.2` — Done** (`docs/plan-safe-push.md`, 2026-11-25): push leaves the repo's newer files alone, pull and
push show both sides of a conflict, and their questions default to No. The release waits for the user's OK.

## Phase 2: a friendlier setup

Plan: `docs/plan-setup-wizard-2.md`, written when phase 1 is done. Release `v1.2.0`.

- **WIZ-6:** one option per line, each with a one-line hint; question 1 suggests `personal` when it is the only
  profile.
- **WIZ-8:** a step for the machine name, defaulting to the short hostname.
- **WIZ-7:** `<` goes back one question; the review offers back.
- **WIZ-10:** one layout rule (headings and questions at column 0, details indented 2, status words padded to 11);
  `check-packages` is quiet on success.
- **WIZ-11:** the bootstrap prints `<n> already there` per step instead of one `UNCHANGED` line per package;
  `--verbose` lists them.
- **WIZ-13:** `mksync setup --help`.
- **WIZ-14:** `--linked` and `--value` flags, so a script can answer every question.

## Not planned

Into the design's "Open" list, not built: prompts on stderr (WIZ-5), refusing piped answers without a terminal
(WIZ-4; the hotfix makes end of input at the confirm a no instead), a step-table engine (WIZ-15, phase 2 may need part of it for back navigation).
