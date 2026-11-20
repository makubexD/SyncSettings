# Windows checks W0 to W6

Goal: prove the new repo layout on the real Windows machine. CI runs the engines on a fake profile, so only that machine has
the real files, paths and sign-ins. These checks unblock phase 8.

Every step is manual, on the Windows machine, in this order. W0 can only pass before W1.

## How to run this

- Keep this page open on GitHub, not from your clone. W0 switches to an old commit, where this file doesn't exist.
- Use one PowerShell window from start to finish. Run the commands in the repo folder.
- `export.bat`, `import.bat` and `commit.bat` end with "Press any key". Press a key to get the prompt back.
- At an `Overwrite? [Y/n]` prompt, press Enter, which means yes.
- If a result doesn't match, stop there and send Claude Code the step and its output. Don't run the next step.

## Checked on Linux, 2026-10-31

| Check | Result |
|---|---|
| W0 on the old commit | The up-to-date check skips itself on a detached commit, so it won't offer to pull |
| Placeholders | The old and new configs use the same five, so a machine with a full `.user-values.json` gets no value prompts |
| Shell and Windows Terminal files | Byte-identical between the old commit and `master`, so W1 expects `UNCHANGED` |
| `.gitconfig` | Differs, because of the split, so W1 expects `UPDATED` |
| W6 | The repo's own `.gitignore` has the same rule, so the check runs in a throwaway repo |

## Steps

### 0. Get ready `[inline: manual, on Windows]`

Change the path to your clone, then run:

```powershell
cd "$HOME\path\to\SyncSettings"
git status --short
git branch --show-current
gh auth status
Test-Path .user-values.json
```

| Command | Expected |
|---|---|
| `git status --short` | Prints nothing |
| `git branch --show-current` | `master` |
| `gh auth status` | Logged in to github.com |
| `Test-Path .user-values.json` | `True` |

If the last one is `False`, W0 asks for your values. Have your name, email, GitHub username, GitHub organization and the
path to `gh.exe` ready. If the machine has no clone, run `gh repo clone makubexD/SyncSettings`, then `cd SyncSettings`.

### W0. Old layout still matches the machine `[inline: manual, on Windows]`

```powershell
git fetch
git switch --detach b404e4d
.\export.bat
git status --short
```

Expected: `UNCHANGED` for every file, and `git status --short` prints nothing.

If `git status --short` lists files, the machine has edits the repo doesn't have. Stop here, stay on this commit, and send
Claude Code that list. Don't run `import.bat`, because W1 would overwrite those edits.

If it printed nothing, finish W0:

```powershell
.\import.bat
git status --short
git switch master
```

Expected: `UNCHANGED` for every file, `git status --short` prints nothing, and you're back on `master`.

### W1. Migrate `[inline: manual, on Windows]`

This is the step that changes your real files. It keeps an extra copy of `.gitconfig`, because a later import can replace
a `.bak`. Run `import.bat` first: an export before this step puts the whole `.gitconfig` in the common file.

```powershell
git pull --ff-only
Copy-Item $HOME\.gitconfig $HOME\.gitconfig.before-w1
.\import.bat
Test-Path $HOME\.gitconfig.bak
```

Press Enter at the `Overwrite? [Y/n]` prompt for `.gitconfig`.

| File | Expected |
|---|---|
| `.gitconfig` | `UPDATED` |
| `.gitconfig.local` | `CREATED` |
| `.bashrc`, `.bash_profile`, Windows Terminal | `UNCHANGED` |
| `dotfiles/common/git/ignore` | `SKIPPED`, target folder not found. W6 creates it. `CREATED` is also fine if the folder exists |
| The two `common` Claude files | `CREATED`, `UPDATED` or `SKIPPED` |

There's no `ERROR` line, and the last command prints `True`.

### W2. Git works `[inline: manual, on Windows]`

```powershell
git config --global user.email
git config --global --includes --get-all credential.https://github.com.helper
git ls-remote origin HEAD
```

| Command | Expected |
|---|---|
| `user.email` | Your email |
| `--get-all` | An empty line, then the line with `gh.exe` and `auth git-credential` |
| `ls-remote` | A commit hash, then `HEAD` |

### W3. Round trip `[inline: manual, on Windows]`

```powershell
.\export.bat
git status --short
```

Expected: `Repo is up to date. No changes detected.`, no `ORPHAN` line, and `git status --short` prints nothing.
`SKIPPED` for `dotfiles/common/git/ignore` is fine until W6.

### W4. Apps `[inline: manual, on Windows]`

1. Open Git Bash and run `vs`. Expected: Visual Studio opens.
2. Open Windows Terminal. Expected: it opens with your settings and no settings error.

### W5. PR flow `[inline: manual, on Windows]`

This uses a harmless test edit and a PR that you close without merging, so W5 doesn't wait for a real change.

```powershell
Copy-Item $HOME\.bashrc $HOME\.bashrc.w5
Add-Content $HOME\.bashrc '# W5 test'
.\export.bat
.\commit.bat
```

If `commit.bat` asks for a machine alias, type a short lowercase name, such as `desktop`.

Expected: `PR opened:` with a link, and you're back on `master`. Use that PR's number below, in place of `<number>`:

```powershell
gh pr view <number>
gh pr diff <number> --name-only
```

Expected: the branch is `sync/windows-<alias>-<date>`, and the only file is `dotfiles/windows/shell/.bashrc`. Then close it
and undo the edit:

```powershell
gh pr close <number> --delete-branch
Move-Item -Force $HOME\.bashrc.w5 $HOME\.bashrc
.\export.bat
git status --short
```

Expected: `Repo is up to date. No changes detected.`, and `git status --short` prints nothing.

### W6. Global git ignore `[inline: manual, on Windows]`

```powershell
New-Item -ItemType Directory -Force "$HOME\.config\git" | Out-Null
.\import.bat
$t = Join-Path $env:TEMP 'w6-check'
git init -q $t
git -C $t check-ignore -v .claude/settings.local.json
Remove-Item -Recurse -Force $t
.\export.bat
git status --short
```

Expected:

- `import.bat` shows `CREATED` for `dotfiles/common/git/ignore`, or `UNCHANGED` if it was already there.
- `check-ignore` prints a line with `.config/git/ignore:1:**/.claude/settings.local.json`. A line with `.gitignore` or no
  line at all is a failure.
- `export.bat` ends with `Repo is up to date. No changes detected.`, and `git status --short` prints nothing.

## When you're done

Tell Claude Code "W0 to W6 passed", or send the step that failed and its output. Claude removes the Windows section from
`TODO.md`.

Keep `.gitconfig.before-w1` and `.gitconfig.bak` until you've used Git for a day or two, then delete them.
