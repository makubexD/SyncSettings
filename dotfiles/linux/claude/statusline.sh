#!/usr/bin/env bash
# Compact statusline for dark terminals (Linux port of the Windows StatusLine.ps1)
# Sections: Time, Model, VEnv, Project Type, Dir, Git, Cost+Context, Cache, Load, Mem, Output Style
# Every section fails silently; stdin is the Claude Code statusline JSON payload.

reset=$'\e[0m'
cyan=$'\e[96m'       # model, cache, resources
yellow=$'\e[93m'     # directory, git changes
magenta=$'\e[95m'    # git branch
blue=$'\e[94m'       # output style, project type
green=$'\e[92m'      # venv, healthy values
yellowDim=$'\e[33m'  # warning values
red=$'\e[91m'        # critical values
gray=$'\e[90m'       # timestamp, separators

# Progress bar: [██████░░░░]
progress_bar() {
    local filled=$(( $1 / 10 )) bar="" i
    (( filled > 10 )) && filled=10
    (( filled < 0 )) && filled=0
    for ((i = 0; i < filled; i++)); do bar+="█"; done
    for ((i = filled; i < 10; i++)); do bar+="░"; done
    printf '[%s]' "$bar"
}

# Token count: lowercase k/M, drop trailing .0
fmt_tokens() {
    awk -v t="$1" 'BEGIN {
        if (t >= 1000000) { v = sprintf("%.1f", t / 1000000); s = "M" }
        else if (t >= 1000) { v = sprintf("%.1f", t / 1000); s = "k" }
        else { printf "%d", t + 0.5; exit }
        sub(/\.0$/, "", v); printf "%s%s", v, s
    }'
}

input=$(cat)

# One jq pass for every field (tab-separated; empty string when missing)
IFS=$'\t' read -r model project_dir cwd cost remaining used_pct tok_used tok_total cache_create cache_read style < <(
    jq -r '[
        .model.display_name // "",
        .workspace.project_dir // "",
        (.cwd // .workspace.current_dir // .workspace.project_dir // ""),
        (.cost.total_cost_usd // "" | tostring),
        (.context_window.remaining_percentage // "" | tostring),
        (.context_window.used_percentage // "" | tostring),
        (.context_window.total_input_tokens // "" | tostring),
        (.context_window.context_window_size // "" | tostring),
        (.context_window.current_usage.cache_creation_input_tokens // 0 | tostring),
        (.context_window.current_usage.cache_read_input_tokens // 0 | tostring),
        .output_style.name // ""
    ] | map(if . == "" then "-" else . end) | @tsv' <<<"$input" 2>/dev/null
)
# "-" is a placeholder so read keeps empty fields aligned
for v in model project_dir cwd cost remaining used_pct tok_used tok_total cache_create cache_read style; do
    [[ ${!v} == "-" ]] && printf -v "$v" ''
done

parts=()

# Time
parts+=("${gray}$(date +%H:%M)${reset}")

# Model
[[ -n $model ]] && parts+=("${cyan}${model}${reset}")

# Virtual environment
venv=""
if [[ -n $project_dir && -d $project_dir/.venv && -f $project_dir/pyproject.toml ]]; then
    venv=".venv"
elif [[ -n $VIRTUAL_ENV ]]; then
    venv=${VIRTUAL_ENV##*/}
elif [[ -n $CONDA_DEFAULT_ENV ]]; then
    venv="conda:$CONDA_DEFAULT_ENV"
fi
[[ -n $venv ]] && parts+=("${green}${venv}${reset}")

# Project type
if [[ -n $project_dir && -d $project_dir ]]; then
    ptype=""
    if   [[ -f $project_dir/pyproject.toml ]]; then ptype="Python"
    elif [[ -f $project_dir/package.json ]];   then ptype="Node.js"
    elif [[ -f $project_dir/Cargo.toml ]];     then ptype="Rust"
    elif [[ -f $project_dir/go.mod ]];         then ptype="Go"
    elif compgen -G "$project_dir/*.csproj" >/dev/null || compgen -G "$project_dir/*.sln" >/dev/null; then ptype=".NET"
    fi
    [[ -n $ptype ]] && parts+=("${blue}${ptype}${reset}")
fi

# Directory
dirname=${cwd%/}
dirname=${dirname##*/}
[[ -n $dirname ]] && parts+=("${yellow}${dirname}${reset}")

# Git: branch, dirty marker, ahead/behind, last commit age, then changes
gitdir=${cwd:-$PWD}
g() { git --no-optional-locks -C "$gitdir" "$@" 2>/dev/null; }
if branch=$(g rev-parse --abbrev-ref HEAD) && [[ -n $branch ]]; then
    porcelain=$(g status --porcelain)
    [[ -n $porcelain ]] && branch+="*"

    gitstatus=""
    if counts=$(g rev-list --left-right --count 'HEAD...@{upstream}'); then
        read -r ahead behind <<<"$counts"
        (( ahead > 0 )) && gitstatus+=" ↑$ahead"
        (( behind > 0 )) && gitstatus+=" ↓$behind"
    fi
    if age=$(g log -1 --format=%cr) && [[ -n $age ]]; then
        age=$(sed -E 's/ years? ago/y/; s/ months? ago/mo/; s/ weeks? ago/w/; s/ days? ago/d/; s/ hours? ago/h/; s/ minutes? ago/m/; s/ seconds? ago/s/' <<<"$age")
        gitstatus+=" $age"
    fi
    parts+=("${magenta}${branch}${gitstatus}${reset}")

    # Insertions/deletions across staged + unstaged, plus untracked count
    read -r ins del < <({ g diff --numstat; g diff --cached --numstat; } | awk '$1 != "-" { i += $1; d += $2 } END { print i + 0, d + 0 }')
    untracked=$(grep -c '^??' <<<"$porcelain")
    changes=()
    (( ins > 0 || del > 0 )) && changes+=("(+${ins},-${del})")
    (( untracked > 0 )) && changes+=("${untracked}?")
    (( ${#changes[@]} > 0 )) && parts+=("${yellow}${changes[*]}${reset}")
fi

# Cost + context
combined=""
if [[ -n $cost ]]; then
    color=$(awk -v c="$cost" -v g="$green" -v y="$yellowDim" -v r="$red" 'BEGIN { print (c < 0.5 ? g : (c <= 2 ? y : r)) }')
    combined+="${color}Cost: \$$(printf '%.2f' "$cost")${reset}"
fi
pct=""
if [[ -n $remaining ]]; then
    pct=$(printf '%.0f' "$remaining")
elif [[ -n $used_pct ]]; then
    pct=$(awk -v u="$used_pct" 'BEGIN { printf "%.0f", 100 - u }')
fi
if [[ -n $pct ]]; then
    if   (( pct > 60 )); then color=$green
    elif (( pct >= 30 )); then color=$yellowDim
    else color=$red
    fi
    bar=$(progress_bar "$pct")
    if [[ -n $tok_used && -n $tok_total && $tok_total != 0 ]]; then
        ctx="Context: $bar $(fmt_tokens "$tok_used")/$(fmt_tokens "$tok_total") (${pct}%)"
    else
        ctx="Context: $bar ${pct}%"
    fi
    [[ -n $combined ]] && combined+=" ${gray}|${reset} "
    combined+="${color}${ctx}${reset}"
fi
[[ -n $combined ]] && parts+=("$combined")

# Cached tokens
cache_create=${cache_create%.*} cache_read=${cache_read%.*}
cached=$(( ${cache_create:-0} + ${cache_read:-0} ))
(( cached > 0 )) && parts+=("${cyan}Cached: $(fmt_tokens "$cached")${reset}")

# System resources: 1-minute load average + memory (cheap on Linux, unlike Windows counters)
read -r load _ </proc/loadavg 2>/dev/null && parts+=("${cyan}Load: ${load}${reset}")
mem=$(awk '/^MemTotal:/ { t = $2 } /^MemAvailable:/ { a = $2 } END { if (t) printf "%.1fG/%.1fG", (t - a) / 1048576, t / 1048576 }' /proc/meminfo 2>/dev/null)
[[ -n $mem ]] && parts+=("${cyan}Mem: ${mem}${reset}")

# Output style (only if not default)
[[ -n $style && $style != default ]] && parts+=("${blue}${style}${reset}")

# Worker mode (Claude edits blocked, code goes through mk-exec)
[[ -e $HOME/.claude/state/worker-mode ]] && parts+=("${green}WORKER${reset}")

sep=" ${gray}|${reset} "
out=""
for p in "${parts[@]}"; do
    out+="${out:+$sep}$p"
done
printf '%s\n' "${out:-Statusline data unavailable}"
