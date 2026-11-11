# One engine for every OS

Phase 5 of `docs/plan-easy-install.md`. Today every behavior is written twice: bash (Linux, macOS) and PowerShell
(Windows), about 3,800 and 4,000 lines, with 485 bash cases and 240 Pester cases that test the same contract separately.

Phases 1 and 2 researched a single engine and added shared cases. Since 2026-11-10 the roadmap builds one TypeScript
engine, compiled to one program per OS, with modules, profiles and layered settings. It's made for one personal Linux
machine and several Windows work machines, one for each job.

## Rules

- No Node on the target machine: the engine ships as a compiled program (Bun or Deno `compile`), and the one-line
  installers download it. A fresh machine restore must keep working with `curl … | bash` and `irm … | iex`.
- `docs/sync-contract.md` stays the spec. The new engine is done when it passes the same cases as both old engines.
- Each "Known differences" row is kept only if the OS forces it (dconf, elevation, file modes); the others pick one
  behavior and the contract records which.
- `bootstrap/linux.sh` stays bash: it runs before anything is installed.
- The docs rule in `docs/plan-easy-install.md` applies to every phase.
- **Old engines frozen from phase 4 to cut-over.** The bash and PowerShell engines only get bug fixes. Each fix comes
  with a shared case, so the new engine inherits it. No new features go into them.
- **Old engines are deleted only when** every one of their cases that has no shared twin has been ported to the new
  engine's tests (the list from phase 3), and the shadow runs (phase 4) show no unexplained difference.
- **Rollback:** the last commit that still has both old engines gets the tag `two-engines-final` before they're deleted.

## Phases

### Phase 1: research `docs/plan-single-engine-1.md`

Inventory, a compiled probe on four runners, a draft of engine-neutral test cases, and a recommendation. Changes no
engine code. Ends with the user's decision: go (and which runtime), shared cases only, or stop.

**Done 2026-11-09.** Evidence in [single-engine-research.md](single-engine-research.md). Decision: **B, shared cases
only.** Phase 2 goes ahead; both engines stay. Phases 3-5 wait: after phase 2, count the steps that repeat a behavior in
the second engine in the plans that follow, and start phase 3 only if they are still about a quarter of the steps
(section 5 of the research). The probe (`probe/single-engine/`, workflow `single-engine-probe`, run on `workflow_dispatch` or a push to `research/single-engine`) stays for
that decision.

### Phase 2: shared cases

Engine-neutral cases in `tests/parity/` that drive any engine as a black box (files in, command, output and files
out), run against both current engines in CI. Worth doing even with no new engine: it replaces two hand-kept suites
for the same contract.

**Done 2026-11-10** ([plan-single-engine-2.md](plan-single-engine-2.md), PR #65, green run
[42841540002](https://github.com/makubexD/SyncSettings/actions/runs/42841540002)). 37 shared cases; `run.sh` (Linux, macOS)
and `run.ps1` (Windows) run them in the three engine jobs. No old case was removed: each bash or Pester twin checks
text the shared runner doesn't read (notes, `ERROR:` messages, summaries) or takes other inputs; the list is in
`tests/parity/README.md`, "Moved from". So the two engine suites stay, and the shared cases sit on top of them.

**Superseded 2026-11-10:** the user chose option A (one TypeScript engine) without waiting for the count, to gain
modules, profiles and layered settings that two engines would each have to build. The count below no longer gates
phase 3. Former rule: **before phase 3, count twin steps.** In the plans written after phase 2, a twin step is a step that adds a behavior
to the second engine that a step of the same plan already added to the first (the Windows half of a Linux step, or
the other way round); a step that only adds a shared case doesn't count. Over the next three engine plans, divide twin
steps by all steps. Start phase 3 only if that is still about a quarter or more (section 5 of the research); below
that, the shared cases are enough and phases 3-5 stay parked.

### Phase 3: design `docs/plan-single-engine-3.md`

A design doc, `docs/design-layers.md`, with no engine code. It ends with the user's go. It holds every decision below as
a rule with an example, the merge-and-split rules, the catalog, config v2, the runtime choice, and an "Open" list.

Decisions made 2026-11-10, to be written into the design:

**Machines and profiles**
- **Profiles are separate from the OS.** A machine picks its profile on its first run, and nothing ties Linux to
  `personal` or Windows to `work`.
- **A profile per job, plus `personal`,** built from modules. The rules every job shares are a `work-base` module that
  each work profile lists. There's no parent profile.
- **Values sit where they vary:**
  - an account or email belongs to the profile;
  - a path such as `<HOME>` or `<GH_CLI_PATH>` belongs to the machine.

  Today's `.user-values.json` moves into those two places.
- **The repo becomes the backup, once it's private.** Job profiles, machine records and values (never passwords or
  tokens) are committed then. Until the user says development is done and the repo goes private, the engine keeps them
  in the machine's local state and refuses to commit them. The first push after the switch commits them.
- **A job ends:** the profile stays in the repo as the last backup and gets `retired: true`. Retired profiles aren't
  suggested.

**First run**
- It scans the machine: tools, existing config files, hostname, Windows domain and git email. It shows what it found
  and lists the profiles.
- It suggests "this replaces `<machine>`" only when the hostname matches a record exactly. There's no scoring.
- It asks four questions:
  - What is this machine for?
  - Claude here: none, Claude only, or Claude plus DeepSeek?
  - Push with a preview, or pull only?
  - What happens to files that are already here?
- The answers go to the machine record (profile, Claude mode, pull-only), and `mksync whoami` prints it.
- **Replacing a broken machine:** the new one takes over the old one's record.

**Push and pull**
- **Every push shows a preview** grouped by who receives each change: all machines, machines on this OS, this
  profile, or this machine only. A setting that exists on one OS never reaches another.
- **A new setting with no rule:** the preview asks where it goes, suggesting "this profile" on work and "all machines"
  on personal. The answer is stored on the profile, so every machine with that profile knows it.
- **Values that never go beyond their profile:** a literal match on that profile's own values (its emails, domains,
  usernames). Anything else is the leak scan's job, so this rule isn't presented as a guarantee.
- `--yes` skips the question, not the preview or the rules.

**Cuts and fallbacks**
- **Linked folders:** the scan finds folders that the shell files point to and asks; a yes becomes a `dir` entry.
  Today's `.linked/` trees are converted into `dir` entries at cut-over.
- **`-User`:** dropped at cut-over. A small elevation wrapper (`RunAs`, `sudo`) is designed in the "Open" list and
  built only on a real need.
- **If a work machine blocks the unsigned program:** run the tool from a clone, with the runtime installed on that
  machine. The real-Windows checklist covers it.
- **The statusline is written once.** Either one shared script, or a `mksync statusline` subcommand. Phase 3 picks one
  after checking how Claude Code runs commands on Windows.

**Testing**
- Everything Linux can do is done on Linux. One local command runs:
  - the unit tests, with Windows paths and line endings simulated;
  - the shared cases;
  - the Windows cases in a local VM (KVM and podman).

  macOS runs in CI only.
- A case the VM can't run goes on the real-Windows checklist the user runs before cut-over.

### Phase 4: core engine and test bench

- **Step 1** proves the local Windows VM: a capped spike, with a pinned 90-day evaluation image. If it fails, Windows
  falls back to CI and the checklist.
- The local test command, plus a CI workflow that builds the programs as artifacts on every push, for dogfooding.
- **The pure core:** config, platforms, picking files, sanitize and hydrate (JSON-escaped where the file is JSON),
  compare, statuses, export, import, check and backups. It reads the old config through the v2 loader from phase 3.
- It passes the shared cases on Linux and in the VM, and in CI on all three OSes.
- **Shadow mode:** on the user's real machines, the new program's `check` and `preview` run next to the old engine's,
  and their output is diffed. Every difference is explained or fixed.

### Phase 5: layers

- The merge-and-split core from the design: JSON (objects, arrays, key order, byte-exact output, CRLF) and `@import`
  for `CLAUDE.md`.
- Config v2 with modules and profiles, living beside v1 as the design decides.
- Unit tests for every worked example in the design.

### Phase 6: machines

- Machine records, the first-run scan and its four questions, `mksync whoami`, replacing a machine, retired profiles,
  and per-machine and per-profile values.
- The public-repo guard: values stay local and are committed after the repo goes private.

### Phase 7: push, pull and Claude

- **It starts with the only Windows sitting before cut-over.** On work machine #1 the user runs one prompt that
  reports names and structure, never values:
  - the `~/.claude` layout and the `settings.json` keys;
  - the statusline;
  - the shell Claude Code uses;
  - whether Git Bash and `jq` are installed;
  - whether the probe program starts.

  The result is redacted, and it settles the design's "Confirm on Windows" list. Everything else in phases 3-8 runs
  on Linux (and the local VM).
- The preview grouped by who receives each change, the new-setting question, and the profile-value rule.
- The Claude layers: `settings.json` merged from base and modules, `CLAUDE.md` imports, and the statusline written
  once. The Windows `~/.claude` comes into the sync.

### Phase 8: the rest

- Diff and the sync point, commit and the PR per profile, dconf and package drift, linked-folder suggestions, the
  `mksync` front door.
- The cases of the old engines that have no shared twin, ported (the phase 3 list).

### Phase 9: cut-over

- A release workflow builds the programs with checksums and `gh attestation`.
- `install.sh` and `install.ps1` download the program. The tool updates itself with `mksync update`, checking the
  config's `schemaVersion`.
- The `.linked/` trees are converted. Tag `two-engines-final`, then delete the bash and PowerShell engines and their
  suites. `bootstrap/linux.sh` stays bash.
- The user runs the real-Windows checklist: what the VM couldn't run, plus a smoke run (install, first run, pull,
  push, and the run-from-clone fallback). Failures are fixed before the deletion is merged.

### Phase 10: private repo and review

Starts when the user says development is done; it can come before or after phase 9.
- Make the repo private and rewrite `docs/decision-private-repo.md` to say what may be committed now. Lift the guard,
  so profiles, records and values are committed on the next push.
- CI minutes rule: Linux on every PR; macOS and Windows when engine or installer files change, on `master`, or on
  demand.
- The review-gate label check grows: a sync PR that brings a new setting (an entry, a file, a JSON key or a profile)
  gets a red check and a comment listing the new settings until the user adds `reviewed`.
- Roll back Claude's auto-approval (`TODO.md`).
