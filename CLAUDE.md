# CLAUDE.md

SyncSettings keeps one person's settings (shell, tools, VS Code, GNOME dconf, `~/.claude`) in git and restores them on
one personal Linux machine and several Windows work machines, one per job. macOS uses the bash engine and is tested in
CI only.

## Direction

Today two engines implement one contract: bash (Linux, macOS) and PowerShell 5.1 (Windows). The goal is one
TypeScript engine, compiled to one program per OS, with modules, a profile per job (plus `personal`) and layered
settings (base, OS, profile, machine). The old engines are deleted at cut-over.

- Roadmap: `docs/plan-single-engine.md`. The current phase is the first not marked **Done**; its steps are in
  `docs/plan-single-engine-<n>.md`.
- Design: `docs/design-layers.md` (phase 3, approved 2026-11-11) decides runtime, code layout, config v2, layers and
  values.
- Spec: `docs/sync-contract.md`. The new engine is done when it passes the shared cases both old engines pass.

## Rules

1. **The repo is public until phase 10.** Never commit real values: names, emails, hostnames, home paths, accounts.
   Profiles, machine records and values stay in local state. Work-machine details are redacted (`work-tool-1`) and
   shown to the user before any commit.
2. **Contract first.** A rule visible in exit codes, status lines or files gets a shared case in
   `tests/parity/cases/` first, `expect/` written from the contract, not from engine output. Then the code, then
   `docs/sync-contract.md`.
3. **Old engines:** a behavior change goes into both until phase 4; from phase 4 to cut-over, bug fixes only, each
   with a shared case.
4. **Nothing is decided silently.** Open questions go in the design's "Open" list; Windows-only ones under "Confirm on
   Windows". Everything else runs on this Linux machine.
5. **No Node on target machines.** Installers download a compiled program; `curl … | bash` and `irm … | iex` must keep
   restoring a fresh machine. `bootstrap/linux.sh` stays bash.
6. **Docs in every plan:** each step updates the contract it changes; each plan ends with a docs step.

## TypeScript engine (phase 4 on)

- Toolchain approved and in place: Bun 1.4.4 (`package.json`, `bun.lock`; `bun install --frozen-lockfile`). Scripts:
  `bun run lint` (tsc), `bun test src`, `bun run build` (`dist/mksync`). `tools/` holds dev-only scripts.
- Layout: a pure core that plans actions, OS adapters that run them, one merge strategy per file type. Command parsing
  goes under `cli/`, the first-run flow under `wizard/`: the project's CLI and wizard rules only load there.
- Output is byte-exact: JSON key order, CRLF on Windows, trailing newline. Values hydrated into JSON are JSON-escaped.
- Command names, flags and exit codes are fixed by the contract ("Front door"). Renames suggested by the `cli` or
  `wizard` skill go in "Open" as a migration.
- Project agents and skills (sigil, `.sigil/manifest.json`): `ts-architecture-reviewer` for layout and module
  boundaries, `ts-code-reviewer` per step, `ts-security-auditor` for sanitize, values and the public-repo guard,
  `ts-debugger` for failing tests, `cli`/`cli-auditor` for `mksync` commands, `wizard`/`wizard-auditor` for the first
  run, `ts-add-package` before any dependency. `ts-npm` and `ts-add-package` assume npm: adapt them for Bun or Deno.

## Today's engines

- `sync-config.json` maps `repoPath` (under `dotfiles/<platform>/<tool>/`) to `localPath`. The required `platform`
  (`windows`, `linux`, `macos`, `common` or a list) picks the engine. Fields: `docs/configuration.md`; layout:
  `docs/layout.md`. `packages/linux/` lists are hand-edited; export never writes them (`docs/packages.md`).
- Bash 4.4+ with `jq`, `git`, `cmp` (macOS: Homebrew bash; `/bin/bash` 3.2 only reaches the re-exec guard):
  `export.sh`, `import.sh`, `commit.sh`, helpers in `scripts/linux/`. PowerShell: `sync.cmd` → `scripts/windows/`.
  They share the config and the `.user-values.json` format, not code.
- `mksync` (`scripts/linux/front.sh`, `scripts/windows/Front.ps1`) is the front door: `status`, `doctor`, `setup`,
  `pull`, `push`, `check`, `diff`, `preview`. It calls the entry points and never syncs a file itself. Push opens a PR
  from a `sync/<os>-…` branch and never pushes to `master`.
- Invariants: compare by content, never by date; `sanitizeRules` turn values into `<PLACEHOLDERS>` on export and
  hydrate them on import, stopping rather than writing a placeholder; import writes `<file>.bak` first; one failing
  file doesn't stop the rest.
- Bash: read with `read_text`, write with `write_text`, never `$(cat f)`. No `@tsv`: parse NUL-separated
  (`jq -j … "\u0000"`, `read -d ''`). A prompt in a piped loop reads from another fd (`read … <&3`). `cp -p` for copies,
  `chmod --reference` for written files.
- PowerShell 5.1: no `??`, no ternary; `[IO.File]::WriteAllText()` for UTF-8 without BOM.

## Tests

- Everything local, in order, stopping at the first failure: `tests/all.sh` (lint, `bun test src`, config check, build,
  shared cases against the program and bash, then the Windows VM layer when `tests/windows-vm/vm.sh status` is 0).
- Shared cases: `tests/parity/run.sh [--engine dist/mksync] [filter]`. Unit tests: `bun test src`. Bash engine:
  `tests/linux/engine.sh [filter]`. Bootstrap: `tests/linux/bootstrap.sh [filter]`. `run.ps1` runs in the local VM
  (`tests/windows-vm/README.md`); Pester only on CI.
- Never test on the real machine: use `HOME=$(mktemp -d) ./import.sh --force < /dev/null` and a throwaway clone for
  `commit.sh`. dconf cases run on `on_test_bus`; never `dconf load` or `dconf write` on the real bus. Bootstrap and
  drift cases run on stubs; nothing may reach the real `sudo`, `apt-get`, `snap` or `curl`.
- Before committing synced files: `leak-scan` green and `grep -rl "$HOME" dotfiles/` prints nothing.

Every change reaches `master` through a PR that the `review-gate` check holds red until it carries the `reviewed`
label; see `docs/review-gate.md` and `docs/daily-workflow.md`.

### Claude auto-approval (temporary, development stage)

Claude may add the `reviewed` label and merge a PR (`gh pr merge <n> --merge --delete-branch`) without asking,
once all of these hold:

1. Claude has read the full diff and rerun the PR's tests.
2. `lint` and `leak-scan` are green.
3. The PR touches none of: `.github/workflows/`, `docs/review-gate.md`, `.claude/settings.json`, or this section.
   Those PRs, and any PR with a failing check, wait for the user to add the label.

After a merge, `git switch master && git pull`. Remove this section when development is done; see `TODO.md`.
