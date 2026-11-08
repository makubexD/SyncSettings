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

## Phases

### Phase 1: Linux `docs/plan-easy-install-1.md`

`import.sh --check`, the `mksync` commands, `install.sh` (`curl … | bash`), docs. Proven on this machine with a
throwaway `HOME`.

### Phase 2: Windows

`install.ps1` (`irm … | iex`) installs Git, jq and gh with winget after asking, clones, and puts `mksync.cmd` on the user
`PATH`. `Import-Settings.ps1 -Check`, and the same commands in a PowerShell front door. Pester cases in CI, then a run on
the real Windows machine. Starts after the W0-W6 checks in `TODO.md` pass.

### Phase 3: macOS, gated on research

macOS isn't supported today. The bash engine needs bash 4 and GNU tools (`chmod --reference`, `readlink -f`), while macOS
ships bash 3.2 and BSD tools. Research first: Homebrew bash and coreutils as dependencies, or portable code. A `macos`
platform value also changes the config contract. The output is a decision, then a phase plan.

### Phase 4: optional, the single engine or the data split

Only if one of the "later" conditions above becomes true.
