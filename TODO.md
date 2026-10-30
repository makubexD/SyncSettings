# TODO

## Roll back Claude auto-approval when development is done

Added 2026-10-30 to speed up development: Claude adds the `reviewed` label and merges its own PRs. When the
repo is stable, give the review back to a human:

- [ ] `CLAUDE.md`: delete the "Claude auto-approval (temporary, development stage)" section.
- [ ] `docs/review-gate.md`: delete the "Claude auto-approval (temporary)" section.
- [ ] `.claude/settings.json`: remove the `gh pr edit … --add-label reviewed` and `gh pr merge …` allow rules
      (delete the file if nothing else is left).
- [ ] Delete this item, and this file if it is empty.
- [ ] Open the rollback PR and add the `reviewed` label yourself; it touches the gate, so Claude may not.
