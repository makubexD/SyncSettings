#!/usr/bin/env bash
# Shared parity cases: run every case in tests/parity/cases/ against the
# compiled program in a throwaway HOME and repo, then compare exit codes, status
# lines and both trees with expect/. The case format is tests/parity/README.md.
# Usage: tests/parity/run.sh [--engine <path>] [case-name-filter]
# PARITY_JOBS: how many cases run at once, default one per processor.

set -euo pipefail

SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$SOURCE_DIR/../.." && pwd)
CASES=${PARITY_CASES:-$REPO/tests/parity/cases}

filter=''
engine_path=$REPO/dist/mksync
passed=0
failed_cases=0
jobs=${PARITY_JOBS:-$(getconf _NPROCESSORS_ONLN 2> /dev/null || echo 4)}
case_name=''
t=''

# The OS a case runs for, resolved exactly as the engine does.
# Copied from the old bash engine's scripts/linux/os.sh.
sync_os() {
    local os=${SYNC_OS:-} uname_s
    if [[ -n $os ]]; then
        case $os in
            linux|macos)
                printf '%s' "$os"
                return 0
                ;;
            *)
                printf 'ERROR: SyncSettings runs on Linux, macOS and Windows; this is %s.\n' "$os" >&2
                return 1
                ;;
        esac
    fi
    uname_s=$(uname -s 2>/dev/null) || uname_s='unknown'
    case $uname_s in
        Linux) printf 'linux' ;;
        Darwin) printf 'macos' ;;
        *)
            printf 'ERROR: SyncSettings runs on Linux, macOS and Windows; this is %s.\n' "$uname_s" >&2
            return 1
            ;;
    esac
}
HARNESS_OS=$(sync_os)
readonly HARNESS_OS

# Status words the program prints. Longer words first so CREATED and UPDATED win
# over CREATE and UPDATE in the alternation. IN, OUT, BOTH and ? are diff labels.
STATUS_WORDS='ADDED|UNCHANGED|MODIFIED|SKIPPED|REMOVED|ERROR|CREATED|UPDATED|EXTRA|ORPHAN|DRIFT|CREATE|UPDATE|IN|OUT|BOTH|\?'
ESC=$(printf '\033')
CR=$(printf '\r')

# -- Helpers -------------------------------------------------------------------

die() {
    printf '%s\n' "$*"
    exit 1
}

# --engine <path> picks the program to run, default dist/mksync. The rest is
# the case filter.
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

[[ $jobs =~ ^[1-9][0-9]*$ ]] || die 'PARITY_JOBS must be a whole number above 0'
[[ -f $engine_path ]] || die "--engine: $engine_path is not a file"
engine_path=$(cd "$(dirname "$engine_path")" && pwd)/$(basename "$engine_path")

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
        | if ($o | has("paths")) then
            if ($o.paths | type) == "array" then all($o.paths[]; type == "string") else false end
          else true end)' "$json" > /dev/null 2>&1 \
        || die 'options.paths must be an array of strings'
    jq -e 'all(.commands[]; (.options // {}) as $o
        | all($o | to_entries[] | select(.key == "name" or .key == "profile" or .key == "replace"
            or .key == "claude" or .key == "mode" or .key == "existing" or .key == "target");
            .value | type == "string"))' "$json" > /dev/null 2>&1 \
        || die 'options name, profile, replace, claude, mode, existing and target must be strings'
    jq -e 'all(.commands[]; (.options // {}) as $o
        | if ($o | has("yes")) then ($o.yes | type) == "boolean" else true end)' "$json" \
        > /dev/null 2>&1 || die 'options.yes must be a boolean'
    jq -e 'all(.commands[]; (.options // {}) as $o
        | if ($o | has("bootstrap")) then ($o.bootstrap | type) == "boolean" else true end)' "$json" \
        > /dev/null 2>&1 || die 'options.bootstrap must be a boolean'
    jq -e 'all(.commands[]; (.options // {}) as $o
        | if ($o | has("partial")) then ($o.partial | type) == "boolean" else true end)' "$json" \
        > /dev/null 2>&1 || die 'options.partial must be a boolean'
    jq -e 'all(.commands[]; (.options // {}) as $o
        | if ($o | has("message")) then ($o.message | type) == "string" else true end)' "$json" \
        > /dev/null 2>&1 || die 'options.message must be a string'
    jq -e 'all(.commands[]; (.options // {}) as $o
        | if ($o | has("resetValues")) then ($o.resetValues | type) == "boolean" else true end)' "$json" \
        > /dev/null 2>&1 || die 'options.resetValues must be a boolean'
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
                  or $cmd == "status" or $cmd == "doctor" or $cmd == "pull"
                  or $cmd == "push" or $cmd == "front-diff"
               else true end)
          and (if ($o | has("bootstrap")) then $cmd == "setup" else true end)
          and (if ($o | has("partial")) then $cmd == "commit" else true end)
          and (if ($o | has("message")) then $cmd == "commit" or $cmd == "push" else true end)
          and (if ($o | has("paths")) then
                  $cmd == "status" or $cmd == "doctor" or $cmd == "pull"
                  or $cmd == "push" or $cmd == "front-diff" or $cmd == "front-check"
               else true end)
          and (if ($o | has("resetValues")) then $cmd == "import" or $cmd == "check" else true end))' "$json" > /dev/null 2>&1 \
        || die 'options name, profile, replace, claude, mode and existing need setup; bootstrap needs setup; yes needs setup, export, preview, machine-retire, profile-retire, status, doctor, pull, push or front-diff; partial needs commit; message needs commit or push; paths needs status, doctor, pull, push, front-diff or front-check; resetValues needs import or check'
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
        jq -e '(.env // {}) as $e
            | if ($e | has("CTX_WINDOW_DIR")) and $e.CTX_WINDOW_DIR != null then
                  if ($e.CTX_WINDOW_DIR | type) == "string" then
                      (($e.CTX_WINDOW_DIR | test("^(/|[A-Za-z]:|\\\\)")) | not)
                      and (($e.CTX_WINDOW_DIR | test("(^|[/\\\\])\\.\\.([/\\\\]|$)")) | not)
                  else false end
              else true end' "$json" > /dev/null 2>&1 \
            || die 'CTX_WINDOW_DIR must be a relative path under home'
    fi
    jq -e 'if has("emptyDirs") then
            (.emptyDirs | type) == "array" and all(.emptyDirs[]; type == "string")
          else true end' "$json" > /dev/null 2>&1 \
        || die 'emptyDirs must be a list of strings'
    jq -e 'if has("emptyDirs") then
            all(.emptyDirs[];
                ((test("^(/|[A-Za-z]:|\\\\)")) | not)
                and ((test("(^|[/\\\\])\\.\\.([/\\\\]|$)")) | not))
          else true end' "$json" > /dev/null 2>&1 \
        || die 'emptyDirs must be relative paths under home'
    jq -e 'if has("git") then (.git == "none" or .git == "committed" or .git == "remote") else true end' "$json" > /dev/null 2>&1 \
        || die 'git must be none, committed or remote'
    jq -e 'if has("stubs") then
            (.stubs | type) == "array"
            and all(.stubs[]; . == "gh" or . == "dconf" or . == "getent" or . == "bootstrap")
          else true end' "$json" > /dev/null 2>&1 \
        || die 'stubs may only hold gh, dconf, getent or bootstrap'
    jq -e '((.stubs // []) | any(. == "getent") | not)
        or ((.stubs // []) | any(. == "dconf"))' "$json" > /dev/null 2>&1 \
        || die 'the getent stub needs the dconf stub'
    jq -e 'if has("syncPoint") then (.syncPoint | type) == "boolean" else true end' "$json" > /dev/null 2>&1 \
        || die 'syncPoint must be a boolean'
    if jq -e 'has("syncPoint")' "$json" > /dev/null 2>&1; then
        jq -e '.git == "remote"' "$json" > /dev/null 2>&1 || die 'syncPoint needs git remote'
    fi
    if [[ -d $dir/origin ]]; then
        jq -e '.git == "remote"' "$json" > /dev/null 2>&1 || die 'origin/ needs git remote'
    fi
    jq -e 'if has("originUrl") then (.originUrl | type) == "string" and .originUrl != "" else true end' \
        "$json" > /dev/null 2>&1 || die 'originUrl must be a non-empty string'
    if jq -e 'has("originUrl")' "$json" > /dev/null 2>&1; then
        jq -e '.git == "remote"' "$json" > /dev/null 2>&1 || die 'originUrl needs git remote'
    fi
    if [[ -d $dir/unsent ]]; then
        jq -e '.git == "committed" or .git == "remote"' "$json" > /dev/null 2>&1 \
            || die 'unsent/ needs git committed or remote'
    fi
    if jq -e 'has("config")' "$json" > /dev/null 2>&1; then
        die 'case.json has a v1 config'
    fi
    if ! jq -e 'has("configV2")' "$json" > /dev/null 2>&1; then
        die 'case.json has no configV2'
    fi
    jq -e '(.configV2 | type) == "object"' "$json" > /dev/null 2>&1 || die 'configV2 must be an object'
    jq -e 'if has("configName") then
            .configName == "sync-config.json" or .configName == "sync-config.v2.json"
          else true end' "$json" > /dev/null 2>&1 \
        || die 'configName must be sync-config.json or sync-config.v2.json'
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

# expect.<os>/ only applies to a case whose differences name a row the program
# keeps per OS; every other case uses expect/ on every OS.
expected_os_folder() {
    local dir=$1
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
# checks it"). A line starting `Next` is kept whole, without its indent, for the
# front door's status.
status_lines() {
    # A prompt answered from a pipe ends with no newline, so its status line
    # follows it on the same line: drop the `…? [Y/n]` prefix first.
    sed "s/${ESC}\[[0-9;]*[A-Za-z]//g" "$1" \
        | sed -E 's/^.*\? \[[Yy]\/[Nn]\][[:space:]]*//' \
        | sed -nE "s/^[[:space:]]*\[?[[:space:]]*($STATUS_WORDS)[[:space:]]*\]?[[:space:]]+([^[:space:]]+).*/\1 \2/p; s/^[[:space:]]*(Next.*)$/\1/p; s/^[[:space:]]*(Linked folder not synced: .*)$/\1/p"
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

# Rewrite the placeholders in the whole-stdout lines of the collected output,
# after every command ran (see the README's "How the runner checks it"): the
# case's temp home becomes <HOME>, the one backup run folder becomes
# backups/RUN, and a Sync point's sha that begins the repo's HEAD becomes
# <HEAD>. The status lines, and every line outside a whole-stdout command, are
# left alone. $1 is the case's temp folder, $2 the case's git mode.
rewrite_whole_output() {
    local temp=$1 git_mode=$2 line n=0 start end run='' head='' sha='' in_whole i
    local result=$temp/actual-output-rewritten
    local -a starts=() ends=() runs=()
    if [[ -f $temp/whole-ranges ]]; then
        while read -r start end; do
            [[ -n $start ]] || continue
            starts+=("$start")
            ends+=("$end")
        done < "$temp/whole-ranges"
    fi
    if [[ -d $temp/home/.local/state/sync-settings/backups ]]; then
        while IFS= read -r -d '' folder; do
            if [[ -n $folder ]]; then
                runs+=("${folder##*/}")
            fi
        done < <(find "$temp/home/.local/state/sync-settings/backups" \
            -mindepth 1 -maxdepth 1 -type d -print0)
        if (( ${#runs[@]} == 1 )); then
            run=${runs[0]}
        fi
    fi
    if [[ $git_mode != none ]]; then
        head=$(git_env -C "$temp/repo" rev-parse HEAD 2> /dev/null) || head=''
    fi
    : > "$result"
    while IFS= read -r line || [[ -n $line ]]; do
        n=$((n + 1))
        in_whole=false
        for i in "${!starts[@]}"; do
            if (( n > starts[i] && n <= ends[i] )); then
                in_whole=true
                break
            fi
        done
        if [[ $in_whole == true ]]; then
            # The temp home as a literal string: quoting keeps a path's glob
            # characters out of the pattern.
            line=${line//"$temp/home"/<HOME>}
            if [[ -n $run ]]; then
                line=${line//"backups/$run"/backups/RUN}
            fi
            if [[ -n $head && $line == '  Sync point : '* ]]; then
                sha=${line#'  Sync point : '}
                if [[ -n $sha && $sha != *[!0-9a-fA-F]* && $head == "$sha"* ]]; then
                    line='  Sync point : <HEAD>'
                fi
            fi
        fi
        printf '%s\n' "$line" >> "$result"
    done < "$temp/actual-output"
    mv "$result" "$temp/actual-output"
}

# One command's output for the expect/lines.txt check: ANSI color codes
# removed, each line trimmed, and a status line in either engine's layout read
# as `WORD label note` with single spaces between (see the README's "How the
# runner checks it"). Notes and every other line stay as they are, trimmed.
normalize_output() {
    local line word label rest
    sed "s/${ESC}\[[0-9;]*[A-Za-z]//g" "$1" \
        | sed -E 's/^.*\? \[[Yy]\/[Nn]\][[:space:]]*//' \
        | while IFS= read -r line || [[ -n $line ]]; do
            line=${line#"${line%%[![:space:]]*}"}
            line=${line%"${line##*[![:space:]]}"}
            if [[ $line =~ ^\[[[:space:]]*($STATUS_WORDS)[[:space:]]*\][[:space:]]+([^[:space:]]+)(.*)$ ]]; then
                word=${BASH_REMATCH[1]}
                label=${BASH_REMATCH[2]}
                rest=${BASH_REMATCH[3]}
            elif [[ $line =~ ^($STATUS_WORDS)[[:space:]]+([^[:space:]]+)(.*)$ ]]; then
                word=${BASH_REMATCH[1]}
                label=${BASH_REMATCH[2]}
                rest=${BASH_REMATCH[3]}
            else
                printf '%s\n' "$line"
                continue
            fi
            if [[ $rest =~ ^[[:space:]]+\((.*)\)[[:space:]]*$ ]]; then
                printf '%s %s %s\n' "$word" "$label" "${BASH_REMATCH[1]}"
            else
                printf '%s %s\n' "$word" "$label"
            fi
        done
}

# Check expect/lines.txt against the per-command normalized output. Lines
# before any `# <n>` belong to command 1; `# <n>` starts command n's lines.
# Each expected line must appear in that command's output, in the file's order,
# other lines allowed between. `! <text>` means no line of that command's
# output contains <text>. A failure names the first missing (or present `!`)
# line and prints the command's normalized output.
check_lines() {
    local dir=$1 count=$2 want line cmd=1 idx text found
    local -a want_lines=() got=() pos=()
    want=$(expected_path "$dir" lines.txt)
    [[ -f $want ]] || return 0
    mapfile -t want_lines < "$want"
    for ((idx = 1; idx <= count; idx++)); do
        pos[idx]=0
    done
    for line in "${want_lines[@]}"; do
        if [[ $line =~ ^#[[:space:]]+([0-9]+)$ ]]; then
            cmd=${BASH_REMATCH[1]}
            (( cmd >= 1 && cmd <= count )) || die "lines command $cmd: no such command"
            continue
        fi
        mapfile -t got < "$t/cmd-$cmd.lines"
        if [[ $line == '! '* ]]; then
            text=${line#! }
            for ((idx = 0; idx < ${#got[@]}; idx++)); do
                if [[ ${got[idx]} == *"$text"* ]]; then
                    die "lines command $cmd: \"$text\" must not appear
output was:
$(cat "$t/cmd-$cmd.lines")"
                fi
            done
        else
            found=false
            for ((idx = pos[cmd]; idx < ${#got[@]}; idx++)); do
                if [[ ${got[idx]} == "$line" ]]; then
                    pos[cmd]=$((idx + 1))
                    found=true
                    break
                fi
            done
            if [[ $found == false ]]; then
                die "lines command $cmd: missing \"$line\"
output was:
$(cat "$t/cmd-$cmd.lines")"
            fi
        fi
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

# Remove the program files copied into the temp repo, so the repo comparison
# sees only the case's own files. `scripts` goes too when nothing is left in it.
strip_engine() {
    local repo=$1
    rm -f "$repo/mksync" "$repo/sync-config.json" "$repo/sync-config.v2.json" "$repo/.user-values.json"
    rm -rf "$repo/scripts/ci"
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
    # The program stays out of git: compressing its 100 MB takes seconds a case.
    printf '%s\n' .user-values.json /mksync >> "$repo/.git/info/exclude" || die 'writing .git/info/exclude failed'
    git_env -C "$repo" add -A || die 'git add failed'
    git_env -C "$repo" commit -q -m 'parity case' || die 'git commit failed'
    if [[ $mode == remote ]]; then
        git_env init -q --bare -b master "$temp/origin.git" || die 'git init of origin failed'
        git_env -C "$repo" remote add origin "$temp/origin.git" || die 'git remote add failed'
        git_env -C "$repo" push -q -u origin master || die 'git push failed'
    fi
}

# Write the gh stub into $temp/bin: it appends its arguments joined by spaces,
# one call per line, to $temp/gh.log and exits 0. It prints nothing, except
# `parity-user` for `api user --jq .login` and `config get -h github.com user`,
# the gh-login and gh-hosts-login suggestions' sources.
write_gh_stub() {
    local temp=$1
    mkdir -p "$temp/bin" || die 'creating the gh stub folder failed'
    printf '%s\n' \
        '#!/bin/sh' \
        "printf '%s\\n' \"\$*\" >> '$temp/gh.log'" \
        'if [ "$*" = "api user --jq .login" ]; then echo parity-user; fi' \
        'if [ "$*" = "config get -h github.com user" ]; then echo parity-user; fi' \
        'exit 0' > "$temp/bin/gh" || die 'writing the gh stub failed'
    chmod +x "$temp/bin/gh" || die 'making the gh stub executable failed'
}

# Write the dconf stub into $temp/bin. `dump <path>` prints the case's
# dconf/<name>.ini, where <name> is the path without its leading and trailing
# slashes and with the rest turned to dashes; a missing file prints nothing.
# `load <path>` appends `load <path>` and then its stdin verbatim to
# $temp/dconf.log. Anything else prints a message on stderr and exits 1.
write_dconf_stub() {
    local temp=$1 dir=$2
    mkdir -p "$temp/bin" || die 'creating the dconf stub folder failed'
    # shellcheck disable=SC2016  # the stub's own $ expansions run when the stub runs
    printf '%s\n' \
        '#!/bin/sh' \
        "case_dir='$dir'" \
        "log='$temp/dconf.log'" \
        'case ${1:-} in' \
        '    dump)' \
        '        [ "$#" -eq 2 ] || { echo "dconf stub: dump needs a path" >&2; exit 1; }' \
        '        name=${2#/}' \
        '        name=${name%/}' \
        "        name=\$(printf '%s' \"\$name\" | tr '/' '-')" \
        '        if [ -f "$case_dir/dconf/$name.ini" ]; then cat "$case_dir/dconf/$name.ini"; fi' \
        '        exit 0' \
        '        ;;' \
        '    load)' \
        '        [ "$#" -eq 2 ] || { echo "dconf stub: load needs a path" >&2; exit 1; }' \
        '        printf "load %s\n" "$2" >> "$log"' \
        '        cat >> "$log"' \
        '        exit 0' \
        '        ;;' \
        '    *)' \
        '        printf "dconf stub: unsupported: %s\n" "$*" >&2' \
        '        exit 1' \
        '        ;;' \
        'esac' > "$temp/bin/dconf" || die 'writing the dconf stub failed'
    chmod +x "$temp/bin/dconf" || die 'making the dconf stub executable failed'
}

# Write the getent stub into $temp/bin: `getent passwd <user>` answers with the
# case's temp home in the home field and exits 0; anything else is getent's
# "key not found", exit 2.
write_getent_stub() {
    local temp=$1 home=$2
    mkdir -p "$temp/bin" || die 'creating the getent stub folder failed'
    # shellcheck disable=SC2016  # the stub's own $ expansions run when the stub runs
    printf '%s\n' \
        '#!/bin/sh' \
        'case ${1:-} in' \
        '    passwd)' \
        '        [ "$#" -eq 2 ] || exit 2' \
        "        printf '%s:x:1000:1000::%s:/bin/bash\\n' \"\$2\" '$home'" \
        '        exit 0' \
        '        ;;' \
        '    *) exit 2 ;;' \
        'esac' > "$temp/bin/getent" || die 'writing the getent stub failed'
    chmod +x "$temp/bin/getent" || die 'making the getent stub executable failed'
}

# Write the bootstrap stub into the case's repo: `bootstrap/linux.sh` appends
# `ran <MKSYNC_SETUP_EXISTING>` to $temp/bootstrap.log and prints BOOTSTRAP RAN,
# then exits 0; it imports nothing, so a case's home shows setup imported nothing. The front
# door runs the repo's own file, so this is the one stub inside a compared tree;
# its log stays outside both trees. `$0` is the repo's absolute path, or the
# relative one the caller ran from the repo root, so its two parents are $temp.
write_bootstrap_stub() {
    local temp=$1
    mkdir -p "$temp/repo/bootstrap" || die 'creating the bootstrap stub folder failed'
    # shellcheck disable=SC2016  # the stub's own $ expansions run when the stub runs
    printf '%s\n' \
        '#!/bin/sh' \
        "printf 'ran %s\\n' \"\${MKSYNC_SETUP_EXISTING-}\" >> \"\${0%/*}/../../bootstrap.log\"" \
        "printf 'BOOTSTRAP RAN\\n'" \
        'exit 0' > "$temp/repo/bootstrap/linux.sh" || die 'writing the bootstrap stub failed'
    chmod +x "$temp/repo/bootstrap/linux.sh" || die 'making the bootstrap stub executable failed'
}

# -- One case ------------------------------------------------------------------

# Runs one case in a fresh throwaway folder, prints the first difference and
# exits 1 from the subshell on a failure. Called in a command substitution, so
# the EXIT trap removes the temp folder on success and failure alike.
run_case() {
    local dir=$1
    local config_json config_file count i cmd rc only_path out stdin_file git_mode gh_stub=false
    local stubs dconf_stub=false bootstrap_stub=false
    local stderr_mode all_output keep_ansi target value
    local want_exit want_output want_home want_repo want_values want_state want_gh want_dconf calls first_load
    local want_bootstrap first_run
    local file rel got want_mode got_mode start_head state_want clone positional out_start out_end
    local -a args=() runs=() path_env=() case_env_unset=() case_env_set=()

    t=$(mktemp -d)
    trap 'rm -rf "$t"' EXIT

    config_json=$(jq -c '.configV2' "$dir/case.json") || die 'case.json has no configV2'
    config_file=sync-config.json
    if [[ $(jq -r 'has("configName")' "$dir/case.json") == true ]]; then
        config_file=$(jq -r '.configName' "$dir/case.json") || die 'case.json has no configName'
    fi
    count=$(jq -r '.commands | length' "$dir/case.json") || die 'case.json has no commands list'

    mkdir -p "$t/repo" "$t/home" "$t/empty"
    if [[ $engine_path == "$REPO/mksync" ]]; then
        # The clone launcher runs src/main.ts next to itself, so a copy
        # would look for the sources in the temp repo. A link keeps it in
        # the clone while the cases still run ./mksync.
        ln -s "$engine_path" "$t/repo/mksync" || die 'linking the launcher failed'
    else
        # A hard link to the run's own copy: a copy per case costs 100 MB each.
        ln "$work/mksync" "$t/repo/mksync" || die 'copying the program failed'
    fi
    # The program runs the leak scan from the repo.
    mkdir -p "$t/repo/scripts"
    cp -a "$REPO/scripts/ci" "$t/repo/scripts/" || die 'copying scripts/ci failed'
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
        # cp -a keeps the fixtures' mtimes, so a home file and its repo twin of the
        # same size can share one. export.sh copies with cp -p into the same inode,
        # and git's stat cache then reports the changed repo file as clean.
        find "$t/home" -type f -exec touch {} + || die 'touching the case home/ failed'
    fi
    # Git stores no empty folder, so a case names its empty folders in
    # emptyDirs; each is created in the temp home before the first command.
    while IFS= read -r rel; do
        mkdir -p "$t/home/$rel" || die "creating the empty folder '$rel' failed"
    done < <(jq -r '.emptyDirs // [] | .[]' "$dir/case.json")

    git_mode=$(jq -r '.git // "none"' "$dir/case.json") || die 'case.json has no git'
    start_head=''
    case $git_mode in
        none) ;;
        committed|remote)
            setup_git "$t/repo" "$t" "$git_mode"
            # The commit the case starts from: a sync point and an expected
            # state file's <START_HEAD> both name it.
            start_head=$(git_env -C "$t/repo" rev-parse HEAD) || die 'reading HEAD failed'
            ;;
        *) die 'git must be none, committed or remote' ;;
    esac

    # A sync point is the commit the last sync left on master, as the engine
    # records it. It goes in before the case's state/ copy, so a case can
    # override it there.
    if [[ $(jq -r '.syncPoint // false' "$dir/case.json") == true ]]; then
        mkdir -p "$t/home/.local/state/sync-settings" \
            || die 'creating the engine state folder failed'
        printf '%s\n' "$start_head" > "$t/home/.local/state/sync-settings/last-sync" \
            || die 'writing the sync point failed'
    fi

    # An origin/ tree is one commit on top of master, made in a second clone and
    # pushed to the bare origin: origin/master is ahead, the repo's master and
    # working tree are not.
    if [[ -d $dir/origin ]]; then
        clone=$t/origin-clone
        git_env clone -q "$t/origin.git" "$clone" || die 'cloning origin failed'
        cp -a "$dir/origin/." "$clone/" || die 'copying the case origin/ failed'
        git_env -C "$clone" add -A || die 'git add in the origin clone failed'
        git_env -c user.name=parity -c user.email=parity@example.com -C "$clone" \
            commit -q -m origin || die 'git commit in the origin clone failed'
        git_env -C "$clone" push -q origin master || die 'git push to origin failed'
        rm -rf "$clone" || die 'removing the origin clone failed'
        git_env -C "$t/repo" fetch -q origin || die 'git fetch origin failed'
    fi

    # An originUrl renames origin once the setup above is done with the bare
    # one, so the program reads that address. GIT_ALLOW_PROTOCOL=file (below)
    # stops any fetch or push to it before it reaches the network.
    origin_url=$(jq -r '.originUrl // empty' "$dir/case.json") || die 'reading originUrl failed'
    if [[ -n $origin_url ]]; then
        git_env -C "$t/repo" remote set-url origin "$origin_url" || die 'git remote set-url failed'
    fi

    # An unsent/ tree goes over the repo's working tree after the commit and
    # stays uncommitted, so `git status --porcelain` shows it. Plain cp -R
    # gives the copies a new mtime: with cp -a a same-size edit can keep the
    # committed file's size and mtime second, and git's stat check then calls
    # the tree clean on some runs.
    if [[ -d $dir/unsent ]]; then
        cp -R "$dir/unsent/." "$t/repo/" || die 'copying the case unsent/ failed'
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

    stubs=$(jq -r '(.stubs // []) | join(" ")' "$dir/case.json") || die 'reading stubs failed'
    if [[ -n $stubs ]]; then
        path_env=(PATH="$t/bin:$PATH")
    fi
    if [[ " $stubs " == *' gh '* ]]; then
        gh_stub=true
        write_gh_stub "$t"
        path_env+=(GH="$t/bin/gh")
    fi
    if [[ " $stubs " == *' dconf '* ]]; then
        dconf_stub=true
        write_dconf_stub "$t" "$dir"
    fi
    if [[ " $stubs " == *' getent '* ]]; then
        write_getent_stub "$t" "$t/home"
    fi
    if [[ " $stubs " == *' bootstrap '* ]]; then
        bootstrap_stub=true
        write_bootstrap_stub "$t"
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
    if [[ -n $origin_url ]]; then
        case_env_set+=(GIT_ALLOW_PROTOCOL=file)
    fi

    : > "$t/actual-exit"
    : > "$t/actual-output"
    : > "$t/whole-ranges"
    for ((i = 0; i < count; i++)); do
        cmd=$(jq -r ".commands[$i].command // empty" "$dir/case.json")
        args=()
        case $cmd in
            export) args=(./mksync export) ;;
            import) args=(./mksync import) ;;
            check) args=(./mksync import --check) ;;
            preview) args=(./mksync export --preview) ;;
            diff) args=(./mksync export --diff) ;;
            commit) args=(./mksync commit) ;;
            setup) args=(./mksync setup) ;;
            statusline) args=(./mksync statusline) ;;
            status) args=(./mksync status) ;;
            doctor) args=(./mksync doctor) ;;
            pull) args=(./mksync pull) ;;
            push) args=(./mksync push) ;;
            front-diff) args=(./mksync diff) ;;
            front-check) args=(./mksync check) ;;
            front-preview) args=(./mksync preview) ;;
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
        while IFS= read -r key; do
            case $key in
                force|only|name|profile|replace|claude|mode|existing|yes|bootstrap|target|partial|message|paths|resetValues) ;;
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
        if [[ $(jq -r ".commands[$i].options.bootstrap // false" "$dir/case.json") == true ]]; then
            args+=(--bootstrap)
        fi
        if [[ $(jq -r ".commands[$i].options.partial // false" "$dir/case.json") == true ]]; then
            args+=(--partial)
        fi
        if [[ $(jq -r ".commands[$i].options | has(\"message\")" "$dir/case.json") == true ]]; then
            args+=(-m "$(jq -r ".commands[$i].options.message" "$dir/case.json")")
        fi
        if [[ $(jq -r ".commands[$i].options.resetValues // false" "$dir/case.json") == true ]]; then
            args+=(--reset-values)
        fi
        # Positional paths, for the front door's commands.
        while IFS= read -r -d '' positional; do
            args+=("$positional")
        done < <(jq -j ".commands[$i].options.paths // [] | .[] | . , \"\\u0000\"" "$dir/case.json")

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
        # GH overrides the gh binary; a caller's GH must never reach a case.
        # A caller's git repo, bus and tokens stay out too; the case's own env is
        # applied after the unsets, so a case may still set them deliberately. The
        # ceiling always holds, so git cannot climb above the case folder.
        # Bun's transpile cache would otherwise land in the case's home; keep it
        # outside both compared trees.
        if [[ $stderr_mode == true || $all_output == true ]]; then
            (cd "$t/repo" && HOME="$t/home" env -u XDG_STATE_HOME -u XDG_CONFIG_HOME -u GH \
                -u VIRTUAL_ENV -u CONDA_DEFAULT_ENV -u DBUS_SESSION_BUS_ADDRESS \
                -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GH_TOKEN -u GITHUB_TOKEN \
                "${case_env_unset[@]}" "${path_env[@]}" "${case_env_set[@]}" \
                XDG_CACHE_HOME="$t/xdg-cache" GIT_CEILING_DIRECTORIES="$t" \
                "${args[@]}" < "$stdin_file") > "$t/raw" 2> "$t/raw-err" || rc=$?
        else
            (cd "$t/repo" && HOME="$t/home" env -u XDG_STATE_HOME -u XDG_CONFIG_HOME -u GH \
                -u VIRTUAL_ENV -u CONDA_DEFAULT_ENV -u DBUS_SESSION_BUS_ADDRESS \
                -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GH_TOKEN -u GITHUB_TOKEN \
                "${case_env_unset[@]}" "${path_env[@]}" "${case_env_set[@]}" \
                XDG_CACHE_HOME="$t/xdg-cache" GIT_CEILING_DIRECTORIES="$t" \
                "${args[@]}" < "$stdin_file") > "$t/raw" 2>&1 || rc=$?
        fi
        printf '%s\n' "$rc" >> "$t/actual-exit"
        out_start=$(wc -l < "$t/actual-output")
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
        if [[ $all_output == true ]]; then
            # The lines this command added, 1-based, for the placeholder
            # rewrite once every command has run.
            out_end=$(wc -l < "$t/actual-output")
            printf '%s %s\n' "$out_start" "$out_end" >> "$t/whole-ranges"
        fi
        # The same command's whole output, normalized for expect/lines.txt.
        # Stderr joins it only when the case asked for stderr, as for output.txt.
        normalize_output "$t/raw" > "$t/cmd-$((i + 1)).lines"
        if [[ $stderr_mode == true && -f $t/raw-err ]]; then
            normalize_output "$t/raw-err" >> "$t/cmd-$((i + 1)).lines"
        fi
    done

    # Every command has run: the whole-stdout lines can now be compared with
    # the places whose value changes per run replaced (the temp home, the
    # backup run folder, the sync point's sha).
    rewrite_whole_output "$t" "$git_mode"

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

    # Every dconf load is logged verbatim as `load <path>` and the loaded text,
    # with no cut, and the log must match expect/dconf.log byte for byte. No
    # expected file means dconf must not be loaded, as for gh above.
    if $dconf_stub; then
        want_dconf=$(expected_path "$dir" dconf.log)
        if [[ -f $want_dconf ]]; then
            [[ -f $t/dconf.log ]] || die 'dconf: want a load, got nothing'
            if ! cmp -s "$want_dconf" "$t/dconf.log"; then
                first_line_diff dconf "$want_dconf" "$t/dconf.log" \
                    || die 'dconf.log: differs from expect'
            fi
        else
            first_load=$(head -n 1 "$t/dconf.log" 2> /dev/null) || true
            [[ -z $first_load ]] || die "dconf: want no load, got \"$first_load\""
        fi
    fi

    # The bootstrap stub appends `ran` to its log; the log must equal
    # expect/bootstrap.log byte for byte, or no run when the file is absent.
    if $bootstrap_stub; then
        want_bootstrap=$(expected_path "$dir" bootstrap.log)
        if [[ -f $want_bootstrap ]]; then
            [[ -f $t/bootstrap.log ]] || die 'bootstrap: want a run, got nothing'
            cmp -s "$want_bootstrap" "$t/bootstrap.log" || die 'bootstrap.log: differs from expect'
        else
            first_run=$(head -n 1 "$t/bootstrap.log" 2> /dev/null) || true
            [[ -z $first_run ]] || die "bootstrap: want no run, got \"$first_run\""
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
            # <START_HEAD> stands for the commit the case started from, which
            # changes per run; substitute it before comparing.
            state_want=$file
            if grep -qF '<START_HEAD>' "$file"; then
                [[ -n $start_head ]] || die "state $rel: <START_HEAD> needs a git repo"
                state_want=$t/state-want
                sed "s/<START_HEAD>/$start_head/g" "$file" > "$state_want" \
                    || die "state $rel: substituting <START_HEAD> failed"
            fi
            cmp -s "$state_want" "$got" || die "state $rel: differs"
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
    check_lines "$dir" "$count"

    want_home=$(expected_path "$dir" home)
    if [[ $(jq -r '(.emptyDirs // []) | length' "$dir/case.json") -gt 0 ]]; then
        # Git stores no empty folder, so expect/home/ can't hold the ones
        # emptyDirs makes; the compare sees a copy of it that has them.
        mkdir -p "$t/expect/home" || die 'creating the expected home/ copy failed'
        if [[ -d $want_home ]]; then
            cp -a "$want_home/." "$t/expect/home/" || die 'copying the expected home/ failed'
        fi
        while IFS= read -r rel; do
            mkdir -p "$t/expect/home/$rel" \
                || die "creating the expected empty folder '$rel' failed"
        done < <(jq -r '.emptyDirs // [] | .[]' "$dir/case.json")
        want_home=$t/expect/home
    fi
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

# Checks and runs one case: prints its result line and, on the first line, one
# of ok, fail or skip for the summary.
report_case() {
    local dir=$1 reason
    if ! reason=$(validate_case "$dir"); then
        printf 'fail\nFAIL %s: %s\n' "$case_name" "${reason:-invalid case.json}"
        return 0
    fi

    # import-eof-no-force counts as yes on every OS.
    if [[ $case_name != import-eof-no-force ]]; then
        if [[ $(jq -r 'has("os")' "$dir/case.json") == true ]]; then
            # shellcheck disable=SC2016  # $os is a jq argument, not a shell variable
            if ! jq -e --arg os "$HARNESS_OS" 'any(.os[]; . == $os)' "$dir/case.json" > /dev/null; then
                printf 'skip\nskip %s\n' "$case_name"
                return 0
            fi
        fi
    fi

    if reason=$(run_case "$dir"); then
        printf 'ok\nok %s\n' "$case_name"
    else
        printf 'fail\nFAIL %s: %s\n' "$case_name" "${reason:-unknown failure}"
    fi
}

# Prints case number $1's result and counts it. No result file means its
# subshell died, which is a failure too.
take_result() {
    local file=$work/$1 kind='' name=${names[$1]}
    if [[ -f $file ]]; then
        { read -r kind || true; cat; } < "$file"
    fi
    case $kind in
        ok) passed=$((passed + 1)) ;;
        skip) ;;
        fail) failed_cases=$((failed_cases + 1)) ;;
        *)
            printf 'FAIL %s: the case ended with no result\n' "$name"
            failed_cases=$((failed_cases + 1))
            ;;
    esac
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if [[ $engine_path != "$REPO/mksync" ]]; then
    cp -a "$engine_path" "$work/mksync" || die 'copying the program failed'
fi

# Cases share nothing, so up to $jobs run at once; results print in case order.
matched=0
shown=0
names=()
pids=()
for dir in "$CASES"/*/; do
    [[ -d $dir ]] || continue
    dir=${dir%/}
    case_name=${dir##*/}

    if [[ -n $filter && $case_name != *"$filter"* ]]; then
        continue
    fi
    names+=("$case_name")
    report_case "$dir" > "$work/$matched" < /dev/null &
    pids+=("$!")
    matched=$((matched + 1))

    while (( matched - shown >= jobs )); do
        wait "${pids[shown]}" || true
        take_result "$shown"
        shown=$((shown + 1))
    done
done
while (( shown < matched )); do
    wait "${pids[shown]}" || true
    take_result "$shown"
    shown=$((shown + 1))
done

if [[ -n $filter && $matched -eq 0 ]]; then
    printf 'no case matches %s\n' "$filter"
    exit 1
fi

printf '%d passed, %d failed\n' "$passed" "$failed_cases"

[[ $failed_cases -eq 0 ]]
