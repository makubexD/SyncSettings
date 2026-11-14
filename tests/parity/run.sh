#!/usr/bin/env bash
# Shared parity cases: run every case in tests/parity/cases/ against the bash
# engine in a throwaway HOME and repo, then compare exit codes, status lines
# and both trees with expect/. The case format is tests/parity/README.md.
# Usage: tests/parity/run.sh [--engine <path>] [case-name-filter]

set -euo pipefail

SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$SOURCE_DIR/../.." && pwd)
CASES=${PARITY_CASES:-$REPO/tests/parity/cases}

filter=''
engine_path=''
passed=0
failed_cases=0
skipped=0
case_name=''
t=''

# The OS a case runs for, resolved exactly as the engine does.
# shellcheck source-path=SCRIPTDIR source=../../scripts/linux/os.sh
source "$REPO/scripts/linux/os.sh"
HARNESS_OS=$(sync_os)
readonly HARNESS_OS

# Status words the engines print. Longer words first so CREATED and UPDATED win
# over CREATE and UPDATE in the alternation. IN, OUT, BOTH and ? are diff labels.
STATUS_WORDS='ADDED|UNCHANGED|MODIFIED|SKIPPED|REMOVED|ERROR|CREATED|UPDATED|EXTRA|ORPHAN|DRIFT|CREATE|UPDATE|IN|OUT|BOTH|\?'
ESC=$(printf '\033')
CR=$(printf '\r')

# -- Helpers -------------------------------------------------------------------

die() {
    printf '%s\n' "$*"
    exit 1
}

# --engine <path> hands the cases to that one program instead of the bash
# engine; without it the runner is unchanged. The rest is the case filter.
while (( $# > 0 )); do
    case $1 in
        --engine)
            [[ $# -ge 2 ]] || die '--engine needs a path'
            engine_path=$2
            shift 2
            ;;
        --engine=*)
            engine_path=${1#--engine=}
            shift
            ;;
        *)
            [[ -z $filter ]] || die "unknown argument '$1'"
            filter=$1
            shift
            ;;
    esac
done

if [[ -n $engine_path ]]; then
    [[ -f $engine_path ]] || die "--engine: $engine_path is not a file"
    engine_path=$(cd "$(dirname "$engine_path")" && pwd)/$(basename "$engine_path")
fi

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
    jq -e 'all(.commands[]; (.options // {}) as $o
        | all($o | to_entries[] | select(.key == "name" or .key == "profile" or .key == "replace"
            or .key == "claude" or .key == "mode" or .key == "existing" or .key == "target");
            .value | type == "string"))' "$json" > /dev/null 2>&1 \
        || die 'options name, profile, replace, claude, mode, existing and target must be strings'
    jq -e 'all(.commands[]; (.options // {}) as $o
        | if ($o | has("yes")) then ($o.yes | type) == "boolean" else true end)' "$json" \
        > /dev/null 2>&1 || die 'options.yes must be a boolean'
    jq -e 'all(.commands[];
        .command as $cmd
        | (.options // {}) as $o
        | (if ($o | has("name")) then $cmd == "setup" else true end)
          and (if ($o | has("profile")) then $cmd == "setup" else true end)
          and (if ($o | has("replace")) then $cmd == "setup" else true end)
          and (if ($o | has("claude")) then $cmd == "setup" else true end)
          and (if ($o | has("mode")) then $cmd == "setup" else true end)
          and (if ($o | has("existing")) then $cmd == "setup" else true end)
          and (if ($o | has("yes")) then
                  $cmd == "setup" or $cmd == "export" or $cmd == "preview"
                  or $cmd == "machine-retire" or $cmd == "profile-retire"
               else true end))' "$json" > /dev/null 2>&1 \
        || die 'options name, profile, replace, claude, mode and existing need setup; yes needs setup, export, preview, machine-retire or profile-retire'
    jq -e 'all(.commands[];
        .command as $cmd | (.options // {}) as $o
        | if ($cmd == "machine-retire" or $cmd == "profile-retire") then
              ($o | has("target"))
          else (($o | has("target")) | not) end)' "$json" > /dev/null 2>&1 \
        || die 'options.target is required for machine-retire and profile-retire, and nowhere else'
    jq -e 'if has("os") then
            if (.os | type) == "array" then
                all(.os[]; . == "linux" or . == "macos" or . == "windows")
            else false end
          else true end' "$json" > /dev/null 2>&1 \
        || die 'os must be a list of linux, macos or windows'
    jq -e 'all(.commands[]; if has("stdin") then (.stdin | type) == "string" else true end)' "$json" > /dev/null 2>&1 \
        || die 'stdin must be a string'
    jq -e 'all(.commands[]; if has("stderr") then (.stderr | type) == "boolean" else true end)' "$json" > /dev/null 2>&1 \
        || die 'stderr must be a boolean'
    jq -e 'all(.commands[]; if has("output") then .output == "all" else true end)' "$json" > /dev/null 2>&1 \
        || die 'output must be "all"'
    jq -e 'if has("env") then
            (.env | type) == "object" and all(.env[]; type == "string" or . == null)
          else true end' "$json" > /dev/null 2>&1 \
        || die 'env must be an object of strings or null'
    if jq -e 'has("configV2")' "$json" > /dev/null 2>&1; then
        jq -e '(.env // {}) | all(keys[];
                . == "SYNC_PROFILE" or . == "SYNC_MACHINE" or . == "SYNC_HOSTNAME" or . == "SYNC_DOMAIN"
                or . == "SYNC_TOOLS" or . == "MKSYNC_VISIBILITY" or . == "SYNC_NOW" or . == "SYNC_LOAD"
                or . == "SYNC_MEM" or . == "SYNC_GIT" or . == "CONTEXT_CLEAR_AT" or . == "CTX_WINDOW_DIR")' \
            "$json" > /dev/null 2>&1 \
            || die 'a configV2 case may set only SYNC_PROFILE, SYNC_MACHINE, SYNC_HOSTNAME, SYNC_DOMAIN, SYNC_TOOLS, MKSYNC_VISIBILITY, SYNC_NOW, SYNC_LOAD, SYNC_MEM, SYNC_GIT, CONTEXT_CLEAR_AT and CTX_WINDOW_DIR in env'
        jq -e '(.env // {}) as $e
            | if ($e | has("CTX_WINDOW_DIR")) and $e.CTX_WINDOW_DIR != null then
                  if ($e.CTX_WINDOW_DIR | type) == "string" then
                      (($e.CTX_WINDOW_DIR | test("^(/|[A-Za-z]:|\\\\)")) | not)
                      and (($e.CTX_WINDOW_DIR | test("(^|[/\\\\])\\.\\.([/\\\\]|$)")) | not)
                  else false end
              else true end' "$json" > /dev/null 2>&1 \
            || die 'CTX_WINDOW_DIR must be a relative path under home'
    fi
    jq -e 'if has("git") then (.git == "none" or .git == "committed" or .git == "remote") else true end' "$json" > /dev/null 2>&1 \
        || die 'git must be none, committed or remote'
    jq -e 'if has("stubs") then
            (.stubs | type) == "array" and all(.stubs[]; . == "gh")
          else true end' "$json" > /dev/null 2>&1 \
        || die 'stubs may only hold gh'
    if jq -e 'has("config") and has("configV2")' "$json" > /dev/null 2>&1; then
        die 'case.json has both config and configV2'
    fi
    if ! jq -e 'has("config") or has("configV2")' "$json" > /dev/null 2>&1; then
        die 'case.json has no config'
    fi
    jq -e 'if has("config") then (.config | type) == "object" else (.configV2 | type) == "object" end' \
        "$json" > /dev/null 2>&1 || die 'config must be an object'
    # commit reaches gh; only the stub may answer, never a real gh.
    jq -e '(any(.commands[]; .command == "commit") | not) or ((.stubs // []) | any(. == "gh"))' \
        "$json" > /dev/null 2>&1 || die 'a commit command needs "stubs": ["gh"]'
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

# With --engine, expect.<os>/ only applies to a case whose differences name a
# row the program keeps per OS; every other case uses expect/ on every OS.
expected_os_folder() {
    local dir=$1
    [[ -z $engine_path ]] && return 0
    jq -e '(.differences // []) | any(
        . == "Entry selection" or . == "Shared files without rules" or . == "Exclude patterns")' \
        "$dir/case.json" > /dev/null 2>&1
}

# The expected file or tree for $2: `expect.<os>/<name>` when it exists for the
# OS the runner is on, else `expect/<name>`.
expected_path() {
    local dir=$1 name=$2
    if expected_os_folder "$dir" && [[ -e $dir/expect.$HARNESS_OS/$name ]]; then
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

# Every line of a command's whole stdout, in order: ANSI color codes removed,
# a trailing carriage return dropped, a final line without a newline kept. An
# empty stdout adds no line (see the README's "How the runner checks it").
# A second argument `keep-ansi` keeps the color codes, for statusline.
whole_output() {
    local keep_ansi=${2:-false}
    if [[ $keep_ansi == true ]]; then
        sed "s/${CR}\$//" "$1"
    else
        sed "s/${ESC}\[[0-9;]*[A-Za-z]//g" "$1" | sed "s/${CR}\$//"
    fi | while IFS= read -r line || [[ -n $line ]]; do
        printf '%s\n' "$line"
    done
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
        "$repo/mksync" "$repo/sync-config.json" "$repo/sync-config.v2.json" "$repo/.user-values.json"
    rm -rf "$repo/scripts/linux" "$repo/scripts/ci"
    rmdir "$repo/scripts" 2> /dev/null || true
}

# The permission bits of a file: GNU and BSD `stat` spell the option differently.
file_mode() {
    # The host's stat, not HARNESS_OS: SYNC_OS=macos on Linux still has GNU stat.
    if [[ $(uname -s) == Darwin ]]; then
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
    local config_json config_file count i cmd rc only_path out stdin_file git_mode gh_stub=false
    local stderr_mode all_output keep_ansi target value
    local want_exit want_output want_home want_repo want_values want_state want_gh calls
    local file rel got want_mode got_mode
    local -a args=() runs=() path_env=() case_env_unset=() case_env_set=()

    t=$(mktemp -d)
    trap 'rm -rf "$t"' EXIT

    if [[ $(jq -r 'has("configV2")' "$dir/case.json") == true ]]; then
        config_json=$(jq -c '.configV2' "$dir/case.json") || die 'case.json has no configV2'
        config_file=sync-config.v2.json
    else
        config_json=$(jq -c '.config' "$dir/case.json") || die 'case.json has no config'
        config_file=sync-config.json
    fi
    count=$(jq -r '.commands | length' "$dir/case.json") || die 'case.json has no commands list'

    mkdir -p "$t/repo" "$t/home" "$t/empty"
    if [[ -n $engine_path ]]; then
        cp -a "$engine_path" "$t/repo/mksync" || die 'copying the program failed'
    else
        mkdir -p "$t/repo/scripts"
        cp -a "$REPO/export.sh" "$REPO/import.sh" "$REPO/commit.sh" "$REPO/sync" "$t/repo/" \
            || die 'copying the engine failed'
        cp -a "$REPO/scripts/linux" "$REPO/scripts/ci" "$t/repo/scripts/" \
            || die 'copying scripts/ failed'
    fi
    printf '%s\n' "$config_json" > "$t/repo/$config_file"
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
    # A seeded state/ goes into the folder the engine treats as its own state,
    # before the first command, exactly like the engine's own files.
    if [[ -d $dir/state ]]; then
        mkdir -p "$t/home/.local/state/sync-settings" || die 'creating the engine state folder failed'
        cp -a "$dir/state/." "$t/home/.local/state/sync-settings/" || die 'copying the case state/ failed'
        # As the program leaves them: the record and profiles for the current user only.
        find "$t/home/.local/state/sync-settings" \( -path '*/sync-settings/machine.json' \
            -o -path '*/sync-settings/profiles/*.json' ! -path '*/sync-settings/profiles/*/*' \) \
            -type f -exec chmod 600 {} + \
            || die 'setting the state record modes failed'
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
        path_env=(PATH="$t/bin:$PATH" GH="$t/bin/gh")
    fi

    # Optional case env: a string sets the variable, null unsets it. Applied by
    # `env` after HOME is set, so a case can unset HOME or USERPROFILE too.
    while IFS= read -r key; do
        if [[ $(jq -r --arg key "$key" '.env[$key] == null' "$dir/case.json") == true ]]; then
            case_env_unset+=(-u "$key")
        else
            value=$(jq -r --arg key "$key" '.env[$key]' "$dir/case.json")
            # CTX_WINDOW_DIR is relative to the case's temp home.
            if [[ $key == CTX_WINDOW_DIR ]]; then
                value=$t/home/$value
            fi
            case_env_set+=("$key=$value")
        fi
    done < <(jq -r '.env // {} | keys[]' "$dir/case.json")

    : > "$t/actual-exit"
    : > "$t/actual-output"
    for ((i = 0; i < count; i++)); do
        cmd=$(jq -r ".commands[$i].command // empty" "$dir/case.json")
        args=()
        if [[ -n $engine_path ]]; then
            case $cmd in
                export) args=(./mksync export) ;;
                import) args=(./mksync import) ;;
                check) args=(./mksync import --check) ;;
                preview) args=(./mksync export --preview) ;;
                setup) args=(./mksync setup) ;;
                statusline) args=(./mksync statusline) ;;
                machine-show) args=(./mksync machine show) ;;
                machine-retire)
                    target=$(jq -r ".commands[$i].options.target" "$dir/case.json")
                    args=(./mksync machine retire "$target")
                    ;;
                profile-retire)
                    target=$(jq -r ".commands[$i].options.target" "$dir/case.json")
                    args=(./mksync profile retire "$target")
                    ;;
                *) die "unknown command '$cmd' in command $((i + 1))" ;;
            esac
        else
            case $cmd in
                export) args=(./export.sh) ;;
                import) args=(./import.sh) ;;
                check) args=(./import.sh --check) ;;
                preview) args=(./export.sh --preview) ;;
                diff) args=(./export.sh --diff) ;;
                commit) args=(./commit.sh) ;;
                *) die "unknown command '$cmd' in command $((i + 1))" ;;
            esac
        fi
        while IFS= read -r key; do
            case $key in
                force|only|name|profile|replace|claude|mode|existing|yes|target) ;;
                *) die "unknown option '$key' in command $((i + 1))" ;;
            esac
        done < <(jq -r ".commands[$i].options // {} | keys[]" "$dir/case.json")
        if [[ $(jq -r ".commands[$i].options.force // false" "$dir/case.json") == true ]]; then
            args+=(--force)
        fi
        while IFS= read -r -d '' only_path; do
            args+=(--only "$only_path")
        done < <(jq -j ".commands[$i].options.only // [] | .[] | . , \"\\u0000\"" "$dir/case.json")
        for key in name profile replace claude mode existing; do
            if [[ $(jq -r --arg key "$key" ".commands[$i].options // {} | has(\$key)" "$dir/case.json") == true ]]; then
                args+=("--$key" "$(jq -r --arg key "$key" ".commands[$i].options[\$key]" "$dir/case.json")")
            fi
        done
        if [[ $(jq -r ".commands[$i].options.yes // false" "$dir/case.json") == true ]]; then
            args+=(--yes)
        fi

        stdin_file=/dev/null
        if [[ $(jq -r ".commands[$i] | has(\"stdin\")" "$dir/case.json") == true ]]; then
            stdin_file=$t/stdin
            jq -j ".commands[$i].stdin" "$dir/case.json" > "$stdin_file" \
                || die "writing stdin for command $((i + 1)) failed"
        fi

        # With stderr, the command's stderr is kept apart so its lines land in
        # the output after the stdout lines; a whole-stdout command without it
        # also keeps stderr apart, so only stdout reaches the output; otherwise
        # both streams are merged as before.
        stderr_mode=$(jq -r ".commands[$i].stderr // false" "$dir/case.json")
        all_output=$(jq -r ".commands[$i] | has(\"output\")" "$dir/case.json")
        keep_ansi=false
        case $cmd in
            setup|machine-show|machine-retire|profile-retire) all_output=true ;;
            statusline) all_output=true; keep_ansi=true ;;
        esac
        rc=0
        # GH overrides the gh binary in commit.sh; a caller's GH must never reach a case.
        if [[ $stderr_mode == true || $all_output == true ]]; then
            (cd "$t/repo" && HOME="$t/home" env -u XDG_STATE_HOME -u XDG_CONFIG_HOME -u GH \
                -u VIRTUAL_ENV -u CONDA_DEFAULT_ENV \
                "${case_env_unset[@]}" "${path_env[@]}" "${case_env_set[@]}" \
                "${args[@]}" < "$stdin_file") > "$t/raw" 2> "$t/raw-err" || rc=$?
        else
            (cd "$t/repo" && HOME="$t/home" env -u XDG_STATE_HOME -u XDG_CONFIG_HOME -u GH \
                -u VIRTUAL_ENV -u CONDA_DEFAULT_ENV \
                "${case_env_unset[@]}" "${path_env[@]}" "${case_env_set[@]}" \
                "${args[@]}" < "$stdin_file") > "$t/raw" 2>&1 || rc=$?
        fi
        printf '%s\n' "$rc" >> "$t/actual-exit"
        if [[ $all_output == true ]]; then
            whole_output "$t/raw" "$keep_ansi" >> "$t/actual-output"
        else
            status_lines "$t/raw" >> "$t/actual-output"
        fi
        if [[ $stderr_mode == true ]]; then
            sed "s/${ESC}\[[0-9;]*[A-Za-z]//g" "$t/raw-err" \
                | while IFS= read -r line || [[ -n $line ]]; do
                    printf '%s\n' "$line"
                done >> "$t/actual-output"
        fi
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
            # The record and profiles hold values, so the program writes them
            # for the current user only; git can't store mode 600.
            # A profile file only: a layer file under profiles/<name>/ keeps
            # its own mode (a case pattern's * also matches /).
            case $rel in
                profiles/*/*) ;;
                machine.json|profiles/*.json) want_mode=600 ;;
            esac
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

    # The program takes neither diff nor commit until phase 8: skip the case
    # without counting it as a failure.
    if [[ -n $engine_path ]]; then
        phase8=$(jq -r '[.commands[].command | select(. == "diff" or . == "commit")]
            | first // empty' "$dir/case.json" 2> /dev/null) || true
        if [[ -n $phase8 ]]; then
            printf 'SKIP %s: %s comes in phase 8\n' "$case_name" "$phase8"
            continue
        fi
    fi

    # setup, machine show, the retire commands and statusline are the program's
    # alone: the old engines don't know them, so the case is skipped, not failed.
    if [[ -z $engine_path ]]; then
        program_only=$(jq -r '[.commands[].command
            | select(. == "setup" or . == "statusline" or . == "machine-show"
                or . == "machine-retire" or . == "profile-retire")]
            | first // empty' "$dir/case.json" 2> /dev/null) || true
        if [[ -n $program_only ]]; then
            printf 'SKIP %s: %s is program only\n' "$case_name" "$program_only"
            skipped=$((skipped + 1))
            continue
        fi
    fi

    # A v2 case needs the program: the bash engine can't read config v2.
    if [[ -z $engine_path ]] && [[ $(jq -r 'has("configV2")' "$dir/case.json") == true ]]; then
        printf 'SKIP %s: v2 only\n' "$case_name"
        skipped=$((skipped + 1))
        continue
    fi

    # With --engine, import-eof-no-force counts as yes on every OS.
    if [[ -z $engine_path || $case_name != import-eof-no-force ]]; then
        if [[ $(jq -r 'has("os")' "$dir/case.json") == true ]]; then
            # shellcheck disable=SC2016  # $os is a jq argument, not a shell variable
            if ! jq -e --arg os "$HARNESS_OS" 'any(.os[]; . == $os)' "$dir/case.json" > /dev/null; then
                printf 'skip %s\n' "$case_name"
                continue
            fi
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

if (( skipped > 0 )); then
    printf '%d passed, %d failed, %d skipped\n' "$passed" "$failed_cases" "$skipped"
else
    printf '%d passed, %d failed\n' "$passed" "$failed_cases"
fi

[[ $failed_cases -eq 0 ]]
