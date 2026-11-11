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

**Machines and profiles**
- **Profiles are separate from the OS.** A machine picks its profile on the first run, and nothing in the code ties
  Linux to `personal` or Windows to `work`.
- **A profile per job,** built from modules. The rules every job shares are one `work-base` module that each work
  profile lists, not a parent profile (DRY, no inheritance). Today: `personal` on Linux, and one work profile per
  Windows job (#1, #2, maybe #3).
- **The repo is the backup.** Job profiles, the machine records and each profile's values (emails, usernames, paths;
  never passwords or tokens) are committed, so the last sync is the last backup. This needs the repo to be private
  (phase 9). Until then the engine refuses to commit these while `gh repo view` says the repo is public, and
  development uses `example.com` fixtures only.

**First run**
- It scans the machine: installed tools, the config files it finds and how they compare with each profile, the
  hostname, the Windows domain and the git email. Then it asks four questions:
  - What is this machine for?
  - Will you use Claude here, and how?
  - Should it send changes back?
  - What happens to files that are already here?
- It suggests the best match, including "this replaces the machine `work-1-laptop`". The answers go to a machine
  record; `mksync whoami` prints it, and the scan warns when the machine no longer matches it.
- **Replacing a broken machine:** the first run on the new one takes over the old machine's record. Its profile and
  values come from the repo, so there's almost nothing to answer.
- **A job ends:** nothing to do. The profile stays in the repo as the last backup. `mksync profile retire <name>`
  hides it from suggestions, and it can be revived.

**Push and pull**
- **Work machines may push.** The preview groups changes by who receives them: all machines, machines on this OS,
  this profile, or this machine only. A setting that exists on one OS never reaches another.
- **A new setting with no rule:** the push preview asks where it goes and remembers the answer. It suggests "this
  profile" on work and "all machines" on personal. A value that contains something private to this machine (its
  email, company domain, internal URLs) never goes beyond its profile.
- **Preview by default:** `--yes` skips the question, not the preview or the rules.

**Cuts and deferrals**
- **Linked folders:** the scan (at the first run and as `mksync scan`) finds folders that the shell files point to,
  such as `C:\MakuCustomAlias`, and asks. A yes becomes a normal `dir` entry. Nothing syncs on its own any more.
- **`-User` and admin rights:** a small per-OS wrapper (`RunAs`, `sudo`) that re-runs only the entries marked
  `elevate`, plus `--user <name>`. Designed now, built only when a real case needs it.

**Testing**
- **Everything runs locally during development.** That means:
  - the core's unit tests;
  - Windows path and line-ending behavior simulated on Linux;
  - the shared cases on Linux;
  - Windows end to end in a local VM (KVM and podman).

  One command runs all of it. CI checks after a push. Only macOS needs CI, since there's no Mac.

### Phase 4: the core engine

It starts with the local test bench: one command runs the core's unit tests, the shared cases on Linux, and the
Windows end-to-end run in the local VM.

The TypeScript engine reads config v1 and handles:
- platforms and picking files;
- sanitize and hydrate;
- compare and statuses;
- export, import and the import check;
- backups.

The core is pure: config and files go in, a list of actions comes out. OS adapters do the I/O. It passes the phase 2
cases locally (Linux and the Windows VM) and in CI (all three OSes), next to the old engines.

### Phase 5: modules, profiles and the first run

This phase adds:
- config v2 with modules and profiles;
- the machine scan, the first-run questions, machine records and `mksync whoami`;
- replacing a machine and `mksync profile retire`;
- the guard that refuses to commit profiles, records or values while the repo is public;
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
- Linked folders as scan suggestions (`mksync scan`) that become `dir` entries, replacing `detectLinkedPaths`.
- The `mksync` front door.
- The elevation wrapper, only if a real case exists by then.

### Phase 8: cut-over

- A release workflow builds the programs with checksums, and `install.sh` and `install.ps1` download them.
- The bash and PowerShell engines and their suites are removed. `bootstrap/linux.sh` stays bash.
- The docs describe one engine.

### Phase 9: private repo and review on every change

Starts when development is done.
- Make the repo private (`docs/decision-private-repo.md`, accepted 2026-11-09), and let the engine commit job
  profiles, machine records and values.
- Set the CI minutes rule for a private repo: Linux on every PR, macOS and Windows when engine or installer files
  change, on `master`, or on demand.
- Add a workflow that asks for a reviewer when a sync PR brings a new setting (a new entry, file, JSON key or
  profile), so every change is tracked and reviewed.
- Roll back Claude's auto-approval (`TODO.md`).
