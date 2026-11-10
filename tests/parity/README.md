# Shared cases (draft)

Cases that test the [contract](../../docs/sync-contract.md) through the command line only, so one case runs against
any engine: bash, PowerShell, or a future compiled one. This folder is a phase 1 draft
([plan-single-engine-1.md](../../docs/plan-single-engine-1.md), step 5). No runner exists yet; phase 2 writes it.

## A case

Each case is a folder under `cases/`:

```
cases/<name>/
  case.json        what to run
  home/            the home folder before the run (optional; empty when missing)
  repo/            repo files before the run, besides sync-config.json (optional)
  expect/
    exit           one exit code per command, one per line
    output.txt     the status lines of every command, in order
    home/          the whole home folder after the last command
    repo/          the whole repo after the last command, besides sync-config.json
```

`case.json`:

| Field | Meaning |
|---|---|
| `description` | One sentence: the behavior and the contract section it checks |
| `os` | Where it runs: a list of `linux`, `macos`, `windows`. Omit for all three |
| `config` | The whole `sync-config.json`, written into the repo before the run |
| `values` | Optional. Written as `.user-values.json` in the repo; omit to have none |
| `commands` | The commands, run in order in the same folders. Each is `{ "command": …, "options": {…} }` |

`command` is one of the `sync` commands (`export`, `import`, `check`, `preview`, `commit`) and `options` uses neutral
names that the runner spells for each engine: `force: true` is `--force` or `-Force`, `only: [paths]` is `--only` or
`-Only`. Every command runs with stdin empty and no terminal, as CI does.

## How the runner checks it

1. Copy the engine into a temp repo, write `config` and `values`, copy `repo/` and `home/`.
2. Run each command with the home folder as `HOME` (Linux, macOS) or `USERPROFILE` (Windows).
3. Compare:
   - **Exit codes** with `expect/exit`.
   - **Status lines.** Each output line that is a status line becomes `WORD label`: the word without brackets or
     color, then the label. Notes and every other line are dropped, so the bash layout and the PowerShell
     `[WORD      ] label` layout read the same. The result must equal `expect/output.txt`, line for line.
   - **Trees**, byte for byte, file list and content. The runner leaves out what an engine keeps for itself:
     `.user-values.json` and the state folder (`~/.local/state/sync-settings`, `%LOCALAPPDATA%\SyncSettings`). File
     modes are compared only where the file system keeps them.

An OS-forced difference (a row of "Known differences" that stays) goes in `expect.<os>/`, which holds only the
files that differ from `expect/` on that OS.

## What fits

A case fits when the behavior shows in exit code, status lines and files. Behavior that needs a git remote, `gh`, a
prompt answer, `dconf` or a package manager fits once the runner offers a stub for it (phase 2). A check of one
function from the inside stays a unit test of that engine.
