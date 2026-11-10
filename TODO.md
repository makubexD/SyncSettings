# TODO

## macOS (low priority: needs a real Mac)

M1-M3 (install line with the brew question, status and `import --check`, `/bin/bash ./sync doctor`) pass in the
`macos-checks` CI job on every PR, first on 2026-11-10 (macOS 26.7.2, arm64, PR #68). Only M4 needs RTK on a real Mac;
there `tests/macos/manual-checks.sh` runs it and writes a report to `~` (the header says how).

- [ ] **M4** Find RTK's config folder on macOS (`~/Library/Application Support/rtk`?) and decide whether `~/.config/rtk/`
      gets a `localPaths.macos`.
- [ ] Delete this section when M4 is settled.

## Roll back Claude auto-approval when development is done

Added 2026-10-30 to speed up development: Claude adds the `reviewed` label and merges its own PRs. When the
repo is stable, give the review back to a human:

- [ ] `CLAUDE.md`: delete the "Claude auto-approval (temporary, development stage)" section.
- [ ] `docs/review-gate.md`: delete the "Claude auto-approval (temporary)" section.
- [ ] `.claude/settings.json`: remove the `gh pr edit … --add-label reviewed` and `gh pr merge …` allow rules
      (delete the file if nothing else is left).
- [ ] Delete this item, and this file if it is empty.
- [ ] Open the rollback PR and add the `reviewed` label yourself; it touches the gate, so Claude may not.
