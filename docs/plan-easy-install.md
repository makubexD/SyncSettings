# Easy install and one smart command

Goal: on any computer, one line installs the tool, and one command, `mksync`, shows where the machine stands and what to
run next. Sending changes, getting updates and first-time setup each take one command.

## Decision (2026-11-08)

We compared four options: a wizard and installers on top of the current scripts, a Node/npm rewrite, one compiled
program like agent-notifications, and splitting the engine from the user's data.

- **Chosen:** keep the bash and PowerShell engines and add the front door on top: one-line installers, `mksync` with
  `status`, `doctor`, `setup`, `push`, `pull`. This covers most of the experience at the lowest cost. It also works on a
  fresh machine, because nothing needs Node.
- **Not now:** a Node/npm package. A fresh machine has no Node, which breaks the restore flow.
- **Later, if keeping two engines costs too much:** one TypeScript engine compiled to one program per OS (Bun or Deno).
  The fixtures in `tests/fixtures/` would prove that it behaves the same.
- **Only if other people use it:** split the engine from the data. Today this is one person on several machines and
  accounts, so it isn't needed.

## Name

The command is `mksync`, a link to the repo's `sync` script. A command named `sync` would hide coreutils `sync`, which
flushes disks. Inside the repo, `./sync` keeps working.

## Commands (same on every OS)

| Command | Does |
|---|---|
| `mksync` | Status: OS, repo, updates waiting on origin, exported changes not sent yet, whether this machine matches the repo, and the command to run next |
| `mksync doctor` | Checks the tools, the GitHub sign-in, the clone and the link, and prints the fix for anything missing |
| `mksync setup` | First run on a machine: doctor, then the import check, then apply (with the Ubuntu restore offered) |
| `mksync pull` | Pull the latest repo, which updates the tool too, then show and apply what changes on this machine |
| `mksync push` | Export this machine's changes, show them, then open the PR |
| `preview`, `export`, `commit`, `import` | Unchanged |

## Docs rule

Docs are part of every phase, not an afterthought:

- A step that changes behavior updates `docs/sync-contract.md` in the same commit.
- Every phase plan ends with a docs step that brings `README.md`, `docs/daily-workflow.md`, `docs/restore.md` and
  `CLAUDE.md` up to date, and enriches them: sample output, troubleshooting for the errors a user can hit, and what each
  command writes where.
- The finish checks that no doc still describes the old behavior (`grep` for the phase's "until phase N" notes).

## Phases

### Phase 1: Linux `docs/plan-easy-install-1.md` (done 2026-11-08)

`import.sh --check`, the `mksync` commands, `install.sh` (`curl … | bash`), docs. Proven on this machine with a
throwaway `HOME`.

### Phase 2: Windows `docs/plan-easy-install-2.md` (code done 2026-11-08; the real run on Windows is W7 in `TODO.md`)

`install.ps1` (`irm … | iex`) installs Git and gh with winget after asking, clones, and puts `mksync.cmd` on the user
`PATH`. `Import-Settings.ps1 -Check`, and the same commands in a PowerShell front door. The PowerShell engine doesn't use
jq, so Windows doesn't install it. Pester cases in CI, then a run on the real Windows machine.

On 2026-11-08 the user chose to start this phase before the W0-W6 checks in `TODO.md` ran. They still gate the real run on
Windows, the last step of the phase.

### Phase 3: macOS research `docs/plan-easy-install-3.md` (done 2026-11-08)

A probe on `macos-latest` measured both routes (`docs/macos-research.md`). The user chose option C: Homebrew `bash` and
`jq` are required, the bash 4 code stays, and the two GNU-only flags on the engine's path get portable helpers. No Mac is
in use yet, so CI proves the macOS work. First tools: git, Claude Code's OS-neutral files, VS Code, the terminal tools and
zsh.

### Phase 4: macOS build `docs/plan-easy-install-4.md`

A `macos` platform value, platform lists (`["linux", "macos"]`) and per-OS `localPaths`; OS detection with a `SYNC_OS`
override for tests; a bash 4 guard that re-execs under Homebrew bash; `mksync` and `install.sh` on macOS; an
`engine-macos` CI job; shared entries moved to `dotfiles/common/`, and zsh and git files under `dotfiles/macos/`.

### Phase 5: optional, the single engine or the data split

Only if one of the "later" conditions above becomes true.
