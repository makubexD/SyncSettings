# One engine, phase 3: design

Roadmap: `docs/plan-single-engine.md`. Goal: `docs/design-layers.md`, a design the user approves before any
TypeScript is written. The decisions of 2026-11-10 in the roadmap's phase 3 are inputs. This phase turns them into
rules, worked examples and file shapes, and lists what is still open.

## Shared rules

- Branch `docs/design-layers`, one commit per step, one PR at the end. Docs only, merged under the usual auto-approval
  once the review passes.
- No engine code. No change to `sync-config.json`.
- Examples use real entries from `sync-config.json`, with `example.com` values, so `leak-scan` stays green.
- **Plain words.** The design is for the user first. Every rule gets one example from the user's machines: personal
  Linux, and Windows work #1-#3.
- **Redaction.** Nothing from a work machine goes into the repo until the user has read it. Names that could identify
  an employer (hooks, skills, MCP servers, paths, hostnames) become `work-tool-1`, `work-mcp-1`, and so on.
- Anything not decided goes in the design's "Open" list. Nothing is decided silently.
- Each step's test is a command, and it fails when the step is missing or incomplete.

## Step 1: Windows session `[inline: needs the user on a Windows work machine]`

File: `docs/design-layers.md` (appendices "Windows Claude today" and "Windows checks").

The user runs one prompt in Claude Code on work machine #1. It gives names and structure, never values:
- the files and folders in `~/.claude`;
- the top-level keys of `settings.json`, each hook's event and command name, and `statusLine.command`;
- the statusline: its language, what it shows, and the tools it calls;
- which shell Claude Code uses there for Bash commands and for the statusline;
- whether Git Bash and `jq` are installed;
- **optional:** whether the probe program from research run 42748992114 (`probe-windows-x64`, Bun or Deno) starts.

  A block is recorded, not fixed. The fallback is to run the tool from a clone.

The user reads the result, and it's redacted under the shared rules. Then mark each item as one of:
- **same as Linux**;
- **same purpose, different implementation**;
- **Windows only**.

Test:
- `jq -r 'keys[]' dotfiles/linux/claude/settings.json | while read -r k; do grep -q "\`$k\`" docs/design-layers.md || echo "missing $k"; done`
  prints nothing.
- `scripts/ci/leak-scan.sh` passes.

## Step 2: How the statusline and hooks run on Windows `[inline: research]`

File: `docs/design-layers.md` (section "Statusline and hooks on Windows").

Combine Claude Code's documentation with step 1's answers:
- which shell runs `statusLine.command` and hook commands on Windows;
- whether `~` and `$HOME` expand there;
- what the statusline needs: `jq`, `git`.

Choose between one shared `statusline.sh` and a `mksync statusline` subcommand:
- the subcommand is written once in TypeScript, needs no `jq` or Git Bash, and starts in about 57 ms on Windows
  (research section 3);
- the script is quicker to tweak by hand.

Write the choice as a line starting `Decision:`, with the reason.

Test: `grep -c '^Decision:' docs/design-layers.md` is at least 1. `grep -cE 'https?://' docs/design-layers.md` is at
least 1.

## Step 3: Catalog `[inline: design judgment]`

File: `docs/design-layers.md` (section "Catalog").

One table row per entry in `sync-config.json` (`repoPath` in backticks), plus the Windows items from step 1. Each row
has:
- the module;
- the layer (base, OS, profile, machine);
- who receives it;
- the merge type (whole file, JSON, `@import`, dconf, dir).

`<YOUR_WORK_MARKETPLACE>` in the common VS Code settings is the worked example of a base file that needs a value per
profile. Any row whose layer isn't obvious goes in "Open".

Test: `jq -r '.files[].repoPath' sync-config.json | while read -r p; do grep -q "| \`$p\`" docs/design-layers.md || echo "missing $p"; done`
prints nothing.

## Step 4: Layers, profiles and values `[inline: design]`

File: `docs/design-layers.md` (sections "Layers", "Modules and profiles", "Values").

- **The layer order** (base, OS, profile, machine), and which layer wins when two set the same key.
- **Modules,** and the module list for `personal` and for a work profile with `work-base`. A module limited to one OS
  can't be switched on elsewhere.
- **The profile file:**
  - its modules;
  - its values (accounts);
  - the destinations remembered for new settings;
  - `retired`.
- **Values:**
  - which belong to the profile (accounts, emails) and which to the machine (paths);
  - how `.user-values.json` moves to them;
  - how a value is JSON-escaped when it's hydrated into a JSON file, for example `C:\Users\x` into `settings.json`.

Test: `for h in '## Layers' '## Modules and profiles' '## Values'; do grep -qF "$h" docs/design-layers.md || echo "missing $h"; done`
prints nothing. `grep -c 'Example:' docs/design-layers.md` is at least 6.

## Step 5: Merge and split `[inline: design, the hardest rules]`

File: `docs/design-layers.md` (section "Merge and split").

- **How import merges a JSON file** from its layers: objects key by key; arrays such as `hooks.*[]` and
  `permissions.allow` by item; key order and indentation, so the output is byte-exact; CRLF.
- **How export splits a changed local file** back into its layers. A worked example for each case:
  1. A key changed that lives in the base.
  2. A key changed that a module's layer sets.
  3. A new array item.
  4. A removed array item.
  5. Claude Code rewriting `settings.json` itself, such as a permission granted or `/model` changed.
  6. A new top-level key, which goes to the new-setting question.
  7. An edit to `CLAUDE.md` inside the base text.
  8. An edit to an `@import` line in `CLAUDE.md`.
  9. A file saved with CRLF on Windows.
- **What import does** when the local file has edits that aren't in any layer yet.

Test: `for n in 1 2 3 4 5 6 7 8 9; do grep -q "^### Case $n:" docs/design-layers.md || echo "missing case $n"; done`
prints nothing.

## Step 6: Machines `[inline: design]`

File: `docs/design-layers.md` (sections "Machine records", "First run", "Replace and retire", "Public-repo guard").

- **The machine record:** profile, machine name, hostname, Claude mode, pull-only, module overrides, and per-machine
  values. Where it's kept: locally until the repo is private, then in `machines/<name>.json`.
- **The first run's exact output:**
  - what the scan found;
  - the list of profiles, and the "replaces `<machine>`" suggestion on an exact hostname match;
  - the four questions with their suggested answers;
  - `mksync whoami`, including the warning when the hostname or domain no longer matches.
- **Replace** (take over a record) and **retire** (`retired: true`).
- **The public-repo guard:** how it reads the repo's visibility, what it refuses, its message, how the first push
  after going private commits what was held locally, and how fixture tests bypass it.

Test: `for h in '## Machine records' '## First run' '## Replace and retire' '## Public-repo guard'; do grep -qF "$h" docs/design-layers.md || echo "missing $h"; done`
prints nothing.

## Step 7: Push, pull and the rest of the rules `[inline: design]`

File: `docs/design-layers.md` (sections "Push and pull", "New settings", "Profile values", "Linked folders", "Open").

- **The preview's exact output,** grouped by who receives each change. `--yes` skips the question, not the preview.
  Pull-only machines have no push.
- **The new-setting question:** its suggestion per profile, and where the answer is stored.
- **The profile-value rule:** a literal match only, and what the leak scan still covers.
- **Linked folders:** the scan's suggestion, and converting today's `.linked/` trees at cut-over.
- **Under "Open":**
  - the elevation wrapper;
  - `-User` dropped at cut-over;
  - whether the employer's policy allows work configs in a personal repo (the user's call).

Test: `for h in '## Push and pull' '## New settings' '## Profile values' '## Linked folders' '## Open'; do grep -qF "$h" docs/design-layers.md || echo "missing $h"; done`
prints nothing.

## Step 8: Config v2 `[inline: design]`

Files: `docs/design-layers.md` (section "Config v2"), `docs/config-v2.example.json`.

- **The v2 shape:**
  - `schemaVersion`;
  - `modules`;
  - each entry's `module` and `merge`;
  - layer sources for JSON and `CLAUDE.md`;
  - `elevate` (reserved);
  - `profiles/<name>.json` and `machines/<name>.json`.
- **Where v2 lives while the old engines still read v1.** Either a separate file, or v2 generated from v1. Decide
  which, and how the two stay in step until cut-over.
- **The v1-to-v2 mapping, one table row per v1 field.**
- **The example** holds one entry of each kind.

Test: `jq -e '.schemaVersion' docs/config-v2.example.json`. Then
`jq -r '[.files[] | keys[]] | unique[]' sync-config.json | while read -r k; do grep -q "| \`$k\`" docs/design-layers.md || echo "unmapped $k"; done`
prints nothing.

## Step 9: Runtime, release and tests `[inline: design]`

File: `docs/design-layers.md` (sections "Runtime", "Code layout", "Release and update", "Tests").

- **Runtime.** Bun, Deno or Node SEA, chosen with the research numbers: size raw and compressed, start-up,
  cross-builds. Also record:
  - the ad-hoc signature on cross-built macOS programs;
  - Gatekeeper and SmartScreen;
  - the step 1 result;
  - the run-from-clone fallback.

  Anything not measured goes to "Open".
- **Code layout.** A pure core that plans the actions, OS adapters, and one merge strategy per file type.
- **Release and update.** CI builds artifacts on every push (from phase 4). At cut-over: releases with checksums and
  `gh attestation`, `mksync update`, and the `schemaVersion` check.
- **Tests:**
  - the local command, with each layer it runs;
  - the plan for the Windows VM in phase 4;
  - shadow mode on the real machines;
  - a table of every `tests/linux/engine.sh` and Pester case with no shared twin, and where each one goes;
  - the first items of the real-Windows checklist.

Test: `for h in '## Runtime' '## Code layout' '## Release and update' '## Tests'; do grep -qF "$h" docs/design-layers.md || echo "missing $h"; done`
prints nothing. `grep -c '^Decision:' docs/design-layers.md` is at least 3.

## Step 10: Docs and close `[inline: docs]`

- `docs/sync-contract.md`: a short "Planned: one engine" note linking the design.
- `docs/single-engine-research.md`: mark the rows the design replaces as superseded: the `detectLinkedPaths` row at
  line 108, the `-User` row at line 111.
- `README.md` and `CLAUDE.md`: one line each pointing to the design.
- The roadmap: phase 3 marked done, with the PR link.
- Project memory: what's decided, what's open, and that phase 4 waits for the user's go.

Test: `git diff --check` is clean. Then
`grep -oE '\]\([^)#]+\.md' docs/design-layers.md | sed 's/^](//' | while read -r f; do [ -f "docs/$f" ] || [ -f "$f" ] || echo "broken $f"; done`
prints nothing.

## Stop

The phase ends with the user's go on `docs/design-layers.md`. Only after that is `docs/plan-single-engine-4.md` written.
