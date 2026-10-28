---
name: mk-delegate
description: Hand a mechanical coding task to the free worker (mk-worker → OpenCode + DeepSeek V4.1 Flash Free), then review its diff and tests before accepting.
argument-hint: "<task, or: step N of docs/plan-x.md>"
disable-model-invocation: true
---

# Delegate to the free worker

Task from the user: $ARGUMENTS

1. **Check the task.** If it is empty, ask what to delegate and stop. If it names a plan step
   ("step 2 of docs/plan-x.md"), read that step and use its files, change and test command as the spec.
   If it is judgment work (design, debugging, user-facing copy), say so in one line and ask whether to
   do it in the main session instead.
2. **Check the repo.** Run `git rev-parse --show-toplevel` and `git status --short`. Not a git repo, or
   a dirty tree: stop and tell the user to commit or stash first.
3. **Write the spec** in a few lines: the exact change, the files allowed to change, and the test command
   that proves it's done. Never include secrets, `.env` contents or private data.
4. **Delegate.** Print the report line, then spawn the `mk-worker` agent with the repo path and the spec:
   `⏵ mk-worker (haiku + opencode/deepseek-v4.1-flash-free, low effort): <task in ≤10 words>`
5. **Review it yourself.** The agent's report is a claim. Read `git diff`, rerun the test command, and
   check that only the allowed files changed and no tests were deleted or skipped.
6. **Report** to the user: accepted or rejected, files changed, test result, model used and whether the
   fallback ran. Don't commit unless the user asks.
   - Rejected once: resend with a concrete correction.
   - Rejected twice: tell the user and offer to do it in the main session.
