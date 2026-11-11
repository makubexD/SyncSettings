# One engine, phase 3: design

Roadmap: `docs/plan-single-engine.md`. Goal: `docs/design-layers.md`, a design the user approves before any
TypeScript is written. It covers:
- layers, modules and profiles;
- machine records and `mksync whoami`;
- the first-run scan and questions;
- replacing and retiring machines;
- the push and pull preview;
- the new-setting question;
- config v2;
- the runtime and the test approach.

The decisions from 2026-11-10 in the roadmap's phase 3 are inputs, not open questions.

## Shared rules

- Branch `docs/design-layers`, one commit per step, one PR at the end. It's docs only, so it's merged under the usual
  auto-approval once the review passes.
- No engine code and no change to `sync-config.json` in this phase. Examples in the design use real entries from
  `sync-config.json`, with `example.com` values, so `leak-scan` stays green.
- Plain words: the design is for the user first. Every rule gets one example from the user's machines (personal Linux,
  work Windows #1-#3).
- Where something is left open, the design says so in an "Open" list. Nothing is decided silently.

## Step 1: Windows `~/.claude` inventory `[inline: needs the user's Windows session]`

File: `docs/design-layers.md` (appendix "Windows Claude today").

The user runs a prompt in a Claude Code session on a Windows work machine. It reports names and structure, never
values:
- the files and folders in `~/.claude`;
- the top-level keys in `settings.json`, and each hook's event and command name;
- what the statusline is written in, what it shows, and which tools it calls.

Record it next to the Linux inventory, and mark each item as one of:
- **same as Linux**;
- **same purpose, different implementation**, like the statusline;
- **Windows only**.

Test: the appendix lists every top-level key of both `settings.json` files, and `leak-scan` passes.

## Step 2: How Claude Code runs commands on Windows `[inline: research]`

File: `docs/design-layers.md` (section "One statusline").

Check Claude Code's documentation, and confirm on the work machine from step 1:
- which shell runs `statusLine.command` and hook commands on Windows (Git Bash, PowerShell or cmd);
- whether `~` and `$HOME` expand there;
- whether `jq` is needed.

Decide how one `statusline.sh` runs on every OS. If it can't, record the smallest fallback.

Test: the section quotes each source (a docs URL or the command run on Windows) next to each claim.

## Step 3: Catalog of today's entries `[inline: design judgment]`

File: `docs/design-layers.md` (section "Catalog").

A table of all 51 entries in `sync-config.json`, plus the Windows Claude items from step 1. Each row has:
- the module;
- the layer (base, OS, profile, machine);
- who receives it (all machines, one OS, this machine only);
- the merge type (whole file, JSON merge, `@import`, dconf).

Flag any entry whose layer isn't obvious, and add it to the "Open" list.

Test: the row count equals `jq '.files | length' sync-config.json` plus the Windows-only items.

## Step 4: The model `[inline: design]`

File: `docs/design-layers.md` (sections "Layers", "Profiles", "Machine records", "First run", "Replace and retire",
"Push and pull", "New settings", "Private values", "Public-repo guard", "Linked folders", "Elevation").

Write down the roadmap's decisions as rules, each with an example:
- **Layer order and conflicts.** A key set in two layers: which wins, and what the preview shows.
- **The profile file.** One per job, plus `personal`. It's a flat list of modules (`work-base` is a module, not a
  parent profile) plus its values. The OS limit always applies.
- **Machine records.** They're stored in the repo; the local file only names which record this machine is. Their
  fields:
  - profile, machine name, module overrides;
  - remembered destinations for new settings;
  - private markers;
  - the scan's hints.
- **The first run and `mksync whoami`.** Show their exact output:
  - what the scan reads, and how a profile match is scored;
  - the four questions, each with its suggested answer;
  - the "replaces `<machine>`" suggestion;
  - the warning when the hints no longer match.
- **Replace and retire.** A new machine takes over a record. `mksync profile retire` and reviving a retired
  profile.
- **The public-repo guard.** The engine checks the repo's visibility and refuses to commit profiles, records or
  values while it's public. Show its message and how a fixture test bypasses it.
- **Linked folders.** The scan's folder suggestions, and how a yes becomes a `dir` entry.
- **The push and pull preview.** Group changes by who receives them. `--yes` skips the question, not the preview or
  the rules.
- **The new-setting question.** It differs per profile and remembers the answer.
- **The private-value rule.** It runs before the leak scan.
- **The elevation wrapper.** Designed here, not built.

Test: each roadmap decision dated 2026-11-10 maps to a section, and the "Open" list holds anything that doesn't.

## Step 5: Config v2 `[inline: design]`

Files: `docs/design-layers.md` (section "Config v2"), `docs/config-v2.example.json`.

- The v2 shape, built from the v1 fields:
  - `modules`;
  - each entry's `module`;
  - `merge` (`file`, `json`, `import`, `dconf`);
  - layer sources for JSON and `CLAUDE.md`;
  - `elevate`;
  - `profiles/<name>.json` with its values;
  - `machines/<name>.json`.
- The v1 to v2 mapping, field by field. v1 configs keep working until phase 8.
- The example holds every kind of entry, not all 51.

Test: `jq empty docs/config-v2.example.json`. Every v1 field in `docs/configuration.md` appears in the mapping.

## Step 6: Runtime, layout and tests `[inline: design]`

File: `docs/design-layers.md` (sections "Runtime", "Code layout", "Tests").

- **Bun or Deno,** picked with the probe numbers in `docs/single-engine-research.md` section 3: size, start-up,
  cross-builds, Gatekeeper and SmartScreen.
- **Code layout.** A pure core (plan the actions), OS adapters (paths, dconf, the elevation wrapper), and one merge
  strategy per file type.
- **Tests.** Unit tests for the pure core, with Windows paths and line endings simulated on Linux, plus the 37 shared
  cases. Say which `engine.sh` and Pester cases have no shared twin, and where each of them goes.
- **The local test command.** One command (for example `./dev test`) runs, on Linux, the unit tests and the
  shared cases. CI runs the same thing on Windows and macOS after a push.
- **The Windows end-to-end checklist** for phase 8. It's run by the user on a real work machine, not by a VM.

Test: each choice names the number or rule behind it.

## Step 7: Docs and close `[inline: docs]`

- `docs/sync-contract.md`: a short "Planned: one engine" note linking the design. The contract itself doesn't change
  until phase 4.
- `README.md` and `CLAUDE.md`: one line each pointing to the design.
- The roadmap: phase 3 marked done, with the PR link.
- Project memory: what's decided, what's open, and that phase 4 waits for the user's go.

Test: `git diff --check` is clean, and every link in the design resolves (`grep -o '](.*\.md' docs/design-layers.md`,
then check each file exists).

## Stop

The phase ends with the user's go on `docs/design-layers.md`. Only after that is `docs/plan-single-engine-4.md` written.
