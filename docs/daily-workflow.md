# Daily workflow

How a settings change moves from one machine to the other with `mksync`. A push opens a pull request; nothing is
pushed to `master` directly. See [review-gate.md](review-gate.md) for what the checks do.

```mermaid
sequenceDiagram
    actor You
    participant A as Machine A
    participant GH as GitHub
    participant B as Machine B

    You->>A: mksync push
    Note over A: local files → dotfiles/, sanitized
    A->>GH: push a sync/... branch, open PR
    Note over GH: review-gate red (no label yet)
    GH-->>You: "workflow failed" email
    You->>GH: read the diff, add the reviewed label
    Note over GH: review-gate, leak-scan, lint green
    You->>GH: merge the PR
    You->>A: git pull
    You->>B: mksync pull
    Note over B: dotfiles/ → local files, placeholders filled
```

## The short version

Linux, macOS and Windows run the same commands:

```bash
mksync        # where this machine stands, and what to run next
mksync push   # on the machine you changed: export, show, open the PR
mksync pull   # on the other machine, after the merge: pull, show, apply
```

`mksync` names the next command, so you don't have to remember the order. `mksync pull` brings the settings; the
program itself is updated with `mksync update`, which replaces it only when a newer release is out. The rest of this
page is the same flow step by step. If `mksync` stops with something you don't recognize, see
[Troubleshooting `mksync`](#troubleshooting-mksync).

A machine that doesn't have `mksync` yet starts with the install line, which goes through a signed-in GitHub CLI so it
works whether the repo is public or private ([README](../README.md#install) has the macOS and `--runtime node` forms):

```bash
sudo apt-get install gh && gh auth login
gh api -H 'Accept: application/vnd.github.raw' repos/makubexD/SyncSettings/contents/install.sh | bash
```

```powershell
winget install --id GitHub.cli -e
# open a new PowerShell window, then:
gh auth login
gh api -H 'Accept: application/vnd.github.raw' repos/makubexD/SyncSettings/contents/install.ps1 | Out-String | iex
```

With `gh` signed in, `mksync update` and the installer download the release through it too.

## Before you pull or push

Three dry runs show what would happen, and none of them writes anything:

```bash
mksync diff      # both ways: which side changed each file since this machine last synced
mksync check     # repo → this machine: every file an import would create or overwrite
mksync preview   # this machine → repo: the diff a push would send
```

The check compares this clone with the machine and doesn't fetch. If `mksync` shows `Origin : <n> update(s) waiting`,
a pull brings those too, and its own list (shown before it asks) is the one to read.

The check can't tell which side is newer; the diff can. It fetches first, then gives each differing file one label:

| Label  | Meaning                               | Next                                              |
| ------ | ------------------------------------- | ------------------------------------------------- |
| `IN`   | Only the repo changed it              | `mksync pull` takes it                            |
| `OUT`  | Only this machine changed it          | `mksync push` sends it                            |
| `BOTH` | Both changed it, differently          | Merge by hand, then push                          |
| `?`    | This machine has no sync recorded yet | Decide by hand; the next pull or push records one |

Each machine remembers the repo commit it last agreed with (`~/.local/state/sync-settings/last-sync`, or
`%LOCALAPPDATA%\SyncSettings\last-sync` on Windows). A full pull records it, and so does a push once its PR opens. Files
you pushed read `OUT` until the PR merges, then drop out of the list.

A JSON file built from several layers (common, system, profile, machine) is one line, whichever layer changed. If the
repo changed one layer and this machine another, the line is `BOTH`.

`mksync pull` runs the diff before it applies anything and stops if a file is `OUT` or `BOTH`, so it can't replace an
edit you haven't sent. Run `mksync push` first, or `mksync pull --force` to overwrite anyway (each file keeps its
`.bak`, and a dated copy: see [Getting an old version back](#getting-an-old-version-back)).

The first pull on a machine has no sync recorded, so it can't tell which side changed a file. It warns, and asks
`Apply these changes? [y/N]`: Enter keeps your files, `y` applies the repo's. `mksync pull --yes` refuses outright,
so a script never overwrites a machine it knows nothing about, even with paths. Take files one at a time without
`--yes` instead (below), or
`mksync pull --force`. A pull that finds nothing to change records the sync anyway, so the next diff has labels.
`mksync setup` guards the same way: once a machine has a sync point, its "back up and replace" lists the files changed
here and asks `[y/N]`, and `--yes` refuses. Run by hand, the restore script still imports without that guard.

## Take or send only some files

`mksync pull`, `mksync push` and `mksync diff` take paths, so you can move one file and leave the rest:

```bash
mksync diff                          # see which files differ, and which side changed them
mksync pull ~/.bashrc                # take the repo's version of this file only
mksync push dotfiles/common/git/.gitconfig   # send this file only
```

A path is either where the file lives on this machine (`~/.bashrc`, or relative to the folder you're in) or its path in
the repo (`dotfiles/...`). A folder entry takes a file inside it too. A path no entry syncs on this machine stops the
command before anything changes. The pull guard still checks the picked files: an `OUT` or `BOTH` file needs `--force`.

A pull or push of some files doesn't record a sync point, since the machine only agrees with part of the repo. Run a
plain `mksync pull` when you want the labels to start from there.

## Getting an old version back

Every file a pull overwrites keeps two copies of the old version: `<file>.bak` next to it, replaced by the next pull of
the same file, and a dated copy that stays for the last 20 pulls:

- Linux and macOS: `~/.local/state/sync-settings/backups/<run>/<repo path>` (under `$XDG_STATE_HOME` when it's set)
- Windows: `%LOCALAPPDATA%\SyncSettings\backups\<run>\<repo path>`

`<run>` is the date and time of the pull, so the newest folder sorts last, and the pull prints it as `Backups : <folder>`.
To restore a file, copy it back over the current one:

```bash
cp ~/.local/state/sync-settings/backups/20261109-153000-4242/dotfiles/common/git/.gitconfig ~/.gitconfig
```

## On the machine where you changed something

Start on an up-to-date `master` with no unrelated changes:

```bash
git switch master
git pull
```

See what would be sent. This changes nothing, in the repo or on the machine:

```bash
mksync preview
```

It lists each file's status, shows the full diff against `HEAD`, and runs the leak scan. The diff shows placeholders,
not your real values. If the scan finds something, the diff is left out; fix the file and preview again.

When it looks right, copy your settings into the repo and open the PR (add `-m "<message>"` to set the title yourself):

```bash
mksync push
```

It exports, shows what changed, and asks `Open a PR with these changes? [Y/n]`. Then it creates the branch
`sync/<os>-<alias>-<yyyymmdd-hhmm>` (`linux`, `macos` or `windows`), commits `dotfiles/`, `packages/` and
`sync-config.json`, pushes the branch, opens the PR and switches back to `master`. It prints the PR link.

### Changes you didn't make

Some tools rewrite their own settings, so preview can show a file you never opened:

| File                                   | Rewritten by                                                            |
| -------------------------------------- | ----------------------------------------------------------------------- |
| `dotfiles/common/htop/htoprc`          | htop, when you change a setting in its interface                        |
| `dotfiles/linux/gnome/mimeapps.list`   | The desktop, when a default app changes                                 |
| `dotfiles/common/vscode/settings.json` | VS Code Settings Sync, with changes from your other machine             |
| `dotfiles/linux/gnome/dconf/*.ini`     | The desktop, when you change the theme, pin an app or change a shortcut |

These are real settings, so read the diff rather than reverting it. To keep one out of a PR, run `git restore <file>`
after the export; preview keeps showing it until you send it.

### A `DRIFT` line

On Linux, preview and export end by comparing `packages/linux/` with the machine. A line like this after you install
something is normal:

```text
  DRIFT      apt/cowsay  (installed, not in packages/linux/apt.txt)
```

It's only a report: nothing was changed, and it doesn't stop anything. If you want the package on a restored machine, add it to
the list, run `scripts/ci/check-packages.sh`, then `mksync push`. If not, uninstall it or add it to `drift-ignore.txt`.
[packages.md](packages.md#reading-the-report) covers every note.

### Machine alias

`<alias>` names this machine in branch names and PR bodies, so the hostname never appears there. With a machine
record it is the record's name. Without one, the first push from a clone asks for it:

```
  Machine alias for branch names (e.g. laptop, desktop):
```

Use lowercase letters, digits and dashes (up to 24 characters, not starting with a dash). The alias is saved
in this clone's git config, is never committed, and is reused from then on. To see or change it:

```bash
git config --get syncsettings.machine
git config syncsettings.machine desktop
```

## Changing how `mksync` behaves

A change to what export, import or commit do starts in [sync-contract.md](sync-contract.md):

1. Write the new rule in the contract.
2. Add a shared case for it in `tests/parity/cases/` and run `tests/parity/run.sh <name>`. It fails until the
   program follows the rule, which shows the case tests something.
3. Change the program until the case passes on Linux; the PR's `program-macos` and `program-windows` jobs prove macOS
   and Windows.

Only a rule that differs by OS on purpose gets a row in the contract's Known differences and an `expect.<os>/`
folder. How to write a case and read a failure: [tests/parity/README.md](../tests/parity/README.md).

## Review and merge

Open the PR link. `review-gate` is red until you review it:

1. Read the diff. Go through the checklist in the PR description.
2. Add the `reviewed` label.
3. When all four checks are green, merge.

Then update `master` on this machine:

```bash
git pull
```

## On the other machine

```bash
mksync pull
```

It switches nothing for you: the clone must be on `master`. It fetches, fast-forwards, and shows what will change before
asking. `mksync check` shows the same list without
applying it.

Import asks before overwriting each file, and it always saves the old file as `<file>.bak` first, even with
`--force`. If you import a newer change over the same file later, that `.bak` is replaced. Import never deletes a local
file: one the repo doesn't have is reported as `EXTRA` and kept.

On Linux, run it in a terminal on the desktop, because GNOME settings load over the session bus. Their backups go in
`~/.local/state/sync-settings/dconf/`, and a setting the repo doesn't name stays as it is.

## Moving a machine from the old layout

The re-layout moved every file under `dotfiles/<platform>/<tool>/` and split `.gitconfig` into a shared file and a
`.gitconfig.local` per system ([layout.md](layout.md)). A machine that hasn't caught up still has the whole `.gitconfig`,
so **import first, then export**. Do this once on each machine, before any export:

```bash
git switch master
mksync pull
```

The pull asks for any value it doesn't have cached, so run it in a terminal. It rewrites `~/.gitconfig`, keeps the old
file as `~/.gitconfig.bak` and creates `~/.gitconfig.local`. Then check that git still works, and that the repo and the
machine agree:

```bash
git config --global user.email
git config --global --includes --get-all credential.https://github.com.helper
git ls-remote origin HEAD
mksync preview
```

The second command prints the `gh` line. `mksync preview` is safe at any time, and until you import it shows `.gitconfig`
as changed.

If you exported first, nothing is lost as long as you don't commit it. Drop the export, then import:

```bash
git restore dotfiles
mksync pull
```

The export would copy the whole `.gitconfig`, credentials included, into the shared file. The push stops at the
cached-value check only when a credential is a cached value, so don't rely on it: read the diff.

## Try a machine record

`mksync setup` writes a machine record; the installers run it for you. To try a record on a machine that has none, run `setup` and tell it to stop before touching any file:

```bash
mksync setup --existing stop
```

It shows what it read (OS, hostname, tools, how many config entries already exist), lists the profiles (`personal` and
any made on this machine), and asks what the machine is for, Claude, and push or pull only; Enter takes the suggestion
in brackets. Above the last question it says how many files differ and, after a first sync, on which side. It prints
the same choices as one command (`Same as: mksync setup …`) and asks `Write the record and apply? [Y/n]`: a no prints
`Stopped: nothing was written.` A yes writes `~/.local/state/sync-settings/machine.json` and the profile next to it,
and stops: `Stopped: the record is written, no file was changed.` If `.user-values.json` has a value it doesn't know where to keep,
it asks once: `<KEY>: kept on 1) this profile 2) this machine [1]`.

```bash
mksync machine show      # the record, six lines
mksync check             # what a pull would change, with the profile and machine layers
```

`--existing backup` instead of `stop` runs the first import right away (each file keeps its `.bak`); `keep` exports this
machine's files first, so it can't be used with `--mode pull-only`. When this machine has a sync point and files it
changed since (`OUT` or `BOTH` in `mksync diff`), `backup` lists them and the confirm becomes `[y/N]`; `--yes` refuses
with exit 1, as `mksync pull --yes` does. Pick `keep` to push those changes first. Running `setup` again stops, because the machine
already has a record; `--replace <name>` takes over a record, for a reinstall. To go back to no layers at all, delete
`machine.json`; `machine retire` only marks the record so it can't push. While the repo is public, nothing of this goes
into it: `export` holds the record and profile, and refuses if the clone already tracks `profiles/` or `machines/`.

Once the record exists, `.user-values.json` is left alone: `setup` copied its values onto the record and the profile,
and from then on the program's `pull` and `push` neither read nor write it. A value found during a run (a path, a
rule's default) is saved on the record or the profile instead, and a missing one stops the run with
`missing value for <KEY>: add it to profile <profile> or machine <name>`
([configuration.md](configuration.md#profiles-and-machines)). Deleting `machine.json` brings `.user-values.json` back
into use.

## When `mksync push` stops

| Message                                                                    | What to do                                                                                                                                                                                |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no machine alias set. Run: git config syncsettings.machine <alias>`       | It ran without a terminal, so it could not ask. Run that command with your alias (e.g. `laptop`), then run it again                                                                       |
| `invalid machine alias '<value>' …`                                        | Pick an alias with only `a-z`, `0-9` and `-`, not starting with `-`. If the message ends with `in git config syncsettings.machine`, fix it with `git config syncsettings.machine <alias>` |
| `commit or stash changes outside dotfiles/ first.`                         | Commit those files on their own branch, or `git stash`, then run it again                                                                                                                 |
| `the leak scan found the lines above; nothing was committed.`              | Open each `<file>:<line>` it listed, replace the personal text or add a `sanitize` rule, then run it again                                                                                |
| `leak scan could not run; nothing was committed.`                          | Restore `scripts/ci/leak-scan.sh` with `git restore`. On Windows, make sure Git for Windows and its `bash.exe` are installed. Then run it again                                           |
| `a cached value for <PLACEHOLDER> is in <file>; nothing was committed.`    | Add a `sanitize` rule for that placeholder to the file's entry, or remove the value from the file, then run it again                                                                      |
| `could not search for cached values; nothing was committed.`               | A changed file could not be read. On Windows this can be a file name with unusual characters: rename it, then run it again                                                                |
| `sync-config.json: entry <file> has an unsafe path.`                       | Fix that entry's `file`: a relative path with `/`, no `..` segment, no drive letter. Remove any symlink under `dotfiles/`                                                                 |
| `sync-config.json: entry <file> needs a dconfPath like /org/gnome/shell/.` | Fix that dconf entry: a `dconfPath` that starts and ends with `/`                                                                                                                         |
| `sync-config.json: entry <file> has an invalid defaultEnv.`                | Use a valid variable name: letters, digits and `_`, not starting with a digit                                                                                                             |
| `run commit.sh from master (current: <branch>).`                           | `git switch master`, then run it again                                                                                                                                                    |
| `master is behind origin; pull first.`                                     | `git pull`, then run it again                                                                                                                                                             |
| `local master has unpushed commits; push or move them to a branch first.`  | `git branch <name>` to keep them on a branch, then `git reset --keep origin/master` (your uncommitted dotfiles changes stay)                                                              |
| `push failed; you are on <branch>.`                                        | Fix the cause (network, auth), run the `git push -u origin <branch>` it prints, then `git switch master`                                                                                  |
| `PR creation failed; branch <branch> is pushed.`                           | Run the `gh pr create --base master --head <branch>` it prints, then `git switch master`                                                                                                  |
| `gh is not found in PATH.`                                                 | Install the [GitHub CLI](https://cli.github.com/), then run `gh auth login`                                                                                                               |

## Troubleshooting `mksync`

| What you see                                                                                       | What to do                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows: `running scripts is disabled on this system`                                              | It comes from running a `.ps1` directly. `mksync.exe` needs no execution policy, and the installer runs through `gh api … \| Out-String \| iex`, which isn't blocked by it                                                                                                        |
| Windows: the installer prints `ERROR: install Git from https://git-scm.com, …`                     | There's no `winget` on this machine (it comes with App Installer from the Microsoft Store). Install Git from that link, open a new window, and run the installer again. `gh` can come later; `doctor` says how                                                                    |
| `mksync` is not recognized, or `command not found`                                                 | The window was open before the install changed `PATH`. Open a new one. If a new window still can't find it, run the install line again; on Linux and macOS it prints the `PATH` line to add when `~/.local/bin` isn't on it                                                       |
| macOS: `ERROR: install bash and jq with Homebrew (brew install bash jq), then run this again.`     | The installer needs Homebrew's bash and `jq` (macOS's own bash is too old). Run `brew install bash jq`, then the install line again. More in [Restore: macOS](restore.md#troubleshooting-on-macos)                                                                                |
| `Next: the machine check failed; run ./import.sh --check to see why.`                              | The status couldn't compare the repo with this machine. Run `mksync check` (the line still names the old script) and read its `ERROR` lines                                                                                                                                       |
| `WARN gh: not signed in; run gh auth login`                                                        | Run `gh auth login` once. Only `mksync push` needs it, to open the pull request                                                                                                                                                                                                   |
| `SKIPPED … needs values: run mksync setup`                                                         | A file has a placeholder (your name, email, a path) with no value yet. Run `mksync setup`; it asks for each one and saves it in `.user-values.json`, which never leaves the machine                                                                                               |
| `WARN <n> value(s) not set; mksync setup asks for them`                                            | The same thing, seen from `doctor`                                                                                                                                                                                                                                                |
| `mksync check` exits with 3                                                                        | Not an error: it means `<n> file(s) would change`. Read the list. If you changed any of those files on this machine, run `mksync push` first; otherwise `mksync pull` applies it. Exit 0 means the machine matches, and exit 1 means a check couldn't run (see its `ERROR` lines) |
| `ERROR: <n> file(s) changed on this machine since the last sync, and a pull would overwrite them.` | The pull found `OUT` or `BOTH` files (listed above the error). Run `mksync push` to send them, or `mksync pull --force` to replace them with the repo's version (each keeps a `.bak`)                                                                                             |
| `ERROR: could not tell which side is newer; …`                                                     | The diff couldn't run. Run `mksync diff` and read its `ERROR` line; `mksync pull --force` skips the diff                                                                                                                                                                          |
| `ERROR: the repo has changes not sent yet; run mksync push first, …`                               | `pull` won't mix your unsent changes with the repo's. Send them with `mksync push`, or drop them with `git restore`, then pull                                                                                                                                                    |
| `ERROR: <dir> exists and isn't a SyncSettings clone; set SYNCSETTINGS_DIR.`                        | The installer won't write into a folder it didn't make. Move that folder, or set `SYNCSETTINGS_DIR` to another place and run it again                                                                                                                                             |
| Windows: `ERROR: …\mksync.cmd already exists; remove it and run this again.` (or `mksync.exe`)     | Another `mksync.cmd` or `mksync.exe` is in the installer's bin folder. Remove or rename it if it isn't yours to keep, then run the installer again. On Linux and macOS the same line names `~/.local/bin/mksync`                                                                  |
| `ERROR: sync-config.json: this config needs a newer mksync: run mksync update.`                    | The repo moved to a config this program doesn't know yet. Run `mksync update`, then the command again                                                                                                                                                                             |
| `ERROR: <file>: checksum does not match SHA256SUMS…`                                               | The installer or `mksync update` downloaded a file that isn't the one the release published, and installed nothing. Run it again later; if it keeps failing, the release itself is wrong: don't install around the check                                                          |
| `ERROR: mksync runs from the clone here; update it with git pull.`                                 | This machine runs `mksync` from the clone (installed with `--runtime`), so there is no program to replace: `git pull` in the clone updates it                                                                                                                                     |

## Cleaning up

GitHub deletes the remote branch when the PR is merged. To drop the local copies:

```bash
git fetch --prune
git branch --list 'sync/*'
git branch -D <branch>
```
