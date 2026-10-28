#!/usr/bin/env bash
# PreToolUse guard for Edit/Write/MultiEdit/NotebookEdit. Does nothing unless worker mode is on
# (flag: ~/.claude/state/worker-mode, toggled with `worker-mode on|off`).
# While on, it denies file edits by Claude so code changes go through mk-exec.
# Still allowed: plan files (docs/plan-*.md, plans/), and anything under ~/.claude (config, memory).
# The mk-exec worker (MK_WORKER=1) is the one meant to edit, so it is never blocked.
[[ -z ${MK_WORKER:-} && -e $HOME/.claude/state/worker-mode ]] || exit 0

input=$(cat)
path=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' <<<"$input" 2>/dev/null)

case "$path" in
    "$HOME"/.claude/*|*/docs/plan-*.md|*/plans/*) exit 0 ;;
esac

reason="Worker mode is on: Claude may not edit ${path:-files} directly. Send this change to mk-exec (/mk-delegate, headless Claude Code on DeepSeek) and review its diff. If this edit is tiny or judgment work, ask the user to run: ! worker-mode off"
jq -n --arg r "$reason" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
