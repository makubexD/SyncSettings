#!/usr/bin/env bash
# Compares the bash statusline with `dist/mksync statusline` on the recorded
# payloads in tools/statusline-payloads/. Both run in a throwaway HOME with
# the same CTX_WINDOW_DIR; the time, load and memory sections are blanked
# because they read the live machine. Everything else must match byte for
# byte, and so must the context-window file each run writes. Decision 7,
# "Statusline (program only)".
set -u

esc=$'\e'
blank='<blanked>'

script_dir=$(dirname "$0")
repo=$(cd "$script_dir/.." && pwd)
payload_dir="$script_dir/statusline-payloads"
bash_statusline="$repo/dotfiles/linux/claude/statusline.sh"
program="$repo/dist/mksync"

if [[ ! -f $program ]]; then
    printf 'statusline-parity: %s is missing; run `bun run build` first.\n' "$program" >&2
    exit 2
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
ctx_dir="$tmp/.claude/state/ctx-window"

# The script and the program print the time, load and memory from the live
# machine, so their text can't be compared.
blank_volatile() {
    sed -E \
        -e "s/${esc}\[90m[0-9][0-9]:[0-9][0-9]${esc}\[0m/${blank}/g" \
        -e "s/${esc}\[96mLoad: [^${esc}]*${esc}\[0m/${blank}/g" \
        -e "s/${esc}\[96mMem: [^${esc}]*${esc}\[0m/${blank}/g"
}

# The context-window files a run left behind, as "<name>=<size>" lines.
ctx_snapshot() {
    if [[ ! -d $ctx_dir ]]; then
        printf 'missing\n'
        return
    fi
    local file
    for file in "$ctx_dir"/*; do
        [[ -e $file ]] || continue
        printf '%s=' "${file##*/}"
        sed -n 'p' "$file"
    done
}

payloads=("$payload_dir"/*.json)
if [[ ! -e ${payloads[0]} ]]; then
    printf 'statusline-parity: no payloads in %s.\n' "$payload_dir" >&2
    exit 2
fi

failures=0
for payload in "${payloads[@]}"; do
    name=${payload##*/}

    rm -rf "$ctx_dir"
    bash_line=$(
        cd "$repo" &&
            HOME="$tmp" CTX_WINDOW_DIR="$ctx_dir" "$bash_statusline" <"$payload"
    )
    bash_ctx=$(ctx_snapshot)

    rm -rf "$ctx_dir"
    program_line=$(
        cd "$repo" &&
            HOME="$tmp" CTX_WINDOW_DIR="$ctx_dir" "$program" statusline <"$payload"
    )
    program_ctx=$(ctx_snapshot)

    line_diff=$(diff -u \
        <(printf '%s\n' "$bash_line" | blank_volatile) \
        <(printf '%s\n' "$program_line" | blank_volatile))
    ctx_diff=$(diff -u \
        <(printf '%s\n' "$bash_ctx") \
        <(printf '%s\n' "$program_ctx"))

    if [[ -z $line_diff && -z $ctx_diff ]]; then
        printf 'ok %s\n' "$name"
        continue
    fi

    failures=$((failures + 1))
    printf 'FAIL %s\n' "$name"
    [[ -n $line_diff ]] && printf '%s\n' "$line_diff"
    if [[ -n $ctx_diff ]]; then
        printf 'CTX_WINDOW_DIR differs:\n%s\n' "$ctx_diff"
    fi
done

(( failures == 0 )) && exit 0
exit 1
