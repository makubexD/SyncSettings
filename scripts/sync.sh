#!/usr/bin/env bash
# Shared helpers for the bash entry points (export.sh / import.sh / commit.sh).
# Source this file after cd-ing to the repo root. Never execute it directly.

set -euo pipefail
shopt -s extglob

REPO_ROOT=$PWD
CONFIG=$REPO_ROOT/sync-config.json
VALUES_FILE=$REPO_ROOT/.user-values.json

declare -A USER_VALUES=()

# -- Config -------------------------------------------------------------------

linux_entries() {
    jq -c '.files[] | select(.platform == "linux")' "$CONFIG"
}

resolve_local() {
    local p=$1
    if [[ $p == '~/'* ]]; then
        p="$HOME/${p#'~/'}"
    fi
    printf '%s' "$p"
}

declare -a EXCLUDES=()
while IFS= read -r pattern; do
    if [[ -n $pattern ]]; then
        EXCLUDES+=("$pattern")
    fi
done < <(jq -r '(.excludePatterns // []) | .[]' "$CONFIG")
is_excluded() {
    local path=$1 leaf=${1##*/} pattern
    for pattern in "${EXCLUDES[@]}"; do
        if [[ $leaf == $pattern || $path == */$pattern ]]; then
            return 0
        fi
    done
    return 1
}

# -- User values cache (.user-values.json) ------------------------------------

load_values() {
    USER_VALUES=()
    [[ -f $VALUES_FILE ]] || return 0
    local key value
    # NUL-separated, not @tsv: @tsv escapes backslashes, which would corrupt Windows paths.
    while IFS= read -r -d '' key && IFS= read -r -d '' value; do
        USER_VALUES[$key]=$value
    done < <(jq -j 'to_entries[] | .key, "\u0000", (.value | tostring), "\u0000"' "$VALUES_FILE")
}

save_values() {
    [[ ${#USER_VALUES[@]} -gt 0 ]] || return 0
    local -a args=()
    local key
    for key in "${!USER_VALUES[@]}"; do
        args+=(--arg "$key" "${USER_VALUES[$key]}")
    done
    jq -S -n "${args[@]}" '$ARGS.named' > "$VALUES_FILE"
}

# -- Prompting ----------------------------------------------------------------

request_values() {
    local direction=$1 reset=$2 rules=$3
    local header_printed=0
    local -a seen=()
    local placeholder prompt rule_default rule_defenv input defval

    # Rules arrive on fd 4 as NUL-separated fields, so `read` below still reads the user's answer
    # from stdin, and empty fields (no default) are not collapsed the way tab-separated input is.
    while IFS= read -r -d '' placeholder <&4 && IFS= read -r -d '' prompt <&4 &&
          IFS= read -r -d '' rule_default <&4 && IFS= read -r -d '' rule_defenv <&4; do
        [[ -n $placeholder ]] || continue

        local is_seen=0 item
        for item in "${seen[@]:-}"; do
            if [[ $item == "$placeholder" ]]; then is_seen=1; break; fi
        done
        if (( is_seen )); then
            continue
        fi

        if [[ $reset != 1 && -n ${USER_VALUES[$placeholder]:-} ]]; then
            continue
        fi
        seen+=("$placeholder")

        if (( ! header_printed )); then
            header_printed=1
            if [[ $direction == export ]]; then
                printf '\n  Enter your actual values so they can be sanitized in the repo:\n\n'
            else
                printf '\n  Enter values to fill the placeholders in the config files:\n\n'
            fi
        fi

        defval=''
        if [[ -n ${USER_VALUES[$placeholder]:-} ]]; then
            defval=${USER_VALUES[$placeholder]}
        elif [[ -n $rule_default ]]; then
            defval=$rule_default
        elif [[ -n $rule_defenv && -n ${!rule_defenv:-} ]]; then
            defval=${!rule_defenv}
        fi

        if [[ -n $defval ]]; then
            printf '  %s [%s]: ' "$prompt" "$defval"
        else
            printf '  %s: ' "$prompt"
        fi
        input=''
        # Empty input takes the default; read may also fail on EOF.
        read -r input || input=''
        if [[ -z $input ]]; then
            input=$defval
        fi
        if [[ -n $input ]]; then
            USER_VALUES[$placeholder]=$input
        elif [[ ! -t 0 ]]; then
            printf 'missing value for %s: add it to .user-values.json\n' "$placeholder" >&2
            exit 1
        fi
    done 4< <(jq -j '.[] | .placeholder, "\u0000", (.prompt // ""), "\u0000",
                          (.default // "" | tostring), "\u0000", (.defaultEnv // ""), "\u0000"' <<<"$rules")

    if (( header_printed )); then
        printf '\n'
    fi
}

# -- Sanitize (values -> placeholders) / hydrate (placeholders -> values) ------

# Placeholders (from the rules) that have a cached value, longest value first, one per line.
# Values come straight from USER_VALUES, never through jq text output, so they stay byte-exact.
_placeholders_by_length() {
    local rules=$1 ph
    while IFS= read -r ph; do
        if [[ -n $ph && -n ${USER_VALUES[$ph]:-} ]]; then
            printf '%d\t%s\n' "${#USER_VALUES[$ph]}" "$ph"
        fi
    done < <(jq -r '.[].placeholder' <<<"$rules") | sort -rn | uniq | cut -f2-
}

sanitize() {
    local c=$1 rules=$2 ph
    # Longest value first, so a value that contains a shorter one is replaced whole.
    while IFS= read -r ph; do
        c=${c//"${USER_VALUES[$ph]}"/"$ph"}
    done < <(_placeholders_by_length "$rules")
    printf '%s' "$c"
}

hydrate() {
    local c=$1 rules=$2 ph
    while IFS= read -r ph; do
        c=${c//"$ph"/"${USER_VALUES[$ph]}"}
    done < <(_placeholders_by_length "$rules")
    printf '%s' "$c"
}

# -- Comparison ----------------------------------------------------------------

same_normalized() {
    local a=$1 b=$2
    a=${a//$'\r'/}
    b=${b//$'\r'/}
    a=${a%%+([[:space:]])}
    b=${b%%+([[:space:]])}
    [[ $a == "$b" ]]
}

# -- Status output --------------------------------------------------------------

status() {
    # usage: status <STATUS> <label> [note]
    local s=$1 label=$2 note=${3:-}
    printf '  %-10s %s%s\n' "$s" "$label" "${note:+  ($note)}"
}

# -- Text I/O helpers ------------------------------------------------------------

# Read a file's full text as-is into $1 (name of variable), keeping trailing newlines.
read_text() {
    local text
    if text=$(cat "$2" && printf x); then
        printf -v "$1" '%s' "${text%x}"
        return 0
    fi
    return 1
}

# Write text as-is (trailing newlines preserved). $1=variable name, $2=destination file.
write_text() {
    printf '%s' "${!1}" > "$2"
}
