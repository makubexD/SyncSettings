# TODO

## Follow-ups

- [ ] Safe-sync review leftovers (optional): refuse `..` segments and `.linked/` repo paths on the bash side, and warn
      when `--only` matched no file; `Front.ps1` should reject an unknown `-x` like front.sh; state bash 4.4+ or guard
      empty arrays under `set -u`.
- [ ] CRLF in shared files: `dotfiles/common/**` is `eol=lf`, so a shared file like `.gitconfig` saved with CRLF on
      Windows shows `BOTH` after a push. Decide whether the Windows engine compares them with line endings normalized.
- [ ] `sync` should call `sync.cmd` by its full path (`cmd.exe //c "<repo>\sync.cmd"`), so it still works when
      `NoDefaultCurrentDirectoryInExePath` is set.

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
