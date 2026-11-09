# TODO

## Windows checks after phases 3 and 4

CI runs the engines on a fake profile, so these need the real Windows machine. Run them in this order: W0 can only pass
before W1. Follow `docs/plan-windows-checks.md`, which has the commands and expected results.

- [ ] **W0** Old layout still matches the machine, which also covers substep 5 of step 18 in
      `docs/archive/plan-safety-fixes.md` and step 20.7 of `docs/archive/plan-restructure-2.md`. Run `git fetch`,
      `git switch --detach b404e4d`, `export.bat`, `import.bat`, `git switch master`. Expect no changes, all `UNCHANGED`.
- [ ] **W1** Migrate. Run `git pull --ff-only`, then `import.bat`, first. Expect `UPDATED` `.gitconfig` with `.bak`,
      `CREATED` `.gitconfig.local`, `UNCHANGED` for shell and Windows Terminal, and `CREATED`, `UPDATED` or `SKIPPED`
      for the Claude files.
- [ ] **W2** Git works. Run `git config --global user.email`,
      `git config --global --includes --get-all credential.https://github.com.helper` and `git ls-remote origin HEAD`.
      Expect your email, the `gh.exe` line, and an answer from the remote.
- [ ] **W3** Round trip. Run `export.bat`. Expect "Repo is up to date" and no `ORPHAN`, including the `common` Claude
      files.
- [ ] **W4** Apps. Open Git Bash and run `vs`; open Windows Terminal. Expect the alias to work and the settings to load.
- [ ] **W5** PR flow. With a test edit to `~/.bashrc`, run `export.bat`, `commit.bat`. Expect a PR from a `sync/windows-…`
      branch with `dotfiles/windows/` paths in it. Close it without merging and undo the edit.
- [ ] **W6** Global git ignore, from phase 4. Create `~/.config/git`, run `import.bat`, and expect `CREATED` or
      `UNCHANGED` for `dotfiles/common/git/ignore`. Then `git check-ignore -v` on a path named
      `.claude/settings.local.json`, in a throwaway repo, shows the rule. In this repo it shows `.gitignore` instead. If
      the folder is missing, import reports `SKIPPED`.
- [ ] **W7** The installer and `mksync`, from step 10 of `docs/archive/plan-easy-install-2.md`, after W0-W6 pass. In PowerShell
      (the branch is merged by then, so use `master`):

      ```powershell
      $env:SYNCSETTINGS_DIR = "$env:TEMP\ss-try"; $env:SYNCSETTINGS_NO_SETUP = '1'
      irm https://raw.githubusercontent.com/makubexD/SyncSettings/master/install.ps1 | iex
      mksync doctor
      ```

      | Check | Expected |
      |---|---|
      | Install | `Cloned into`, the PATH line, `Installed.` |
      | Same line again | `Updated` |
      | `mksync doctor` | No `MISSING` line |
      | `mksync` in the real clone | Exit 0, `Origin` up to date |

      Then remove `$env:TEMP\ss-try` and run the installer again with `SYNCSETTINGS_DIR` set to the real clone (and
      `SYNCSETTINGS_NO_SETUP` removed), so `mksync` points at it.
- [ ] **W8** `mksync diff` and the pull guard, from `docs/plan-docs-dryrun-2.md`, after W7, in the real clone:

      | Check | Expected |
      |---|---|
      | `mksync diff` before any pull | `Last sync  : none recorded on this machine`; differing files marked `?`; exit 3, or exit 0 with `agree` |
      | `mksync pull` once, answering `y` to `[y/N]` | Ends with `Sync point : <short>`; `%LOCALAPPDATA%\SyncSettings\last-sync` holds the full SHA |
      | Edit `~/.bashrc`, then `mksync diff` | `[OUT       ] dotfiles/windows/shell/.bashrc`, `1 out`, exit 3 |
      | `mksync` | Machine `1 file(s) differ: 0 in, 1 out, 0 both`, Next `mksync push` |
      | `mksync pull` with that edit | The `OUT` line and the `ERROR: 1 file(s) changed on this machine …` line; exit 1; the edit is still there |
      | `mksync push`, then `mksync diff` before the merge | Still `OUT`; after the merge and a fetch, `agree` |

      Then undo the test edit.
- [ ] **W9** picked files, the first-pull guard and dated backups, from `docs/plan-safe-sync.md`, after W8, in the real
      clone:

      | Check | Expected |
      |---|---|
      | Rename `%LOCALAPPDATA%\SyncSettings\last-sync` aside, then `mksync pull --yes` with a file differing | The two `ERROR: no sync is recorded …` lines; exit 1; nothing changed. Put the file back |
      | Change one synced file in the repo, then `mksync pull <its local path>` | Only that file listed and updated; its `.bak` written; no `Sync point` line |
      | After that pull | `Backups    : …\SyncSettings\backups\<run>` printed; the folder holds the old version under its repo path |
      | `mksync diff <path>` on a file you edited | Only that file labeled; exit 3 |
      | In Git Bash, from `~`: `./<clone>/sync diff .bashrc` | Resolves to `~\.bashrc`, not `<clone>\.bashrc`; no `is not synced` |

      Then undo the test edits.
- [ ] Safe-sync review leftovers (optional): refuse `..` segments and `.linked/` repo paths on the bash side, and warn
      when `--only` matched no file; `Front.ps1` should reject an unknown `-x` like front.sh; state bash 4.4+ or guard
      empty arrays under `set -u`.
- [ ] Once W0-W6 pass, delete `export.bat`, `import.bat` and `commit.bat`, and their mentions; `sync.cmd` and `mksync`
      cover them.
- [ ] Delete this section when all of them pass.

If W0 reports changes, those are Windows edits the repo doesn't have. Note the files, run `git restore dotfiles`,
continue with W1, and reapply them from the `.bak` files before W3. Import only once before that, because a second
import can replace a `.bak`.

If `export.bat` runs before W1, the whole `.gitconfig` lands in the common file and the cached-value check stops
`commit.bat`. Run `git restore dotfiles`, then W1.

## macOS checks after phase 4

CI runs the engine on `macos-latest`; nobody has run it on a real Mac yet.

- [ ] **M1** On a Mac (13 or newer) with Homebrew, run the install line from the README. Expect the `brew install bash jq`
      question, `Installed.`, and `mksync doctor` with no `MISSING` line.
- [ ] **M2** `mksync` shows `macos <version>`; `./import.sh --check` lists `.zshrc`, `.zprofile`, `.gitconfig.local` and the
      shared files, with VS Code under `~/Library/Application Support/Code/User/`.
- [ ] **M3** `/bin/bash ./sync doctor` re-runs itself under Homebrew's bash (no `declare -A` error).
- [ ] **M4** Find RTK's config folder on macOS (`~/Library/Application Support/rtk`?) and decide whether `~/.config/rtk/`
      gets a `localPaths.macos`.
- [ ] Delete this section when all of them pass.

## Roll back Claude auto-approval when development is done

Added 2026-10-30 to speed up development: Claude adds the `reviewed` label and merges its own PRs. When the
repo is stable, give the review back to a human:

- [ ] `CLAUDE.md`: delete the "Claude auto-approval (temporary, development stage)" section.
- [ ] `docs/review-gate.md`: delete the "Claude auto-approval (temporary)" section.
- [ ] `.claude/settings.json`: remove the `gh pr edit … --add-label reviewed` and `gh pr merge …` allow rules
      (delete the file if nothing else is left).
- [ ] Delete this item, and this file if it is empty.
- [ ] Open the rollback PR and add the `reviewed` label yourself; it touches the gate, so Claude may not.
