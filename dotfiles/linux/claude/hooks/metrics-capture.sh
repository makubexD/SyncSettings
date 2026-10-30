#!/usr/bin/env bash
# Metrics ledger hook, see docs/plan-workflow-metrics-1.md.
# Usage: metrics-capture.sh <SessionStart|UserPromptSubmit|PostToolUse|SessionEnd>
# Claude Code pipes the hook payload on stdin. One compact JSON line per event lands in
# $METRICS_DIR/events-YYYY-MM.jsonl (default ~/.claude/state/metrics), and SessionEnd appends
# the same line to sessions.jsonl. Only derived fields are stored, never prompt text or commands.
# Never fails the session: a bad payload logs one line to hook-errors.log and every path exits 0.
[[ -z ${MK_WORKER:-} ]] || exit 0
trap 'exit 0' EXIT
umask 077
exec >/dev/null

event=${1:-}
case $event in
    SessionStart | UserPromptSubmit | PostToolUse | SessionEnd) ;;
    *) exit 0 ;;
esac

METRICS_DIR=${METRICS_DIR:-$HOME/.claude/state/metrics}
[[ -d $METRICS_DIR ]] || mkdir -p "$METRICS_DIR" 2>/dev/null
[[ -d $METRICS_DIR ]] || exit 0

exec 2>/dev/null
exec 2>>"$METRICS_DIR/hook-errors.log" || exit 0

# Claude Code's stdin is a socket, so $(</dev/stdin) fails with ENXIO. `read -d ''` works but
# does one syscall per byte, 143 ms on a 100 KB Edit payload.
payload=$(cat)

printf -v ts '%(%FT%T%z)T' -1
printf -v month '%(%Y-%m)T' -1
ledger=$METRICS_DIR/events-$month.jsonl
# Raw payload tool name. A Bash call that runs none of the parsed commands needs no jq.
tool_bash_re='"tool_name"[[:space:]]*:[[:space:]]*"Bash"'

invalid() {
    { printf '%s\n' "$ts $event: invalid payload" >>"$METRICS_DIR/hook-errors.log"; } 2>/dev/null
    exit 0
}

# Strip one matching pair of quotes from $1 into $uq.
unquote() {
    uq=$1
    [ "${#uq}" -ge 2 ] || return 0
    case $uq in
        \"*\" | \'*\') uq=${uq:1:${#uq}-2} ;;
    esac
}

[ -n "$payload" ] || invalid

case $event in
    SessionStart)
        cwd=$(jq -r '.cwd // ""' <<<"$payload" 2>/dev/null) || invalid
        top=
        st=
        if [ -n "$cwd" ]; then
            top=$(timeout 0.2 git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || top=
            st=$(timeout 0.2 git --no-optional-locks -C "$cwd" status --porcelain --branch 2>/dev/null) || st=
        fi
        # Not a repo, missing cwd or a timeout: all three stay null.
        if [ -z "$top" ] || [ -z "$st" ]; then
            top=
            st=
        fi
        branch=
        dirty=
        if [ -n "$st" ]; then
            first=${st%%$'\n'*}
            rest=${st#"$first"}
            branch=${first#\#\# }
            case $branch in
                "No commits yet on "*) branch=${branch#No commits yet on } ;;
                "HEAD (no branch)"*) branch= ;;
            esac
            branch=${branch%%...*}
            branch=${branch%% *}
            if [ -n "$rest" ]; then dirty=true; else dirty=false; fi
        fi
        line=$(jq -c --arg ts "$ts" --arg repo "$top" --arg branch "$branch" --arg dirty "$dirty" '
            {v: 1, ts: $ts, event: "session_start",
             session: .session_id, cwd: .cwd,
             source: .source, model: .model,
             repo: (if $repo == "" then null else $repo end),
             branch: (if $branch == "" then null else $branch end),
             dirty: (if $dirty == "" then null else $dirty == "true" end)}' <<<"$payload" 2>/dev/null) || invalid
        ;;
    UserPromptSubmit)
        hash=$(jq -j '.prompt // empty' <<<"$payload" 2>/dev/null | sha256sum)
        hash=${hash%% *}
        line=$(jq -c --arg ts "$ts" --arg hash "$hash" '
            def plan_of($p): [$p | match("[\\w./~-]*plan-[\\w./~-]*\\.md")][0].string;
            def match_of($p): [$p | match("\\bsteps? ([0-9]+)( to ([0-9]+))?"; "i")] | .[0];
            def slash_of($p): [$p | match("^/([\\w:-]+)(\\s|$)")][0].captures[0].string;
            (.prompt // "") as $p
            | if ($p | startswith("<agent-message ")) or ($p | startswith("<task-notification>"))
              then empty
              else (plan_of($p)) as $plan
              | (match_of($p)) as $m
              | {v: 1, ts: $ts, event: "prompt",
                 session: .session_id, cwd: .cwd,
                 len: (if .prompt == null then null else ($p | length) end),
                 hash: $hash, plan: $plan,
                 step: (if $plan == null or $m == null then null else ($m.captures[0].string | tonumber) end),
                 step_to: (if $plan == null or $m == null or $m.captures[2].string == null then null
                           else ($m.captures[2].string | tonumber) end),
                 slash: slash_of($p)}
              end' <<<"$payload" 2>/dev/null) || invalid
        ;;
    PostToolUse)
        # Fast path: a Bash call that runs none of the parsed commands pays no jq at all.
        if [[ $payload =~ $tool_bash_re && $payload != *mk-exec* && $payload != *git* && $payload != *'gh pr'* ]]; then
            exit 0
        fi
        if [[ $payload =~ $tool_bash_re ]]; then
            # One jq pass for the cwd and the command; the command is parsed here, never stored.
            raw=$(jq -j '(.cwd // ""), "\n", (.tool_input.command // "")' <<<"$payload" 2>/dev/null) || invalid
            bcwd=${raw%%$'\n'*}
            bcmd=${raw#*$'\n'}
            bcmd=${bcmd//&&/$'\n'}
            bcmd=${bcmd//||/$'\n'}
            bcmd=${bcmd//;/$'\n'}
            commit_re='^git([[:space:]]+-[cC][[:space:]]+[^[:space:]]+)*[[:space:]]+commit([[:space:]]|$)'
            dir= seen_mk_exec= seen_commit= seen_gh=
            while IFS= read -r seg; do
                # A command position: leading blanks and an opening parenthesis, then an optional rtk.
                seg=${seg#"${seg%%[![:space:]]*}"}
                while [ "${seg:0:1}" = "(" ]; do
                    seg=${seg:1}
                    seg=${seg#"${seg%%[![:space:]]*}"}
                done
                seg=${seg#"rtk "}
                case $seg in
                    cd | cd[[:space:]]*)
                        arg=${seg#cd}
                        arg=${arg#"${arg%%[![:space:]]*}"}
                        arg=${arg%"${arg##*[![:space:]]}"}
                        unquote "$arg"
                        arg=$uq
                        case $arg in
                            '') ;;
                            '~') dir=$HOME ;;
                            '~/'*) dir=$HOME/${arg#"~/"} ;;
                            /*) dir=$arg ;;
                            *) dir=${dir:-${bcwd:-$PWD}}/$arg ;;
                        esac
                        ;;
                    *)
                        if [[ $seg =~ ^mk-exec([[:space:]]|$) ]]; then
                            [ -n "$seen_mk_exec" ] && continue
                            rest=${seg#mk-exec}
                            rest=${rest#"${rest%%[![:space:]]*}"}
                            effort=medium
                            case $rest in
                                --effort=*)
                                    rest=${rest#--effort=}
                                    effort=${rest%%[[:space:]]*}
                                    rest=${rest#"$effort"}
                                    ;;
                                --effort[[:space:]]*)
                                    rest=${rest#--effort}
                                    rest=${rest#"${rest%%[![:space:]]*}"}
                                    effort=${rest%%[[:space:]]*}
                                    rest=${rest#"$effort"}
                                    ;;
                            esac
                            [ -n "$effort" ] || effort=medium
                            rest=${rest#"${rest%%[![:space:]]*}"}
                            unquote "${rest%%[[:space:]]*}"
                            repo=
                            case $uq in
                                '~'* | /* | .* | '$'*) repo=$uq ;;
                            esac
                            line=$(jq -c --arg ts "$ts" --arg effort "$effort" --arg repo "$repo" '
                                {v: 1, ts: $ts, event: "mk_exec",
                                 session: .session_id, cwd: .cwd,
                                 effort: $effort,
                                 repo: (if $repo == "" then null else $repo end)}' <<<"$payload" 2>/dev/null) || invalid
                            printf '%s\n' "$line" >>"$ledger"
                            seen_mk_exec=1
                        elif [[ $seg =~ ^gh[[:space:]]+pr[[:space:]]+(merge|create|edit)([[:space:]]|$) ]]; then
                            [ -n "$seen_gh" ] && continue
                            sub=${BASH_REMATCH[1]}
                            rest=${seg:${#BASH_REMATCH[0]}}
                            pr=
                            if [[ $rest =~ (^|[[:space:]])([0-9]+)([[:space:]]|$) ]]; then
                                pr=${BASH_REMATCH[2]}
                            fi
                            [ "$sub" = create ] && pr=
                            label= has_label=
                            if [[ $rest =~ --add-label=([^[:space:]]*) ]]; then
                                label=${BASH_REMATCH[1]}
                                has_label=1
                            elif [[ $rest =~ --add-label[[:space:]]+([^[:space:]]+) ]]; then
                                label=${BASH_REMATCH[1]}
                                has_label=1
                            fi
                            unquote "$label"
                            label=$uq
                            case $label in
                                '' | *[!A-Za-z0-9._:/-]*) label= ;;
                            esac
                            [ "$sub" = edit ] && [ -z "$has_label" ] && continue
                            action=label
                            case $sub in
                                merge) action=merge ;;
                                create) action=create ;;
                            esac
                            line=$(jq -c --arg ts "$ts" --arg action "$action" --arg label "$label" \
                                --argjson pr "${pr:-null}" '
                                {v: 1, ts: $ts, event: "gh",
                                 session: .session_id, cwd: .cwd,
                                 action: $action, pr: $pr,
                                 label: (if $label == "" then null else $label end)}' <<<"$payload" 2>/dev/null) || invalid
                            printf '%s\n' "$line" >>"$ledger"
                            seen_gh=1
                        elif [[ $seg =~ $commit_re ]]; then
                            [ -n "$seen_commit" ] && continue
                            gdir=
                            grest=${seg#git}
                            while [[ $grest =~ ^[[:space:]]+-([cC])[[:space:]]+([^[:space:]]+) ]]; do
                                [ "${BASH_REMATCH[1]}" = C ] && gdir=${BASH_REMATCH[2]}
                                grest=${grest#"${BASH_REMATCH[0]}"}
                            done
                            if [ -n "$gdir" ]; then
                                unquote "$gdir"
                                gdir=$uq
                                case $gdir in
                                    '~') gdir=$HOME ;;
                                    '~/'*) gdir=$HOME/${gdir#"~/"} ;;
                                esac
                                case $gdir in
                                    /*) d=$gdir ;;
                                    *) d=${dir:-${bcwd:-$PWD}}/$gdir ;;
                                esac
                            else
                                d=${dir:-${bcwd:-$PWD}}
                            fi
                            out=$(git -C "$d" rev-parse --show-toplevel HEAD 2>/dev/null) || out=
                            repo= sha=
                            if [[ $out == *$'\n'* ]]; then
                                repo=${out%%$'\n'*}
                                sha=${out#*$'\n'}
                            fi
                            line=$(jq -c --arg ts "$ts" --arg repo "$repo" --arg sha "$sha" '
                                {v: 1, ts: $ts, event: "git_commit",
                                 session: .session_id, cwd: .cwd,
                                 repo: (if $repo == "" then null else $repo end),
                                 sha: (if $sha == "" then null else $sha end)}' <<<"$payload" 2>/dev/null) || invalid
                            printf '%s\n' "$line" >>"$ledger"
                            seen_commit=1
                        fi
                        ;;
                esac
            done <<<"$bcmd"
            exit 0
        fi
        line=$(jq -c --arg ts "$ts" --arg home "$HOME" '
            def cls($p; $h):
                if $p == null then null
                elif ($p | test("/docs/plan-.*\\.md$")) or ($p | test("/plans/")) then "plan"
                elif ($p | startswith($h + "/.claude/bin/")) or ($p | startswith($h + "/.claude/hooks/")) then "repo-code"
                elif ($p | startswith($h + "/.claude/")) or ($p | test("/\\.claude/")) or ($p | endswith("/CLAUDE.md")) then "claude-config"
                elif ($p | endswith(".md")) or ($p | test("/docs/")) then "repo-docs"
                else "repo-code"
                end;
            if (.tool_name == "Edit") or (.tool_name == "Write") or (.tool_name == "MultiEdit") or (.tool_name == "NotebookEdit") then
                (.tool_input.file_path // .tool_input.notebook_path) as $p
                | {v: 1, ts: $ts, event: "edit",
                   session: .session_id, cwd: .cwd,
                   tool: .tool_name, path: $p, class: cls($p; $home)}
            elif .tool_name == "Skill" then
                {v: 1, ts: $ts, event: "skill",
                 session: .session_id, cwd: .cwd,
                 name: .tool_input.skill}
            elif .tool_name == "Agent" then
                {v: 1, ts: $ts, event: "agent",
                 session: .session_id, cwd: .cwd,
                 type: .tool_input.subagent_type}
            else empty
            end' <<<"$payload" 2>/dev/null) || invalid
        ;;
    SessionEnd)
        line=$(jq -c --arg ts "$ts" '
            {v: 1, ts: $ts, event: "session_end",
             session: .session_id, cwd: .cwd,
             reason: .reason}' <<<"$payload" 2>/dev/null) || invalid
        [ -n "$line" ] || exit 0
        printf '%s\n' "$line" >>"$ledger"
        printf '%s\n' "$line" >>"$METRICS_DIR/sessions.jsonl"
        exit 0
        ;;
esac

[ -n "$line" ] || exit 0
printf '%s\n' "$line" >>"$ledger"
