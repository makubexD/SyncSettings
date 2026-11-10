# One engine for every OS

Phase 5 of `docs/plan-easy-install.md`. Today every behavior is written twice: bash (Linux, macOS) and PowerShell
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
(section 5 of the research). The probe (`probe/single-engine/`, workflow `single-engine-probe`, run by hand) stays for
that decision.

### Phase 2: shared cases

Engine-neutral cases in `tests/parity/` that drive any engine as a black box (files in, command, output and files
out), run against both current engines in CI. Worth doing even with no new engine: it replaces two hand-kept suites
for the same contract.

### Phase 3: the core engine

TypeScript engine: config and platforms, picking files, sanitize and hydrate, compare, statuses, export, import, the
import check, backups. Passes the phase 2 cases on Linux, macOS and Windows in CI, next to the old engines.

### Phase 4: the rest

Diff and the sync point, commit and the PR, dconf, package drift, linked folders, `-User` on Windows, and the `mksync`
front door.

### Phase 5: cut-over

A release workflow builds the programs with checksums; `install.sh` and `install.ps1` download them; the bash and
PowerShell engines and their suites are removed; the docs describe one engine.
