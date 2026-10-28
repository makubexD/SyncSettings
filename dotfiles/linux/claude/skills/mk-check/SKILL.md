---
name: mk-check
description: Verify the free-worker setup (oc-exec, OpenCode, mk-worker agent, worker mode) with a live test job on DeepSeek, and on the GLM fallback when asked.
argument-hint: "[--fallback]"
disable-model-invocation: true
---

# Check the free-worker setup

Arguments: $ARGUMENTS

Run these checks in one Bash call where possible, then report a short checklist (✓ / ✗ per line, with
the fix for any ✗).

1. **Installed:** `command -v oc-exec`, and `opencode --version` (load nvm first:
   `source ~/.nvm/nvm.sh`). Also check that `~/.claude/agents/mk-worker.md` exists.
2. **Pinned models:** `grep -E 'model=' ~/.local/bin/oc-exec` shows only
   `opencode/deepseek-v4.1-flash-free` and `opencode/glm-5.3-flash-free`. Anything else is a ✗:
   other free Zen models may keep data for training.
3. **Worker mode:** `worker-mode status`.
4. **Live test:** make a throwaway repo in the scratchpad (or `mktemp -d`), `git init`, commit an empty
   `README.md`, then run
   `oc-exec <dir> "Append the line 'mk-check ok' to README.md. Change nothing else." > <dir>.log 2>&1`,
   then `grep -m1 'oc-exec: model=' <dir>.log; tail -5 <dir>.log`
   (add `--fallback` as the first argument if `$ARGUMENTS` contains `--fallback`). Pass if
   `README.md` contains `mk-check ok` and `git status --short` shows only README.md. Report the model
   from the `oc-exec: model=` banner and how long the run took. Delete the throwaway repo and its log afterwards.

This check calls `oc-exec` directly instead of spawning `mk-worker`, so it uses no Haiku tokens.
