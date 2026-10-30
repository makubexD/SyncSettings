# Daily workflow

How a settings change moves from one machine to the other. The commit step opens a pull request; nothing is
pushed to `master` directly. See [review-gate.md](review-gate.md) for what the checks do.

```mermaid
sequenceDiagram
    actor You
    participant A as Machine A
    participant GH as GitHub
    participant B as Machine B

    You->>A: ./export.sh (or export.bat)
    Note over A: local files → dotfiles/, sanitized
    You->>A: ./commit.sh (or commit.bat)
    A->>GH: push a sync/... branch, open PR
    Note over GH: review-gate red (no label yet)
    GH-->>You: "workflow failed" email
    You->>GH: read the diff, add the reviewed label
    Note over GH: review-gate, leak-scan, lint green
    You->>GH: merge the PR
    You->>A: git pull
    You->>B: git pull
    You->>B: ./import.sh (or import.bat)
    Note over B: dotfiles/ → local files, placeholders filled
```

## On the machine where you changed something

Start on an up-to-date `master` with no unrelated changes:

```bash
git switch master
git pull
```

See what would be sent. This changes nothing, in the repo or on the machine:

```bash
./sync preview
```

It lists each file's status, shows the full diff against `HEAD`, and runs the leak scan. The diff shows placeholders,
not your real values. If the scan finds something, the diff is left out; fix the file and preview again.

When it looks right, copy your settings into the repo and open the PR (add `-m "<message>"` to set the title yourself):

```bash
./sync export
./sync commit
```

`commit` creates the branch `sync/linux-<alias>-<yyyymmdd-hhmm>`, commits `dotfiles/` and `sync-config.json`,
pushes the branch, opens the PR and switches back to `master`. It prints the PR link.

On Windows, the commands are the same: `.\sync preview` in PowerShell, or `sync preview` in cmd. Use
`-Message "<message>"` to set the title. The branch is `sync/windows-<alias>-<yyyyMMdd-HHmm>`.

`./export.sh`, `./commit.sh`, `export.bat` and `commit.bat` still work.

### Machine alias

`<alias>` names this machine in branch names and PR bodies, so the hostname never appears there. The first
time you commit from a clone, `commit.sh` (or `commit.bat`) asks for it:

```
  Machine alias for branch names (e.g. laptop, desktop):
```

Use lowercase letters, digits and dashes (up to 24 characters, not starting with a dash). The alias is saved
in this clone's git config, is never committed, and is reused from then on. To see or change it:

```bash
git config --get syncsettings.machine
git config syncsettings.machine desktop
```

## Review and merge

Open the PR link. `review-gate` is red until you review it:

1. Read the diff. Go through the checklist in the PR description.
2. Add the `reviewed` label.
3. When all three checks are green, merge.

Then update `master` on this machine:

```bash
git pull
```

## On the other machine

```bash
git switch master
git pull
./sync import
```

Import asks before overwriting each file, and it always saves the old file as `<file>.bak` first, even with
`--force`. If you import a newer change over the same file later, that `.bak` is replaced.

## When `commit.sh` stops

| Message | What to do |
|---|---|
| `no machine alias set. Run: git config syncsettings.machine <alias>` | It ran without a terminal, so it could not ask. Run that command with your alias (e.g. `laptop`), then run it again |
| `invalid machine alias '<value>' …` | Pick an alias with only `a-z`, `0-9` and `-`, not starting with `-`. If the message ends with `in git config syncsettings.machine`, fix it with `git config syncsettings.machine <alias>` |
| `commit or stash changes outside dotfiles/ first.` | Commit those files on their own branch, or `git stash`, then run it again |
| `run commit.sh from master (current: <branch>).` (or `commit.bat`) | `git switch master`, then run it again |
| `master is behind origin; pull first.` | `git pull`, then run it again |
| `local master has unpushed commits; push or move them to a branch first.` | `git branch <name>` to keep them on a branch, then `git reset --keep origin/master` (your uncommitted dotfiles changes stay) |
| `push failed; you are on <branch>.` | Fix the cause (network, auth), run the `git push -u origin <branch>` it prints, then `git switch master` |
| `PR creation failed; branch <branch> is pushed.` | Run the `gh pr create --base master --head <branch>` it prints, then `git switch master` |
| `gh is not found in PATH.` | Install the [GitHub CLI](https://cli.github.com/), then run `gh auth login` |

## Cleaning up

GitHub deletes the remote branch when the PR is merged. To drop the local copies:

```bash
git fetch --prune
git branch --list 'sync/*'
git branch -D <branch>
```
