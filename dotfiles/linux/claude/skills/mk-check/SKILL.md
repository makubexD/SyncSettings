---
name: mk-check
description: Verify the DeepSeek worker setup (mk-exec, key and balance, isolated worker config, worker mode, logs) with a live test job.
argument-hint: "[--effort low|medium|high]"
disable-model-invocation: true
---

# Check the DeepSeek worker setup

Arguments: $ARGUMENTS

Run these checks in one Bash call where possible, then report a short checklist (✓ / ✗ per line, with
the fix for any ✗). Never print the API key.

1. **Installed:** `command -v mk-exec workflow-report claude`, and `~/.claude-worker/{CLAUDE.md,settings.json}` exist.
2. **Key:** `~/.config/claude-workers/env` exists with mode 600 and has a `DEEPSEEK_API_KEY=` line
   (check with `grep -c`, never `cat`).
3. **Isolation:** `env | grep -c '^ANTHROPIC_'` in this session is 0, and `~/.claude-worker` has no
   `.credentials.json`.
4. **Worker mode:** `worker-mode status`.
5. **Live test:** make a throwaway repo in the scratchpad, `git init`, commit an empty `README.md`, then
   run `mk-exec --effort <level, default low> <dir> "Append the line 'mk-check ok' to README.md. Change nothing else. Then run: cat README.md"`.
   Pass if the exit code is 0, `README.md` contains `mk-check ok`, `git status --short` shows only
   README.md, and the log dir in the last summary line holds `stream.jsonl`, `meta.json`, `diff.patch`
   and `summary.txt`. Report the model, effort, tokens, duration and the balance from the banner.
   Delete the throwaway repo afterwards (keep the log dir).
