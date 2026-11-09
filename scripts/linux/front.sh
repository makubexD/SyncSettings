#!/usr/bin/env bash
# Front-door helpers for `sync`: status, doctor, and later setup, pull and push.
# Sourced after `cd` into the repo root; it defines functions and does no work.

# OS detection, shared with the engine.
FRONT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/linux/os.sh
source "$FRONT_DIR/os.sh"

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

# Run a command with a time limit, returning 124 on timeout like `timeout`.
# macOS has no `timeout`, so the fallback runs the command in the background
# and a watcher kills it after the limit.
run_with_timeout() {
    local secs=$1
    shift

    if command -v timeout > /dev/null 2>&1; then
        timeout "$secs" "$@"
        return
    fi

    local pid watcher rc=0
    "$@" &
    pid=$!
    (
        sleep "$secs"
        kill "$pid" 2>/dev/null
    ) &
    watcher=$!
    wait "$pid" || rc=$?
    if kill -0 "$watcher" 2>/dev/null; then
        # The command finished first: stop the watcher and keep its status.
        kill "$watcher" 2>/dev/null || true
        return "$rc"
    fi
    return 124
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
        elif ! GIT_TERMINAL_PROMPT=0 run_with_timeout "${SYNC_FETCH_TIMEOUT:-15}" git -C "$REPO_ROOT" fetch -q origin master > /dev/null 2>&1; then
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
        unsent=$(front_git status --porcelain --untracked-files=all -- dotfiles packages sync-config.json 2>/dev/null | wc -l)
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

# Pull and push only make sense in the clone, on master, with somewhere to
# fetch from and push to. Prints the error and exits 1 otherwise.
front_require_clone() {
    local command=$1 branch=''

    if ! front_git rev-parse --is-inside-work-tree > /dev/null 2>&1 ||
        ! front_git remote get-url origin > /dev/null 2>&1; then
        printf 'ERROR: %s needs the repo clone on master with an origin remote.\n' "$command" >&2
        exit 1
    fi

    branch=$(front_git rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'unknown')
    if [[ $branch != master ]]; then
        printf 'ERROR: %s needs the repo clone on master with an origin remote.\n' "$command" >&2
        exit 1
    fi
}

# Get the latest repo and apply it here: fetch, fast-forward, rerun this to run
# the new code, then the import check and, unless declined, the import.
front_pull() {
    local apply_yes=0 no_fetch=0 updates answer='' rc=0

    while (( $# > 0 )); do
        case $1 in
            --yes) apply_yes=1; shift ;;
            --no-fetch) no_fetch=1; shift ;;
            *)
                printf 'Unknown option: %s\n' "$1" >&2
                exit 1
                ;;
        esac
    done

    front_require_clone pull

    if [[ -n $(front_git status --porcelain -- dotfiles packages sync-config.json 2>/dev/null) ]]; then
        printf 'ERROR: the repo has changes not sent yet; run mksync push first, or git restore them.\n' >&2
        exit 1
    fi

    if (( ! no_fetch )); then
        if ! front_git fetch -q origin master; then
            printf 'ERROR: could not reach origin.\n' >&2
            exit 1
        fi
        updates=$(front_git rev-list --count HEAD..origin/master 2>/dev/null || printf '0')
        if (( updates > 0 )); then
            if ! front_git pull --ff-only -q; then
                printf 'ERROR: pull failed; resolve it and rerun.\n' >&2
                exit 1
            fi
            printf '  Pulled %s commit(s).\n' "$updates"
            # Run the just-pulled code, not the copy this process started with.
            if (( apply_yes )); then
                exec "$REPO_ROOT/sync" pull --no-fetch --yes
            fi
            exec "$REPO_ROOT/sync" pull --no-fetch
        fi
    fi

    "$REPO_ROOT/import.sh" --check < /dev/null || rc=$?
    case $rc in
        0) exit 0 ;;
        3) ;;
        *) exit 1 ;;
    esac

    if (( ! apply_yes )); then
        printf '  Apply these changes? [Y/n] '
        read -r answer || answer=''
        if [[ -n $answer && $answer != [Yy]* ]]; then
            printf '  Nothing applied.\n'
            exit 0
        fi
    fi

    exec "$REPO_ROOT/import.sh" --force
}

# Send this machine's changes as a PR: export, show the diff and, unless
# declined, run the commit flow.
front_push() {
    local apply_yes=0 message='' answer='' changes='' rc=0

    while (( $# > 0 )); do
        case $1 in
            --yes) apply_yes=1; shift ;;
            -m)
                if (( $# < 2 )); then
                    printf 'Missing value for -m\n' >&2
                    exit 1
                fi
                message=$2
                shift 2
                ;;
            *)
                printf 'Unknown option: %s\n' "$1" >&2
                exit 1
                ;;
        esac
    done

    front_require_clone push

    # A repo behind origin would make export.sh offer its own pull and stop, and
    # push would then report nothing to send. Ask for a pull first instead.
    if front_git fetch -q origin master 2>/dev/null &&
        (( $(front_git rev-list --count HEAD..origin/master 2>/dev/null || printf '0') > 0 )); then
        printf 'ERROR: origin has updates; run mksync pull first.\n' >&2
        exit 1
    fi

    # Stdin stays attached so export.sh can ask for missing values.
    rc=0
    "$REPO_ROOT/export.sh" || rc=$?
    if (( rc != 0 )); then
        exit "$rc"
    fi

    changes=$(front_git status --porcelain -- dotfiles packages sync-config.json 2>/dev/null || true)
    if [[ -z $changes ]]; then
        printf '  Nothing to send: the repo matches this machine.\n'
        exit 0
    fi

    front_git status --short -- dotfiles packages sync-config.json || true

    if (( ! apply_yes )); then
        printf '  Open a PR with these changes? [Y/n] '
        read -r answer || answer=''
        if [[ -n $answer && $answer != [Yy]* ]]; then
            printf '  Kept in the repo. Run mksync push again, or git restore dotfiles to drop them.\n'
            exit 0
        fi
    fi

    if [[ -n $message ]]; then
        exec "$REPO_ROOT/commit.sh" -m "$message"
    fi
    exec "$REPO_ROOT/commit.sh"
}

# First run on this machine: doctor, the read-only import check, the optional
# Ubuntu bootstrap, then apply the check's changes unless declined. `--yes`
# answers the apply question only; bootstrap uses sudo, so it takes --bootstrap
# or a real yes.
front_setup() {
    local apply_yes=0 bootstrap=0 apply=1 answer='' rc=0 os_id='' check_rc=0

    while (( $# > 0 )); do
        case $1 in
            --yes) apply_yes=1; shift ;;
            --bootstrap) bootstrap=1; shift ;;
            *)
                printf 'Unknown option: %s\n' "$1" >&2
                exit 1
                ;;
        esac
    done

    rc=0
    front_doctor || rc=$?
    if (( rc != 0 )); then
        exit 1
    fi

    rc=0
    "$REPO_ROOT/import.sh" --check < /dev/null || rc=$?
    case $rc in
        0|3) check_rc=$rc ;;
        *) exit 1 ;;
    esac

    os_id=$(front_os_release_value ID)
    if [[ $os_id == ubuntu && -x $REPO_ROOT/bootstrap/linux.sh ]]; then
        if (( bootstrap )); then
            exec "$REPO_ROOT/bootstrap/linux.sh"
        fi
        printf '  Also restore apps and packages from packages/linux (uses sudo)? [y/N] '
        read -r answer || answer=''
        if [[ -n $answer && $answer == [Yy]* ]]; then
            exec "$REPO_ROOT/bootstrap/linux.sh"
        fi
    fi

    if (( check_rc == 3 )); then
        if (( ! apply_yes )); then
            printf '  Apply these changes? [Y/n] '
            read -r answer || answer=''
            if [[ -n $answer && $answer != [Yy]* ]]; then
                printf '  Nothing applied.\n'
                apply=0
            fi
        fi
        if (( apply )); then
            rc=0
            "$REPO_ROOT/import.sh" --force || rc=$?
            if (( rc != 0 )); then
                exit "$rc"
            fi
        fi
    fi

    printf '  Setup done. Run mksync any time to see where this machine stands.\n'
    return 0
}

# One OK, WARN or MISSING line per check. Returns 1 when a MISSING line printed.
front_doctor() {
    local missing=0 tool pkg hint gh_bin version count sync_platform
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

    if command -v jq > /dev/null 2>&1 && sync_platform=$(sync_os 2>/dev/null); then
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
            done < <(jq -j --arg os "$sync_platform" "$PLATFORM_SELECT_JQ"' [.files[]
                | select(selected($os))
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
