#!/bin/bash
# Context-size gate, a UserPromptSubmit and PostToolUse hook. See
# docs/plan-workflow-fixes.md step 10 and docs/plan-workflow-fixes-2.md step 6.
# Reads the hook payload on stdin: UserPromptSubmit {"session_id":"s",
# "hook_event_name":"UserPromptSubmit","prompt":"...","transcript_path":"..."}, or
# PostToolUse {"hook_event_name":"PostToolUse","tool_name":"Bash",
# "tool_input":{"command":"..."},"transcript_path":"..."}. Context size is input_tokens +
# cache_read_input_tokens + cache_creation_input_tokens of .message.usage on the last
# transcript line with "type":"assistant", read from the last 256 KB of the transcript.
# If .session_id is a safe name and ${CTX_WINDOW_DIR:-$HOME/.claude/state/ctx-window}/
# <session_id> holds only digits W, the threshold becomes min(CONTEXT_CLEAR_AT,
# W * 70 / 100), so a small window stops before auto-compact. A missing file, an unsafe
# session_id or a bad value keeps CONTEXT_CLEAR_AT.
# At or over that threshold a prompt that is /next or starts with
# "/next " gets a block decision telling the model to /clear and resume; a prompt starting
# with <task-notification> gets one plain line telling it to commit, alert the user and
# stop. A PostToolUse Bash command that is a git commit carrying a "Plan-Step:" trailer
# gets one JSON object whose hookSpecificOutput.additionalContext says the step is
# committed and to stop for /clear unless no steps are left. /next --force, MK_WORKER=1,
# other prompts and commands, and any problem (bad JSON, missing transcript, no usage)
# print nothing. Always exits 0 and fails open; writes nothing to disk.
CONTEXT_CLEAR_AT=${CONTEXT_CLEAR_AT:-200000}
TAIL_BYTES=262144

input=$(cat) || exit 0

[[ ${MK_WORKER:-} == 1 ]] && exit 0

# Cheap prefilter: a payload with no /next, task notification or Plan-Step trailer
# cannot act. PostToolUse commit payloads carry "Plan-Step:" in the command.
[[ $input == *'/next'* || $input == *'<task-notification>'* || $input == *'Plan-Step:'* ]] || exit 0

prompt=
tp=
event=
tool=
cmd=
sid=
{
    IFS= read -r -d '' prompt
    IFS= read -r -d '' tp
    IFS= read -r -d '' event
    IFS= read -r -d '' tool
    IFS= read -r -d '' cmd
    IFS= read -r -d '' sid
} < <(
    printf '%s' "$input" |
        jq -j '(.prompt // ""), "\u0000", (.transcript_path // ""), "\u0000",
            (.hook_event_name // ""), "\u0000", (.tool_name // ""), "\u0000",
            (.tool_input.command // ""), "\u0000",
            (.session_id // ""), "\u0000"' 2>/dev/null
)

mode=
case $prompt in
    '/next' | '/next '*)
        # Any word --force skips the gate.
        read -ra words <<<"$prompt"
        for word in "${words[@]}"; do
            [[ $word == --force ]] && exit 0
        done
        mode=gate
        ;;
    '<task-notification>'*) mode=notification ;;
    *)
        # PostToolUse commit gate: only a Bash git commit with the Plan-Step trailer.
        if [[ $event == PostToolUse && $tool == Bash &&
            $cmd == *'git commit'* && $cmd == *'Plan-Step:'* ]]; then
            mode=post
        else
            exit 0
        fi
        ;;
esac

[[ -n $tp && -r $tp ]] || exit 0

# The first line of a tail -c read may be partial: fromjson? drops lines that do not
# parse. Lines are reversed so first() stops at the newest line with a usage object
# instead of parsing the whole tail.
size=$(
    tail -c "$TAIL_BYTES" -- "$tp" 2>/dev/null |
        grep -F '"type":"assistant"' |
        tac |
        jq -R -n '
            first(inputs
                | fromjson? | objects | select(.type == "assistant")
                | .message | objects | .usage | objects
                | (.input_tokens // 0) + (.cache_read_input_tokens // 0)
                  + (.cache_creation_input_tokens // 0)
            ) // empty' 2>/dev/null
)

[[ $size =~ ^[0-9]+$ ]] || exit 0

# Auto-compact arrives near 83% of the model's window; stop earlier on a small window.
if [[ $sid =~ ^[A-Za-z0-9_-]+$ ]]; then
    window_file="${CTX_WINDOW_DIR:-$HOME/.claude/state/ctx-window}/$sid"
    if [[ -r $window_file ]]; then
        window=$(<"$window_file")
        if [[ $window =~ ^[0-9]+$ ]] && (( window > 0 )); then
            window_limit=$((window * 70 / 100))
            (( window_limit < CONTEXT_CLEAR_AT )) && CONTEXT_CLEAR_AT=$window_limit
        fi
    fi
fi

(( size < CONTEXT_CLEAR_AT )) && exit 0

k=$((size / 1000))
limit=$((CONTEXT_CLEAR_AT / 1000))

if [[ $mode == notification ]]; then
    printf 'Context is %sk tokens: when this worker step is reviewed, commit it, send the user a push notification, and stop with "/clear, then /next". Do not start the next step.\n' "$k"
elif [[ $mode == post ]]; then
    jq -cn --arg k "${k}k" \
        '{hookSpecificOutput: {hookEventName: "PostToolUse",
            additionalContext: ("Context is \($k) tokens: this plan step is committed. Even if no steps are left (the finish starts fresh), send the user a push notification and stop with \"/clear, then /next\".")}}'
elif [[ -n ${CLAUDE_CODE_BRIDGE_SESSION_ID:-} ]]; then
    # Remote Control is on: a block reason shows only in the local terminal, so a user on
    # another device would see nothing. Let the prompt through and have the model answer.
    jq -cn --arg k "${k}k" --arg limit "${limit}k" \
        '{hookSpecificOutput: {hookEventName: "UserPromptSubmit",
            additionalContext: ("context-gate: context is \($k) tokens (limit \($limit)). Do not run /next, plan-next or any other tool except a push notification. Send the user a push notification, then reply with exactly one line: \"Context is \($k) (limit \($limit)): run /clear, then /next. /next --force skips this check.\"")}}'
else
    jq -cn --arg k "${k}k" --arg limit "${limit}k" \
        '{decision: "block", reason: ("Context is \($k) tokens (limit \($limit)). Run /clear, then /next to resume at the right step. /next --force skips this check.")}'
fi

exit 0
