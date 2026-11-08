#!/usr/bin/env bash
# Front-door helpers for `sync`: status, doctor, and later setup, pull and push.
# Sourced after `cd` into the repo root; it defines functions and does no work.

# A value from the os-release file (`PRETTY_NAME`, `ID`), or `unknown`. The
# value may be quoted; SYNC_OS_RELEASE overrides the path.
front_os_release_value() {
    local key=$1 file=${SYNC_OS_RELEASE:-/etc/os-release} line value=''
    [[ -f $file ]] || { printf 'unknown'; return 0; }
    while IFS= read -r line || [[ -n $line ]]; do
        case $line in
            "$key="*) value=${line#*=} ;;
        esac
    done < "$file"
    value=${value%$'\r'}
    if [[ $value == \"*\" ]]; then
        value=${value#\"}
        value=${value%\"}
    elif [[ $value == \'*\' ]]; then
        value=${value#\'}
        value=${value%\'}
    fi
    printf '%s' "${value:-unknown}"
}

# Run git against the repo, never asking for credentials on a terminal.
front_git() {
    GIT_TERMINAL_PROMPT=0 git -C "$REPO_ROOT" "$@"
}

# The install hint for a missing package: the first package manager on PATH.
front_install_hint() {
    local pkg=$1
    if command -v apt-get > /dev/null 2>&1; then
        printf 'sudo apt-get install %s' "$pkg"
    elif command -v dnf > /dev/null 2>&1; then
        printf 'sudo dnf install %s' "$pkg"
    elif command -v pacman > /dev/null 2>&1; then
        printf 'sudo pacman -S %s' "$pkg"
    else
        printf 'your package manager'
    fi
}

# Print where this machine stands and the first command to run next.
front_status() {
    local pretty origin_text unsent_text machine_text next
    local is_git=0 has_origin=0 branch='' updates=0 unsent=0
    local machine_state=unknown machine_n='' tmp='' rc=0

    pretty=$(front_os_release_value PRETTY_NAME)

    if front_git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
        is_git=1
    fi

    if (( ! is_git )); then
        origin_text='not a git clone'
    elif ! front_git remote get-url origin > /dev/null 2>&1; then
        origin_text='no origin remote'
    else
        has_origin=1
        branch=$(front_git rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'unknown')
        if [[ $branch != master ]]; then
            origin_text="on branch $branch, not master"
        elif ! GIT_TERMINAL_PROMPT=0 timeout 15 git -C "$REPO_ROOT" fetch -q origin master > /dev/null 2>&1; then
            origin_text='offline, not checked'
        else
            updates=$(front_git rev-list --count HEAD..origin/master 2>/dev/null || printf '0')
            if (( updates > 0 )); then
                origin_text="$updates update(s) waiting"
            else
                origin_text='up to date'
            fi
        fi
    fi

    if (( ! is_git )); then
        unsent_text='not checked'
    else
        unsent=$(front_git status --porcelain -- dotfiles packages sync-config.json 2>/dev/null | wc -l)
        unsent=${unsent//[[:space:]]/}
        if (( unsent > 0 )); then
            unsent_text="$unsent changed file(s) not sent yet"
        else
            unsent_text='none'
        fi
    fi

    # The import check is read-only; keep its output only long enough to read
    # the summary line and find out how many files differ.
    tmp=$(mktemp) || tmp=''
    machine_text='not checked: run ./import.sh --check to see why'
    if [[ -n $tmp ]]; then
        rc=0
        "$REPO_ROOT/import.sh" --check < /dev/null > "$tmp" 2>&1 || rc=$?
        case $rc in
            0)
                machine_text='matches the repo'
                machine_state=match
                ;;
            3)
                machine_n=$(sed -n 's/^  \([0-9][0-9]*\) file(s) would change\..*/\1/p' "$tmp" | head -n 1)
                if [[ -n $machine_n ]]; then
                    machine_text="$machine_n file(s) differ from the repo"
                    machine_state=differ
                fi
                ;;
        esac
        rm -f "$tmp"
    fi

    if (( ! is_git || ! has_origin )); then
        next='run mksync doctor.'
    elif (( updates > 0 )); then
        next='mksync pull'
    elif (( unsent > 0 )); then
        next='mksync push'
    elif [[ $machine_state == differ ]]; then
        next="mksync pull to take the repo's version, or mksync push to send this machine's."
    else
        next='nothing to do.'
    fi

    printf '\n'
    printf '  SyncSettings  linux (%s)\n' "$pretty"
    printf '  %-10s: %s\n' 'Repo' "$REPO_ROOT"
    printf '  %-10s: %s\n' 'Origin' "$origin_text"
    printf '  %-10s: %s\n' 'Unsent' "$unsent_text"
    printf '  %-10s: %s\n' 'Machine' "$machine_text"
    printf '\n'
    printf '  Next: %s\n' "$next"
    return 0
}

# One OK, WARN or MISSING line per check. Returns 1 when a MISSING line printed.
front_doctor() {
    local missing=0 tool pkg hint gh_bin version count
    local config values_file link_path repo_link placeholder

    version=${BASH_VERSION:-unknown}
    if (( BASH_VERSINFO[0] >= 4 )); then
        printf '  %-8s %s\n' OK "bash $version"
    else
        printf '  %-8s %s\n' MISSING "bash 4 or newer (this is $version)"
        missing=1
    fi

    for tool in git jq cmp; do
        pkg=$tool
        if [[ $tool == cmp ]]; then
            pkg=diffutils
        fi
        if command -v "$tool" > /dev/null 2>&1; then
            printf '  %-8s %s\n' OK "$tool"
        else
            hint=$(front_install_hint "$pkg")
            printf '  %-8s %s\n' MISSING "$tool: install with $hint"
            missing=1
        fi
    done

    gh_bin=${GH:-gh}
    if ! command -v "$gh_bin" > /dev/null 2>&1; then
        printf '  %-8s %s\n' WARN 'gh: needed for push; see https://cli.github.com'
    elif "$gh_bin" auth status > /dev/null 2>&1; then
        printf '  %-8s %s\n' OK 'gh (signed in)'
    else
        printf '  %-8s %s\n' WARN 'gh: not signed in; run gh auth login'
    fi

    if front_git remote get-url origin > /dev/null 2>&1; then
        printf '  %-8s %s\n' OK 'repo clone with origin'
    else
        printf '  %-8s %s\n' WARN 'repo has no origin remote'
    fi

    link_path=''
    repo_link=$(readlink -f "$REPO_ROOT/sync" 2>/dev/null || true)
    if command -v mksync > /dev/null 2>&1; then
        link_path=$(readlink -f "$(command -v mksync)" 2>/dev/null || true)
    fi
    if [[ -n $link_path && $link_path == "$repo_link" ]]; then
        printf '  %-8s %s\n' OK 'mksync on PATH'
    else
        printf '  %-8s %s\n' WARN "mksync not on PATH; run: ln -s \"$REPO_ROOT/sync\" ~/.local/bin/mksync"
    fi

    if command -v jq > /dev/null 2>&1; then
        config=$REPO_ROOT/sync-config.json
        values_file=$REPO_ROOT/.user-values.json
        count=0
        if [[ -f $config ]]; then
            while IFS= read -r -d '' placeholder; do
                if [[ ! -f $values_file ]] ||
                    ! jq -e --arg p "$placeholder" 'has($p) and (.[$p] | tostring | length > 0)' \
                        "$values_file" > /dev/null 2>&1; then
                    count=$((count + 1))
                fi
            done < <(jq -j '[.files[]
                | select(.platform == "linux" or .platform == "common")
                | (.sanitizeRules // [])[]
                | select(((.default // "") | tostring) == ""
                    and ((.defaultEnv // "") | tostring) == "")
                | .placeholder] | unique[] | ., "\u0000"' "$config" 2>/dev/null)
        fi
        if (( count > 0 )); then
            printf '  %-8s %s\n' WARN "$count value(s) not set; mksync setup asks for them"
        else
            printf '  %-8s %s\n' OK 'values'
        fi
    fi

    if (( missing )); then
        printf '  Fix the MISSING items, then run mksync doctor again.\n'
        return 1
    fi
    printf '  Ready.\n'
    return 0
}
