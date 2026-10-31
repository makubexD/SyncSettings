#!/usr/bin/env bash
# Shared helpers for the bash entry points (export.sh / import.sh / commit.sh).
# Source this file after cd-ing to the repo root. Never execute it directly.

set -euo pipefail

REPO_ROOT=$PWD
CONFIG=$REPO_ROOT/sync-config.json
VALUES_FILE=$REPO_ROOT/.user-values.json

declare -A USER_VALUES=()

# -- Config -------------------------------------------------------------------

# Every entry must name one of the three platforms. Stop before any file is touched.
check_platforms() {
    local repo_path
    while IFS= read -r -d '' repo_path; do
        printf 'ERROR: sync-config.json: entry %s needs "platform": "common", "windows" or "linux".\n' "$repo_path" >&2
        exit 1
    done < <(jq -j '.files[]
        | select((.platform == "common" or .platform == "windows" or .platform == "linux") | not)
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

    # A dconf entry has no local file: it owns its repoPath and names a dconf
    # folder instead. Refuse a bad one before anything is dumped or loaded.
    while IFS= read -r -d '' repo_path && IFS= read -r -d '' dconf_path \
        && IFS= read -r -d '' platform; do
        path_is_safe "$repo_path" repo || path_fail "$repo_path"
        [[ $platform == linux ]] || dconf_fail "$repo_path"
        [[ $dconf_path =~ ^(/[A-Za-z0-9._-]+)+/$ ]] || dconf_fail "$repo_path"
        [[ $dconf_path != */../* ]] || dconf_fail "$repo_path"
    done < <(jq -j '.files[] | select(.type == "dconf")
        | (.repoPath // ""), "\u0000", (.path // ""), "\u0000", (.platform // ""), "\u0000"' "$CONFIG")

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

check_platforms
check_paths

platform_entries() {
    jq -c '.files[] | select(.platform == "linux" or .platform == "common")' "$CONFIG"
}

resolve_local() {
    local p=$1
    # shellcheck disable=SC2088  # literal '~/' prefix from sync-config.json
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

# -- Status output --------------------------------------------------------------

status() {
    # usage: status <STATUS> <label> [note]
    local s=$1 label=$2 note=${3:-}
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

    printf '  Nothing was written. Run ./export.sh to apply.\n'

    return "$leak_found"
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
