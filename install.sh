#!/usr/bin/env bash
# Install or update SyncSettings on Linux: clone the repo (or fast-forward an
# existing clone), link mksync, then run setup. Designed to be piped into bash,
# so every line is a function definition and the last line runs the installer.
set -euo pipefail

usage() {
    printf 'usage: install.sh [--yes] [--no-setup]\n'
    printf '  --yes       answer yes to the questions\n'
    printf '  --no-setup  clone and link mksync, but do not run setup\n'
}

# The file the questions are read from: SYNCSETTINGS_TTY when set, else stdin
# when it is a terminal, else /dev/tty when it is readable, else /dev/null.
resolve_tty() {
    if [[ -n ${SYNCSETTINGS_TTY:-} ]]; then
        printf '%s' "$SYNCSETTINGS_TTY"
    elif [[ -t 0 ]]; then
        printf '/dev/stdin'
    elif { : < /dev/tty; } 2> /dev/null; then
        # -r passes without a controlling terminal; opening it is the real test.
        printf '/dev/tty'
    else
        printf '/dev/null'
    fi
}

# Read one answer from the answers source into $REPLY. Returns 1 at EOF, when
# nobody can answer, with REPLY empty.
read_answer() {
    local tty=$1
    REPLY=''
    if ! read -r REPLY 2> /dev/null < "$tty"; then
        REPLY=''
        return 1
    fi
}

# Stop on anything that isn't Linux.
check_platform() {
    local kernel
    kernel=$(uname -s 2> /dev/null || printf 'unknown')
    case $kernel in
        Linux) ;;
        Darwin)
            printf "ERROR: macOS isn't supported yet.\n" >&2
            exit 1
            ;;
        MINGW*|MSYS*|CYGWIN*)
            printf 'ERROR: on Windows, run the PowerShell installer from the README.\n' >&2
            exit 1
            ;;
        *)
            printf 'ERROR: unsupported system: %s.\n' "$kernel" >&2
            exit 1
            ;;
    esac
}

# The install packages for the tools that are missing, space separated.
missing_packages() {
    local pkgs='' tool pkg
    for tool in git jq cmp; do
        pkg=$tool
        if [[ $tool == cmp ]]; then
            pkg=diffutils
        fi
        if ! command -v "$tool" > /dev/null 2>&1; then
            pkgs="${pkgs:+$pkgs }$pkg"
        fi
    done
    printf '%s' "$pkgs"
}

# Make git, jq and cmp available, offering apt-get when it exists.
ensure_tools() {
    local yes=$1 tty=$2 pkgs answer
    local -a packages
    pkgs=$(missing_packages)
    [[ -n $pkgs ]] || return 0

    if ! command -v apt-get > /dev/null 2>&1; then
        printf 'ERROR: install %s with your package manager, then run this again.\n' "$pkgs" >&2
        exit 1
    fi

    if (( ! yes )); then
        printf '  Install %s with sudo apt-get? [Y/n] ' "$pkgs"
        # EOF means nobody is there to answer: don't run sudo unattended.
        if ! read_answer "$tty"; then
            printf '\nERROR: install %s with your package manager, then run this again.\n' "$pkgs" >&2
            exit 1
        fi
        answer=$REPLY
        if [[ -n $answer && $answer != [Yy]* ]]; then
            printf 'ERROR: install %s with your package manager, then run this again.\n' "$pkgs" >&2
            exit 1
        fi
    fi

    if ! sudo apt-get update -q; then
        printf 'ERROR: the package install failed.\n' >&2
        exit 1
    fi
    read -r -a packages <<< "$pkgs"
    if ! sudo apt-get install -y "${packages[@]}"; then
        printf 'ERROR: the package install failed.\n' >&2
        exit 1
    fi

    pkgs=$(missing_packages)
    if [[ -n $pkgs ]]; then
        printf 'ERROR: install %s with your package manager, then run this again.\n' "$pkgs" >&2
        exit 1
    fi
}

# True when the folder is itself a git clone with an origin remote.
is_clone_with_origin() {
    local dir=$1 top
    [[ -d $dir ]] || return 1
    top=$(git -C "$dir" rev-parse --show-toplevel 2> /dev/null) || return 1
    [[ $(readlink -f "$dir") == "$top" ]] || return 1
    git -C "$dir" remote get-url origin > /dev/null 2>&1
}

# Clone the repo, or fast-forward an existing clone, then check it looks like
# SyncSettings.
install_repo() {
    local dir=$1 url=$2 ref=$3

    if is_clone_with_origin "$dir"; then
        if ! git -C "$dir" pull --ff-only -q; then
            printf 'ERROR: could not update %s; resolve it and run this again.\n' "$dir" >&2
            exit 1
        fi
        printf '  Updated %s\n' "$dir"
    else
        if [[ -e $dir ]] && [[ -n $(ls -A "$dir" 2> /dev/null) ]]; then
            printf "ERROR: %s exists and isn't a SyncSettings clone; set SYNCSETTINGS_DIR.\n" "$dir" >&2
            exit 1
        fi
        if ! git clone -q --branch "$ref" "$url" "$dir"; then
            printf 'ERROR: could not clone %s.\n' "$url" >&2
            exit 1
        fi
        printf '  Cloned into %s\n' "$dir"
    fi

    if [[ ! -f $dir/sync || ! -f $dir/sync-config.json ]]; then
        printf "ERROR: %s doesn't look like SyncSettings.\n" "$dir" >&2
        exit 1
    fi
}

# Put mksync on PATH, refusing to overwrite something that isn't its link.
link_mksync() {
    local dir=$1 bin=$2 link target
    target=$(readlink -f "$dir/sync")
    mkdir -p "$bin"
    link=$bin/mksync

    if [[ -e $link || -L $link ]]; then
        if [[ ! -L $link ]] || [[ $(readlink -f "$link" 2> /dev/null || true) != "$target" ]]; then
            printf 'ERROR: %s already exists; remove it and run this again.\n' "$link" >&2
            exit 1
        fi
    fi

    ln -sfn "$dir/sync" "$link"
    case ":$PATH:" in
        *":$bin:"*) ;;
        *)
            printf '  Add this line to ~/.bashrc, then open a new terminal: export PATH="%s:%s"\n' "$bin" "\$PATH"
            ;;
    esac
}

# Run `sync setup`, with stdin from the answers source and --yes when given.
run_setup() {
    local dir=$1 yes=$2 tty=$3 rc=0
    if (( yes )); then
        "$dir/sync" setup --yes < "$tty" || rc=$?
    else
        "$dir/sync" setup < "$tty" || rc=$?
    fi
    if (( rc != 0 )); then
        exit "$rc"
    fi
}

main() {
    local yes=0 no_setup=0 url dir ref bin tty
    while (( $# > 0 )); do
        case $1 in
            --yes) yes=1; shift ;;
            --no-setup) no_setup=1; shift ;;
            *)
                usage >&2
                exit 1
                ;;
        esac
    done

    url=${SYNCSETTINGS_REPO_URL:-https://github.com/makubexD/SyncSettings.git}
    dir=${SYNCSETTINGS_DIR:-$HOME/SyncSettings}
    ref=${SYNCSETTINGS_REF:-master}
    bin=${SYNCSETTINGS_BIN:-$HOME/.local/bin}

    check_platform

    tty=$(resolve_tty)

    ensure_tools "$yes" "$tty"
    install_repo "$dir" "$url" "$ref"
    link_mksync "$dir" "$bin"

    if (( ! no_setup )); then
        run_setup "$dir" "$yes" "$tty"
    fi

    printf '  Installed. Run mksync any time.\n'
}

main "$@"
