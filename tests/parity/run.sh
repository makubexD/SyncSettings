#!/usr/bin/env bash
# Shared parity cases: run every case in tests/parity/cases/ against the bash
# engine in a throwaway HOME and repo, then compare exit codes, status lines
# and both trees with expect/. The case format is tests/parity/README.md.
# Usage: tests/parity/run.sh [case-name-filter]

set -euo pipefail

SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$SOURCE_DIR/../.." && pwd)
CASES=${PARITY_CASES:-$REPO/tests/parity/cases}

filter=${1:-}
passed=0
failed_cases=0
case_name=''
t=''

# The OS a case runs for, resolved exactly as the engine does.
# shellcheck source-path=SCRIPTDIR source=../../scripts/linux/os.sh
source "$REPO/scripts/linux/os.sh"
HARNESS_OS=$(sync_os)
readonly HARNESS_OS

# Status words the engines print. Longer words first so CREATED and UPDATED win
# over CREATE and UPDATE in the alternation.
STATUS_WORDS='ADDED|UNCHANGED|MODIFIED|SKIPPED|REMOVED|ERROR|CREATED|UPDATED|EXTRA|ORPHAN|DRIFT|CREATE|UPDATE'
ESC=$(printf '\033')

# -- Helpers -------------------------------------------------------------------

die() {
    printf '%s\n' "$*"
    exit 1
}

# The status lines of a command's output, each as `WORD label`: ANSI color codes
# removed, notes and every other line dropped (see the README's "How the runner
# checks it").
status_lines() {
    sed "s/${ESC}\[[0-9;]*[A-Za-z]//g" "$1" \
        | sed -nE "s/^[[:space:]]*\[?[[:space:]]*($STATUS_WORDS)[[:space:]]*\]?[[:space:]]+([^[:space:]]+).*/\1 \2/p"
}

# Compare two line files, one line per command or per status line. $1 is the
# name `exit` or `output`, $2 the wanted file, $3 the got file; a missing wanted
# file means nothing was expected.
first_line_diff() {
    local what=$1 want_file=$2 got_file=$3
    local -a want_lines=() got_lines=()
    local n w g count
    if [[ -f $want_file ]]; then
        mapfile -t want_lines < "$want_file"
    fi
    mapfile -t got_lines < "$got_file"
    count=${#want_lines[@]}
    if (( ${#got_lines[@]} > count )); then
        count=${#got_lines[@]}
    fi
    for ((n = 0; n < count; n++)); do
        w=${want_lines[n]:-}
        g=${got_lines[n]:-}
        [[ $w == "$g" ]] && continue
        if (( n >= ${#got_lines[@]} )); then
            die "$what line $((n + 1)): want \"$w\", got nothing"
        fi
        if (( n >= ${#want_lines[@]} )); then
            die "$what line $((n + 1)): want nothing, got \"$g\""
        fi
        if [[ $what == exit && ${#want_lines[@]} -eq 1 && ${#got_lines[@]} -eq 1 ]]; then
            die "exit: want $w, got $g"
        fi
        if [[ $what == exit ]]; then
            die "exit line $((n + 1)): want $w, got $g"
        fi
        die "output line $((n + 1)): want \"$w\", got \"$g\""
    done
    return 0
}

# The first line that makes `diff -r` report a difference; empty when the trees
# match.
tree_diff() {
    local want_dir=$1 got_dir=$2
    shift 2
    local out
    out=$(diff -r "$@" "$want_dir" "$got_dir" 2>&1) || true
    if [[ -n $out ]]; then
        printf '%s\n' "$out" | head -n 1
    fi
}

# -- One case ------------------------------------------------------------------

# Runs one case in a fresh throwaway folder, prints the first difference and
# exits 1 from the subshell on a failure. Called in a command substitution, so
# the EXIT trap removes the temp folder on success and failure alike.
run_case() {
    local dir=$1
    local config_json count i cmd rc only_path out
    local -a args=()

    t=$(mktemp -d)
    trap 'rm -rf "$t"' EXIT

    config_json=$(jq -c '.config' "$dir/case.json") || die 'case.json has no config'
    count=$(jq -r '.commands | length' "$dir/case.json") || die 'case.json has no commands list'

    mkdir -p "$t/repo" "$t/home" "$t/repo/scripts" "$t/empty"
    cp -a "$REPO/export.sh" "$REPO/import.sh" "$REPO/commit.sh" "$REPO/sync" "$t/repo/" \
        || die 'copying the engine failed'
    cp -a "$REPO/scripts/linux" "$REPO/scripts/ci" "$t/repo/scripts/" \
        || die 'copying scripts/ failed'
    printf '%s\n' "$config_json" > "$t/repo/sync-config.json"
    if [[ $(jq -r 'has("values")' "$dir/case.json") == true ]]; then
        jq -c '.values' "$dir/case.json" > "$t/repo/.user-values.json" \
            || die 'writing .user-values.json failed'
    fi
    if [[ -d $dir/repo ]]; then
        cp -a "$dir/repo/." "$t/repo/" || die 'copying the case repo/ failed'
    fi
    if [[ -d $dir/home ]]; then
        cp -a "$dir/home/." "$t/home/" || die 'copying the case home/ failed'
    fi

    : > "$t/actual-exit"
    : > "$t/actual-output"
    for ((i = 0; i < count; i++)); do
        cmd=$(jq -r ".commands[$i].command // empty" "$dir/case.json")
        args=()
        case $cmd in
            export) args=(./export.sh) ;;
            import) args=(./import.sh) ;;
            check) args=(./import.sh --check) ;;
            preview) args=(./export.sh --preview) ;;
            commit) args=(./commit.sh) ;;
            *) die "unknown command '$cmd' in command $((i + 1))" ;;
        esac
        while IFS= read -r key; do
            case $key in
                force|only) ;;
                *) die "unknown option '$key' in command $((i + 1))" ;;
            esac
        done < <(jq -r ".commands[$i].options // {} | keys[]" "$dir/case.json")
        if [[ $(jq -r ".commands[$i].options.force // false" "$dir/case.json") == true ]]; then
            args+=(--force)
        fi
        while IFS= read -r -d '' only_path; do
            args+=(--only "$only_path")
        done < <(jq -j ".commands[$i].options.only // [] | .[] | . , \"\\u0000\"" "$dir/case.json")

        rc=0
        (cd "$t/repo" && HOME="$t/home" env -u XDG_STATE_HOME -u XDG_CONFIG_HOME \
            "${args[@]}" < /dev/null) > "$t/raw" 2>&1 || rc=$?
        printf '%s\n' "$rc" >> "$t/actual-exit"
        status_lines "$t/raw" >> "$t/actual-output"
    done

    # The engine's own state folder is not part of the case: drop it before the
    # home tree is compared.
    rm -rf "$t/home/.local/state/sync-settings"
    rmdir "$t/home/.local/state" 2> /dev/null || true
    rmdir "$t/home/.local" 2> /dev/null || true

    first_line_diff exit "$dir/expect/exit" "$t/actual-exit"
    first_line_diff output "$dir/expect/output.txt" "$t/actual-output"

    if [[ -d $dir/expect/home ]]; then
        out=$(tree_diff "$dir/expect/home" "$t/home") || true
    else
        out=$(tree_diff "$t/empty" "$t/home") || true
    fi
    [[ -z $out ]] || die "$out"

    if [[ -d $dir/expect/repo ]]; then
        out=$(tree_diff "$dir/expect/repo" "$t/repo" \
            -x sync-config.json -x .user-values.json \
            -x export.sh -x import.sh -x commit.sh -x sync -x scripts) || true
    else
        out=$(tree_diff "$t/empty" "$t/repo" \
            -x sync-config.json -x .user-values.json \
            -x export.sh -x import.sh -x commit.sh -x sync -x scripts) || true
    fi
    [[ -z $out ]] || die "$out"

    return 0
}

# -- Runner --------------------------------------------------------------------

for dir in "$CASES"/*/; do
    [[ -d $dir ]] || continue
    case_name=${dir%/}
    case_name=${case_name##*/}

    if [[ -n $filter && $case_name != *"$filter"* ]]; then
        continue
    fi

    if [[ -f $dir/case.json ]] && [[ $(jq -r 'has("os")' "$dir/case.json") == true ]]; then
        # shellcheck disable=SC2016  # $os is a jq argument, not a shell variable
        if ! jq -e --arg os "$HARNESS_OS" '.os | index($os)' "$dir/case.json" > /dev/null; then
            printf 'skip %s\n' "$case_name"
            continue
        fi
    fi

    if reason=$(run_case "$dir"); then
        printf 'ok %s\n' "$case_name"
        passed=$((passed + 1))
    else
        printf 'FAIL %s: %s\n' "$case_name" "${reason:-unknown failure}"
        failed_cases=$((failed_cases + 1))
    fi
done

printf '%d passed, %d failed\n' "$passed" "$failed_cases"

[[ $failed_cases -eq 0 ]]
