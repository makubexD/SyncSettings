#!/usr/bin/env bash
# Restore this machine from the repo: packages, tools, configs, links, plugins.
# Run it as your own user, not with sudo. Running it again is safe.
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
NO_SESSION=0
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

step_snaps() {
    local name extra option rc=0
    local -a cmd=()
    # snapd may be absent in a container. `snap list` is a read-only guard.
    if ! snap list </dev/null >/dev/null 2>&1; then
        boot_skipped packages/linux/snap.txt 'snapd not running'
        return 0
    fi
    if (( DRY_RUN == 0 )); then
        "${SUDO[@]}" snap wait system seed.loaded </dev/null || return 1
    fi
    while read -r name extra <&3; do
        [[ -n $name ]] || continue
        if snap list "$name" </dev/null >/dev/null 2>&1; then
            boot_unchanged "snap/$name"
            continue
        fi
        if (( DRY_RUN )); then
            status WOULD "snap/$name"
            continue
        fi
        cmd=("${SUDO[@]}" snap install "$name")
        for option in $extra; do
            case $option in
                classic) cmd+=(--classic) ;;
                channel=*) cmd+=("--channel=${option#channel=}") ;;
            esac
        done
        if ! "${cmd[@]}" </dev/null; then
            status ERROR "snap/$name" 'install failed'
            rc=1
            continue
        fi
        boot_installed "snap/$name"
    done 3< <(list_lines "$PACKAGES_DIR/snap.txt")
    return "$rc"
}

step_fonts() {
    local asset tag sha dest fetched rc=0 added=0
    while read -r asset tag sha <&3; do
        [[ -n $asset ]] || continue
        dest=$HOME/.local/share/fonts/NerdFonts/$asset
        if [[ -d $dest ]]; then
            boot_unchanged "font/$asset"
            continue
        fi
        if (( DRY_RUN )); then
            status WOULD "font/$asset"
            continue
        fi
        fetched=$WORK/$asset.tar.xz
        if ! fetch_verified \
            "https://github.com/ryanoasis/nerd-fonts/releases/download/$tag/$asset.tar.xz" \
            "$sha" "$fetched" </dev/null; then
            status ERROR "font/$asset" 'download or hash failed'
            rc=1
            continue
        fi
        # Build under $WORK and move only the finished folder, so a failed
        # unpack can't leave a folder a rerun would count as installed.
        if ! mkdir -p "$WORK/$asset" \
            || ! tar -xJf "$fetched" -C "$WORK/$asset" </dev/null; then
            status ERROR "font/$asset" 'unpack failed'
            rc=1
            continue
        fi
        if ! mkdir -p "${dest%/*}" || ! mv "$WORK/$asset" "$dest"; then
            status ERROR "font/$asset" 'move failed'
            rc=1
            continue
        fi
        boot_installed "font/$asset"
        added=1
    done 3< <(list_lines "$PACKAGES_DIR/fonts.txt")
    if (( added )); then
        fc-cache -f </dev/null || return 1
    fi
    return "$rc"
}

step_extensions() {
    local uuid url commit dest checkout build rc=0
    if ! command -v glib-compile-schemas >/dev/null 2>&1; then
        boot_skipped packages/linux/gnome-extensions.txt 'glib-compile-schemas not installed'
        return 0
    fi
    while read -r uuid url commit <&3; do
        [[ -n $uuid ]] || continue
        dest=$HOME/.local/share/gnome-shell/extensions/$uuid
        if [[ -f $dest/metadata.json ]]; then
            boot_unchanged "extension/$uuid"
            continue
        fi
        if (( DRY_RUN )); then
            status WOULD "extension/$uuid"
            continue
        fi
        checkout=$WORK/git/$uuid
        build=$WORK/build/$uuid
        if ! mkdir -p "$checkout"; then
            status ERROR "extension/$uuid" 'checkout folder failed'
            rc=1
            continue
        fi
        if ! git -C "$checkout" init -q </dev/null \
            || ! git -C "$checkout" fetch -q --depth 1 "$url" "$commit" </dev/null \
            || ! git -C "$checkout" -c advice.detachedHead=false checkout -q FETCH_HEAD </dev/null; then
            status ERROR "extension/$uuid" 'fetch failed'
            rc=1
            continue
        fi
        if [[ $(git -C "$checkout" rev-parse HEAD </dev/null) != "$commit" ]]; then
            status ERROR "extension/$uuid" 'wrong commit'
            rc=1
            continue
        fi
        # The pinned recipe: metadata, stylesheet, schemas, and the modern
        # scripts flat. Never the extension's own install.sh.
        if ! mkdir -p "$build" \
            || ! cp -p "$checkout/metadata.json" "$checkout/stylesheet.css" "$build/" \
            || ! cp -p "$checkout"/src/modern/*.js "$build/" \
            || ! cp -a "$checkout/schemas" "$build/schemas"; then
            status ERROR "extension/$uuid" 'build failed'
            rc=1
            continue
        fi
        if ! glib-compile-schemas "$build/schemas" </dev/null; then
            status ERROR "extension/$uuid" 'schema compile failed'
            rc=1
            continue
        fi
        # -T: a folder left there without metadata.json must fail, not nest the build.
        if ! mkdir -p "${dest%/*}" || ! mv -T "$build" "$dest"; then
            status ERROR "extension/$uuid" 'move failed'
            rc=1
            continue
        fi
        boot_installed "extension/$uuid"
    done 3< <(list_lines "$PACKAGES_DIR/gnome-extensions.txt")
    return "$rc"
}
# The newest Node version under nvm, as drift_npm picks it. Empty if there's none.
newest_node() {
    [[ -d $HOME/.nvm/versions/node ]] || return 0
    find "$HOME/.nvm/versions/node" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null \
        | sort -V | tail -n 1
}

step_node() {
    local name='' url='' sha='' newest=''
    if [[ -f $HOME/.nvm/nvm.sh ]]; then
        boot_unchanged nvm
    elif (( DRY_RUN )); then
        status WOULD nvm
    else
        while read -r name url sha <&3; do
            if [[ $name == nvm ]]; then
                break
            fi
        done 3< <(list_lines "$PACKAGES_DIR/tools.txt")
        if [[ $name != nvm || -z $url || -z $sha ]]; then
            status ERROR nvm 'nvm pin missing'
            return 1
        fi
        if ! fetch_verified "$url" "$sha" "$WORK/nvm-install.sh"; then
            status ERROR nvm 'download or hash failed'
            return 1
        fi
        if ! PROFILE=/dev/null NVM_DIR="$HOME/.nvm" bash "$WORK/nvm-install.sh" </dev/null; then
            status ERROR nvm 'installer failed'
            return 1
        fi
        boot_installed nvm
    fi
    newest=$(newest_node)
    if [[ -n $newest ]]; then
        boot_unchanged node
    elif (( DRY_RUN )); then
        status WOULD node
    else
        if ! bash -c 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" && nvm install --lts && nvm alias default "lts/*"' </dev/null; then
            status ERROR node 'lts install failed'
            return 1
        fi
        boot_installed node
    fi
}

step_npm() {
    local name newest='' dir listed present
    local -a missing=()
    newest=$(newest_node)
    if [[ -z $newest ]]; then
        boot_skipped packages/linux/npm.txt 'no Node installed'
        return 0
    fi
    dir=$HOME/.nvm/versions/node/$newest
    listed=$(package_names "$PACKAGES_DIR/npm.txt")
    present=$(npm_packages "$dir/lib/node_modules")
    while IFS= read -r name <&3; do
        if [[ -z $name ]]; then
            continue
        fi
        if grep -Fxq "$name" <<<"$present"; then
            boot_unchanged "npm/$name"
        else
            missing+=("$name")
        fi
    done 3< <(printf '%s\n' "$listed")
    if (( ${#missing[@]} == 0 )); then
        return 0
    fi
    if (( DRY_RUN )); then
        for name in "${missing[@]}"; do
            status WOULD "npm/$name"
        done
        return 0
    fi
    if ! PATH="$dir/bin:$PATH" npm install -g -- "${missing[@]}" </dev/null; then
        for name in "${missing[@]}"; do
            status ERROR "npm/$name" 'install failed'
        done
        return 1
    fi
    for name in "${missing[@]}"; do
        boot_installed "npm/$name"
    done
}

step_pipx() {
    local name out present listed rc=0
    local -a missing=()
    if ! command -v pipx >/dev/null 2>&1; then
        boot_skipped packages/linux/pipx.txt 'pipx not installed'
        return 0
    fi
    if ! out=$(pipx list --short 2>/dev/null </dev/null); then
        boot_skipped packages/linux/pipx.txt 'pipx failed'
        return 0
    fi
    present=$(awk '{ print $1 }' <<<"$out" | LC_ALL=C sort -u)
    listed=$(package_names "$PACKAGES_DIR/pipx.txt")
    while IFS= read -r name <&3; do
        if [[ -z $name ]]; then
            continue
        fi
        if grep -Fxq "$name" <<<"$present"; then
            boot_unchanged "pipx/$name"
        else
            missing+=("$name")
        fi
    done 3< <(printf '%s\n' "$listed")
    if (( ${#missing[@]} == 0 )); then
        return 0
    fi
    if (( DRY_RUN )); then
        for name in "${missing[@]}"; do
            status WOULD "pipx/$name"
        done
        return 0
    fi
    for name in "${missing[@]}"; do
        if ! pipx install "$name" </dev/null; then
            status ERROR "pipx/$name" 'install failed'
            rc=1
            continue
        fi
        boot_installed "pipx/$name"
    done
    return "$rc"
}
# Unpack one tools.txt line under $WORK and move its binary into place. The
# return code says where it stopped, so the caller can name the failure: 10
# download or hash, 11 unpack, 12 install. The move is last, so a failed
# recipe leaves nothing at the target.
install_tool() {
    local name=$1 url=$2 sha=$3 target=$4 file dir
    case $name in
        bun)
            file=$WORK/$name.zip
            dir=$WORK/$name
            fetch_verified "$url" "$sha" "$file" </dev/null || return 10
            mkdir -p "$dir" || return 11
            unzip -jo "$file" bun-linux-x64/bun -d "$dir" </dev/null || return 11
            mkdir -p "${target%/*}" || return 12
            install -m 755 "$dir/bun" "$target" </dev/null || return 12
            ln -sf "$HOME/.bun/bin/bun" "$HOME/.bun/bin/bunx" || return 12
            ;;
        rtk|copilot)
            file=$WORK/$name.tar.gz
            dir=$WORK/$name
            fetch_verified "$url" "$sha" "$file" </dev/null || return 10
            mkdir -p "$dir" || return 11
            tar -xzf "$file" -C "$dir" "$name" </dev/null || return 11
            mkdir -p "${target%/*}" || return 12
            install -m 755 "$dir/$name" "$target" </dev/null || return 12
            ;;
        *)
            return 1
            ;;
    esac
}

step_tools() {
    local name url sha target code=0 rc=0
    local claude=$HOME/.local/bin/claude
    while read -r name url sha <&3; do
        [[ -n $name ]] || continue
        # nvm is step_node's, so its line is left alone here.
        if [[ $name == nvm ]]; then
            continue
        fi
        case $name in
            bun) target=$HOME/.bun/bin/bun ;;
            rtk|copilot) target=$HOME/.local/bin/$name ;;
            *)
                status ERROR "tool/$name" 'no recipe'
                rc=1
                continue
                ;;
        esac
        if [[ -e $target ]]; then
            boot_unchanged "tool/$name"
            continue
        fi
        if (( DRY_RUN )); then
            status WOULD "tool/$name"
            continue
        fi
        code=0
        install_tool "$name" "$url" "$sha" "$target" || code=$?
        case $code in
            0) boot_installed "tool/$name" ;;
            10) status ERROR "tool/$name" 'download or hash failed'; rc=1 ;;
            11) status ERROR "tool/$name" 'unpack failed'; rc=1 ;;
            *) status ERROR "tool/$name" 'install failed'; rc=1 ;;
        esac
    done 3< <(list_lines "$PACKAGES_DIR/tools.txt")
    # Claude's installer is unpinned, so it goes to a file and runs from there,
    # never through a pipe. It runs last, so its failure leaves the others.
    if [[ -e $claude ]]; then
        boot_unchanged tool/claude
    elif (( DRY_RUN )); then
        status WOULD tool/claude
    elif ! curl -fsSL --proto '=https' --tlsv1.2 -o "$WORK/claude-install.sh" \
        https://claude.ai/install.sh </dev/null; then
        status ERROR tool/claude 'download failed'
        rc=1
    elif ! bash "$WORK/claude-install.sh" </dev/null; then
        status ERROR tool/claude 'installer failed'
        rc=1
    elif [[ ! -x $claude ]]; then
        status ERROR tool/claude 'installer left no claude'
        rc=1
    else
        boot_installed tool/claude
    fi
    return "$rc"
}
step_import() {
    # No desktop session means no dconf, and a screen of ERROR lines. Set
    # NO_SESSION so preview and the summary know to stop and say so.
    if [[ -z ${DBUS_SESSION_BUS_ADDRESS:-} ]]; then
        NO_SESSION=1
        if (( DRY_RUN == 0 )); then
            boot_skipped import 'no desktop session; rerun from a terminal on the desktop'
        fi
        return 0
    fi
    if (( DRY_RUN )); then
        return 0
    fi
    # Stdin stays the terminal, so import's overwrite prompts work.
    ./import.sh || return 1
}

step_links() {
    local src name dest
    for src in "$HOME"/.claude/bin/*; do
        [[ -e $src ]] || continue
        # Only the executable scripts, not directories or the rest.
        [[ -f $src && -x $src ]] || continue
        name=${src##*/}
        dest=$HOME/.local/bin/$name
        # -L before -e: a dangling link is "anything else" unless its target
        # is right, so it is never overwritten as if it were missing.
        if [[ -L $dest ]]; then
            if [[ $(readlink "$dest") == "$HOME/.claude/bin/$name" ]]; then
                boot_unchanged "link/$name"
            else
                boot_skipped "link/$name" 'exists; left alone'
            fi
        elif [[ -e $dest ]]; then
            boot_skipped "link/$name" 'exists; left alone'
        elif (( DRY_RUN )); then
            status WOULD "link/$name"
        else
            mkdir -p "$HOME/.local/bin" || return 1
            ln -s "$HOME/.claude/bin/$name" "$dest" || return 1
            boot_installed "link/$name"
        fi
    done
}

# Marketplaces in settings.json that known_marketplaces.json lacks, as
# NUL-separated add arguments.
missing_marketplaces() {
    local known=$HOME/.claude/plugins/known_marketplaces.json
    [[ -f $known ]] || known=/dev/null
    jq -j --slurpfile k <(cat "$known") '(($k[0] // {}) | keys) as $have
        | (.extraKnownMarketplaces // {}) | to_entries[] | select(.key as $n | $have | index($n) | not)
        | .value.source | .repo + (if .ref then "#" + .ref else "" end), "\u0000"' "$1"
}

# Enabled plugins that installed_plugins.json lacks, NUL-separated.
missing_plugins() {
    local installed=$HOME/.claude/plugins/installed_plugins.json
    [[ -f $installed ]] || installed=/dev/null
    jq -j --slurpfile i <(cat "$installed") '(($i[0].plugins // {}) | keys) as $have
        | (.enabledPlugins // {}) | to_entries[] | select(.value == true) | .key
        | select(. as $n | $have | index($n) | not) | (., "\u0000")' "$1"
}

step_plugins() {
    local settings=$HOME/.claude/settings.json keep=$WORK/settings.json
    local claude=$HOME/.local/bin/claude spec plugin rc=0
    local -a markets=() plugs=()
    # -x, not -e: a non-executable file is not a working claude, and the test
    # harness leaves an empty one there to keep other cases idle.
    if [[ ! -f $settings || ! -x $claude ]]; then
        boot_skipped plugins 'settings.json or claude not installed'
        return 0
    fi
    if ! command -v jq >/dev/null 2>&1; then
        if (( DRY_RUN )); then
            status WOULD plugins
            return 0
        fi
        status ERROR plugins 'jq not installed'
        return 1
    fi
    # Both missing lists first, read from settings.json before anything rewrites
    # it, so a dry run prints them without claude and a finished machine reports
    # UNCHANGED without copying or touching the file.
    while IFS= read -r -d '' spec <&3; do
        markets+=("$spec")
    done 3< <(missing_marketplaces "$settings")
    while IFS= read -r -d '' plugin <&3; do
        plugs+=("$plugin")
    done 3< <(missing_plugins "$settings")
    if (( ${#markets[@]} == 0 && ${#plugs[@]} == 0 )); then
        boot_unchanged plugins
        return 0
    fi
    if (( DRY_RUN )); then
        for spec in "${markets[@]}"; do
            status WOULD "plugin/$spec"
        done
        for plugin in "${plugs[@]}"; do
            status WOULD "plugin/$plugin"
        done
        return 0
    fi
    # `add` rewrites settings.json (it drops autoUpdate), so keep a copy aside
    # and put it back after, whatever happened. Nothing between the two copies
    # returns early, so the restore always runs.
    cp -p "$settings" "$keep" || return 1
    for spec in "${markets[@]}"; do
        if "$claude" plugin marketplace add "$spec" </dev/null; then
            boot_installed "plugin/$spec"
        else
            status ERROR "plugin/$spec" 'add failed'
            rc=1
        fi
    done
    for plugin in "${plugs[@]}"; do
        # The shell running this has not loaded the restored .bashrc, and without
        # bun on PATH a plugin that needs it installs with no packages.
        if PATH="$HOME/.bun/bin:$PATH" "$claude" plugin install "$plugin" </dev/null; then
            boot_installed "plugin/$plugin"
        else
            status ERROR "plugin/$plugin" 'install failed'
            rc=1
        fi
    done
    cp -p "$keep" "$settings" || return 1
    return "$rc"
}

step_vscode() {
    local name code out present listed rc=0
    local -a missing=()
    # The snap may have been skipped, or code may be installed another way.
    code=$(command -v code 2>/dev/null) || code=''
    if [[ -z $code && -x $ROOT/snap/bin/code ]]; then
        code=$ROOT/snap/bin/code
    fi
    if [[ -z $code ]]; then
        boot_skipped packages/linux/vscode-extensions.txt 'code not installed'
        return 0
    fi
    # A read-only guard: no extensions can be listed without a working code.
    if ! out=$("$code" --list-extensions </dev/null 2>/dev/null); then
        boot_skipped packages/linux/vscode-extensions.txt 'code failed'
        return 0
    fi
    # The list file is lowercase; code may print ids in any case.
    present=$(tr '[:upper:]' '[:lower:]' <<<"$out" | LC_ALL=C sort -u)
    listed=$(package_names "$PACKAGES_DIR/vscode-extensions.txt")
    while IFS= read -r name <&3; do
        if [[ -z $name ]]; then
            continue
        fi
        if grep -Fxq "$name" <<<"$present"; then
            boot_unchanged "vscode/$name"
        else
            missing+=("$name")
        fi
    done 3< <(printf '%s\n' "$listed")
    if (( ${#missing[@]} == 0 )); then
        return 0
    fi
    if (( DRY_RUN )); then
        for name in "${missing[@]}"; do
            status WOULD "vscode/$name"
        done
        return 0
    fi
    for name in "${missing[@]}"; do
        if ! "$code" --install-extension "$name" </dev/null; then
            status ERROR "vscode/$name" 'install failed'
            rc=1
            continue
        fi
        boot_installed "vscode/$name"
    done
    return "$rc"
}

step_preview() {
    if (( DRY_RUN )); then
        return 0
    fi
    if (( NO_SESSION )); then
        return 0
    fi
    ./sync preview </dev/null || return 1
}

print_summary() {
    printf '\n%d installed, %d already there, %d skipped.\n' "$INSTALLED" "$UNCHANGED" "$BOOT_SKIPPED"
    local step
    for step in "${FAILED[@]}"; do
        status ERROR "$step" 'failed'
    done
    printf 'Next: docs/restore.md\n'
    if (( NO_SESSION )); then
        printf 'Rerun ./bootstrap/linux.sh from a terminal on the desktop to finish.\n'
    fi
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
