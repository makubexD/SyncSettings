#!/usr/bin/env bash
# Shared helpers for the bash entry points (export.sh / import.sh / commit.sh).
# Source this file after cd-ing to the repo root. Never execute it directly.

set -euo pipefail

REPO_ROOT=$PWD
CONFIG=$REPO_ROOT/sync-config.json
VALUES_FILE=$REPO_ROOT/.user-values.json

# The system this run is for, resolved once from SYNC_OS or uname -s.
SYNC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/linux/os.sh
source "$SYNC_DIR/os.sh"

if ! SYNC_PLATFORM=$(sync_os); then
    # A sourced library (bootstrap/linux.sh) returns instead of ending the caller.
    if [[ -n ${SYNC_LIB_ONLY:-} ]]; then
        return 1
    fi
    exit 1
fi

declare -A USER_VALUES=()

# -- Config -------------------------------------------------------------------

# Every entry must name one of the three platforms. Stop before any file is touched.
check_platforms() {
    local repo_path
    while IFS= read -r -d '' repo_path; do
        printf 'ERROR: sync-config.json: entry %s needs "platform": "common", "windows", "linux", "macos" or a list of the last three.\n' "$repo_path" >&2
        exit 1
    done < <(jq -j '
        def valid_platform:
            if type == "string" then
                . == "common" or . == "windows" or . == "linux" or . == "macos"
            elif type == "array" then
                length > 0
                and ((unique | length) == length)
                and all(.[]; type == "string" and (. == "windows" or . == "linux" or . == "macos"))
            else false end;
        .files[]
        | select((.platform | valid_platform) | not)
        | .repoPath, "\u0000"' "$CONFIG")
}

# A path is safe when it starts with its required prefix and has no ".." segment,
# splitting on both / and \. A name like "foo..bar" is a legal segment; an empty
# path never matches a prefix, so it fails.
path_is_safe() {
    local path=$1 kind=$2 rest seg
    case $kind in
        repo)
            [[ $path == dotfiles/* ]] || return 1
            ;;
        local)
            # shellcheck disable=SC2088  # literal '~' prefix from sync-config.json
            [[ $path == '~/'* || $path == $'~\\'* ]] || return 1
            ;;
    esac
    rest=$path
    while [[ -n $rest ]]; do
        seg=${rest%%[\\/]*}
        [[ $seg == '..' ]] && return 1
        if [[ $rest == *[\\/]* ]]; then
            rest=${rest#*[\\/]}
        else
            break
        fi
    done
    return 0
}

path_fail() {
    printf 'ERROR: sync-config.json: entry %s has an unsafe path.\n' "$1" >&2
    exit 1
}

dconf_fail() {
    printf 'ERROR: sync-config.json: entry %s needs "platform": "linux" and a dconf path like /org/gnome/shell/.\n' "$1" >&2
    exit 1
}

default_env_fail() {
    printf 'ERROR: sync-config.json: entry %s has an invalid defaultEnv.\n' "$1" >&2
    exit 1
}

# Every path must stay inside dotfiles/ and the home directory, on any platform,
# and no symlink may sit under dotfiles/. Stop before any file is touched.
check_paths() {
    local repo_path local_path dconf_path platform
    while IFS= read -r -d '' repo_path && IFS= read -r -d '' local_path; do
        path_is_safe "$repo_path" repo || path_fail "$repo_path"
        path_is_safe "$local_path" local || path_fail "$repo_path"
    done < <(jq -j '.files[] | select(.type != "dconf")
        | (.repoPath // ""), "\u0000", (.localPath // ""), "\u0000"' "$CONFIG")

    # localPaths is an optional object of per-system paths. A value follows the
    # localPath rule, and a key names a system the engine knows.
    local lp_key lp_value lp_type
    while IFS= read -r -d '' repo_path && IFS= read -r -d '' lp_type; do
        [[ $lp_type == object ]] || path_fail "$repo_path"
    done < <(jq -j '.files[]
        | select(has("localPaths"))
        | .repoPath, "\u0000", (.localPaths | type), "\u0000"' "$CONFIG")

    while IFS= read -r -d '' repo_path && IFS= read -r -d '' lp_key \
        && IFS= read -r -d '' lp_value; do
        case $lp_key in
            linux|macos|windows) ;;
            *)
                printf 'ERROR: sync-config.json: entry %s has an unknown localPaths key %s.\n' "$repo_path" "$lp_key" >&2
                exit 1
                ;;
        esac
        path_is_safe "$lp_value" local || path_fail "$repo_path"
    done < <(jq -j '.files[]
        | select(has("localPaths"))
        | select((.localPaths | type) == "object")
        | .repoPath as $r
        | .localPaths | to_entries[]
        | $r, "\u0000", .key, "\u0000", (.value // ""), "\u0000"' "$CONFIG")

    # A dconf entry has no local file: it owns its repoPath and names a dconf
    # folder instead. Refuse a bad one before anything is dumped or loaded.
    while IFS= read -r -d '' repo_path && IFS= read -r -d '' dconf_path \
        && IFS= read -r -d '' platform; do
        path_is_safe "$repo_path" repo || path_fail "$repo_path"
        [[ $platform == linux ]] || dconf_fail "$repo_path"
        [[ $dconf_path =~ ^(/[A-Za-z0-9._-]+)+/$ ]] || dconf_fail "$repo_path"
        [[ $dconf_path != */../* ]] || dconf_fail "$repo_path"
    done < <(jq -j '.files[] | select(.type == "dconf")
        | (.repoPath // ""), "\u0000", (.path // ""), "\u0000",
          (.platform | if type == "array" then "list" else (. // "") end), "\u0000"' "$CONFIG")

    # A defaultEnv is read as a variable name, so it must be a valid shell name.
    local default_env env_name_re='^[A-Za-z_][A-Za-z0-9_]*$'
    while IFS= read -r -d '' repo_path && IFS= read -r -d '' default_env; do
        [[ $default_env =~ $env_name_re ]] || default_env_fail "$repo_path"
    done < <(jq -j '.files[]
        | select(.sanitizeRules != null)
        | .repoPath as $r
        | .sanitizeRules[]
        | select(.defaultEnv != null)
        | $r, "\u0000", .defaultEnv, "\u0000"' "$CONFIG")

    # A symlink can point anywhere; name the entry that owns it, or the symlink's
    # own repo-relative path when no entry does.
    local link name
    while IFS= read -r -d '' link; do
        name=${link#"$REPO_ROOT"/}
        path_fail "$(jq -j --arg name "$name" '
            ([.files[] | select(.type != "dir") | select(.repoPath == $name) | .repoPath] +
             [.files[] | select(.type == "dir") | .repoPath as $r | select($name == $r or ($name | startswith($r + "/"))) | $r] +
             [.files[] | select(.detectLinkedPaths == true) | .repoPath as $r | select($name | startswith($r + ".linked/")) | $r])
            | .[0] // $name' "$CONFIG")"
    done < <(find "$REPO_ROOT/dotfiles" -type l -print0 2>/dev/null | sort -z)
}

if [[ -z ${SYNC_LIB_ONLY:-} ]]; then
    check_platforms
    check_paths
fi

platform_entries() {
    jq -c --arg os "$SYNC_PLATFORM" "$PLATFORM_SELECT_JQ"' .files[]
        | select(selected($os))
        | if ((.localPaths // {})[$os]) != null then .localPath = .localPaths[$os] else . end' "$CONFIG"
}

resolve_local() {
    local p=$1
    # shellcheck disable=SC2088  # literal '~/' prefix from sync-config.json
    if [[ $p == '~/'* ]]; then
        p="$HOME/${p#'~/'}"
    fi
    printf '%s' "$p"
}

# -- Picking files (--only) ---------------------------------------------------

# The repo paths picked with --only, filled by resolve_only. Empty means no pick.
declare -ga ONLY_PATHS=()

# normalize_path <absolute path>: drop empty and . segments and fold .. ones,
# lexically, without following links. Not realpath -m: BSD realpath lacks -m.
normalize_path() {
    local rest=$1 part
    local -a out=()
    while [[ -n $rest ]]; do
        part=${rest%%/*}
        if [[ $rest == */* ]]; then
            rest=${rest#*/}
        else
            rest=''
        fi
        case $part in
            ''|.) ;;
            ..) (( ${#out[@]} == 0 )) || unset 'out[-1]' ;;
            *) out+=("$part") ;;
        esac
    done
    local IFS=/
    printf '/%s' "${out[*]}"
}

# resolve_only <path>...: turn each repo or local path into the repo path it
# names, using the entries selected for this OS. A path that matches no entry
# stops the run before any file is touched.
resolve_only() {
    local -a e_repo=() e_local=() e_kind=()
    local repo_path local_path kind arg p found rest
    local i

    ONLY_PATHS=()

    # NUL-separated, not @tsv: a path can hold a backslash or a tab.
    while IFS= read -r -d '' repo_path && IFS= read -r -d '' local_path \
        && IFS= read -r -d '' kind; do
        e_repo+=("$repo_path")
        case $kind in
            dir)
                e_kind+=('dir')
                e_local+=("$(normalize_path "$(resolve_local "$local_path")")")
                ;;
            dconf)
                e_kind+=('dconf')
                e_local+=('')
                ;;
            *)
                e_kind+=('file')
                e_local+=("$(normalize_path "$(resolve_local "$local_path")")")
                ;;
        esac
    done < <(platform_entries | jq -j '.repoPath, "\u0000", (.localPath // ""), "\u0000",
        (.type // "file"), "\u0000"')

    for arg in "$@"; do
        p=$arg
        # A repo path keeps its form; only a trailing slash is dropped.
        while [[ $p == */ && $p != / ]]; do
            p=${p%/}
        done
        if [[ $p == dotfiles/* ]]; then
            found=0
            for i in "${!e_repo[@]}"; do
                if [[ $p == "${e_repo[$i]}" ]] \
                    || { [[ ${e_kind[$i]} == dir ]] && [[ $p == "${e_repo[$i]}/"* ]]; } \
                    || { [[ ${e_kind[$i]} == file ]] && [[ $p == "${e_repo[$i]}.linked/"* ]]; }; then
                    found=1
                    break
                fi
            done
            if (( ! found )); then
                printf 'ERROR: %s is not synced on this machine.\n' "$arg" >&2
                return 1
            fi
            ONLY_PATHS+=("$p")
            continue
        fi

        # Local path: expand ~, make it absolute against the caller's folder,
        # then normalize . and .. so it compares with the entries' paths.
        # shellcheck disable=SC2088  # a literal '~' typed by the caller
        case $p in
            '~') p=$HOME ;;
            '~/'*) p="$HOME/${p#'~/'}" ;;
        esac
        if [[ $p != /* ]]; then
            p="${SYNC_CALLER_PWD:-$PWD}/$p"
        fi
        p=$(normalize_path "$p")

        found=0
        for i in "${!e_repo[@]}"; do
            if [[ ${e_kind[$i]} != dconf && $p == "${e_local[$i]}" ]]; then
                ONLY_PATHS+=("${e_repo[$i]}")
                found=1
                break
            fi
        done
        (( found )) && continue
        for i in "${!e_repo[@]}"; do
            if [[ ${e_kind[$i]} == dir && $p == "${e_local[$i]}/"* ]]; then
                rest=${p#"${e_local[$i]}/"}
                ONLY_PATHS+=("${e_repo[$i]}/$rest")
                found=1
                break
            fi
        done
        if (( ! found )); then
            printf 'ERROR: %s is not synced on this machine.\n' "$arg" >&2
            return 1
        fi
    done
    return 0
}

# only_selected <repo_path>: true when no --only was given, or the path is one
# of them or sits inside one (including a linked folder of a file entry).
only_selected() {
    local repo_path=$1 selected
    [[ ${#ONLY_PATHS[@]} -gt 0 ]] || return 0
    for selected in "${ONLY_PATHS[@]}"; do
        if [[ $repo_path == "$selected" || $repo_path == "$selected/"* \
            || $repo_path == "$selected.linked/"* ]]; then
            return 0
        fi
    done
    return 1
}

declare -a EXCLUDES=()
if [[ -z ${SYNC_LIB_ONLY:-} ]]; then
    while IFS= read -r pattern; do
        if [[ -n $pattern ]]; then
            EXCLUDES+=("$pattern")
        fi
    done < <(jq -r '(.excludePatterns // []) | .[]' "$CONFIG")
fi
is_excluded() {
    local path=$1 leaf=${1##*/} pattern
    for pattern in "${EXCLUDES[@]}"; do
        # shellcheck disable=SC2053  # pattern is a glob on purpose
        if [[ $leaf == $pattern || $path == */$pattern ]]; then
            return 0
        fi
    done
    return 1
}

# -- Up-to-date check -----------------------------------------------------------

# Warn, or offer to pull, when the repo is behind origin/master. Silent unless
# the repo is a git work tree on master with an origin remote.
check_upstream() {
    local branch n answer

    GIT_TERMINAL_PROMPT=0 git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
    GIT_TERMINAL_PROMPT=0 git -C "$REPO_ROOT" remote get-url origin >/dev/null 2>&1 || return 0
    branch=$(GIT_TERMINAL_PROMPT=0 git -C "$REPO_ROOT" symbolic-ref --short -q HEAD 2>/dev/null) || return 0
    [[ $branch == master ]] || return 0

    if ! GIT_TERMINAL_PROMPT=0 git -C "$REPO_ROOT" fetch -q origin master 2>/dev/null; then
        printf '  NOTE: could not reach origin; skipping the up-to-date check.\n'
        return 0
    fi

    n=$(GIT_TERMINAL_PROMPT=0 git -C "$REPO_ROOT" rev-list --count HEAD..origin/master 2>/dev/null) || return 0
    if (( n == 0 )); then
        return 0
    fi

    if [[ ! -t 0 ]]; then
        printf '  WARNING: repo is %d commit(s) behind origin/master; run git pull --ff-only.\n' "$n"
        return 0
    fi

    printf '  Repo is %d commit(s) behind origin/master. Pull now (git pull --ff-only)? [Y/n] ' "$n"
    answer=''
    read -r answer || answer=''
    if [[ -z $answer || $answer == [Yy]* ]]; then
        if ! GIT_TERMINAL_PROMPT=0 git -C "$REPO_ROOT" pull --ff-only -q 2>/dev/null; then
            printf 'ERROR: pull failed; resolve it and rerun.\n' >&2
            exit 1
        fi
        printf '  Pulled %d commit(s); run the command again.\n' "$n"
        exit 0
    fi
    return 0
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
    # Tighten an existing file before writing, so new values never sit in a readable one.
    (
        umask 077
        if [[ -e $VALUES_FILE ]]; then
            chmod 600 "$VALUES_FILE"
        fi
        jq -S -n "${args[@]}" '$ARGS.named' > "$VALUES_FILE"
    )
}

# -- Value inference (import only) --------------------------------------------

# Fill USER_VALUES from an existing local file: where a repo line carries a
# placeholder that the matching local line does not, the local text between the
# repo line's prefix and suffix is that placeholder's value. Cached values win.
# Entries arrive as newline-delimited JSON (platform_entries output).
infer_values() {
    local entries=$1 entry repo_path local_path rules repo_file
    local repo_text local_text r l ph prefix suffix value
    local i count
    local -a repo_lines=() local_lines=()
    local -A escape=()

    [[ -n $entries ]] || return 0

    # Entries arrive on fd 3, so stdin stays free for anything the loop runs.
    while IFS= read -r entry <&3; do
        [[ -n $entry ]] || continue
        rules=$(jq -c '(.sanitizeRules // [])' <<<"$entry")
        [[ $rules != '[]' ]] || continue

        # Placeholders whose rule stores the backslash-doubled form in the file.
        escape=()
        while IFS= read -r -d '' ph; do
            escape[$ph]=1
        done < <(jq -j '.[] | select(.escapeBackslashes == true) | .placeholder, "\u0000"' <<<"$rules")

        repo_path=$(jq -r '.repoPath' <<<"$entry")
        local_path=$(resolve_local "$(jq -r '.localPath' <<<"$entry")")
        repo_file=$REPO_ROOT/$repo_path
        [[ -f $repo_file && -f $local_path ]] || continue

        read_text repo_text "$repo_file" || continue
        read_text local_text "$local_path" || continue

        mapfile -t repo_lines <<<"$repo_text"
        mapfile -t local_lines <<<"$local_text"
        count=${#repo_lines[@]}
        if (( ${#local_lines[@]} < count )); then
            count=${#local_lines[@]}
        fi

        for (( i = 0; i < count; i++ )); do
            r=${repo_lines[$i]%$'\r'}
            l=${local_lines[$i]%$'\r'}
            while IFS= read -r -d '' ph; do
                [[ -n $ph ]] || continue
                [[ $r == *"$ph"* ]] || continue
                [[ $l == *"$ph"* ]] && continue
                # Text before the first placeholder and after it, both literal.
                prefix=${r%%"$ph"*}
                suffix=${r#*"$ph"}
                [[ $l == "$prefix"* ]] || continue
                [[ $l == *"$suffix" ]] || continue
                (( ${#l} >= ${#prefix} + ${#suffix} )) || continue
                value=${l:${#prefix}:${#l}-${#prefix}-${#suffix}}
                # The file holds the doubled form, so undo it before caching.
                if [[ -n ${escape[$ph]:-} ]]; then
                    value=${value//\\\\/\\}
                fi
                if [[ -n $value && -z ${USER_VALUES[$ph]:-} ]]; then
                    USER_VALUES[$ph]=$value
                fi
            done < <(jq -j '.[] | .placeholder, "\u0000"' <<<"$rules")
        done
    done 3< <(printf '%s\n' "$entries")
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
        else
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
    local c=$1 rules=$2 ph v doubled
    # Longest value first, so a value that contains a shorter one is replaced whole.
    while IFS= read -r ph; do
        v=${USER_VALUES[$ph]}
        doubled=${v//\\/\\\\}
        # A config file may escape its backslashes (C:\\Tools): replace that form first.
        if [[ $doubled != "$v" ]]; then
            c=${c//"$doubled"/"$ph"}
        fi
        c=${c//"$v"/"$ph"}
    done < <(_placeholders_by_length "$rules")
    printf '%s' "$c"
}

hydrate() {
    local c=$1 rules=$2 ph v
    local -A escape=()
    # Placeholders whose rule asks for backslash-doubled values on the way back.
    while IFS= read -r -d '' ph; do
        escape[$ph]=1
    done < <(jq -j '.[] | select(.escapeBackslashes == true) | .placeholder, "\u0000"' <<<"$rules")

    while IFS= read -r ph; do
        v=${USER_VALUES[$ph]}
        if [[ -n ${escape[$ph]:-} && $v == *\\* ]]; then
            v=${v//\\/\\\\}
        fi
        c=${c//"$ph"/"$v"}
    done < <(_placeholders_by_length "$rules")
    printf '%s' "$c"
}

# -- Comparison ----------------------------------------------------------------

same_normalized() {
    local a=$1 b=$2
    a=${a//$'\r'/}
    b=${b//$'\r'/}
    a=${a%"${a##*[![:space:]]}"}
    b=${b%"${b##*[![:space:]]}"}
    [[ $a == "$b" ]]
}

# -- dconf ----------------------------------------------------------------------

# Keep the keys of a dump (stdin) that match an entry's "keys" patterns. A key's
# name is relative to the entry's path. The output keeps dconf's layout: a blank
# line between sections, and no section left without keys.
dconf_filter() {
    local -a patterns=()
    local line rel pattern section='' pending=0 first=1
    mapfile -d '' patterns < <(jq -j '.[] | ., "\u0000"' <<<"$1")
    while IFS= read -r line; do
        case $line in
            '') continue ;;
            '['*']') section=${line:1:-1}; pending=1; continue ;;
        esac
        rel=${line%%=*}
        [[ $section == / ]] || rel=$section/$rel
        for pattern in "${patterns[@]}"; do
            # shellcheck disable=SC2053  # pattern is a glob on purpose
            if [[ $rel == $pattern ]]; then
                if (( pending )); then
                    (( first )) || printf '\n'
                    printf '[%s]\n' "$section"
                    pending=0
                    first=0
                fi
                printf '%s\n' "$line"
                break
            fi
        done
    done
}

# dconf writes go over the session bus to a service that keeps the login
# session's HOME, so a throwaway HOME would still change the real desktop.
dconf_home_ok() {
    [[ $HOME == "$(getent passwd "$(id -u)" | cut -d: -f6)" ]]
}

# A dump reads the database file in this dir, but a load goes to the service, which
# keeps the session's own dir. With another dir, a dump comes back empty and a load
# still changes the desktop.
dconf_config_ok() {
    [[ ${XDG_CONFIG_HOME:-$HOME/.config} == "$HOME/.config" ]]
}

# One "[section] key=value" line per key, so two dumps compare key by key.
dconf_flat() {
    awk '/^\[.*\]$/ { s = $0; next } NF { print s " " $0 }'
}

# Keys in the repo file ($1) that the dump ($2) doesn't have with that value.
# Keys only the dump has don't count: dconf load leaves them alone.
dconf_unapplied() {
    LC_ALL=C comm -23 <(dconf_flat < "$1" | LC_ALL=C sort) <(dconf_flat <<<"$2" | LC_ALL=C sort)
}

# -- Package drift ---------------------------------------------------------------

# Names in a list: the first field of each line, without comments and blanks.
package_names() {
    [[ -f $1 ]] || return 0
    awk '!/^[[:space:]]*(#|$)/ { print $1 }' "$1" | LC_ALL=C sort -u
}

# Names drift-ignore.txt gives for one manager.
drift_ignored() {
    [[ -f $PACKAGES_DIR/drift-ignore.txt ]] || return 0
    awk -v m="$1" '$1 == m { print $2 }' "$PACKAGES_DIR/drift-ignore.txt" | LC_ALL=C sort -u
}

# Listed names ($3, sorted) that aren't present ($4).
drift_missing() {
    local manager=$1 list=$2 listed=$3 present=$4 name
    while IFS= read -r name; do
        [[ -z $name ]] || status DRIFT "$manager/$name" "in packages/linux/$list, not installed"
    done < <(LC_ALL=C comm -23 <(printf '%s\n' "$listed") <(printf '%s\n' "$present" | LC_ALL=C sort -u))
}

# Chosen names ($4) that are neither listed ($3) nor ignored.
drift_extra() {
    local manager=$1 list=$2 listed=$3 chosen=$4 name
    while IFS= read -r name; do
        [[ -z $name ]] || status DRIFT "$manager/$name" "installed, not in packages/linux/$list"
    done < <(LC_ALL=C comm -13 <(printf '%s\n%s\n' "$listed" "$(drift_ignored "$manager")" | LC_ALL=C sort -u) \
                               <(printf '%s\n' "$chosen" | LC_ALL=C sort -u))
}

# Installed npm packages under a node_modules dir: one @scope/name per scoped
# package, one name per plain package, and no dotfiles like .bin.
npm_packages() {
    local node_dir=$1 name sub
    [[ -d $node_dir ]] || return 0
    for name in "$node_dir"/*; do
        [[ -d $name ]] || continue
        name=${name##*/}
        [[ $name == .* ]] && continue
        if [[ $name == @* ]]; then
            for sub in "$node_dir/$name"/*; do
                [[ -d $sub ]] || continue
                sub=${sub##*/}
                [[ $sub == .* ]] && continue
                printf '%s/%s\n' "$name" "$sub"
            done
        else
            printf '%s\n' "$name"
        fi
    done | LC_ALL=C sort -u
}

# Installed apt package names from dpkg-query, LC_ALL=C sorted. Returns 1 when
# dpkg-query is missing or failed, so a caller can tell "none" from "unknown".
dpkg_installed() {
    local out
    if ! command -v dpkg-query >/dev/null 2>&1; then
        return 1
    fi
    if ! out=$(dpkg-query -W -f='${db:Status-Status} ${Package}\n' 2>/dev/null); then
        return 1
    fi
    awk '$1 == "installed" { print $2 }' <<<"$out" | LC_ALL=C sort -u
}

drift_apt() {
    local out present chosen apt_listed deb_listed listed
    apt_listed=$(package_names "$PACKAGES_DIR/apt.txt")
    deb_listed=$(package_names "$PACKAGES_DIR/deb.txt")
    listed=$(printf '%s\n%s\n' "$apt_listed" "$deb_listed" | LC_ALL=C sort -u)

    if ! command -v dpkg-query >/dev/null 2>&1; then
        status SKIPPED packages/linux/apt.txt 'dpkg-query not installed'
        return 0
    fi
    if ! present=$(dpkg_installed); then
        status SKIPPED packages/linux/apt.txt 'dpkg-query failed'
        return 0
    fi
    drift_missing apt apt.txt "$apt_listed" "$present"
    drift_missing apt deb.txt "$deb_listed" "$present"

    if ! command -v apt-mark >/dev/null 2>&1; then
        status SKIPPED packages/linux/apt.txt 'apt-mark not installed'
        return 0
    fi
    if ! out=$(apt-mark showmanual 2>/dev/null); then
        status SKIPPED packages/linux/apt.txt 'apt-mark failed'
        return 0
    fi
    chosen=$(awk -F: '{ print $1 }' <<<"$out" | LC_ALL=C sort -u)
    drift_extra apt apt.txt "$listed" "$chosen"
}

drift_snap() {
    local out present listed
    if ! command -v snap >/dev/null 2>&1; then
        status SKIPPED packages/linux/snap.txt 'snap not installed'
        return 0
    fi
    if ! out=$(snap list 2>/dev/null); then
        status SKIPPED packages/linux/snap.txt 'snap failed'
        return 0
    fi
    present=$(awk 'NR > 1 && $NF !~ /(^|,)(base|snapd)(,|$)/ { print $1 }' <<<"$out" | LC_ALL=C sort -u)
    listed=$(package_names "$PACKAGES_DIR/snap.txt")
    drift_missing snap snap.txt "$listed" "$present"
    drift_extra snap snap.txt "$listed" "$present"
}

drift_npm() {
    local nvm_dir newest node_dir listed present
    nvm_dir=$HOME/.nvm/versions/node
    if [[ ! -d $nvm_dir ]]; then
        status SKIPPED packages/linux/npm.txt 'nvm not installed'
        return 0
    fi
    newest=$(find "$nvm_dir" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort -V | tail -n 1) || newest=
    [[ -n $newest ]] || { status SKIPPED packages/linux/npm.txt 'nvm not installed'; return 0; }
    node_dir=$nvm_dir/$newest/lib/node_modules
    listed=$(package_names "$PACKAGES_DIR/npm.txt")
    present=$(npm_packages "$node_dir")
    drift_missing npm npm.txt "$listed" "$present"
    drift_extra npm npm.txt "$listed" "$present"
}

drift_pipx() {
    local out present listed
    if ! command -v pipx >/dev/null 2>&1; then
        status SKIPPED packages/linux/pipx.txt 'pipx not installed'
        return 0
    fi
    if ! out=$(pipx list --short 2>/dev/null); then
        status SKIPPED packages/linux/pipx.txt 'pipx failed'
        return 0
    fi
    present=$(awk '{ print $1 }' <<<"$out" | LC_ALL=C sort -u)
    listed=$(package_names "$PACKAGES_DIR/pipx.txt")
    drift_missing pipx pipx.txt "$listed" "$present"
    drift_extra pipx pipx.txt "$listed" "$present"
}

drift_vscode() {
    local out present listed
    if ! command -v code >/dev/null 2>&1; then
        status SKIPPED packages/linux/vscode-extensions.txt 'code not installed'
        return 0
    fi
    if ! out=$(code --list-extensions 2>/dev/null); then
        status SKIPPED packages/linux/vscode-extensions.txt 'code failed'
        return 0
    fi
    present=$(LC_ALL=C sort -u <<<"$out")
    listed=$(package_names "$PACKAGES_DIR/vscode-extensions.txt")
    drift_missing vscode vscode-extensions.txt "$listed" "$present"
    drift_extra vscode vscode-extensions.txt "$listed" "$present"
}

# Names of the folders directly inside a dir. A loose file isn't a package, and
# a missing dir means nothing is present, not a skipped tool.
drift_folders() {
    local dir=$1 name
    [[ -d $dir ]] || return 0
    for name in "$dir"/*; do
        [[ -d $name ]] || continue
        printf '%s\n' "${name##*/}"
    done | LC_ALL=C sort -u
}

drift_font() {
    local listed present
    listed=$(package_names "$PACKAGES_DIR/fonts.txt")
    present=$(drift_folders "$HOME/.local/share/fonts/NerdFonts")
    drift_missing font fonts.txt "$listed" "$present"
    drift_extra font fonts.txt "$listed" "$present"
}

drift_extension() {
    local listed present
    listed=$(package_names "$PACKAGES_DIR/gnome-extensions.txt")
    present=$(drift_folders "$HOME/.local/share/gnome-shell/extensions")
    drift_missing extension gnome-extensions.txt "$listed" "$present"
    drift_extra extension gnome-extensions.txt "$listed" "$present"
}

# Basenames of the files directly in a dir, optionally only *.sources/*.list.
drift_source_names() {
    local dir=$1 only_lists=${2:-} name
    [[ -d $dir ]] || return 0
    for name in "$dir"/*; do
        [[ -f $name ]] || continue
        if [[ -n $only_lists && $name != *.sources && $name != *.list ]]; then
            continue
        fi
        printf '%s\n' "${name##*/}"
    done | LC_ALL=C sort -u
}

drift_apt_source() {
    local repo_dir=$PACKAGES_DIR/apt-sources system_dir=$root/etc/apt/sources.list.d
    local listed present name
    listed=$(drift_source_names "$repo_dir" lists)
    present=$(drift_source_names "$system_dir")
    drift_missing apt-source apt-sources "$listed" "$present"
    drift_extra apt-source apt-sources "$listed" "$present"

    # A source that is present but can't be read counts as not installed.
    while IFS= read -r name; do
        [[ -z $name ]] && continue
        [[ -f $system_dir/$name ]] || continue
        if [[ ! -r $repo_dir/$name || ! -r $system_dir/$name ]]; then
            status DRIFT "apt-source/$name" 'in packages/linux/apt-sources, not installed'
        elif ! cmp -s "$repo_dir/$name" "$system_dir/$name"; then
            status DRIFT "apt-source/$name" 'differs from packages/linux/apt-sources'
        fi
    done <<<"$listed"
}

drift_apt_key() {
    local key_dir=$PACKAGES_DIR/apt-sources/keyrings path name target
    [[ -d $key_dir ]] || return 0
    for path in "$key_dir"/*.gpg; do
        [[ -f $path ]] || continue
        name=${path##*/}
        target=
        if [[ -f $root/usr/share/keyrings/$name ]]; then
            target=$root/usr/share/keyrings/$name
        elif [[ -f $root/etc/apt/keyrings/$name ]]; then
            target=$root/etc/apt/keyrings/$name
        fi
        if [[ -z $target || ! -r $path || ! -r $target ]]; then
            status DRIFT "apt-key/$name" 'in packages/linux/apt-sources, not installed'
        elif ! cmp -s "$path" "$target"; then
            status DRIFT "apt-key/$name" 'differs from packages/linux/apt-sources'
        fi
    done
}

# Report drift between the package lists and what this machine has installed.
# Report only: never writes a list, never changes a count or the exit code.
report_drift() {
    # The report reads apt-mark, snap and find -printf, so macOS skips it.
    if [[ $SYNC_PLATFORM == macos ]]; then
        return 0
    fi
    PACKAGES_DIR=$REPO_ROOT/packages/linux
    [[ -d $PACKAGES_DIR ]] || return 0
    root=${DRIFT_ROOT:-}
    drift_apt
    drift_snap
    drift_npm
    drift_pipx
    drift_vscode
    drift_font
    drift_extension
    drift_apt_source
    drift_apt_key
}

# -- Sync point ------------------------------------------------------------------

# Where this machine records the repo commit it last agreed with.
last_sync_file() {
    printf '%s\n' "${XDG_STATE_HOME:-$HOME/.local/state}/sync-settings/last-sync"
}

# Print the recorded SHA and return 0 when the file's first line is 40 hex
# characters and names a commit in this clone. Anything else is "no sync
# point": print nothing and return 1.
read_last_sync() {
    local file sha
    file=$(last_sync_file)
    [[ -f $file ]] || return 1
    IFS= read -r sha < "$file" || return 1
    [[ $sha =~ ^[0-9a-f]{40}$ ]] || return 1
    git -C "$REPO_ROOT" cat-file -e "${sha}^{commit}" 2>/dev/null || return 1
    printf '%s\n' "$sha"
}

# Record a SHA as this machine's sync point. A failure prints a WARNING and
# returns 0: the sync point is a convenience, never a reason to fail a run.
write_last_sync() {
    local sha=$1 file dir tmp
    file=$(last_sync_file)
    dir=${file%/*}
    tmp=$dir/.last-sync.$$
    if { mkdir -p "$dir" && printf '%s\n' "$sha" > "$tmp" && mv -f "$tmp" "$file"; } 2>/dev/null; then
        return 0
    fi
    rm -f "$tmp" 2>/dev/null || true
    printf '  WARNING: could not record the sync point in %s.\n' "$file"
    return 0
}

# -- Status output --------------------------------------------------------------

STATUS_ERRORS=0
STATUS_USER_SKIPS=0

status() {
    # usage: status <STATUS> <label> [note]
    # Counts ERROR lines in STATUS_ERRORS and SKIPPED lines noted "user skipped"
    # in STATUS_USER_SKIPS, so a caller can tell a clean, unattended run apart.
    local s=$1 label=$2 note=${3:-}
    if [[ $s == ERROR ]]; then
        STATUS_ERRORS=$((STATUS_ERRORS + 1))
    elif [[ $s == SKIPPED && $note == 'user skipped' ]]; then
        STATUS_USER_SKIPS=$((STATUS_USER_SKIPS + 1))
    fi
    printf '  %-10s %s%s\n' "$s" "$label" "${note:+  ($note)}"
}

# -- Orphan report --------------------------------------------------------------

# Every file under dotfiles/ that no entry owns. All platforms count, so both
# engines print the same list. Report only: never deletes, never changes the
# change count or the exit code.
report_orphans() {
    [[ -d $REPO_ROOT/dotfiles ]] || return 0

    local -a owned=() dir_prefixes=() linked_prefixes=()
    local p prefix is_owned

    # A file or dconf entry owns its repoPath exactly.
    while IFS= read -r -d '' p; do
        owned+=("$p")
    done < <(jq -j '.files[] | select(.type != "dir") | .repoPath, "\u0000"' "$CONFIG")
    # A dir entry owns everything under <repoPath>/.
    while IFS= read -r -d '' prefix; do
        dir_prefixes+=("$prefix")
    done < <(jq -j '.files[] | select(.type == "dir") | .repoPath + "/", "\u0000"' "$CONFIG")
    # An entry with detectLinkedPaths owns everything under <repoPath>.linked/.
    while IFS= read -r -d '' prefix; do
        linked_prefixes+=("$prefix")
    done < <(jq -j '.files[] | select(.detectLinkedPaths == true) | .repoPath + ".linked/", "\u0000"' "$CONFIG")

    while IFS= read -r -d '' p; do
        p=${p#"$REPO_ROOT"/}
        is_owned=0
        for prefix in "${owned[@]:-}"; do
            if [[ $p == "$prefix" ]]; then is_owned=1; break; fi
        done
        if (( ! is_owned )); then
            for prefix in "${dir_prefixes[@]:-}"; do
                # An empty array expands to one empty element; it must not own everything.
                [[ -n $prefix ]] || continue
                if [[ $p == "$prefix"* ]]; then is_owned=1; break; fi
            done
        fi
        if (( ! is_owned )); then
            for prefix in "${linked_prefixes[@]:-}"; do
                [[ -n $prefix ]] || continue
                if [[ $p == "$prefix"* ]]; then is_owned=1; break; fi
            done
        fi
        if (( ! is_owned )); then
            status ORPHAN "$p" 'no entry in sync-config.json; git rm it or add an entry'
        fi
    done < <(find "$REPO_ROOT/dotfiles" -type f -print0 | sort -z)
}

# -- Leak scan ------------------------------------------------------------------

# Run scripts/ci/leak-scan.sh over the given paths.
# Returns 0 when clean, 1 when it found a hit, 2 when it could not run (script
# missing or not executable, or any exit code other than 0 and 1).
run_leak_scan() {
    local scan=$REPO_ROOT/scripts/ci/leak-scan.sh code
    [[ -x $scan ]] || return 2
    if "$scan" "$@"; then
        return 0
    else
        code=$?
    fi
    if (( code == 1 )); then
        return 1
    fi
    return 2
}

# -- Export preview -------------------------------------------------------------

# Show what a real export would write to the repo, without touching the repo.
# Runs export.sh against a throwaway copy of dotfiles/ and diffs it against HEAD.
run_preview() {
    if ! git -C "$REPO_ROOT" rev-parse --verify -q HEAD >/dev/null 2>&1; then
        printf 'ERROR: --preview needs a git repo with a commit.\n' >&2
        exit 1
    fi

    PREVIEW_TMP=$(mktemp -d)
    trap 'rm -rf "$PREVIEW_TMP"' EXIT
    trap 'exit 130' INT TERM
    mkdir -p "$PREVIEW_TMP/before" "$PREVIEW_TMP/after"

    git -C "$REPO_ROOT" archive -o "$PREVIEW_TMP/before.tar" HEAD -- dotfiles sync-config.json
    tar -xf "$PREVIEW_TMP/before.tar" -C "$PREVIEW_TMP/before"

    cp -a "$REPO_ROOT/dotfiles" "$REPO_ROOT/sync-config.json" "$REPO_ROOT/export.sh" "$REPO_ROOT/scripts" "$PREVIEW_TMP/after/"
    if [[ -d $REPO_ROOT/packages ]]; then
        cp -a "$REPO_ROOT/packages" "$PREVIEW_TMP/after/"
    fi
    if [[ -f $REPO_ROOT/.user-values.json ]]; then
        cp -a "$REPO_ROOT/.user-values.json" "$PREVIEW_TMP/after/"
    fi

    (cd "$PREVIEW_TMP/after" && SYNC_PREVIEW=1 ./export.sh)

    cd "$PREVIEW_TMP"

    # Scan first: a hit must suppress the diff, which would print the leaked text.
    leak_found=0
    if run_leak_scan after/dotfiles after/sync-config.json; then
        printf '  Leak scan: clean.\n'
    else
        local code=$?
        if (( code == 1 )); then
            printf '  WARNING: the leak scan found the lines above. Fix them before committing.\n'
            leak_found=1
        else
            printf 'ERROR: leak scan could not run; nothing was committed.\n' >&2
            exit 1
        fi
    fi

    if (( leak_found == 0 )); then
        local path differed=0
        for path in dotfiles sync-config.json; do
            if git --no-pager diff --no-index --stat "before/$path" "after/$path"; then
                :
            else
                if (( $? > 1 )); then
                    printf 'ERROR: git diff failed.\n' >&2
                    exit 1
                fi
                differed=1
            fi
        done

        if (( differed )); then
            for path in dotfiles sync-config.json; do
                if git --no-pager diff --no-index "before/$path" "after/$path"; then
                    :
                else
                    if (( $? > 1 )); then
                        printf 'ERROR: git diff failed.\n' >&2
                        exit 1
                    fi
                fi
            done
        else
            printf '  Nothing would be sent: the repo matches HEAD.\n'
        fi
    fi

    printf '  Nothing was written. Run mksync push to send it.\n'

    return "$leak_found"
}

# -- Export diff ----------------------------------------------------------------

# True when two paths under the diff's trees hold the same version. A path
# absent on both sides counts as the same version.
diff_path_same() {
    local a=$1 b=$2
    if [[ -f $a && -f $b ]]; then
        cmp -s "$a" "$b"
    else
        [[ ! -e $a && ! -e $b ]]
    fi
}

# Show which side changed each file this OS owns: this machine, the sync point,
# and origin/master (or HEAD). Builds three trees in a temp folder and writes
# nothing outside it, ever.
# Exit: 0 when nothing differs, 3 when something does, 1 on an error.
run_diff() {
    if ! git -C "$REPO_ROOT" rev-parse --verify -q HEAD >/dev/null 2>&1; then
        printf 'ERROR: --diff needs a git repo with a commit.\n' >&2
        exit 1
    fi

    # Global on purpose: the EXIT trap needs it after this function returns.
    DIFF_TMP=$(mktemp -d)
    trap 'rm -rf "$DIFF_TMP"' EXIT
    trap 'exit 130' INT TERM
    mkdir -p "$DIFF_TMP/base" "$DIFF_TMP/theirs" "$DIFF_TMP/mine"

    local sync_sha='' have_base=0 repo_ref repo_sha last_line
    local entry repo_path entry_type path label prefix line tree
    local in_count=0 out_count=0 both_count=0 unknown_count=0
    local mine_base theirs_base hints

    # base: the tree this machine last agreed with (the sync point).
    if sync_sha=$(read_last_sync); then
        have_base=1
        if ! git -C "$REPO_ROOT" archive -o "$DIFF_TMP/base.tar" "$sync_sha" -- dotfiles; then
            printf 'ERROR: git archive failed for %s.\n' "$sync_sha" >&2
            exit 1
        fi
        tar -xf "$DIFF_TMP/base.tar" -C "$DIFF_TMP/base"
    fi

    # theirs: the repo's side. The engine never fetches.
    if git -C "$REPO_ROOT" rev-parse --verify -q origin/master >/dev/null 2>&1; then
        repo_ref=origin/master
    else
        repo_ref=HEAD
    fi
    repo_sha=$(git -C "$REPO_ROOT" log -1 --format=%h "$repo_ref")
    if ! git -C "$REPO_ROOT" archive -o "$DIFF_TMP/theirs.tar" "$repo_ref" -- dotfiles; then
        printf 'ERROR: git archive failed for %s.\n' "$repo_ref" >&2
        exit 1
    fi
    tar -xf "$DIFF_TMP/theirs.tar" -C "$DIFF_TMP/theirs"

    # With no sync point the repo's tree stands in for the base, so every
    # difference is machine against repo and no side can be called newer.
    if (( ! have_base )) && [[ -d $DIFF_TMP/theirs/dotfiles ]]; then
        cp -a "$DIFF_TMP/theirs/dotfiles" "$DIFF_TMP/base/"
    fi

    # mine: the base plus the current engine and config, then a preview export
    # inside it. A file export doesn't touch therefore still equals base.
    if [[ -d $DIFF_TMP/base/dotfiles ]]; then
        cp -a "$DIFF_TMP/base/dotfiles" "$DIFF_TMP/mine/"
    fi
    cp -a "$REPO_ROOT/sync-config.json" "$REPO_ROOT/export.sh" "$REPO_ROOT/scripts" "$DIFF_TMP/mine/"
    if [[ -d $REPO_ROOT/packages ]]; then
        cp -a "$REPO_ROOT/packages" "$DIFF_TMP/mine/"
    fi
    if [[ -f $REPO_ROOT/.user-values.json ]]; then
        cp -a "$REPO_ROOT/.user-values.json" "$DIFF_TMP/mine/"
    fi

    if ! (cd "$DIFF_TMP/mine" && SYNC_PREVIEW=1 ./export.sh) < /dev/null > "$DIFF_TMP/export.log" 2>&1; then
        cat "$DIFF_TMP/export.log"
        printf '  ERROR: the export for the diff failed; see above.\n' >&2
        exit 1
    fi

    # The paths this OS's entries own: a file or dconf entry its repoPath, a
    # file entry also its .linked/ prefix, a dir entry its folder prefix.
    local -a owned_exact=() owned_linked=() owned_dirs=()
    while IFS= read -r entry; do
        repo_path=$(jq -r '.repoPath' <<<"$entry")
        entry_type=$(jq -r '.type // "file"' <<<"$entry")
        if [[ $entry_type == dir ]]; then
            owned_dirs+=("$repo_path/")
        else
            owned_exact+=("$repo_path")
            if [[ $entry_type == file ]]; then
                owned_linked+=("$repo_path.linked/")
            fi
        fi
    done < <(platform_entries)

    printf '\n  SyncSettings -- DIFF (%s)\n\n' "$SYNC_PLATFORM"
    if (( have_base )); then
        last_line=$(git -C "$REPO_ROOT" log -1 --format='%h (%cs)' "$sync_sha")
    else
        last_line='none recorded on this machine'
    fi
    printf '  Last sync  : %s\n' "$last_line"
    printf '  Repo       : %s %s\n\n' "$repo_ref" "$repo_sha"

    local -a diff_lines=()
    while IFS= read -r path; do
        [[ -n $path ]] || continue

        local owned_here=0
        for prefix in "${owned_exact[@]:-}"; do
            if [[ -n $prefix && $path == "$prefix" ]]; then owned_here=1; break; fi
        done
        if (( ! owned_here )); then
            for prefix in "${owned_linked[@]:-}"; do
                if [[ -n $prefix && $path == "$prefix"* ]]; then owned_here=1; break; fi
            done
        fi
        if (( ! owned_here )); then
            for prefix in "${owned_dirs[@]:-}"; do
                if [[ -n $prefix && $path == "$prefix"* ]]; then owned_here=1; break; fi
            done
        fi
        (( owned_here )) || continue

        mine_base=0
        if diff_path_same "$DIFF_TMP/mine/$path" "$DIFF_TMP/base/$path"; then
            mine_base=1
        fi
        theirs_base=0
        if diff_path_same "$DIFF_TMP/theirs/$path" "$DIFF_TMP/base/$path"; then
            theirs_base=1
        fi

        label=''
        if (( have_base )); then
            if (( mine_base && theirs_base )); then
                :
            elif (( mine_base )); then
                label=IN
            elif (( theirs_base )); then
                label=OUT
            elif diff_path_same "$DIFF_TMP/mine/$path" "$DIFF_TMP/theirs/$path"; then
                # Both sides made the same change.
                :
            else
                label=BOTH
            fi
        elif ! diff_path_same "$DIFF_TMP/mine/$path" "$DIFF_TMP/theirs/$path"; then
            label='?'
        fi

        case $label in
            IN) in_count=$((in_count + 1)); diff_lines+=("IN $path") ;;
            OUT) out_count=$((out_count + 1)); diff_lines+=("OUT $path") ;;
            BOTH) both_count=$((both_count + 1)); diff_lines+=("BOTH $path") ;;
            '?') unknown_count=$((unknown_count + 1)); diff_lines+=("? $path") ;;
            '') ;;
        esac
    done < <(
        for tree in base theirs mine; do
            [[ -d $DIFF_TMP/$tree/dotfiles ]] || continue
            (cd "$DIFF_TMP/$tree" && find dotfiles -type f -print)
        done | LC_ALL=C sort -u
    )

    for line in "${diff_lines[@]:-}"; do
        [[ -n $line ]] || continue
        status "${line%% *}" "${line#* }"
    done
    if (( unknown_count + in_count + out_count + both_count > 0 )); then
        printf '\n'
    fi

    printf '  %s\n\n' "--------------------------------------------------"

    if (( in_count + out_count + both_count + unknown_count == 0 )); then
        printf '  This machine and the repo agree.\n\n'
        return 0
    fi

    if (( ! have_base )); then
        printf '  %d file(s) differ. No sync is recorded on this machine, so the newer side is unknown.\n' \
            "$unknown_count"
        printf '  Run mksync pull or mksync push once to record one.\n\n'
        return 3
    fi

    printf '  %d file(s) differ: %d in, %d out, %d both.\n' \
        "$((in_count + out_count + both_count))" "$in_count" "$out_count" "$both_count"
    hints=''
    if (( in_count > 0 )); then
        hints='IN: mksync pull takes them.'
    fi
    if (( out_count > 0 )); then
        hints="${hints:+$hints }OUT: mksync push sends them."
    fi
    if (( both_count > 0 )); then
        hints="${hints:+$hints }BOTH: changed on both sides; merge by hand."
    fi
    printf '  %s\n\n' "$hints"

    return 3
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

# Copy $1's mode onto $2 without GNU-only `chmod --reference`: stat -c is GNU,
# stat -f %Lp is BSD and macOS. -L follows a symlink, as `chmod --reference` did.
# $1=reference file, $2=target file.
copy_mode() {
    chmod "$(stat -L -c %a "$1" 2>/dev/null || stat -L -f %Lp "$1")" "$2"
}
