# Shared cases (draft)

Cases that test the [contract](../../docs/sync-contract.md) through the command line only, so one case runs against
any engine: bash, PowerShell, or a future compiled one. This folder is a phase 1 draft
([plan-single-engine-1.md](../../docs/plan-single-engine-1.md), step 5). `run.sh` is the bash runner; phase 2 adds the PowerShell one.

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
    values.json    optional: .user-values.json after the last command
    state/         optional: files the engine's state folder must hold
    gh.log         optional: the gh calls, when the case stubs gh
  expect.<os>/     optional: only what differs from expect/ on linux, macos or windows
```

`case.json`:

| Field | Meaning |
|---|---|
| `description` | One sentence: the behavior and the contract section it checks |
| `os` | Where it runs: a list of `linux`, `macos`, `windows`. Omit for all three |
| `config` | The whole `sync-config.json`, written into the repo before the run |
| `values` | Optional. Written as `.user-values.json` in the repo; omit to have none |
| `commands` | The commands, run in order in the same folders. Each is `{ "command": …, "options": {…}, "stdin": … }` |
| `git` | Optional. `"none"` (default): the temp repo is a plain folder. `"committed"`: a git repo with everything committed on `master`. `"remote"`: that, plus a local bare `origin` it was pushed to, with `master` tracking it |
| `stubs` | Optional. `["gh"]` puts a `gh` stub first on `PATH`; see `expect/gh.log` below |
| `differences` | Required when the case has an `expect.<os>/` folder, and only then: the names of the rows it records |

`command` is one of `export`, `import`, `check` (`import --check`, `-Check`), `preview` (`export --preview`,
`-Preview`), `diff` (`export --diff`, `-Diff`) and `commit`. `options` uses neutral names that the runner spells for
each engine: `force: true` is `--force` or `-Force`, `only: [paths]` is `--only` or `-Only`. Every command runs with no
terminal, as CI does, and with stdin empty unless the command has `stdin`: a string sent as its stdin, such as `"n\n"`
for a prompt answer.

### Per-OS expectations

`expect.<os>/` (`linux`, `macos`, `windows`) holds only what differs on that OS. Each entry replaces its twin in
`expect/`: `exit` and `output.txt` as files, `home/` and `repo/` as whole trees, `values.json`, `state/` and `gh.log`
the same way. Use it only for a row of the contract's
[Known differences](../../docs/sync-contract.md#known-differences), named in `differences`. The one other allowed
name is `"Entry selection"`, for a case where each OS picks its own entries by design.

### The `gh` stub

With `"stubs": ["gh"]`, every `gh` call appends its arguments, joined by spaces, as one line to a log outside both
trees; the stub prints nothing and exits 0. Each logged line is cut to its first two words (`pr create`), so branch
names and titles don't matter, and the result must equal `expect/gh.log` line for line. No `expect/gh.log` with the
stub on means `gh` must not be called.

## How the runner checks it

1. Copy the engine into a temp repo, write `config` and `values`, copy `repo/` and `home/`.
2. Run each command with the home folder as `HOME` (Linux, macOS) or `USERPROFILE` (Windows).
3. Compare:
   - **Exit codes** with `expect/exit`.
   - **Status lines.** Each output line that is a status line becomes `WORD label`: the word without brackets or
     color, then the label. Notes and every other line are dropped, so the bash layout and the PowerShell
     `[WORD      ] label` layout read the same. The result must equal `expect/output.txt`, line for line.
   - **Trees**, byte for byte, file list and content. The runner leaves out what an engine keeps for itself:
     `.user-values.json`, the state folder (`~/.local/state/sync-settings`, `%LOCALAPPDATA%\SyncSettings`), and `.git`
     (the bare `origin` lives outside the repo). File modes are compared only where the file system keeps them.
   - **Values**, when `expect/values.json` exists: the repo's `.user-values.json` after the run, as JSON with key
     order ignored.
   - **State**, when `expect/state/` exists: each file in it must be in the state folder with the same bytes; other
     state files, such as the sync point, whose SHA changes per run, are ignored. A run's dated backup folder
     `backups/<run>/` is read as `backups/RUN/`, and there must be exactly one, so the time and pid don't matter.
   - **gh calls**, when the case stubs `gh` (above).

Each file is taken from `expect.<os>/` when it's there for the OS the runner is on, else from `expect/`.

## What fits

A case fits when the behavior shows in exit code, status lines and files. Behavior that needs a git remote, `gh`, a
prompt answer, `dconf` or a package manager fits once the runner offers a stub for it (phase 2). A check of one
function from the inside stays a unit test of that engine.

## Moved from

A bash or Pester case is removed when a shared case tests the same behavior through the same inputs and the old case
checks nothing more. None has been removed yet. Every twin found checks something the runner can't see, or takes
other inputs:

| Shared case | Old cases kept | What they check beyond the shared case |
|---|---|---|
| `dconf-path-no-slash`, `defaultenv-invalid`, `localpaths-bad-key`, `local-path-absolute`, `repo-path-dotdot`, `platform-missing` | `dconf_path_no_slash`, `defaultenv_invalid`, `localpaths_bad_key`, `path_local_absolute`, `path_repo_traversal`, `missing_platform`; Pester `dconf-path-no-slash`, `localpaths-bad-key`, `path-local-absolute`, `path-repo-traversal`, `missing-platform` | the `ERROR:` text |
| `missing-value-stops`, `preview-only-refused`, `preview-no-change` | `noninteractive_missing_value`, `export_only_preview`, `preview_no_changes`; Pester `noninteractive-missing-value-import`, `export-only-preview`, `preview-no-changes` | the message text |
| `dir-import-extra`, `import-updated-backup`, `only-one-file`, `orphan-reported` | `dir_import_extra`, `import_backup`, `import_only_one`, `orphan_reported` and their Pester twins | the note after the label |
| `export-adds`, `hydrate-creates`, `sanitize-round-trip` | `export_adds`, `import_creates`, `roundtrip_unchanged`; Pester `export-adds`, `import-creates`, `roundtrip-unchanged` | the fixture's four files (modes, no trailing newline), the push hint, `dotfiles/windows` with CRLF |
| `sanitize-longest-first` | `sanitize_longest_first`, Pester `sanitize-longest-first` | values with backslashes under `escapeBackslashes` |
| `sanitized-crlf-unchanged` | `crlf_unchanged` | the import half: the local file keeps CRLF |
| `only-dotdot` | `only_repo_dotdot`, Pester `only-repo-dotdot` | `resolve_only` / `Resolve-OnlyPaths` from the inside |
| `diff-in` | Pester `diff-in` | an `IN` label from a recorded sync point, and the summary lines |
| `commit-opens-pr` | `commit_happy`, Pester `commit-happy` | `origin/master` unmoved, back on `master`, one `sync/…` branch |
