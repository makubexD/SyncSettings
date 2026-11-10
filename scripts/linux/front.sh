#!/usr/bin/env bash
# Front-door helpers for `sync`: status, doctor, and later setup, pull and push.
# Sourced after `cd` into the repo root; it defines functions and does no work.

# OS detection, shared with the engine.
FRONT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/linux/os.sh
source "$FRONT_DIR/os.sh"

# The system this run is for, resolved once from SYNC_OS or uname -s.
if ! SYNC_PLATFORM=$(sync_os); then
    exit 1
fi

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
# The recorded sync point, or nothing. read_last_sync lives in the engine; run
# it in its own shell so the engine's globals and shell options stay out.
front_sync_point() {
    (cd "$REPO_ROOT" && SYNC_LIB_ONLY=1 "${BASH:-bash}" -c \
        'source scripts/linux/sync.sh && read_last_sync' 2>/dev/null) || true
}

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
        sleep "$secs" &
        s=$!
        trap 'kill "$s" 2>/dev/null; exit 0' TERM
        wait "$s"
        kill "$pid" 2>/dev/null
    ) &
    watcher=$!
    wait "$pid" || rc=$?
    if kill -0 "$watcher" 2>/dev/null; then
        # The command finished first: stop the watcher and keep its status.
        kill "$watcher" 2>/dev/null || true
        wait "$watcher" 2>/dev/null || true
        return "$rc"
    fi
    return 124
}

# The install hint for a missing package: the first package manager on PATH.
front_install_hint() {
    local pkg=$1
    if [[ $SYNC_PLATFORM == macos ]]; then
        # cmp ships with macOS; doctor asks for diffutils, which brew has too.
        printf 'brew install %s' "$pkg"
    elif command -v apt-get > /dev/null 2>&1; then
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
    local sync_sha='' diff_tmp='' diff_rc=0 diff_summary='' diff_in='' diff_out='' diff_both=''
    local differ_next="mksync pull to take the repo's version, or mksync push to send this machine's."

    if [[ $SYNC_PLATFORM == macos ]]; then
        pretty=$(sw_vers -productVersion 2>/dev/null || printf 'unknown')
    else
        pretty=$(front_os_release_value PRETTY_NAME)
    fi

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

    # With a sync point, the diff says which side changed the differing files,
    # so the machine line can give the split and the next step can be exact.
    # No sync point, a failed diff or a diff that agrees keeps the text above.
    if [[ $machine_state == differ ]]; then
        sync_sha=$(front_sync_point)
        if [[ -n $sync_sha ]]; then
            diff_tmp=$(mktemp) || diff_tmp=''
            if [[ -n $diff_tmp ]]; then
                diff_rc=0
                "$REPO_ROOT/export.sh" --diff < /dev/null > "$diff_tmp" 2>&1 || diff_rc=$?
                if (( diff_rc == 3 )) &&
                    diff_summary=$(sed -nE \
                        's/^  ([0-9]+ file\(s\) differ: ([0-9]+) in, ([0-9]+) out, ([0-9]+) both)\.$/\1|\2|\3|\4/p' \
                        "$diff_tmp" | head -n 1) &&
                    [[ -n $diff_summary ]]; then
                    IFS='|' read -r machine_text diff_in diff_out diff_both <<< "$diff_summary"
                    if (( diff_both > 0 || (diff_in > 0 && diff_out > 0) )); then
                        differ_next='mksync diff, then push or pull file by file.'
                    elif (( diff_out > 0 )); then
                        differ_next='mksync push'
                    elif (( diff_in > 0 )); then
                        differ_next='mksync pull'
                    fi
                fi
                rm -f "$diff_tmp"
            fi
        fi
    fi

    if (( ! is_git || ! has_origin )); then
        next='run mksync doctor.'
    elif (( updates > 0 )); then
        next='mksync pull'
    elif (( unsent > 0 )); then
        next='mksync push'
    elif [[ $machine_state == differ ]]; then
        next=$differ_next
    elif [[ $machine_state == unknown ]]; then
        next='the machine check failed; run ./import.sh --check to see why.'
    else
        next='nothing to do.'
    fi

    printf '\n'
    printf '  SyncSettings  %s (%s)\n' "$SYNC_PLATFORM" "$pretty"
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

# Show which side changed each file, after a fetch so the repo side is current.
# The fetch has the status's timeout; offline keeps comparing with the last one.
# Anything not starting with "-" is a path to pick; the engines resolve it.
front_diff() {
    local -a only=()

    while (( $# > 0 )); do
        case $1 in
            -*)
                printf 'Unknown option: %s\n' "$1" >&2
                exit 1
                ;;
            *)
                only+=(--only "$1")
                shift
                ;;
        esac
    done

    if front_git remote get-url origin > /dev/null 2>&1; then
        if ! GIT_TERMINAL_PROMPT=0 run_with_timeout "${SYNC_FETCH_TIMEOUT:-15}" \
            git -C "$REPO_ROOT" fetch -q origin master > /dev/null 2>&1; then
            printf '  Offline: comparing with the last fetch.\n'
        fi
    fi
    exec "$REPO_ROOT/export.sh" --diff "${only[@]}"
}

# Get the latest repo and apply it here: fetch, fast-forward, rerun this to run
# the new code, then the import check and, unless declined, the import.
front_pull() {
    local apply_yes=0 no_fetch=0 force=0 updates answer='' rc=0 point=''
    local diff_tmp='' diff_rc=0 blocked='' count=0
    local -a paths=() only=()

    while (( $# > 0 )); do
        case $1 in
            --yes) apply_yes=1; shift ;;
            --no-fetch) no_fetch=1; shift ;;
            --force) force=1; shift ;;
            -*)
                printf 'Unknown option: %s\n' "$1" >&2
                exit 1
                ;;
            *)
                # The re-exec after a git pull starts in the repo, so a relative
                # path is made absolute against the caller's folder here.
                # shellcheck disable=SC2088  # a literal '~/' typed by the caller
                case $1 in
                    /*|'~'|'~/'*|dotfiles/*) paths+=("$1") ;;
                    *) paths+=("${SYNC_CALLER_PWD:-$PWD}/$1") ;;
                esac
                only+=(--only "${paths[-1]}")
                shift
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
                if (( force )); then
                    exec "$REPO_ROOT/sync" pull --no-fetch --yes --force "${paths[@]}"
                fi
                exec "$REPO_ROOT/sync" pull --no-fetch --yes "${paths[@]}"
            fi
            if (( force )); then
                exec "$REPO_ROOT/sync" pull --no-fetch --force "${paths[@]}"
            fi
            exec "$REPO_ROOT/sync" pull --no-fetch "${paths[@]}"
        fi
    fi

    "$REPO_ROOT/import.sh" --check "${only[@]}" < /dev/null || rc=$?
    case $rc in
        0)
            # Nothing to overwrite, but a full import still records the sync
            # point, so this machine stops reading '?' in the next diff.
            if (( ${#paths[@]} == 0 )); then
                exec "$REPO_ROOT/import.sh" --force < /dev/null
            fi
            exit 0
            ;;
        3) ;;
        *) exit 1 ;;
    esac

    point=$(front_sync_point)

    # With no sync point every diff label is '?', so the pull can't tell which
    # side changed these files. Refuse under --yes, and ask with the default
    # no when interactive.
    if (( ! force )) && [[ -z $point ]]; then
        if (( apply_yes )); then
            printf "  ERROR: no sync is recorded on this machine, so a pull can't tell which side changed these files.\n" >&2
            printf '  Run mksync diff, then mksync push, mksync pull <path> without --yes, or mksync pull --force (each keeps a .bak).\n' >&2
            exit 1
        fi
        printf '  No sync is recorded on this machine: if you changed these files here, a pull overwrites them (each keeps a .bak).\n'
        printf '  Apply these changes? [y/N] '
        read -r answer || answer=''
        if [[ $answer != [Yy]* ]]; then
            printf '  Nothing applied.\n'
            exit 0
        fi
        exec "$REPO_ROOT/import.sh" --force "${only[@]}"
    fi

    # A pull overwrites this machine's version of every changed file, so ask
    # the diff which side changed them first. OUT and BOTH would be lost.
    if (( ! force )) && [[ -n $point ]]; then
        diff_tmp=$(mktemp) || diff_tmp=''
        if [[ -z $diff_tmp ]]; then
            printf '  ERROR: could not tell which side is newer; run mksync diff to see why, or mksync pull --force.\n' >&2
            exit 1
        fi
        diff_rc=0
        "$REPO_ROOT/export.sh" --diff "${only[@]}" < /dev/null > "$diff_tmp" 2>&1 || diff_rc=$?
        blocked=$(grep -E '^  (OUT|BOTH) ' "$diff_tmp" || true)
        rm -f "$diff_tmp"
        case $diff_rc in
            0|3) ;;
            *)
                printf '  ERROR: could not tell which side is newer; run mksync diff to see why, or mksync pull --force.\n' >&2
                exit 1
                ;;
        esac
        if [[ -n $blocked ]]; then
            printf '%s\n' "$blocked"
            count=$(printf '%s\n' "$blocked" | wc -l)
            count=${count//[[:space:]]/}
            printf '  ERROR: %s file(s) changed on this machine since the last sync, and a pull would overwrite them.\n' "$count" >&2
            printf '  Run mksync push first, or mksync pull --force to overwrite them (each keeps a .bak).\n' >&2
            exit 1
        fi
    fi

    if (( ! apply_yes )); then
        printf '  Apply these changes? [Y/n] '
        read -r answer || answer=''
        if [[ -n $answer && $answer != [Yy]* ]]; then
            printf '  Nothing applied.\n'
            exit 0
        fi
    fi

    exec "$REPO_ROOT/import.sh" --force "${only[@]}"
}

# Send this machine's changes as a PR: export, show the diff and, unless
# declined, run the commit flow.
front_push() {
    local apply_yes=0 message='' answer='' changes='' rc=0
    local -a paths=() only=() commit_args=()

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
            -*)
                printf 'Unknown option: %s\n' "$1" >&2
                exit 1
                ;;
            *)
                paths+=("$1")
                only+=(--only "$1")
                shift
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
    "$REPO_ROOT/export.sh" "${only[@]}" || rc=$?
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

    # Picked files only: the commit covers part of the repo, so no sync point.
    if (( ${#paths[@]} > 0 )); then
        commit_args+=(--partial)
    fi

    if [[ -n $message ]]; then
        exec "$REPO_ROOT/commit.sh" -m "$message" "${commit_args[@]}"
    fi
    exec "$REPO_ROOT/commit.sh" "${commit_args[@]}"
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

    if (( bootstrap )) && [[ $SYNC_PLATFORM == macos ]]; then
        printf 'ERROR: --bootstrap is Ubuntu only.\n' >&2
        exit 1
    fi

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
    if [[ $SYNC_PLATFORM == linux && $os_id == ubuntu && -x $REPO_ROOT/bootstrap/linux.sh ]]; then
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
    local config values_file link_path repo_link placeholder macos_version major

    version=${BASH_VERSION:-unknown}
    if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
        printf '  %-8s %s\n' OK "bash $version"
    else
        hint=''
        if [[ $SYNC_PLATFORM == macos ]]; then
            hint="; install with $(front_install_hint bash)"
        fi
        printf '  %-8s %s\n' MISSING "bash 4.4 or newer (this is $version)$hint"
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

    if [[ $SYNC_PLATFORM == macos ]]; then
        if command -v brew > /dev/null 2>&1; then
            printf '  %-8s %s\n' OK 'brew'
        else
            printf '  %-8s %s\n' MISSING 'brew: install from https://brew.sh'
            missing=1
        fi

        macos_version=$(sw_vers -productVersion 2>/dev/null || true)
        major=${macos_version%%.*}
        if [[ $major =~ ^[0-9]+$ ]] && (( major < 13 )); then
            printf '  %-8s %s\n' WARN "macOS $macos_version is older than 13"
        fi
    fi

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
