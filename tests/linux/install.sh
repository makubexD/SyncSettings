#!/usr/bin/env bash
# Installer tests: run install.sh against a throwaway origin, HOME and release
# folder, asserting byte-exact results and status lines.
# Usage: tests/linux/install.sh [case-name-filter]

# shellcheck disable=SC2329  # helpers and cases are called indirectly
set -euo pipefail

SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$SOURCE_DIR/../.." && pwd)

filter=${1:-}
failed=0
passed=0
failed_cases=0
skipped=0
case_name=''
t=''
out=''
rc=0

# The cases run install.sh as linux unless they set SYNC_OS themselves.
export SYNC_OS=${SYNC_OS:-linux}

# Cases build repos with git outside the throwaway HOME. Keep the host's git
# config, ignore and attributes files out of them.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 XDG_CONFIG_HOME=/nonexistent

# -- Helpers -------------------------------------------------------------------

fail() {
    printf 'FAIL %s: %s\n' "$case_name" "$*"
    # Cases run in a command-substitution subshell, where errexit does not abort
    # function bodies; exit the subshell so the runner reports the failure.
    exit 1
}

# File mode in octal: GNU stat takes -c, BSD (macOS) stat takes -f %Lp.
file_mode() {
    stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"
}

# SHA256 of a file, hash only: GNU sha256sum, or shasum -a 256 on macOS.
sha256_of() {
    if command -v sha256sum > /dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

# Fresh throwaway working dir; removed when this case's subshell exits.
new_tmp() {
    t=$(mktemp -d)
    out=$t/out
    trap 'rm -rf "$t"' EXIT
}

# Turn $t/repo into a git repo on master with one commit, plus a bare origin at
# $t/origin.git holding the same commit.
make_git_repo() {
    git -C "$t/repo" init -q -b master
    git -C "$t/repo" add -A
    git -C "$t/repo" -c user.name=t -c user.email=t@example.com commit -q -m init
    git init -q --bare -b master "$t/origin.git"
    git -C "$t/repo" remote add origin "$t/origin.git"
    git -C "$t/repo" push -q origin master
}

# The release folder install.sh downloads from: latest holds v9.9.9, and the
# four programs are scripts that log their arguments to $t/stub/log and, for
# setup, write the clone's dotfiles into HOME as the program would.
make_install_release() {
    local dir=$t/release/download/v9.9.9 asset
    mkdir -p "$dir"
    printf 'v9.9.9\n' > "$t/release/latest"
    for asset in mksync-linux-x64 mksync-linux-arm64 mksync-darwin-arm64 mksync-windows-x64.exe; do
        cat > "$dir/$asset" <<EOF
#!/bin/sh
printf 'mksync %s\n' "\$*" >> "$t/stub/log"
if [ "\$1" = setup ]; then
    mkdir -p "\$HOME/.config/fixture"
    cp "\$HOME/SyncSettings/dotfiles/linux/plain.txt" "\$HOME/.config/fixture/plain.txt"
    cp "\$HOME/SyncSettings/dotfiles/common/shared.conf" "\$HOME/.config/fixture/shared.conf"
    printf 'Setup done.\n'
fi
exit 0
EOF
        chmod +x "$dir/$asset"
    done
    : > "$dir/SHA256SUMS"
    for asset in mksync-darwin-arm64 mksync-linux-arm64 mksync-linux-x64 mksync-windows-x64.exe; do
        printf '%s  %s\n' "$(sha256_of "$dir/$asset")" "$asset" >> "$dir/SHA256SUMS"
    done
}

# The curl stub: serves only file:// URLs out of the case's release folder, so
# no case reaches the network. -o writes the file, no -o prints it, and a
# missing file exits 22 as curl -f does. Each call is logged to curl.log.
make_curl_stub() {
    cat > "$t/stub/curl" <<EOF
#!/bin/sh
out=''
format=''
url=''
while [ "\$#" -gt 0 ]; do
    case \$1 in
        -o) out=\$2; shift 2 ;;
        -w) format=\$2; shift 2 ;;
        -*) shift ;;
        *) url=\$1; shift ;;
    esac
done
printf '%s\n' "\$url" >> "$t/stub/curl.log"
case \$url in
    file://*) path=\${url#file://} ;;
    *)
        printf 'curl: unsupported URL\n' >&2
        exit 1
        ;;
esac
if [ ! -f "\$path" ]; then
    printf 'curl: (22) The requested URL returned error: 404\n' >&2
    exit 22
fi
if [ -n "\$out" ]; then
    cat "\$path" > "\$out"
else
    cat "\$path"
fi
case \$format in
    *url_effective*) printf '%s' "\$url" ;;
esac
exit 0
EOF
    chmod +x "$t/stub/curl"
}

# Bare origin for the install cases: the clone's launcher, install.sh, a
# minimal config and dotfiles, pushed to $t/origin.git. install.sh clones it
# into a throwaway HOME, next to a release folder and the curl stub.
setup_install_origin() {
    new_tmp
    mkdir -p "$t/repo/dotfiles/linux" "$t/repo/dotfiles/common" "$t/home" "$t/stub"
    cp -a "$REPO/install.sh" "$REPO/mksync" "$t/repo/"
    printf '{"version": 1, "files": []}\n' > "$t/repo/sync-config.json"
    printf '#!/bin/sh\nexit 0\n' > "$t/repo/sync"
    chmod +x "$t/repo/sync"
    printf 'plain\n' > "$t/repo/dotfiles/linux/plain.txt"
    printf 'shared\n' > "$t/repo/dotfiles/common/shared.conf"
    make_git_repo
    make_install_release
    make_curl_stub
}

# Stubs for the install cases: sudo and apt-get log their arguments (the
# install one links the real jq into the stub folder) and gh is signed in.
make_install_stubs() {
    cat > "$t/stub/sudo" <<EOF
#!/bin/sh
printf 'sudo %s\n' "\$*" >> "$t/stub/log"
exec "\$@"
EOF
    chmod +x "$t/stub/sudo"
    cat > "$t/stub/apt-get" <<EOF
#!/bin/sh
printf 'apt-get %s\n' "\$*" >> "$t/stub/log"
if [ "\$1" = install ]; then
    ln -sf "$(command -v jq)" "$t/stub/jq"
fi
exit 0
EOF
    chmod +x "$t/stub/apt-get"
    cat > "$t/stub/gh" <<'EOF'
#!/bin/sh
exit 0
EOF
    chmod +x "$t/stub/gh"
}

# Stubs for the macOS install cases: the install stubs plus a brew that logs its
# arguments and, on install, creates the bash candidate and jq the installer
# then finds. The stubs in $t/stub come first on PATH, so nothing reaches real
# brew or sudo; $t/brewbin goes last, so the host jq still wins.
make_macos_install_stubs() {
    local real_bash real_jq
    real_bash=$(command -v bash)
    real_jq=$(command -v jq)
    make_install_stubs
    mkdir -p "$t/brewbin"
    cat > "$t/stub/brew" <<EOF
#!/bin/sh
printf 'brew %s\n' "\$*" >> "$t/stub/log"
printf '==> Pouring bash\n'
if [ "\$1" = install ]; then
    ln -sf "$real_bash" "$t/brewbin/bash"
    printf '#!/bin/sh\nexec %s "\$@"\n' "$real_jq" > "$t/brewbin/jq"
    chmod +x "$t/brewbin/jq"
fi
exit 0
EOF
    chmod +x "$t/stub/brew"
}

# A PATH with only the tools install.sh itself runs, and no jq, so the
# missing-tool branch is the one that runs. curl is already the stub in
# $t/stub, so it is not linked over; shasum stands in on macOS, which has no
# sha256sum.
make_install_path() {
    local tool path
    for tool in bash env uname git cmp mkdir ln readlink sha256sum shasum chmod mv rm mktemp cut cat; do
        if path=$(command -v "$tool" 2> /dev/null); then
            ln -sf "$path" "$t/stub/$tool"
        fi
    done
}

# Run install.sh against the bare origin with a throwaway HOME. $1 is the PATH,
# $2 the answers source, and the rest are installer arguments.
run_install() {
    local path=$1 tty=$2
    shift 2
    rc=0
    (cd "$t" && PATH="$path" HOME="$t/home" GH="$t/stub/gh" \
        SYNC_OS="${SYNC_OS:-}" SYNC_ARCH="${SYNC_ARCH:-}" SYNC_BREW_BASH="${SYNC_BREW_BASH:-}" \
        SYNCSETTINGS_REPO_URL="$t/origin.git" SYNCSETTINGS_TTY="$tty" \
        SYNCSETTINGS_RELEASE_URL="${SYNCSETTINGS_RELEASE_URL:-file://$t/release}" \
        GIT_TERMINAL_PROMPT=0 "$REPO/install.sh" "$@") > "$out" 2>&1 || rc=$?
}

# -- Cases ---------------------------------------------------------------------

case_install_fresh() {
    setup_install_origin

    SYNC_ARCH=x86_64 run_install "$t/stub:$PATH" /dev/null --no-setup
    (( rc == 0 )) || fail "install.sh exited $rc, want 0"

    grep -Fq "  Cloned into $t/home/SyncSettings" "$out" || fail "missing the Cloned into line"
    [[ -d $t/home/SyncSettings/.git ]] || fail "the clone was not created"
    [[ -f $t/home/.local/bin/mksync ]] || fail "mksync is not the downloaded program"
    [[ ! -L $t/home/.local/bin/mksync ]] || fail "mksync is a symlink"
    cmp -s "$t/home/.local/bin/mksync" "$t/release/download/v9.9.9/mksync-linux-x64" \
        || fail "mksync is not the downloaded program"
    grep -Fq "export PATH=\"$t/home/.local/bin:\$PATH\"" "$out" || fail "missing the PATH hint"
}

case_install_update() {
    setup_install_origin
    run_install "$t/stub:$PATH" /dev/null --no-setup
    (( rc == 0 )) || fail "the first install exited $rc, want 0"

    printf 'updated\n' > "$t/repo/dotfiles/linux/plain.txt"
    git -C "$t/repo" -c user.name=t -c user.email=t@example.com commit -qam update
    git -C "$t/repo" push -q origin master

    run_install "$t/stub:$PATH" /dev/null --no-setup
    (( rc == 0 )) || fail "the second install exited $rc, want 0"

    grep -Fq "  Updated $t/home/SyncSettings" "$out" || fail "missing the Updated line"
    [[ $(git -C "$t/home/SyncSettings" rev-parse HEAD) == $(git --git-dir="$t/origin.git" rev-parse master) ]] \
        || fail "the clone is not at origin's HEAD"
}

case_install_not_a_clone() {
    setup_install_origin
    mkdir -p "$t/home/SyncSettings"
    printf 'keep\n' > "$t/home/SyncSettings/file.txt"

    run_install "$t/stub:$PATH" /dev/null --no-setup
    (( rc == 1 )) || fail "install.sh exited $rc, want 1"

    grep -Fq "ERROR: $t/home/SyncSettings exists and isn't a SyncSettings clone; set SYNCSETTINGS_DIR." "$out" \
        || fail "missing the not-a-clone error"
    [[ $(cat "$t/home/SyncSettings/file.txt") == keep ]] || fail "the folder was touched"
}

# The clone check wants mksync and sync-config.json: a clone without the old
# sync is still accepted.
case_install_mksync_clone() {
    setup_install_origin
    git -C "$t/repo" rm -q sync
    git -C "$t/repo" -c user.name=t -c user.email=t@example.com commit -q -m drop-sync
    git -C "$t/repo" push -q origin master

    SYNC_ARCH=x86_64 run_install "$t/stub:$PATH" /dev/null --no-setup
    (( rc == 0 )) || fail "install.sh exited $rc, want 0"

    [[ -f $t/home/SyncSettings/mksync ]] || fail "the clone has no mksync"
    [[ ! -e $t/home/SyncSettings/sync ]] || fail "the clone still has sync"
}

# A folder with only the old sync marker, no mksync, is not taken as a clone.
case_install_old_sync_not_a_clone() {
    setup_install_origin
    mkdir -p "$t/home/SyncSettings"
    printf '#!/bin/sh\n' > "$t/home/SyncSettings/sync"

    run_install "$t/stub:$PATH" /dev/null --no-setup
    (( rc == 1 )) || fail "install.sh exited $rc, want 1"

    grep -Fq "ERROR: $t/home/SyncSettings exists and isn't a SyncSettings clone; set SYNCSETTINGS_DIR." "$out" \
        || fail "missing the not-a-clone error"
    [[ -f $t/home/SyncSettings/sync ]] || fail "the folder was touched"
}

# The old ~/.local/bin/sync link into the clone is removed, with its line.
case_install_removes_old_sync_link() {
    setup_install_origin
    run_install "$t/stub:$PATH" /dev/null --no-setup
    (( rc == 0 )) || fail "the first install exited $rc, want 0"

    mkdir -p "$t/home/.local/bin"
    ln -s "$t/home/SyncSettings/sync" "$t/home/.local/bin/sync"

    run_install "$t/stub:$PATH" /dev/null --no-setup
    (( rc == 0 )) || fail "the second install exited $rc, want 0"

    [[ ! -e $t/home/.local/bin/sync && ! -L $t/home/.local/bin/sync ]] || fail "the old sync link was kept"
    grep -Fxq 'removed the old sync link' "$out" || fail "missing the removed-link line"
}

# A regular file at ~/.local/bin/sync is kept, and nothing is printed for it.
case_install_keeps_sync_file() {
    setup_install_origin
    mkdir -p "$t/home/.local/bin"
    printf 'mine\n' > "$t/home/.local/bin/sync"

    run_install "$t/stub:$PATH" /dev/null --no-setup
    (( rc == 0 )) || fail "install.sh exited $rc, want 0"

    [[ $(cat "$t/home/.local/bin/sync") == mine ]] || fail "the regular file was touched"
    if grep -Fxq 'removed the old sync link' "$out"; then
        fail "the installer printed the removed-link line for a regular file"
    fi
}

# A symlink at ~/.local/bin/sync pointing outside the clone is kept.
case_install_keeps_foreign_sync_link() {
    setup_install_origin
    printf 'other\n' > "$t/elsewhere"
    mkdir -p "$t/home/.local/bin"
    ln -s "$t/elsewhere" "$t/home/.local/bin/sync"

    run_install "$t/stub:$PATH" /dev/null --no-setup
    (( rc == 0 )) || fail "install.sh exited $rc, want 0"

    [[ -L $t/home/.local/bin/sync ]] || fail "the symlink was removed"
    [[ $(readlink "$t/home/.local/bin/sync") == "$t/elsewhere" ]] || fail "the symlink was changed"
    if grep -Fxq 'removed the old sync link' "$out"; then
        fail "the installer printed the removed-link line for a foreign symlink"
    fi
}

case_install_link_conflict() {
    setup_install_origin
    mkdir -p "$t/home/.local/bin"
    printf 'mine\n' > "$t/home/.local/bin/mksync"

    run_install "$t/stub:$PATH" /dev/null --no-setup
    (( rc == 1 )) || fail "install.sh exited $rc, want 1"

    grep -Fq "ERROR: $t/home/.local/bin/mksync already exists; remove it and run this again." "$out" \
        || fail "missing the link-conflict error"
    [[ $(cat "$t/home/.local/bin/mksync") == mine ]] || fail "the existing file was touched"
}

case_install_missing_jq_yes() {
    setup_install_origin
    make_install_stubs
    make_install_path

    run_install "$t/stub" /dev/null --yes --no-setup
    (( rc == 0 )) || fail "install.sh exited $rc, want 0"

    grep -Fq 'apt-get install -y jq' "$t/stub/log" || fail "the apt-get stub did not install jq"
    [[ -x $t/home/.local/bin/mksync ]] || fail "the program was not installed"
}

case_install_missing_jq_no_answer() {
    setup_install_origin
    make_install_stubs
    make_install_path
    printf 'n\n' > "$t/answers"

    run_install "$t/stub" "$t/answers" --no-setup
    (( rc == 1 )) || fail "install.sh exited $rc, want 1"

    grep -Fq 'ERROR: install jq with your package manager, then run this again.' "$out" \
        || fail "missing the package-manager error"
    [[ ! -e $t/stub/log ]] || fail "the apt-get stub was called"
}

# Nobody to answer (EOF): the installer must not run sudo unattended.
case_install_missing_jq_eof() {
    setup_install_origin
    make_install_stubs
    make_install_path

    run_install "$t/stub" /dev/null --no-setup
    (( rc == 1 )) || fail "install.sh exited $rc, want 1"

    grep -Fq 'ERROR: install jq with your package manager, then run this again.' "$out" \
        || fail "missing the package-manager error"
    [[ ! -e $t/stub/log ]] || fail "the apt-get stub was called"
}

case_install_macos_no_brew() {
    setup_install_origin
    make_install_path

    SYNC_OS=macos SYNC_BREW_BASH="$t/brewbin/bash" \
        run_install "$t/stub" /dev/null --no-setup
    (( rc == 1 )) || fail "install.sh exited $rc, want 1"

    grep -Fq 'ERROR: install Homebrew first: https://brew.sh' "$out" \
        || fail "missing the Homebrew error"
    [[ ! -e $t/home/SyncSettings ]] || fail "the installer cloned without Homebrew"
}

case_install_macos_fresh() {
    setup_install_origin
    make_macos_install_stubs

    printf 'y\n' > "$t/answers"
    SYNC_OS=macos SYNC_ARCH=arm64 SYNC_BREW_BASH="$t/brewbin/bash" \
        run_install "$t/stub:$PATH:$t/brewbin" "$t/answers"
    (( rc == 0 )) || fail "install.sh exited $rc, want 0"

    grep -Fq 'brew install bash jq' "$t/stub/log" || fail "Homebrew did not install bash and jq"
    if grep -q '^sudo ' "$t/stub/log"; then
        fail "the macOS install ran sudo"
    fi
    cmp -s "$t/home/.local/bin/mksync" "$t/release/download/v9.9.9/mksync-darwin-arm64" \
        || fail "mksync is not the downloaded macOS program"
    grep -Fq 'Setup done.' "$out" || fail "setup did not run under the Homebrew bash"
    [[ -f $t/home/.config/fixture/shared.conf ]] || fail "setup did not import the common fixture"
}

case_install_macos_deps_eof() {
    setup_install_origin
    make_macos_install_stubs

    SYNC_OS=macos SYNC_BREW_BASH="$t/brewbin/bash" \
        run_install "$t/stub:$PATH:$t/brewbin" /dev/null --no-setup
    (( rc == 1 )) || fail "install.sh exited $rc, want 1"

    grep -Fq 'ERROR: install bash and jq with Homebrew' "$out" || fail "missing the Homebrew error"
    [[ ! -e $t/stub/log ]] || fail "the brew stub was called"
    [[ ! -e $t/home/SyncSettings ]] || fail "the installer cloned after end of input"
}

case_install_macos_deps_no() {
    setup_install_origin
    make_macos_install_stubs
    printf 'n\n' > "$t/answers"

    SYNC_OS=macos SYNC_BREW_BASH="$t/brewbin/bash" \
        run_install "$t/stub:$PATH:$t/brewbin" "$t/answers" --no-setup
    (( rc == 1 )) || fail "install.sh exited $rc, want 1"

    [[ ! -e $t/stub/log ]] || fail "the brew stub was called"
    [[ ! -e $t/home/SyncSettings ]] || fail "the installer cloned after a declined install"
}

case_install_macos_has_deps() {
    setup_install_origin
    make_macos_install_stubs
    ln -sf "$(command -v bash)" "$t/brewbin/bash"

    SYNC_OS=macos SYNC_ARCH=arm64 SYNC_BREW_BASH="$t/brewbin/bash" \
        run_install "$t/stub:$PATH:$t/brewbin" /dev/null --no-setup
    (( rc == 0 )) || fail "install.sh exited $rc, want 0"

    [[ ! -e $t/stub/log ]] || fail "the brew stub was called"
    [[ -x $t/home/.local/bin/mksync ]] || fail "the program was not installed"
}

case_install_runs_setup() {
    setup_install_origin
    make_install_stubs
    printf 'PRETTY_NAME="Test OS"\nID=debian\n' > "$t/os-release"
    export SYNC_OS_RELEASE="$t/os-release"

    run_install "$t/stub:$PATH" /dev/null --yes
    (( rc == 0 )) || fail "install.sh exited $rc, want 0"

    [[ -f $t/home/.config/fixture/plain.txt ]] || fail "setup did not import plain.txt"
    grep -Fq 'Setup done.' "$out" || fail "missing the Setup done line"
    grep -Fq 'Installed. Run mksync any time.' "$out" || fail "missing the Installed line"
}

case_install_partial() {
    setup_install_origin
    sed '$d' "$REPO/install.sh" > "$t/install-partial.sh"

    rc=0
    (cd "$t" && PATH="$t/stub:$PATH" HOME="$t/home" \
        SYNCSETTINGS_REPO_URL="$t/origin.git" SYNCSETTINGS_TTY=/dev/null \
        GIT_TERMINAL_PROMPT=0 bash "$t/install-partial.sh" --no-setup) > "$out" 2>&1 || rc=$?
    (( rc == 0 )) || fail "the partial download exited $rc, want 0"

    [[ ! -e $t/home/SyncSettings ]] || fail "the partial download cloned"
    [[ ! -e $t/home/.local/bin/mksync ]] || fail "the partial download linked mksync"
}

# The installer downloads the release program, checks it, installs it 0755 and
# runs setup through it.
case_install_download() {
    setup_install_origin

    SYNC_ARCH=x86_64 run_install "$t/stub:$PATH" /dev/null --yes
    (( rc == 0 )) || fail "install.sh exited $rc, want 0"

    cmp -s "$t/home/.local/bin/mksync" "$t/release/download/v9.9.9/mksync-linux-x64" \
        || fail "mksync is not the downloaded program"
    [[ $(file_mode "$t/home/.local/bin/mksync") == 755 ]] \
        || fail "mksync mode is $(file_mode "$t/home/.local/bin/mksync"), want 755"
    grep -Fq 'mksync setup' "$t/stub/log" || fail "setup did not run through the downloaded program"
}

# A SHA256SUMS line that doesn't match the download stops the install.
case_install_checksum_mismatch() {
    setup_install_origin
    printf '%064d  mksync-linux-x64\n' 0 > "$t/release/download/v9.9.9/SHA256SUMS"

    SYNC_ARCH=x86_64 run_install "$t/stub:$PATH" /dev/null --no-setup
    (( rc == 1 )) || fail "install.sh exited $rc, want 1"

    grep -Fq 'ERROR: mksync-linux-x64: checksum does not match SHA256SUMS.' "$out" \
        || fail "missing the checksum error"
    [[ ! -e $t/home/.local/bin/mksync ]] || fail "the installer installed the program anyway"
}

# --runtime links the clone's launcher and never downloads.
case_install_runtime() {
    setup_install_origin

    run_install "$t/stub:$PATH" /dev/null --no-setup --runtime node
    (( rc == 0 )) || fail "install.sh exited $rc, want 0"

    [[ -L $t/home/.local/bin/mksync ]] || fail "mksync is not a symlink"
    # The installer links to the clone's real path (pwd -P): on macOS $t is
    # under /var, a link to /private/var.
    local clone
    clone=$(cd "$t/home/SyncSettings" && pwd -P)
    [[ $(readlink "$t/home/.local/bin/mksync") == "$clone/mksync" ]] \
        || fail "mksync does not link to the clone's launcher"
    [[ ! -e $t/stub/curl.log ]] || fail "the curl stub ran for --runtime"
}

# A latest link that names no x.y.z tag (GitHub's /releases page while no
# release exists) stops before any download.
case_install_no_release() {
    setup_install_origin
    printf 'releases\n' > "$t/release/latest"

    SYNC_ARCH=x86_64 run_install "$t/stub:$PATH" /dev/null --no-setup
    (( rc == 1 )) || fail "install.sh exited $rc, want 1"

    grep -Fq "ERROR: could not find the latest release at file://$t/release." "$out" \
        || fail "missing the no-release error"
    [[ ! -e $t/home/.local/bin/mksync ]] || fail "the installer installed a program anyway"
}

# A CPU with no release program stops before anything is installed.
case_install_unsupported_arch() {
    setup_install_origin

    SYNC_ARCH=ia32 run_install "$t/stub:$PATH" /dev/null --no-setup
    (( rc == 1 )) || fail "install.sh exited $rc, want 1"

    grep -Fq 'ERROR: no mksync program for linux ia32.' "$out" \
        || fail "missing the unsupported-arch error"
    [[ ! -e $t/home/.local/bin/mksync ]] || fail "the installer installed a program anyway"
}

# A second install over the same program leaves it unchanged.
case_install_twice() {
    setup_install_origin

    run_install "$t/stub:$PATH" /dev/null --no-setup
    (( rc == 0 )) || fail "the first install exited $rc, want 0"
    local hash mode
    hash=$(sha256_of "$t/home/.local/bin/mksync")
    mode=$(file_mode "$t/home/.local/bin/mksync")

    run_install "$t/stub:$PATH" /dev/null --no-setup
    (( rc == 0 )) || fail "the second install exited $rc, want 0"

    [[ $(sha256_of "$t/home/.local/bin/mksync") == "$hash" ]] || fail "the second install changed the program"
    [[ $(file_mode "$t/home/.local/bin/mksync") == "$mode" ]] || fail "the second install changed the mode"
}

# -- Runner --------------------------------------------------------------------

while IFS= read -r fn; do
    case_name=${fn#case_}
    case_name=${case_name//_/-}
    if [[ -n $filter && $case_name != *"$filter"* ]]; then
        continue
    fi
    # Each case runs in a subshell so its EXIT trap (new_tmp) cleans up its temp dir.
    # set -e is off inside this command substitution (it is an if condition), so
    # every assertion must end in || fail.
    if out_text=$("$fn"); then
        printf 'ok   %s\n' "$case_name"
        passed=$((passed + 1))
    else
        printf '%s\n' "$out_text"
        failed=1
        failed_cases=$((failed_cases + 1))
    fi
done < <(compgen -A function case_)

printf '%d passed, %d failed, %d skipped\n' "$passed" "$failed_cases" "$skipped"

exit "$failed"
