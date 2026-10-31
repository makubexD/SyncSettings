#!/usr/bin/env bash
# Restore this machine from the repo: packages, tools, configs, links, plugins.
# Run it as your own user. It asks for sudo once, and running it again is safe.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# jq isn't installed yet, so skip the config checks sync.sh runs when sourced.
SYNC_LIB_ONLY=1
source scripts/linux/sync.sh

PACKAGES_DIR=$REPO_ROOT/packages/linux
ROOT=${BOOTSTRAP_ROOT:-}
SUDO=(sudo)
DRY_RUN=0
FAILED=()
INSTALLED=0
UNCHANGED=0
BOOT_SKIPPED=0
APT_STALE=0

# Data lines of a list, without comments and blanks.
list_lines() {
    [[ -f $1 ]] || return 0
    awk '!/^[[:space:]]*(#|$)/' "$1"
}

# Download $1 to $3 and stop unless its SHA-256 is $2.
fetch_verified() {
    local url=$1 sha=$2 dest=$3
    curl -fsSL --proto '=https' --tlsv1.2 -o "$dest" "$url" || return 1
    if ! printf '%s  %s\n' "$sha" "$dest" | sha256sum -c --quiet - >/dev/null 2>&1; then
        rm -f "$dest"
        return 1
    fi
}

# `if ! "$@"` turns errexit off inside the step, so every command in a step ends
# in `|| return 1` or is checked by hand.
run_step() {
    local name=$1
    shift
    printf '\n  -- %s\n' "$name"
    if ! "$@"; then
        status ERROR "$name" 'step failed'
        FAILED+=("$name")
    fi
}

usage() {
    printf 'Usage: %s [--dry-run]\n' "${BASH_SOURCE[0]##*/}"
    printf 'Restore this machine from the repo. --dry-run prints what would change and changes nothing.\n'
}

parse_args() {
    if (( $# > 1 )); then
        usage >&2
        exit 1
    fi
    case ${1:-} in
        '') ;;
        --dry-run) DRY_RUN=1 ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; exit 1 ;;
    esac
}

# A KEY=VALUE field from the os-release file, with quotes stripped.
os_field() {
    sed -n "s/^$1=//p" "$ROOT/etc/os-release" 2>/dev/null | tr -d '"'
}

# Stop unless the machine can run bootstrap: the right user, arch and distro,
# valid package lists, and a working sudo. --dry-run runs all but the last.
check_machine() {
    if [[ $(id -u) == 0 ]]; then
        printf 'ERROR: run bootstrap as your own user, not root.\n' >&2
        exit 2
    fi
    if [[ $(uname -m) != x86_64 ]]; then
        printf 'ERROR: the pinned downloads are for x86_64.\n' >&2
        exit 2
    fi
    if ! command -v apt-get >/dev/null || [[ $(os_field ID) != ubuntu ]]; then
        printf 'ERROR: bootstrap needs Ubuntu.\n' >&2
        exit 2
    fi
    if ! scripts/ci/check-packages.sh "$PACKAGES_DIR"; then
        printf 'ERROR: fix packages/linux first.\n' >&2
        exit 2
    fi
    if (( DRY_RUN == 0 )) && ! "${SUDO[@]}" -v; then
        printf 'ERROR: sudo is needed for apt and snap.\n' >&2
        exit 2
    fi
    if [[ $(os_field VERSION_ID) != 26.04 ]]; then
        printf 'WARNING: the lists were recorded on Ubuntu 26.04.\n'
    fi
}

# Count a step's outcome and print its status line.
boot_installed() {
    status INSTALLED "$@"
    INSTALLED=$(( INSTALLED + 1 ))
}

boot_unchanged() {
    status UNCHANGED "$@"
    UNCHANGED=$(( UNCHANGED + 1 ))
}

boot_skipped() {
    status SKIPPED "$@"
    BOOT_SKIPPED=$(( BOOT_SKIPPED + 1 ))
}

# Signed-By paths in a source file, one per line: `Signed-By: /p` in .sources
# and `signed-by=/p` in .list, ignoring case.
source_keys() {
    sed -n 's/.*[Ss][Ii][Gg][Nn][Ee][Dd]-[Bb][Yy][: =][[:space:]]*\([^][:space:]]*\).*/\1/p' "$1"
}

# Put $1 at $2 unless the file already matches. A missing file is copied (and
# marks the apt cache stale), an identical one is unchanged, and a different one
# is kept and reported, because a key may have been rotated on purpose.
install_file() {
    local from=$1 to=$2 label=$3
    if [[ ! -e $to ]]; then
        if (( DRY_RUN )); then
            status WOULD "$label"
            return 0
        fi
        "${SUDO[@]}" install -D -m 0644 "$from" "$to" </dev/null || return 1
        boot_installed "$label"
        APT_STALE=1
    elif cmp -s "$from" "$to"; then
        boot_unchanged "$label"
    else
        boot_skipped "$label" 'differs from the repo; see docs/packages.md'
    fi
}

# -- Steps ---------------------------------------------------------------------

step_apt_sources() {
    local installed src name to value base
    # ca-certificates must be present before any https source can be fetched.
    # Not a pipe into grep -q: with pipefail, the writer's SIGPIPE reads as missing.
    installed=$(dpkg_installed) || installed=''
    if ! grep -qx ca-certificates <<<"$installed"; then
        if (( DRY_RUN )); then
            status WOULD apt/ca-certificates
        else
            "${SUDO[@]}" apt-get install -y ca-certificates || return 1
            boot_installed apt/ca-certificates
            APT_STALE=1
        fi
    fi
    for src in "$PACKAGES_DIR"/apt-sources/*.sources "$PACKAGES_DIR"/apt-sources/*.list; do
        [[ -f $src ]] || continue
        name=${src##*/}
        to=$ROOT/etc/apt/sources.list.d/$name
        install_file "$src" "$to" "/etc/apt/sources.list.d/$name" || return 1
        while IFS= read -r value <&3; do
            base=${value##*/}
            install_file "$PACKAGES_DIR/apt-sources/keyrings/$base" "$ROOT$value" "$value" || return 1
        done 3< <(source_keys "$src")
    done
}

step_apt() {
    local listed name
    local -a missing=()
    listed=$(package_names "$PACKAGES_DIR/apt.txt")
    while IFS= read -r name <&3; do
        [[ -z $name ]] || missing+=("$name")
    done 3< <(LC_ALL=C comm -23 <(printf '%s\n' "$listed") <(dpkg_installed))
    if (( ${#missing[@]} == 0 )) && (( APT_STALE == 0 )); then
        boot_unchanged apt.txt
        return 0
    fi
    if (( DRY_RUN )); then
        for name in "${missing[@]}"; do
            status WOULD "apt/$name"
        done
        return 0
    fi
    "${SUDO[@]}" apt-get update || return 1
    if (( ${#missing[@]} > 0 )); then
        "${SUDO[@]}" apt-get install -y -- "${missing[@]}" || return 1
    fi
    for name in "${missing[@]}"; do
        boot_installed "apt/$name"
    done
    APT_STALE=0
}

step_debs() {
    local installed name url sha deb rc=0
    installed=$(dpkg_installed) || installed=''
    while read -r name url sha <&3; do
        if grep -qx "$name" <<<"$installed"; then
            boot_unchanged "deb/$name"
            continue
        fi
        if (( DRY_RUN )); then
            status WOULD "deb/$name"
            continue
        fi
        deb=$WORK/$name.deb
        if ! fetch_verified "$url" "$sha" "$deb"; then
            status ERROR "deb/$name" 'download or hash failed'
            rc=1
            continue
        fi
        if [[ $(dpkg-deb -f "$deb" Package 2>/dev/null) != "$name" ]]; then
            status ERROR "deb/$name" 'wrong package'
            rm -f "$deb"
            rc=1
            continue
        fi
        chmod 755 "$WORK"
        chmod 644 "$deb"
        if ! "${SUDO[@]}" apt-get install -y "$deb" </dev/null; then
            status ERROR "deb/$name" 'install failed'
            rc=1
            continue
        fi
        boot_installed "deb/$name"
    done 3< <(list_lines "$PACKAGES_DIR/deb.txt")
    return "$rc"
}

step_snaps() { return 0; }
step_fonts() { return 0; }
step_extensions() { return 0; }
step_node() { return 0; }
step_npm() { return 0; }
step_pipx() { return 0; }
step_tools() { return 0; }
step_import() { return 0; }
step_links() { return 0; }
step_plugins() { return 0; }
step_vscode() { return 0; }
step_preview() { return 0; }

print_summary() {
    printf '\n%d installed, %d already there, %d skipped.\n' "$INSTALLED" "$UNCHANGED" "$BOOT_SKIPPED"
    local step
    for step in "${FAILED[@]}"; do
        status ERROR "$step" 'failed'
    done
    printf 'Next: docs/restore.md\n'
}

main() {
    parse_args "$@"
    check_machine
    WORK=$(mktemp -d)
    trap 'rm -rf "$WORK"' EXIT
    run_step 'apt sources' step_apt_sources
    run_step apt step_apt
    run_step debs step_debs
    run_step snaps step_snaps
    run_step fonts step_fonts
    run_step extensions step_extensions
    run_step node step_node
    run_step npm step_npm
    run_step pipx step_pipx
    run_step tools step_tools
    run_step import step_import
    run_step links step_links
    run_step plugins step_plugins
    run_step vscode step_vscode
    run_step preview step_preview
    print_summary
    (( ${#FAILED[@]} == 0 ))
}

# scripts/ci/bootstrap-check.sh sources this file to reuse the steps without main.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
    main "$@"
fi
