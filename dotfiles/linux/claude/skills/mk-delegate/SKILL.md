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
2. **Check the task.** If it is empty, ask what to delegate and stop. If it names a plan step
   ("step 2 of docs/plan-x.md"), read that step and use its files, change and test command as the spec.
   If the step is tagged `[inline: …]`, stop and say the main session should do it, quoting the reason.
   If it is judgment work (design, debugging, user-facing copy), say so in one line and ask whether to
   do it in the main session instead.
3. **Check the repo.** Run `git rev-parse --show-toplevel` and `git status --short`. Not a git repo, or
   a dirty tree: stop and tell the user to commit or stash first. An uncommitted plan file counts as
   dirty too: offer to commit it (`docs: plan <feature>`) before delegating.
4. **Write the spec** in a few lines: the exact change, the files allowed to change, the test command
   that proves it's done, and any setup it needs (e.g. `source ~/.nvm/nvm.sh` before npm). Name callers
   outside the allowed files that the change could break, so the worker stops instead of leaving them
   broken. Never include secrets, `.env` contents or private data: the paid API is not zero-retention.
5. **Delegate.** Print the report line, then run with Bash `run_in_background: true`:
   `⏵ mk-exec (deepseek <model>, <level> effort): <task in ≤10 words>`
   `mk-exec --effort <level> <repo> '<spec>'`
   Wait for the completion notification; don't poll or sleep. Then read only the output file's
   summary (it ends with `--- log <dir>`). The full transcript is in `<dir>/stream.jsonl` if needed.
6. **Exit codes.** 0 = review it. 75 = DeepSeek key, balance or rate problem: stop, report the error
   line, don't retry. 2 = setup problem (dirty tree, missing key): fix and rerun. 124 = timed out after
   15 min: treat as a rejection. Other non-zero: read the errors in the summary, treat as a rejection.
7. **Review it yourself.** The summary is a claim. Read `git diff`, rerun the test command, and check
   that only the allowed files changed and no tests were deleted or skipped.
8. **Report** to the user: accepted or rejected, files changed, test result, model, effort, tokens, and
   the log dir. Don't commit unless the user asks.
   - Rejected once: discard the worker's changes only with the user's OK (or `git stash`), then resend
     with a concrete correction.
   - Rejected twice: tell the user and offer to do it in the main session.
