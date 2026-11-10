# One engine for every OS

Phase 5 of `docs/plan-easy-install.md`. Since 2026-11-10 it also delivers modules, profiles and layered settings
(phases 3 and 5-6), so one tool fits a personal Linux machine and several Windows work machines. Today every behavior is written twice: bash (Linux, macOS) and PowerShell
(Windows), about 3,800 and 4,000 lines, with 485 bash cases and 240 Pester cases that test the same contract separately.
The follow-ups plan (2026-11-09) wrote two of its six changes twice, once per engine. This roadmap checks whether one
TypeScript engine, compiled to one program per OS, costs less to keep than two, and builds it only if the research says
so.

## Rules

- No Node on the target machine: the engine ships as a compiled program (Bun or Deno `compile`), and the one-line
  installers download it. A fresh machine restore must keep working with `curl … | bash` and `irm … | iex`.
- `docs/sync-contract.md` stays the spec. The new engine is done when it passes the same cases as both old engines.
- Each "Known differences" row is kept only if the OS forces it (dconf, elevation, file modes); the others pick one
  behavior and the contract records which.
- `bootstrap/linux.sh` stays bash: it runs before anything is installed.
- The docs rule in `docs/plan-easy-install.md` applies to every phase.

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

A design doc, `docs/design-layers.md`, and no engine code. It covers:
- the four layers (base, OS, profile, machine) and modules;
- the machine file and `mksync whoami`;
- the first-run questions;
- the push and pull preview, grouped by who receives each change;
- the new-setting question;
- the config v2 shape and how v1 maps to it;
- the runtime (Bun or Deno) and the TypeScript layout;
- the test approach.

It also inventories the Windows `~/.claude` and checks how Claude Code on Windows runs the statusline and hooks. It ends
with the user's go on the design.

Decisions made 2026-11-10, to be written into the design:

- **Profiles are separate from the OS.** A machine picks its profile on the first run and the answer is stored on that
  machine. Today Linux is `personal` and the Windows machines are `work`, but nothing in the code fixes that.
- **One `work` profile for every job.** Accounts and paths are per-machine values, like the git email today. Job-only
  settings live in the machine layer and are never pushed or backed up. A private repo for them waits until losing one
  hurts.
- **Work machines may push**, with a preview grouped by who receives each change: all machines, machines on this OS, or
  this machine only. A setting that exists on one OS never reaches another.
- **A new setting with no rule:** the push preview asks where it goes and remembers the answer. The suggestion is
  "this machine only" on `work` and "all machines" on `personal`. Values that contain something this machine marks as
  private (its email, company domain or internal URLs) are kept on the machine whatever the answer.
- **First-run hints:** the tool may read the hostname, the Windows domain and the git email to suggest the profile.
  The answers go to `~/.config/mksync/machine.json`, and `mksync whoami` prints them.
- **Preview by default:** `push` and `pull` always show the plan. `--yes` skips the question, not the preview or the
  rules.
- **Cuts:**
  - `detectLinkedPaths` becomes an explicit `dir` entry for `MakuCustomAlias`.
  - `-User` is removed from the engine. Elevation is designed as a small per-OS wrapper (`RunAs`, `sudo`) that re-runs
    only the entries marked `elevate`, and it's built only when a real case needs it.

### Phase 4: the core engine

The TypeScript engine reads config v1 and handles:
- platforms and picking files;
- sanitize and hydrate;
- compare and statuses;
- export, import and the import check;
- backups.

The core is pure: config and files go in, a list of actions comes out. OS adapters do the I/O. It passes the phase 2
cases on Linux, macOS and Windows in CI, next to the old engines.

### Phase 5: modules, profiles and the first run

This phase adds:
- config v2 with modules and profiles;
- the machine file, the first-run questions and `mksync whoami`;
- the push and pull preview, grouped by who receives each change;
- the new-setting question and the private-value rule.

### Phase 6: layers

- A JSON merge for `settings.json`: a base, plus layers from modules.
- `@import` layers for `CLAUDE.md`.
- One `statusline.sh` for every OS.
- The Windows `~/.claude` brought into the sync.

### Phase 7: the rest

- Diff and the sync point.
- Commit and the PR.
- dconf and package drift.
- The `MakuCustomAlias` folder entry, replacing linked folders.
- The `mksync` front door.
- The elevation wrapper, only if a real case exists by then.

### Phase 8: cut-over

- A release workflow builds the programs with checksums, and `install.sh` and `install.ps1` download them.
- The bash and PowerShell engines and their suites are removed. `bootstrap/linux.sh` stays bash.
- The docs describe one engine.
