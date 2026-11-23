---
name: mk-delegate
description: Hand a mechanical coding task to the paid DeepSeek worker (mk-exec → headless Claude Code on DeepSeek), then review its diff and tests before accepting.
argument-hint: "[--effort low|medium|high] <task, or: step N of docs/plan-x.md>"
disable-model-invocation: true
---

# Delegate to the DeepSeek worker

Arguments from the user: $ARGUMENTS

1. **Parse effort.** If the arguments start with `--effort <level>`, take it (`low`, `medium` or `high`) and
   drop it from the task. Default: `medium`. A plan step tagged `[worker:<level>]` sets it too; an explicit
   `--effort` wins. Mapping: low = deepseek-flash/low, medium = deepseek-flash/high, high = deepseek-v4-pro/high.
   `high` costs about 7x `medium` per run (Nov 2026: $0.16 vs $0.02) and wasn't more reliable, so it runs in two
   cases only, and `mk-exec` refuses it without `--why`:
   - **Escalation**: a `medium` run of this step was rejected for wrong logic (not a bad spec). Resend with
     `--effort high --why escalation`; `mk-exec` checks that a `medium` log for the step exists and it has no commit.
   - **Reasoning**: the step is tagged `[worker:high: reasoning: <what>]`. Send with `--effort high --why reasoning`.
   Any other `high` tag (CI-only, "must land first try", "read closely") runs at `medium`; say so in one line.
   Sub-steps of a split step, and anything resent after a timeout, go at `medium`.
2. **Check the task.** If it is empty, ask what to delegate and stop. If it names a plan step
   ("step 2 of docs/plan-x.md"), read that step and use its files, change and test command as the spec.
   If the step is tagged `[inline: …]`, stop and say the main session should do it, quoting the reason.
   If it is judgment work (design, debugging, user-facing copy), say so in one line and ask whether to
   do it in the main session instead. If its result is a model's own behavior (an eval or probe run),
   stop: the worker would measure DeepSeek, not the model under test. Delegating the eval files is fine.
3. **Check the repo.** Run `git rev-parse --show-toplevel` and `git status --short`. Not a git repo, or
   a dirty tree: stop and tell the user to commit or stash first. An uncommitted plan file or plan edit counts as
   dirty too, but don't ask: run the repo's formatter and `plan-next --check` on it, commit it
   (`docs: plan <feature> edits`, `Route: unplanned`), then delegate.
4. **Size it.** A worker step is one concern touching at most about 3 files. If the step is bigger (several
   separate changes, a long file-by-file list), split it into sub-steps and send them one at a time, each
   reviewed before the next. The effort level is unaffected: keep the one chosen.
5. **Write the spec** in a few lines: the exact change, the files allowed to change, the test command
   that proves it's done, and any setup it needs (e.g. `source ~/.nvm/nvm.sh` before npm). Name callers
   outside the allowed files that the change could break, so the worker stops instead of leaving them
   broken. The worker reads the repo's `CLAUDE.md`, rules and project hooks itself, so don't restate them;
   the summary's `project config:` line shows what it loaded. Never include secrets, `.env` contents or private data: the paid API is not zero-retention.
6. **Delegate.** Print the report line, then run with Bash `run_in_background: true`:
   `⏵ mk-exec (deepseek <model>, <level> effort): <task in ≤10 words>`
   `mk-exec --effort <level> [--step <plan>#<n>] [--why escalation|reasoning] <repo> '<spec>'`
   For a plan step always pass `--step` (repo-relative plan path, as in the `Plan-Step` trailer): it goes into
   `meta.json`, and `workflow-report` uses it to show whether a `high` run was accepted.
   Wait for the completion notification; don't poll or sleep. Then read only the output file's
   summary, in a Bash call of its own: `sed -n '/--- worker summary/,$p' <output file>` (it ends with
   `--- log <dir>`). Don't chain it with the diff or a file: long combined output gets indexed and cut, and you
   read it all again. Never `ctx_execute` to print it. The full transcript is in `<dir>/stream.jsonl` if needed.
7. **Exit codes.** 0 = review it. 75 = DeepSeek key, balance or rate problem: stop, report the error
   line, don't retry. 2 = setup problem (dirty tree, missing key): fix and rerun. 124 = timed out after
   15 min: the step is too big, so split it and send the parts; don't resend at `high`. `(max turns)`: the step was too big and the diff may be partial; review
   what's there, then split the rest and send it. Other non-zero: read the errors, treat as a rejection.
8. **Review it yourself.** The summary is a claim. Read `git diff` through Bash (RTK trims it; one call, nothing
   chained), new files with the Read tool, never through `ctx_execute`. Rerun the step's own test command and
   the linter on the changed files (not the full suite, which runs once in the plan's finish), and check
   that only the allowed files changed and no tests were deleted or skipped.
9. **Report** to the user: accepted or rejected, files changed, test result, model, effort, tokens, and
   the log dir. A one-off task: don't commit unless the user asks. A step of a committed plan: commit
   the accepted step with the `Plan-Step` and `Route` trailers from `CLAUDE.md`, and send the next one
   without asking; stop and ask only at an `[inline]` judgment
   step, a rejection or failure, or the end of the phase or plan. If the `context-gate` hook added its line to the
   completion notification, commit the step, send a push notification, and stop with "/clear, then /next".
   - Rejected once: discard the worker's changes only with the user's OK (or `git stash`), then resend
     with a concrete correction.
   - Rejected twice: tell the user and offer to do it in the main session.
10. **Kept worktree.** If `mk-exec` says `worker created gitignored files, worktree kept`, look at the files it
    names. If they are only build outputs (gitignored binaries, `dist/`, `build/`), the repo needs a `.mk-disposable`
    line for them: tell the user the exact line (e.g. `dist/`), add it in a commit of its own when they agree, and
    resend the step. `mk-prune` removes the old worktree after 7 days. Anything else kept (a failed apply, worker
    commits, a gitignored file that isn't a build output) is a failure: review it like a rejection.
11. **Low balance.** A `mk-exec: LOW BALANCE …` line in the summary is a warning, not a failure: review the run
    as usual and push-notify the user to top up.
