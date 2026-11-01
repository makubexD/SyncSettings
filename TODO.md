# TODO

## Windows checks after phases 3 and 4

CI runs the engines on a fake profile, so these need the real Windows machine. Run them in this order: W0 can only pass
before W1. Follow `docs/plan-windows-checks.md`, which has the commands and expected results.

- [ ] **W0** Old layout still matches the machine, which also covers substep 5 of step 18 in
      `docs/plan-safety-fixes.md` and step 20.7 of `docs/plan-restructure-2.md`. Run `git fetch`,
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
- [ ] Delete this section when all of them pass.

If W0 reports changes, those are Windows edits the repo doesn't have. Note the files, run `git restore dotfiles`,
continue with W1, and reapply them from the `.bak` files before W3. Import only once before that, because a second
import can replace a `.bak`.

If `export.bat` runs before W1, the whole `.gitconfig` lands in the common file and the cached-value check stops
`commit.bat`. Run `git restore dotfiles`, then W1.

## Roll back Claude auto-approval when development is done

Added 2026-10-30 to speed up development: Claude adds the `reviewed` label and merges its own PRs. When the
repo is stable, give the review back to a human:

- [ ] `CLAUDE.md`: delete the "Claude auto-approval (temporary, development stage)" section.
- [ ] `docs/review-gate.md`: delete the "Claude auto-approval (temporary)" section.
- [ ] `.claude/settings.json`: remove the `gh pr edit … --add-label reviewed` and `gh pr merge …` allow rules
      (delete the file if nothing else is left).
- [ ] Delete this item, and this file if it is empty.
- [ ] Open the rollback PR and add the `reviewed` label yourself; it touches the gate, so Claude may not.
