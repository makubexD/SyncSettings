#!/usr/bin/env bash
# PreToolUse guard for mcp__plugin_context-mode_context-mode__ctx_execute used as a printer.
# Denies only when tool_input.language is "shell" and the code is a chain of plain read/print
# commands: the first stage of every command starts with cat, sed -n, head, tail, git diff,
# git show, git log, rtk read, workflow-report, ls or echo, and no later pipeline stage is
# wc, grep -c, sort, uniq, awk, jq, python or python3. Anything else, including a bad payload,
# a missing field or another language, is allowed: no output, exit 0. It never exits non-zero.
input=$(cat)
lang=$(jq -r '.tool_input.language // ""' <<<"$input" 2>/dev/null) || exit 0
[[ $lang == shell ]] || exit 0
code=$(jq -r '.tool_input.code // ""' <<<"$input" 2>/dev/null) || exit 0
[[ -n $code ]] || exit 0

reason='ctx_execute is for computing over data. To read a file, diff or worker summary, use Bash (RTK trims it) or Read with offset/limit.'

# Command names match as whole words: "catalog" is not cat, "git diff-tree" is not git diff.
read_re='^(cat|head|tail|ls|echo)([^[:alnum:]_]|$)|^sed[[:space:]]+-n|^git[[:space:]]+(diff|show|log)([^[:alnum:]_]|$)|^rtk[[:space:]]+read([^[:alnum:]_]|$)|^workflow-report([^[:alnum:]_]|$)'
compute_re='^(wc|sort|uniq|awk|jq|python3?)([^[:alnum:]_]|$)|^grep[[:space:]]+-c([^[:alnum:]_]|$)'

trim() {
    local s=$1
    s=${s#"${s%%[![:space:]]*}"}
    s=${s%"${s##*[![:space:]]}"}
    printf '%s' "$s"
}

# Split on newlines, ";", "&&" and "||"; || goes first so it is not read as a pipe.
normalized=${code//||/$'\n'}
normalized=${normalized//&&/$'\n'}
normalized=${normalized//;/$'\n'}

all_read=1
seen=0
leading=1
while IFS= read -r raw; do
    piece=$(trim "$raw")
    [[ -n $piece ]] || continue
    # A fragment with no word in it (a stray operator, a lone "==") is not a command.
    [[ $piece =~ [[:alnum:]] ]] || continue
    if (( leading )); then
        leading=0
        # Drop a leading "cd <dir>": it only sets the directory for the reads after it.
        [[ $piece =~ ^cd([[:space:]]|$) ]] && continue
    fi
    seen=1
    IFS='|' read -r -a stages <<<"$piece"
    first=$(trim "${stages[0]}")
    if ! [[ $first =~ $read_re ]]; then
        all_read=0
        break
    fi
    i=1
    while (( i < ${#stages[@]} )); do
        stage=$(trim "${stages[$i]}")
        if [[ $stage =~ $compute_re ]]; then
            all_read=0
            break 2
        fi
        i=$((i + 1))
    done
done <<<"$normalized"

(( all_read && seen )) || exit 0

jq -n --arg r "$reason" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
exit 0
