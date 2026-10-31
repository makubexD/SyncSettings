#!/usr/bin/env bash
# Scan files for personal paths, addresses and secrets.
# Prints "<file>:<line>: <rule>" per hit and never the matched text, so a leak
# does not end up in CI logs. Exits 1 on any hit, 0 when clean.
# Usage: scripts/ci/leak-scan.sh [path...]
# Default paths: dotfiles, sync-config.json and packages/ when it exists.
set -euo pipefail

if (( $# > 0 )); then
    PATHS=("$@")
else
    PATHS=(dotfiles sync-config.json)
    if [[ -d packages ]]; then
        PATHS+=(packages)
    fi
fi

for path in "${PATHS[@]}"; do
    if [[ ! -e $path ]]; then
        printf 'ERROR: no such file or directory: %s\n' "$path" >&2
        exit 2
    fi
done

HITS=0

# Print one hit as "<file>:<line>: <rule>" and count it.
emit() {
    local rule=$1 hit=$2
    local file=${hit%%:*}
    local rest=${hit#*:}
    local lineno=${rest%%:*}
    printf '%s:%s: %s\n' "$file" "$lineno" "$rule"
    HITS=$(( HITS + 1 ))
}

# scan_rule <rule> <pattern>: one grep pass, one line per matching file line.
scan_rule() {
    local rule=$1 pattern=$2
    local out status=0 hit
    out=$(grep -rnIE -- "$pattern" "${PATHS[@]}") || status=$?
    if (( status > 1 )); then
        printf 'ERROR: scan failed for rule %s\n' "$rule" >&2
        exit 2
    fi
    [[ -n $out ]] || return 0
    while IFS= read -r hit; do
        emit "$rule" "$hit"
    done <<<"$out"
}

# scan_email <pattern>: report a line unless every address on it is allowed.
# One disallowed address is enough, even when the line also has an allowed one.
scan_email() {
    local pattern=$1
    local out status=0 hit file rest addr text bad
    out=$(grep -rnIE -- "$pattern" "${PATHS[@]}") || status=$?
    if (( status > 1 )); then
        printf 'ERROR: scan failed for rule email\n' >&2
        exit 2
    fi
    [[ -n $out ]] || return 0
    while IFS= read -r hit; do
        file=${hit%%:*}
        rest=${hit#*:}
        text=${rest#*:}
        # Extension UUIDs look like addresses; only these two keys hold them.
        if [[ $file == *dotfiles/linux/gnome/dconf/*.ini && $text =~ ^(enabled|disabled)-extensions= ]]; then
            continue
        fi
        bad=0
        while [[ $text =~ $pattern ]]; do
            addr=${BASH_REMATCH[0],,}
            if [[ $addr != *@users.noreply.github.com && $addr != *@example.com && $addr != *@anthropic.com ]]; then
                bad=1
                break
            fi
            text=${text#*"${BASH_REMATCH[0]}"}
        done
        if (( bad )); then
            emit email "$hit"
        fi
    done <<<"$out"
}

scan_rule home-path '/home/[a-z_][a-z0-9_-]*'
scan_rule windows-profile '[A-Za-z]:\\+Users\\+[^<%\\"]+'
scan_email '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
scan_rule private-key '-----BEGIN [A-Z ]*PRIVATE KEY-----'
scan_rule github-token 'gh[pousr]_[A-Za-z0-9]{30,}'
scan_rule api-key 'sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}'

if (( HITS > 0 )); then
    exit 1
fi
exit 0
