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

# Check case.json before anything is copied or run. Dies with a short reason;
# the caller runs this in a subshell so only that case FAILs.
validate_case() {
    local dir=$1 json=$1/case.json
    [[ -f $json ]] || die 'case.json is missing'
    jq -e 'type == "object"' "$json" > /dev/null 2>&1 \
        || die 'case.json is not a JSON object'
    jq -e '(.commands | type) == "array" and (.commands | length) > 0' "$json" > /dev/null 2>&1 \
        || die 'commands must be a non-empty array'
    jq -e 'all(.commands[]; (. | type) == "object" and (.command | type) == "string")' "$json" > /dev/null 2>&1 \
        || die 'every command must be an object with a string command'
    jq -e 'all(.commands[]; if has("options") then (.options | type) == "object" else true end)' "$json" > /dev/null 2>&1 \
        || die 'options must be an object'
    jq -e 'all(.commands[]; (.options // {}) as $o
        | if ($o | has("force")) then ($o.force | type) == "boolean" else true end)' "$json" > /dev/null 2>&1 \
        || die 'options.force must be a boolean'
    jq -e 'all(.commands[]; (.options // {}) as $o
        | if ($o | has("only")) then
            if ($o.only | type) == "array" then all($o.only[]; type == "string") else false end
          else true end)' "$json" > /dev/null 2>&1 \
        || die 'options.only must be an array of strings'
    jq -e 'if has("os") then
            if (.os | type) == "array" then
                all(.os[]; . == "linux" or . == "macos" or . == "windows")
            else false end
          else true end' "$json" > /dev/null 2>&1 \
        || die 'os must be a list of linux, macos or windows'
    jq -e 'all(.commands[]; if has("stdin") then (.stdin | type) == "string" else true end)' "$json" > /dev/null 2>&1 \
        || die 'stdin must be a string'
    jq -e 'if has("git") then (.git == "none" or .git == "committed" or .git == "remote") else true end' "$json" > /dev/null 2>&1 \
        || die 'git must be none, committed or remote'
    jq -e 'if has("stubs") then
            (.stubs | type) == "array" and all(.stubs[]; . == "gh")
          else true end' "$json" > /dev/null 2>&1 \
        || die 'stubs may only hold gh'
    local name suffix os_folder=0 has_differences=false
    for name in "$dir"/expect.*; do
        [[ -d $name ]] || continue
        suffix=${name##*/expect.}
        case $suffix in
            linux|macos|windows) os_folder=1 ;;
            *) die "expect.$suffix: unknown OS folder" ;;
        esac
    done
    if jq -e 'has("differences")' "$json" > /dev/null 2>&1; then
        has_differences=true
    fi
    if (( os_folder )); then
        jq -e '(.differences | type) == "array" and (.differences | length) > 0
            and all(.differences[]; type == "string")' "$json" > /dev/null 2>&1 \
            || die 'differences must name the Known differences rows for expect.<os>/'
    fi
    if [[ $has_differences == true ]] && (( ! os_folder )); then
        die 'differences set but no expect.<os>/ folder'
    fi
    [[ ! -d $dir/repo/packages ]] \
        || die 'packages/ needs the drift stubs from phase 2'
}

# The expected file or tree for $2: `expect.<os>/<name>` when it exists for the
# OS the runner is on, else `expect/<name>`.
expected_path() {
    local dir=$1 name=$2
    if [[ -e $dir/expect.$HARNESS_OS/$name ]]; then
        printf '%s\n' "$dir/expect.$HARNESS_OS/$name"
    else
        printf '%s\n' "$dir/expect/$name"
    fi
}

# The status lines of a command's output, each as `WORD label`: ANSI color codes
# removed, notes and every other line dropped (see the README's "How the runner
# checks it").
status_lines() {
    # A prompt answered from a pipe ends with no newline, so its status line
    # follows it on the same line: drop the `…? [Y/n]` prefix first.
    sed "s/${ESC}\[[0-9;]*[A-Za-z]//g" "$1" \
        | sed -E 's/^.*\? \[[Yy]\/[Nn]\][[:space:]]*//' \
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
        die "$what line $((n + 1)): want \"$w\", got \"$g\""
    done
    return 0
}

# The first line that makes `diff -rq` report a difference; empty when the
# trees match. The case and temp folder prefixes are trimmed so the line names
# the file from the case's point of view.
tree_diff() {
    local want_dir=$1 got_dir=$2 line case_root temp_root
    line=$(diff -rq -x .git "$want_dir" "$got_dir" 2>&1 | head -n 1) || true
    [[ -n $line ]] || return 0
    case_root=${dir%/}
    temp_root=${t%/}
    printf '%s\n' "$line" | sed "s|$case_root/||g; s|$temp_root/||g"
}

# Remove the engine files copied into the temp repo, so the repo comparison
# sees only the case's own files. `scripts` goes too when nothing is left in it.
strip_engine() {
    local repo=$1
    rm -f "$repo/export.sh" "$repo/import.sh" "$repo/commit.sh" "$repo/sync" \
        "$repo/sync-config.json" "$repo/.user-values.json"
    rm -rf "$repo/scripts/linux" "$repo/scripts/ci"
    rmdir "$repo/scripts" 2> /dev/null || true
}

# The permission bits of a file: GNU and BSD `stat` spell the option differently.
file_mode() {
    if [[ $HARNESS_OS == macos ]]; then
        stat -f %Lp "$1"
    else
        stat -c %a "$1"
    fi
}

# Compare the mode of every file in the wanted tree with the one in the got
# tree. The content diff has already shown the file lists match, so walking
# `want` covers both sides.
compare_modes() {
    local want_dir=$1 got_dir=$2 rel want_mode got_mode
    while IFS= read -r -d '' rel; do
        rel=${rel#./}
        want_mode=$(file_mode "$want_dir/$rel") || die "mode $rel: cannot read the wanted file"
        got_mode=$(file_mode "$got_dir/$rel") || die "mode $rel: cannot read the got file"
        [[ $want_mode == "$got_mode" ]] || die "mode $rel: want $want_mode, got $got_mode"
    done < <(cd "$want_dir" && find . -type f -print0)
}

# git with the user's own configuration kept out of the case.
git_env() {
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git "$@"
}

# Put the case's temp repo under git: everything committed on master, and for
# `remote` also a bare origin at $temp/origin.git that master tracks.
setup_git() {
    local repo=$1 temp=$2 mode=$3
    git_env -C "$repo" init -q -b master || die 'git init failed'
    git_env -C "$repo" config user.name Parity || die 'git config user.name failed'
    git_env -C "$repo" config user.email parity@example.com || die 'git config user.email failed'
    git_env -C "$repo" config commit.gpgsign false || die 'git config commit.gpgsign failed'
    printf '.user-values.json\n' >> "$repo/.git/info/exclude" || die 'writing .git/info/exclude failed'
    git_env -C "$repo" add -A || die 'git add failed'
    git_env -C "$repo" commit -q -m 'parity case' || die 'git commit failed'
    if [[ $mode == remote ]]; then
        git_env init -q --bare -b master "$temp/origin.git" || die 'git init of origin failed'
        git_env -C "$repo" remote add origin "$temp/origin.git" || die 'git remote add failed'
        git_env -C "$repo" push -q -u origin master || die 'git push failed'
    fi
}

# Write the gh stub into $temp/bin: it appends its arguments joined by spaces,
# one call per line, to $temp/gh.log, prints nothing and exits 0.
write_gh_stub() {
    local temp=$1
    mkdir -p "$temp/bin" || die 'creating the gh stub folder failed'
    printf '%s\n' \
        '#!/bin/sh' \
        "printf '%s\\n' \"\$*\" >> '$temp/gh.log'" \
        'exit 0' > "$temp/bin/gh" || die 'writing the gh stub failed'
    chmod +x "$temp/bin/gh" || die 'making the gh stub executable failed'
}

# -- One case ------------------------------------------------------------------

# Runs one case in a fresh throwaway folder, prints the first difference and
# exits 1 from the subshell on a failure. Called in a command substitution, so
# the EXIT trap removes the temp folder on success and failure alike.
run_case() {
    local dir=$1
    local config_json count i cmd rc only_path out stdin_file git_mode gh_stub=false
    local want_exit want_output want_home want_repo want_values want_state want_gh calls
    local file rel got want_mode got_mode
    local -a args=() runs=() path_env=()

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

    git_mode=$(jq -r '.git // "none"' "$dir/case.json") || die 'case.json has no git'
    case $git_mode in
        none) ;;
        committed|remote) setup_git "$t/repo" "$t" "$git_mode" ;;
        *) die 'git must be none, committed or remote' ;;
    esac

    if jq -e '(.stubs // []) | any(. == "gh")' "$dir/case.json" > /dev/null 2>&1; then
        gh_stub=true
        write_gh_stub "$t"
        path_env=(PATH="$t/bin:$PATH")
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
            diff) args=(./export.sh --diff) ;;
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

        stdin_file=/dev/null
        if [[ $(jq -r ".commands[$i] | has(\"stdin\")" "$dir/case.json") == true ]]; then
            stdin_file=$t/stdin
            jq -j ".commands[$i].stdin" "$dir/case.json" > "$stdin_file" \
                || die "writing stdin for command $((i + 1)) failed"
        fi

        rc=0
        (cd "$t/repo" && HOME="$t/home" env -u XDG_STATE_HOME -u XDG_CONFIG_HOME \
            "${path_env[@]}" "${args[@]}" < "$stdin_file") > "$t/raw" 2>&1 || rc=$?
        printf '%s\n' "$rc" >> "$t/actual-exit"
        status_lines "$t/raw" >> "$t/actual-output"
    done

    # Each gh call is cut to its first two words, so branch names and titles
    # don't matter. No expected file means gh must not be called.
    if $gh_stub; then
        want_gh=$(expected_path "$dir" gh.log)
        : > "$t/gh-cut"
        if [[ -f $t/gh.log ]]; then
            awk '{ print $1 (NF > 1 ? " " $2 : "") }' "$t/gh.log" > "$t/gh-cut" \
                || die 'reading gh.log failed'
        fi
        if [[ -f $want_gh ]]; then
            first_line_diff gh "$want_gh" "$t/gh-cut"
        else
            calls=$(head -n 1 "$t/gh-cut")
            [[ -z $calls ]] || die "gh: want no call, got \"$calls\""
        fi
    fi

    # The repo's values cache is compared as JSON, key order ignored, before
    # the engine files are stripped from the repo.
    want_values=$(expected_path "$dir" values.json)
    if [[ -e $want_values ]]; then
        [[ -f $t/repo/.user-values.json ]] || die 'values.json: .user-values.json is missing'
        jq -S . "$want_values" > "$t/want-values.json" 2> /dev/null \
            || die 'values.json: expect is not valid JSON'
        jq -S . "$t/repo/.user-values.json" > "$t/got-values.json" 2> /dev/null \
            || die 'values.json: .user-values.json is not valid JSON'
        cmp -s "$t/want-values.json" "$t/got-values.json" || die 'values.json: differs from expect'
    fi

    # The engine's own state folder is not part of the case: take the copy the
    # case expects, then drop it before the home tree is compared.
    want_state=$(expected_path "$dir" state)
    if [[ -d $want_state ]]; then
        [[ -d $t/home/.local/state/sync-settings ]] || die 'state: engine state folder is missing'
        cp -a "$t/home/.local/state/sync-settings" "$t/state" \
            || die 'state: copying the engine state folder failed'
        while IFS= read -r -d '' rel; do
            runs+=("$rel")
        done < <(find "$t/state/backups" -mindepth 1 -maxdepth 1 -type d -print0 2> /dev/null)
        if (( ${#runs[@]} > 0 )); then
            (( ${#runs[@]} == 1 )) || die "state: want one backup run folder, got ${#runs[@]}"
            mv "${runs[0]}" "$t/state/backups/RUN" || die 'state: renaming the backup run folder failed'
        fi
    fi
    rm -rf "$t/home/.local/state/sync-settings"
    rmdir "$t/home/.local/state" 2> /dev/null || true
    rmdir "$t/home/.local" 2> /dev/null || true

    if [[ -d $want_state ]]; then
        while IFS= read -r -d '' file; do
            rel=${file#"$want_state"/}
            got=$t/state/$rel
            [[ -f $got ]] || die "state $rel: missing"
            cmp -s "$file" "$got" || die "state $rel: differs"
            want_mode=$(file_mode "$file") || die "state $rel: cannot read the wanted file"
            got_mode=$(file_mode "$got") || die "state $rel: cannot read the got file"
            [[ $want_mode == "$got_mode" ]] || die "state $rel mode: want $want_mode, got $got_mode"
        done < <(find "$want_state" -type f -print0)
    fi

    want_exit=$(expected_path "$dir" exit)
    want_output=$(expected_path "$dir" output.txt)
    first_line_diff exit "$want_exit" "$t/actual-exit"
    first_line_diff output "$want_output" "$t/actual-output"

    want_home=$(expected_path "$dir" home)
    if [[ -d $want_home ]]; then
        out=$(tree_diff "$want_home" "$t/home") || true
        [[ -z $out ]] || die "$out"
        compare_modes "$want_home" "$t/home"
    else
        out=$(tree_diff "$t/empty" "$t/home") || true
        [[ -z $out ]] || die "$out"
        compare_modes "$t/empty" "$t/home"
    fi

    strip_engine "$t/repo"
    want_repo=$(expected_path "$dir" repo)
    if [[ -d $want_repo ]]; then
        out=$(tree_diff "$want_repo" "$t/repo") || true
        [[ -z $out ]] || die "$out"
        compare_modes "$want_repo" "$t/repo"
    else
        out=$(tree_diff "$t/empty" "$t/repo") || true
        [[ -z $out ]] || die "$out"
        compare_modes "$t/empty" "$t/repo"
    fi

    return 0
}

# -- Runner --------------------------------------------------------------------

matched=0
for dir in "$CASES"/*/; do
    [[ -d $dir ]] || continue
    dir=${dir%/}
    case_name=${dir##*/}

    if [[ -n $filter && $case_name != *"$filter"* ]]; then
        continue
    fi
    matched=$((matched + 1))

    if ! reason=$(validate_case "$dir"); then
        printf 'FAIL %s: %s\n' "$case_name" "${reason:-invalid case.json}"
        failed_cases=$((failed_cases + 1))
        continue
    fi

    if [[ $(jq -r 'has("os")' "$dir/case.json") == true ]]; then
        # shellcheck disable=SC2016  # $os is a jq argument, not a shell variable
        if ! jq -e --arg os "$HARNESS_OS" 'any(.os[]; . == $os)' "$dir/case.json" > /dev/null; then
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

if [[ -n $filter && $matched -eq 0 ]]; then
    printf 'no case matches %s\n' "$filter"
    exit 1
fi

printf '%d passed, %d failed\n' "$passed" "$failed_cases"

[[ $failed_cases -eq 0 ]]
