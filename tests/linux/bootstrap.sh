#!/usr/bin/env bash
# Stub tests for bootstrap/linux.sh: the guard checks and step order run against
# stub tools only, so no case can reach the real sudo, apt-get, snap, curl,
# code, pipx, git or claude. Usage: tests/linux/bootstrap.sh [case-name-filter]

set -euo pipefail

SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$SOURCE_DIR/../.." && pwd)

filter=${1:-}
failed=0
case_name=''
t=''
out=''
rc=0

# -- Helpers -------------------------------------------------------------------

fail() {
    printf 'FAIL %s: %s\n' "$case_name" "$*"
    # Cases run in a command-substitution subshell, where errexit does not abort
    # function bodies; exit the subshell so the runner reports the failure.
    exit 1
}

# The status line the code under test prints, to match it exactly.
status_line() {
    printf '  %-10s %s%s\n' "$1" "$2" "${3:+  ($3)}"
}

output_has_status() {
    grep -Fqx "$(status_line "$@")" "$out"
}

# Fresh throwaway working dir; removed when this case's subshell exits.
new_tmp() {
    t=$(mktemp -d)
    out=$t/out
    trap 'rm -rf "$t"' EXIT
}

# A stub tool: log "<tool> <args>" to $t/calls, print the stub's canned output,
# then exit with the stub's rc (0 unless a case writes one).
make_stub() {
    local tool=$1
    cat > "$t/bin/$tool" <<EOF
#!/bin/sh
printf '%s %s\n' "$tool" "\$*" >> "$t/calls"
cat "$t/stub/$tool.out" 2>/dev/null
rc=\$(cat "$t/stub/$tool.rc" 2>/dev/null || echo 0)
[ "\$rc" -eq 0 ] || exit "\$rc"
EOF
    chmod +x "$t/bin/$tool"
}

# npm logs its arguments and the PATH it ran with, so a case can prove the
# newest Node's bin comes first. install fails only when its rc file says so.
make_npm_stub() {
    cat > "$t/bin/npm" <<EOF
#!/bin/sh
printf 'npm %s\n' "\$*" >> "$t/calls"
printf 'npm-path %s\n' "\$PATH" >> "$t/calls"
cat "$t/stub/npm.out" 2>/dev/null
rc=\$(cat "$t/stub/npm.rc" 2>/dev/null || echo 0)
[ "\$rc" -eq 0 ] || exit "\$rc"
EOF
    chmod +x "$t/bin/npm"
}

# sudo logs like the other stubs, then runs the command it was given. `-v`
# only validates, so it just succeeds.
make_sudo_stub() {
    cat > "$t/bin/sudo" <<EOF
#!/bin/sh
printf 'sudo %s\n' "\$*" >> "$t/calls"
cat "$t/stub/sudo.out" 2>/dev/null
rc=\$(cat "$t/stub/sudo.rc" 2>/dev/null || echo 0)
[ "\$rc" -eq 0 ] || exit "\$rc"
if [ "\$1" = -v ] || [ "\$1" = -k ]; then
    exit 0
fi
exec "\$@"
EOF
    chmod +x "$t/bin/sudo"
}

# curl logs, then copies $t/net/<basename of the URL> to its -o path, or exits
# 22 when that file is missing.
make_curl_stub() {
    cat > "$t/bin/curl" <<EOF
#!/bin/sh
printf 'curl %s\n' "\$*" >> "$t/calls"
out=''
url=''
while [ "\$#" -gt 0 ]; do
    case \$1 in
        -o) out=\$2; shift 2 ;;
        -*) shift ;;
        *) url=\$1; shift ;;
    esac
done
base=\${url##*/}
if [ -n "\$out" ] && [ -f "$t/net/\$base" ]; then
    cp "$t/net/\$base" "\$out"
    exit 0
fi
exit 22
EOF
    chmod +x "$t/bin/curl"
}

# git: init and fetch only log. checkout fills the tree a real extension commit
# has, so the step's recipe has something to copy, and install.sh writes a marker
# that proves the step never runs it. rev-parse prints $t/stub/git-rev.out.
make_git_stub() {
    cat > "$t/bin/git" <<EOF
#!/bin/sh
printf 'git %s\n' "\$*" >> "$t/calls"
dir=''
while [ "\$#" -gt 0 ]; do
    case \$1 in
        -C) dir=\$2; shift 2 ;;
        -c) shift 2 ;;
        -*) shift ;;
        *) break ;;
    esac
done
rc() { cat "$t/stub/\$1.rc" 2>/dev/null || echo 0; }
case \$1 in
    init|fetch) exit "\$(rc git-\$1)" ;;
    checkout)
        [ "\$(rc git-checkout)" -eq 0 ] || exit "\$(rc git-checkout)"
        uuid=\${dir##*/}
        mkdir -p "\$dir/src/modern" "\$dir/src/legacy" "\$dir/schemas"
        printf 'export default class {}\n' > "\$dir/src/modern/extension.js"
        printf '// legacy\n' > "\$dir/src/legacy/old.js"
        printf '#!/bin/sh\ntouch "$t/install-sh-ran"\n' > "\$dir/install.sh"
        printf '{"uuid":"%s","shell-version":["50"]}\n' "\$uuid" > "\$dir/metadata.json"
        printf '/* stylesheet */\n' > "\$dir/stylesheet.css"
        printf '<schema/>\n' > "\$dir/schemas/x.xml"
        exit 0 ;;
    rev-parse) cat "$t/stub/git-rev.out" 2>/dev/null; exit 0 ;;
esac
exit 0
EOF
    chmod +x "$t/bin/git"
}

# code: --list-extensions prints $t/stub/code.out and exits with the rc in
# $t/stub/code-list.rc (0 unless a case writes one). An install succeeds unless
# $t/stub/code-fail/<id> exists, so one id can fail without the others.
make_code_stub() {
    cat > "$t/bin/code" <<EOF
#!/bin/sh
printf 'code %s\n' "\$*" >> "$t/calls"
case \$1 in
    --list-extensions)
        cat "$t/stub/code.out" 2>/dev/null
        exit "\$(cat "$t/stub/code-list.rc" 2>/dev/null || echo 0)" ;;
    --install-extension)
        [ ! -f "$t/stub/code-fail/\$2" ] || exit 1
        exit 0 ;;
esac
exit 0
EOF
    chmod +x "$t/bin/code"
    mkdir -p "$t/stub/code-fail"
}

# snap: a plain `snap list` passes unless $t/stub/snap.rc says otherwise. A
# `snap list <name>` passes only when $t/stub/snap-present/<name> exists. wait
# and install succeed unless their rc file says otherwise.
make_snap_stub() {
    cat > "$t/bin/snap" <<EOF
#!/bin/sh
printf 'snap %s\n' "\$*" >> "$t/calls"
case \$1 in
    list)
        shift
        if [ "\$#" -eq 0 ]; then
            cat "$t/stub/snap.out" 2>/dev/null
            exit "\$(cat "$t/stub/snap.rc" 2>/dev/null || echo 0)"
        fi
        if [ -f "$t/stub/snap-present/\$1" ]; then
            printf '%s 1.0 1 latest/stable\n' "\$1"
            exit 0
        fi
        printf 'error: no matching snaps installed\n' >&2
        exit 1 ;;
    install) exit "\$(cat "$t/stub/snap-install.rc" 2>/dev/null || echo 0)" ;;
    wait) exit "\$(cat "$t/stub/snap-wait.rc" 2>/dev/null || echo 0)" ;;
esac
exit 0
EOF
    chmod +x "$t/bin/snap"
    mkdir -p "$t/stub/snap-present"
}

# Build $t/repo from the real bootstrap/, scripts/ and packages/linux/, plus a
# stub home, a fake root holding /etc/os-release, and the tool stubs. Cases
# overwrite stub outputs/rc files or package lists before running.
setup_case() {
    new_tmp
    mkdir -p "$t/repo" "$t/home" "$t/root/etc" "$t/bin" "$t/sysbin" "$t/stub" "$t/net" "$t/tmp"
    : > "$t/calls"
    cp -a "$REPO/bootstrap" "$t/repo/"
    cp -a "$REPO/scripts" "$t/repo/"
    mkdir -p "$t/repo/packages"
    cp -a "$REPO/packages/linux" "$t/repo/packages/"
    # Entry points used by later steps: log their arguments, then print
    # $t/stub/import.out and exit with $t/stub/import.rc, so a case can make it
    # fail or report a file in ERROR.
    cat > "$t/repo/import.sh" <<EOF
#!/bin/sh
printf 'import' >> "$t/calls"
for a in "\$@"; do printf ' %s' "\$a" >> "$t/calls"; done
printf '\n' >> "$t/calls"
cat "$t/stub/import.out" 2>/dev/null
rc=\$(cat "$t/stub/import.rc" 2>/dev/null || echo 0)
[ "\$rc" -eq 0 ] || exit "\$rc"
EOF
    cat > "$t/repo/sync" <<EOF
#!/bin/sh
printf 'sync %s\n' "\$*" >> "$t/calls"
EOF
    chmod +x "$t/repo/import.sh" "$t/repo/sync"
    printf 'ID=ubuntu\nVERSION_ID=26.04\n' > "$t/root/etc/os-release"
    printf '1000\n' > "$t/stub/id.out"
    printf 'x86_64\n' > "$t/stub/uname.out"
    local tool
    for tool in apt-get dpkg-query dpkg-deb pipx claude glib-compile-schemas fc-cache id uname nvm; do
        make_stub "$tool"
    done
    make_code_stub
    make_npm_stub
    make_sudo_stub
    make_curl_stub
    make_git_stub
    make_snap_stub
    # Nothing is installed unless a case writes `installed <name>` lines here,
    # which is the format dpkg_installed parses.
    : > "$t/stub/dpkg-query.out"
    local p
    for tool in bash awk sed grep sort comm cmp cp mv rm mkdir mktemp chmod ln cat tar unzip sha256sum install env dirname basename tr cut head tail tee find jq xz gzip ls wc readlink; do
        p=$(command -v "$tool") || fail "$tool is not installed"
        ln -s "$p" "$t/sysbin/$tool"
    done
}

# Run bootstrap from $t/repo with a throwaway HOME and a PATH that holds only
# the stubs and an allowlist of harmless tools. Set bootstrap_session='' to run
# without a session bus (restore-no-session); it defaults to a fake one.
run_bootstrap() {
    local session=${bootstrap_session-unix:path=/dev/null}
    rc=0
    (cd "$t/repo" && env -i HOME="$t/home" PATH="$t/bin:$t/sysbin" \
        BOOTSTRAP_ROOT="$t/root" DBUS_SESSION_BUS_ADDRESS="$session" TMPDIR="$t/tmp" \
        bash "$t/repo/bootstrap/linux.sh" "$@" < /dev/null) > "$out" 2>&1 || rc=$?
}

# Replace $t/repo/packages/linux with a small set that passes check-packages.sh:
# two apt names, one source and one key under each keyring folder, both keys
# referenced. Cases write the list files and sources they need over this.
make_packages() {
    local dir=$t/repo/packages/linux
    rm -rf "$dir"
    mkdir -p "$dir/apt-sources/keyrings"
    printf 'ca-certificates\ngit\n' > "$dir/apt.txt"
    : > "$dir/deb.txt"
    # The real tool pins: seed_tools makes their targets exist, so the step
    # makes no request. Cases that test a recipe write their own lines.
    cp "$REPO/packages/linux/tools.txt" "$dir/tools.txt"
    cat > "$dir/apt-sources/test.sources" <<'EOF'
Types: deb
URIs: https://example.com/apt
Suites: stable
Components: main
Signed-By: /usr/share/keyrings/test.gpg
EOF
    cat > "$dir/apt-sources/other.list" <<'EOF'
deb [signed-by=/etc/apt/keyrings/other.gpg] https://example.com/other stable main
EOF
    printf 'key\n' > "$dir/apt-sources/keyrings/test.gpg"
    printf 'key\n' > "$dir/apt-sources/keyrings/other.gpg"
    # A Node that is already installed, so cases about other steps leave node,
    # npm and pipx idle. The node cases replace this with the state they need.
    make_nvm_sh "$t/home"
    make_node_version v22.1.0
    seed_tools
}

# Every standalone tool already installed, so step_tools reports UNCHANGED and
# downloads nothing in cases about other steps. The tool cases remove the
# targets they test.
seed_tools() {
    mkdir -p "$t/home/.bun/bin" "$t/home/.local/bin"
    : > "$t/home/.bun/bin/bun"
    : > "$t/home/.local/bin/rtk"
    : > "$t/home/.local/bin/copilot"
    : > "$t/home/.local/bin/claude"
}

# Place the repo's apt sources and keys at their install targets, byte-identical,
# so the step reports UNCHANGED and leaves APT_STALE alone. Keys land in both
# keyring folders so the Signed-By path matches whichever one a source names.
seed_sources() {
    local dir=$t/repo/packages/linux/apt-sources src key
    mkdir -p "$t/root/etc/apt/sources.list.d" "$t/root/usr/share/keyrings" "$t/root/etc/apt/keyrings"
    for src in "$dir"/*.sources "$dir"/*.list; do
        [[ -f $src ]] || continue
        cp "$src" "$t/root/etc/apt/sources.list.d/${src##*/}"
    done
    for key in "$dir/keyrings/"*.gpg; do
        [[ -f $key ]] || continue
        cp "$key" "$t/root/usr/share/keyrings/${key##*/}"
        cp "$key" "$t/root/etc/apt/keyrings/${key##*/}"
    done
}

# Put the release asset in $t/net and write fonts.txt pinned to its hash. The
# archive is a real .tar.xz holding one font file, unless $4 is `raw`, which
# writes $3 as the asset so the hash matches but tar can't unpack it.
make_font_release() {
    local asset=$1 tag=$2 body=${3:-font bytes} kind=${4:-tar} sha
    rm -rf "$t/font-fixture"
    mkdir -p "$t/font-fixture"
    if [[ $kind == tar ]]; then
        printf '%s\n' "$body" > "$t/font-fixture/$asset.ttf"
        tar -cJf "$t/net/$asset.tar.xz" -C "$t/font-fixture" "$asset.ttf"
    else
        printf '%s\n' "$body" > "$t/net/$asset.tar.xz"
    fi
    sha=$(sha256sum "$t/net/$asset.tar.xz" | cut -d' ' -f1)
    printf '%s %s %s\n' "$asset" "$tag" "$sha" > "$t/repo/packages/linux/fonts.txt"
}

# Write one gnome-extensions.txt line and the commit its rev-parse should print.
make_extension_list() {
    local uuid=$1 url=$2 commit=$3
    printf '%s %s %s\n' "$uuid" "$url" "$commit" > "$t/repo/packages/linux/gnome-extensions.txt"
    printf '%s\n' "$commit" > "$t/stub/git-rev.out"
}

# The fixture nvm.sh for $1/.nvm: nvm is a function logging every call. The real
# script can't run here, and a binary stub can't be sourced.
make_nvm_sh() {
    local home=$1
    mkdir -p "$home/.nvm"
    cat > "$home/.nvm/nvm.sh" <<EOF
nvm() {
    printf 'nvm %s\n' "\$*" >> "$t/calls"
}
EOF
}

# The pinned nvm installer in $t/net plus its tools.txt line. With PROFILE
# unset it appends to ~/.bashrc, as the real installer does; it leaves a fixture
# nvm.sh and one Node version behind, so the step can carry on.
make_nvm_release() {
    mkdir -p "$t/net"
    cat > "$t/net/install.sh" <<EOF
#!/bin/sh
PROFILE=\${PROFILE:-\$HOME/.bashrc}
printf 'nvm-install PROFILE=%s NVM_DIR=%s\n' "\$PROFILE" "\$NVM_DIR" >> "$t/calls"
printf 'nvm touched\n' >> "\$PROFILE"
mkdir -p "\$NVM_DIR/versions/node/v22.1.0/lib/node_modules"
cat > "\$NVM_DIR/nvm.sh" <<'NVMSH'
nvm() {
    printf 'nvm %s\n' "\$*" >> "$t/calls"
}
NVMSH
EOF
    local sha
    sha=$(sha256sum "$t/net/install.sh" | cut -d' ' -f1)
    printf 'nvm https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh %s\n' "$sha" \
        > "$t/repo/packages/linux/tools.txt"
}

# A Node version folder under the throwaway home, with the given npm packages
# already in lib/node_modules. No real binaries: the npm stub is on PATH.
make_node_version() {
    local version=$1 path
    local dir=$t/home/.nvm/versions/node/$version/lib/node_modules
    shift
    mkdir -p "$dir"
    for path in "$@"; do
        mkdir -p "$dir/$path"
    done
}

# Build the release asset in $t/net under its URL basename. A zip holds
# bun-linux-x64/bun; a tarball holds $name plus a LICENSE sibling, so a recipe
# that unpacked the whole archive would leave the LICENSE behind; raw writes
# text, so the hash matches but the archive can't be unpacked. The zip is made
# with python3, on the test side only: `zip` may not be installed, and python3
# never enters the stub PATH.
make_tool_asset() {
    local name=$1 url=$2 kind=${3:-tar} body=${4:-$1 binary} base
    base=${url##*/}
    rm -rf "$t/tool-fixture"
    mkdir -p "$t/tool-fixture"
    case $kind in
        zip)
            mkdir -p "$t/tool-fixture/bun-linux-x64"
            printf '%s\n' "$body" > "$t/tool-fixture/bun-linux-x64/bun"
            python3 -I -c 'import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.write(sys.argv[2], "bun-linux-x64/bun")' \
                "$t/net/$base" "$t/tool-fixture/bun-linux-x64/bun"
            ;;
        tar)
            printf '%s\n' "$body" > "$t/tool-fixture/$name"
            printf 'license\n' > "$t/tool-fixture/LICENSE"
            tar -czf "$t/net/$base" -C "$t/tool-fixture" "$name" LICENSE
            ;;
        raw)
            printf '%s\n' "$body" > "$t/net/$base"
            ;;
    esac
}

# Append one tools.txt line for the asset already in $t/net. Without a hash
# argument it records the file's own, so the step's check passes.
write_tool_line() {
    local name=$1 url=$2 sha=${3:-}
    [[ -n $sha ]] || sha=$(sha256sum "$t/net/${url##*/}" | cut -d' ' -f1)
    printf '%s %s %s\n' "$name" "$url" "$sha" >> "$t/repo/packages/linux/tools.txt"
}

# The restore cases don't care about the earlier steps: seed them all idle, so
# only import, links, plugins and preview do anything, and snapd is "down".
seed_restore() {
    make_packages
    seed_sources
    printf 'installed ca-certificates\ninstalled git\n' > "$t/stub/dpkg-query.out"
    printf '1\n' > "$t/stub/snap.rc"
}

# A claude stub that records plugin state the way the real tool does: `plugin
# marketplace add <spec>` keys known_marketplaces.json by the marketplace name it
# finds in settings.json and drops that marketplace's autoUpdate, and `plugin
# install <plugin>` keys installed_plugins.json's .plugins object. It logs like
# the other stubs, then exits with $t/stub/claude.rc, so a case can make it
# rewrite settings.json and then fail.
make_claude_stub() {
    cat > "$t/home/.local/bin/claude" <<EOF
#!/bin/sh
printf 'claude %s\n' "\$*" >> "$t/calls"
settings=$t/home/.claude/settings.json
plugins=$t/home/.claude/plugins
mkdir -p "\$plugins"
[ -f "\$plugins/known_marketplaces.json" ] || printf '{}\n' > "\$plugins/known_marketplaces.json"
[ -f "\$plugins/installed_plugins.json" ] || printf '{"plugins":{}}\n' > "\$plugins/installed_plugins.json"
case \$2 in
    marketplace)
        spec=\$4
        key=\$(jq -r --arg spec "\$spec" '(.extraKnownMarketplaces // {}) | to_entries[] | select((.value.source.repo + (if .value.source.ref then "#" + .value.source.ref else "" end)) == \$spec) | .key' "\$settings")
        jq --arg key "\$key" '.[\$key] = {source: {source: "github"}}' "\$plugins/known_marketplaces.json" > "\$plugins/known.tmp" && mv "\$plugins/known.tmp" "\$plugins/known_marketplaces.json"
        jq --arg key "\$key" 'del(.extraKnownMarketplaces[\$key].autoUpdate)' "\$settings" > "\$settings.tmp" && mv "\$settings.tmp" "\$settings"
        ;;
    install)
        printf '%s\n' "\$PATH" > "$t/stub/claude.path"
        plugin=\$3
        jq --arg p "\$plugin" '.plugins[\$p] = {}' "\$plugins/installed_plugins.json" > "\$plugins/installed.tmp" && mv "\$plugins/installed.tmp" "\$plugins/installed_plugins.json"
        ;;
esac
rc=\$(cat "$t/stub/claude.rc" 2>/dev/null || echo 0)
[ "\$rc" -eq 0 ] || exit "\$rc"
EOF
    chmod +x "$t/home/.local/bin/claude"
}

# Write settings.json with the given extraKnownMarketplaces and enabledPlugins
# objects. The plugin state folder is left to the claude stub to create.
make_claude_settings() {
    local markets=$1 plugins=$2
    mkdir -p "$t/home/.claude"
    printf '{"extraKnownMarketplaces": %s, "enabledPlugins": %s}\n' "$markets" "$plugins" \
        > "$t/home/.claude/settings.json"
}

# An executable script in ~/.claude/bin, as import leaves it, for step_links to
# link into ~/.local/bin.
seed_claude_bin() {
    mkdir -p "$t/home/.claude/bin"
    : > "$t/home/.claude/bin/mk-exec"
    chmod +x "$t/home/.claude/bin/mk-exec"
}

# -- Cases ---------------------------------------------------------------------

case_guard_root() {
    setup_case
    printf '0\n' > "$t/stub/id.out"
    run_bootstrap
    (( rc == 2 )) || fail "exited $rc, want 2"
    grep -Fq 'run bootstrap as your own user, not root.' "$out" || fail 'missing root message'
    ! grep -q '^sudo ' "$t/calls" || fail 'sudo was called'
}

case_guard_arch() {
    setup_case
    printf 'aarch64\n' > "$t/stub/uname.out"
    run_bootstrap
    (( rc == 2 )) || fail "exited $rc, want 2"
    grep -Fq 'the pinned downloads are for x86_64.' "$out" || fail 'missing arch message'
}

case_guard_not_ubuntu() {
    setup_case
    printf 'ID=debian\nVERSION_ID=26.04\n' > "$t/root/etc/os-release"
    run_bootstrap
    (( rc == 2 )) || fail "exited $rc, want 2"
    grep -Fq 'bootstrap needs Ubuntu.' "$out" || fail 'missing Ubuntu message'
}

case_guard_bad_list() {
    setup_case
    printf '%s\n' '-x' > "$t/repo/packages/linux/apt.txt"
    run_bootstrap
    (( rc == 2 )) || fail "exited $rc, want 2"
    grep -Fq 'fix packages/linux first.' "$out" || fail 'missing package-list message'
    grep -Fq 'apt.txt:1:' "$out" || fail 'the bad line was not reported'
    ! grep -q '^sudo ' "$t/calls" || fail 'sudo was called'
}

case_guard_sudo_refused() {
    setup_case
    printf '1\n' > "$t/stub/sudo.rc"
    run_bootstrap
    (( rc == 2 )) || fail "exited $rc, want 2"
    grep -Fq 'sudo is needed for apt and snap.' "$out" || fail 'missing sudo message'
    printf 'id -u\nuname -m\nsudo -v\n' > "$t/expected"
    cmp -s "$t/expected" "$t/calls" || fail "unexpected calls: $(cat "$t/calls")"
}

case_guard_other_release() {
    setup_case
    make_packages
    printf 'ID=ubuntu\nVERSION_ID=24.04\n' > "$t/root/etc/os-release"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    grep -Fq 'WARNING: the lists were recorded on Ubuntu 26.04.' "$out" || fail 'missing version warning'
}

case_guard_unknown_option() {
    setup_case
    run_bootstrap --nope
    (( rc == 1 )) || fail "exited $rc, want 1"
    grep -Fq 'Usage:' "$out" || fail 'missing usage'
}

case_guard_help() {
    setup_case
    run_bootstrap --help
    (( rc == 0 )) || fail "exited $rc, want 0"
    grep -Fq 'Usage:' "$out" || fail 'missing usage'
    [[ ! -s "$t/calls" ]] || fail "calls were made: $(cat "$t/calls")"
}

case_guard_dry_run_no_sudo() {
    setup_case
    run_bootstrap --dry-run
    (( rc == 0 )) || fail "exited $rc, want 0"
    ! grep -q '^sudo ' "$t/calls" || fail 'sudo was called'
    ! grep -q '^curl ' "$t/calls" || fail 'curl was called'
}

case_guard_step_order() {
    setup_case
    make_packages
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    local expected got
    expected=$(printf '  -- %s\n' 'apt sources' apt debs snaps fonts extensions node npm pipx tools import links plugins vscode preview)
    got=$(grep '^  -- ' "$out")
    [[ $got == "$expected" ]] || fail "step order wrong: $(printf '%s\n' "$got")"
}

case_guard_sourced_no_main() {
    setup_case
    rc=0
    (cd "$t/repo" && env -i HOME="$t/home" PATH="$t/bin:$t/sysbin" BOOTSTRAP_ROOT="$t/root" \
        bash -c 'source bootstrap/linux.sh') > "$out" 2>&1 || rc=$?
    (( rc == 0 )) || fail "sourcing exited $rc, want 0"
    ! grep -q '^  -- ' "$out" || fail 'a step ran when sourced'
    ! grep -q '^sudo ' "$t/calls" || fail 'sudo was called when sourced'
}

case_guard_no_jq() {
    setup_case
    rm "$t/sysbin/jq"
    run_bootstrap --dry-run
    (( rc == 0 )) || fail "exited $rc, want 0"
    local before
    before=$(awk '/^  -- /{exit} {print}' "$out")
    ! printf '%s' "$before" | grep -q jq || fail "jq ran before the first step: $before"
}

case_guard_step_failure_continues() {
    setup_case
    make_packages
    printf 'installed ca-certificates\n' > "$t/stub/dpkg-query.out"
    printf '100\n' > "$t/stub/apt-get.rc"
    run_bootstrap
    (( rc == 1 )) || fail "exited $rc, want 1"
    grep -Fq '  -- debs' "$out" || fail 'the step after apt did not run'
    grep -Eq 'ERROR[[:space:]]+apt[[:space:]]+\(failed\)' "$out" || fail 'summary does not name apt'
}

case_guard_sudo_dropped() {
    setup_case
    make_packages
    printf 'code classic\n' > "$t/repo/packages/linux/snap.txt"
    printf 'alpha\n' > "$t/repo/packages/linux/npm.txt"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0; output: $out"
    local k last_snap first_npm
    k=$(grep -n '^sudo -k$' "$t/calls" | head -n1 | cut -d: -f1)
    last_snap=$(grep -n '^sudo snap install' "$t/calls" | tail -n1 | cut -d: -f1)
    first_npm=$(grep -n '^npm install' "$t/calls" | head -n1 | cut -d: -f1)
    [[ -n $k && -n $last_snap && -n $first_npm ]] \
        || fail "missing a call: sudo -k=$k snap install=$last_snap npm install=$first_npm"
    (( last_snap < k && k < first_npm )) \
        || fail "wrong order: snap install=$last_snap sudo -k=$k npm install=$first_npm"
}

case_apt_sources_fresh() {
    setup_case
    make_packages
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    local dir=$t/repo/packages/linux/apt-sources
    local target repo f
    for f in \
        'etc/apt/sources.list.d/test.sources:test.sources' \
        'etc/apt/sources.list.d/other.list:other.list' \
        'usr/share/keyrings/test.gpg:keyrings/test.gpg' \
        'etc/apt/keyrings/other.gpg:keyrings/other.gpg'; do
        target=${f%%:*}
        repo=${f#*:}
        [[ -f "$t/root/$target" ]] || fail "missing $target"
        cmp -s "$dir/$repo" "$t/root/$target" || fail "$target differs from the repo"
        [[ $(stat -c %a "$t/root/$target") == 644 ]] || fail "$target has wrong mode"
    done
}

case_apt_sources_comment_ignored() {
    setup_case
    make_packages
    local dir=$t/repo/packages/linux/apt-sources
    printf '\ndeb [signed-by=/etc/apt/keyrings/x.gpg] https://example.com/x stable main\n# signed-by=/etc/cron.d/x.gpg\n' >> "$dir/other.list"
    printf 'key\n' > "$dir/keyrings/x.gpg"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0; output: $out"
    [[ ! -e "$t/root/etc/cron.d/x.gpg" ]] || fail 'the commented path was installed'
}

case_apt_sources_bad_key_path() {
    setup_case
    make_packages
    local dir=$t/repo/packages/linux/apt-sources
    cat >> "$dir/test.sources" <<'EOF'

Types: deb
URIs: https://example.com/x
Suites: stable
Components: main
Signed-By: /etc/apt/keyrings/x.gpg
X-Note: Signed-By: /etc/cron.d/x.gpg
EOF
    printf 'key\n' > "$dir/keyrings/x.gpg"
    run_bootstrap
    (( rc == 1 )) || fail "exited $rc, want 1"
    output_has_status ERROR /etc/cron.d/x.gpg 'key path outside the keyring folders' \
        || fail 'missing ERROR for the bad key path'
    [[ ! -e "$t/root/etc/cron.d/x.gpg" ]] || fail 'the bad key path was written'
}

case_apt_sources_same() {
    setup_case
    make_packages
    seed_sources
    printf 'installed ca-certificates\ninstalled git\n' > "$t/stub/dpkg-query.out"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    output_has_status UNCHANGED /etc/apt/sources.list.d/test.sources || fail 'missing UNCHANGED for test.sources'
    ! grep -Fq 'install -D' "$t/calls" || fail 'install was called'
}

case_apt_sources_differs() {
    setup_case
    make_packages
    seed_sources
    printf 'different\n' > "$t/root/usr/share/keyrings/test.gpg"
    printf 'installed ca-certificates\ninstalled git\n' > "$t/stub/dpkg-query.out"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    output_has_status SKIPPED /usr/share/keyrings/test.gpg 'differs from the repo; see docs/packages.md' \
        || fail 'missing SKIPPED for the differing key'
    [[ $(cat "$t/root/usr/share/keyrings/test.gpg") == different ]] || fail 'key was overwritten'
}

case_apt_sources_before_install() {
    setup_case
    make_packages
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    local si ui ii
    si=$(grep -n 'install -D -m 0644' "$t/calls" | head -n1 | cut -d: -f1)
    ui=$(grep -n 'apt-get update' "$t/calls" | head -n1 | cut -d: -f1)
    ii=$(grep -n 'apt-get install -y --' "$t/calls" | head -n1 | cut -d: -f1)
    [[ -n $si && -n $ui && -n $ii ]] || fail "missing a call: install=$si update=$ui install=$ii"
    (( si < ui && ui < ii )) || fail "wrong order: install=$si update=$ui install=$ii"
}

case_apt_install_missing() {
    setup_case
    make_packages
    printf 'installed ca-certificates\n' > "$t/stub/dpkg-query.out"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    grep -Fq 'apt-get install -y -- git' "$t/calls" || fail 'git was not installed'
    output_has_status INSTALLED apt/git || fail 'missing INSTALLED apt/git'
    ! grep -Fq 'apt-get install -y -- ca-certificates' "$t/calls" || fail 'ca-certificates installed again'
}

case_apt_nothing_missing() {
    setup_case
    make_packages
    seed_sources
    printf 'installed ca-certificates\ninstalled git\n' > "$t/stub/dpkg-query.out"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    ! grep -q 'apt-get' "$t/calls" || fail 'apt-get was called'
    output_has_status UNCHANGED apt.txt || fail 'missing UNCHANGED apt.txt'
}

case_apt_install_fails() {
    setup_case
    make_packages
    printf 'installed ca-certificates\n' > "$t/stub/dpkg-query.out"
    printf '100\n' > "$t/stub/apt-get.rc"
    run_bootstrap
    (( rc == 1 )) || fail "exited $rc, want 1"
    grep -Fq 'ERROR' "$out" || fail 'no ERROR line'
    grep -Fq '  -- debs' "$out" || fail 'later header did not print'
}

case_apt_dry_run() {
    setup_case
    make_packages
    printf 'installed ca-certificates\n' > "$t/stub/dpkg-query.out"
    run_bootstrap --dry-run
    (( rc == 0 )) || fail "exited $rc, want 0"
    output_has_status WOULD apt/git || fail 'missing WOULD apt/git'
    ! grep -q 'apt-get' "$t/calls" || fail 'apt-get was called'
}

case_deb_installs() {
    setup_case
    make_packages
    local content='deb content' sha
    sha=$(printf '%s' "$content" | sha256sum | cut -d' ' -f1)
    printf 'foo https://example.com/foo.deb %s\n' "$sha" > "$t/repo/packages/linux/deb.txt"
    mkdir -p "$t/net"
    printf '%s' "$content" > "$t/net/foo.deb"
    printf 'foo\n' > "$t/stub/dpkg-deb.out"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    grep -Eq 'apt-get install -y .*foo\.deb' "$t/calls" || fail 'foo.deb was not installed'
    output_has_status INSTALLED deb/foo || fail 'missing INSTALLED deb/foo'
}

case_deb_bad_hash() {
    setup_case
    make_packages
    printf 'foo https://example.com/foo.deb %064d\n' 0 > "$t/repo/packages/linux/deb.txt"
    mkdir -p "$t/net"
    printf 'other bytes\n' > "$t/net/foo.deb"
    run_bootstrap
    (( rc == 1 )) || fail "exited $rc, want 1"
    grep -Fq 'ERROR' "$out" || fail 'no ERROR line'
    grep -Fq 'foo.deb' "$t/calls" || fail 'foo.deb was not downloaded'
    ! grep -Eq 'apt-get install -y .*\.deb' "$t/calls" || fail 'a .deb was installed'
    ! grep -q 'dpkg-deb' "$t/calls" || fail 'dpkg-deb was called'
    # main's trap removes $WORK, so call fetch_verified directly to see the file go.
    # shellcheck disable=SC2016  # expanded by the inner bash
    (cd "$t/repo" && env -i HOME="$t/home" PATH="$t/bin:$t/sysbin" BOOTSTRAP_ROOT="$t/root" bash -c \
        'source bootstrap/linux.sh; ! fetch_verified https://example.com/foo.deb "$1" "$HOME/foo.deb"' _ \
        "$(printf '%064d' 0)") || fail 'fetch_verified accepted a bad hash'
    [[ ! -e $t/home/foo.deb ]] || fail 'the file with the bad hash was left behind'
}

# A new source needs an update even when every package is already installed.
case_apt_update_new_source() {
    setup_case
    make_packages
    printf 'installed ca-certificates\ninstalled git\n' > "$t/stub/dpkg-query.out"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    grep -Fq 'apt-get update' "$t/calls" || fail 'apt-get update was not called'
    ! grep -Fq 'apt-get install' "$t/calls" || fail 'apt-get install was called'
}

# More output than a pipe holds, with the match first: a pipe into grep -q would
# kill the writer and report ca-certificates as missing.
case_apt_certs_long_list() {
    setup_case
    make_packages
    seed_sources
    { printf 'installed ca-certificates\ninstalled git\n'
      awk 'BEGIN { for (i = 0; i < 50000; i++) printf "installed zz%d\n", i }'
    } > "$t/stub/dpkg-query.out"
    run_bootstrap --dry-run
    (( rc == 0 )) || fail "exited $rc, want 0"
    ! grep -q WOULD "$out" || fail "a finished machine printed: $(grep WOULD "$out")"
}

case_deb_wrong_package() {
    setup_case
    make_packages
    local content='deb content' sha
    sha=$(printf '%s' "$content" | sha256sum | cut -d' ' -f1)
    printf 'foo https://example.com/foo.deb %s\n' "$sha" > "$t/repo/packages/linux/deb.txt"
    mkdir -p "$t/net"
    printf '%s' "$content" > "$t/net/foo.deb"
    printf 'bar\n' > "$t/stub/dpkg-deb.out"
    run_bootstrap
    (( rc == 1 )) || fail "exited $rc, want 1"
    grep -Fq 'ERROR' "$out" || fail 'no ERROR line'
    ! grep -Eq 'apt-get install -y .*\.deb' "$t/calls" || fail 'a .deb was installed'
    grep -q 'dpkg-deb' "$t/calls" || fail 'dpkg-deb was not called'
}

case_deb_already_installed() {
    setup_case
    make_packages
    printf 'foo https://example.com/foo.deb %064d\n' 0 > "$t/repo/packages/linux/deb.txt"
    printf 'installed foo\n' > "$t/stub/dpkg-query.out"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    ! grep -q 'curl' "$t/calls" || fail 'curl was called'
    output_has_status UNCHANGED deb/foo || fail 'missing UNCHANGED deb/foo'
}

case_deb_loop_keeps_going() {
    setup_case
    make_packages
    local content='good' sha
    sha=$(printf '%s' "$content" | sha256sum | cut -d' ' -f1)
    printf 'bad https://example.com/bad.deb %064d\n' 0 > "$t/repo/packages/linux/deb.txt"
    printf 'good https://example.com/good.deb %s\n' "$sha" >> "$t/repo/packages/linux/deb.txt"
    mkdir -p "$t/net"
    printf 'wrong bytes\n' > "$t/net/bad.deb"
    printf '%s' "$content" > "$t/net/good.deb"
    printf 'good\n' > "$t/stub/dpkg-deb.out"
    run_bootstrap
    (( rc == 1 )) || fail "exited $rc, want 1"
    grep -Eq 'apt-get install -y .*good\.deb' "$t/calls" || fail 'good.deb was not installed'
    ! grep -Eq 'apt-get install -y .*bad\.deb' "$t/calls" || fail 'bad.deb was installed'
}

# -- Desktop: snaps, fonts, extensions -----------------------------------------

case_desktop_snap_args() {
    setup_case
    make_packages
    printf 'code classic\npostman channel=v11/stable\n' > "$t/repo/packages/linux/snap.txt"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    grep -Fxq 'sudo snap install code --classic' "$t/calls" || fail 'code was not installed with --classic'
    grep -Fxq 'sudo snap install postman --channel=v11/stable' "$t/calls" \
        || fail 'postman was not installed from its channel'
    output_has_status INSTALLED snap/code || fail 'missing INSTALLED snap/code'
    output_has_status INSTALLED snap/postman || fail 'missing INSTALLED snap/postman'
    [[ $(grep -m1 -E '^sudo snap (wait|install)' "$t/calls") == 'sudo snap wait system seed.loaded' ]] \
        || fail 'snap wait did not come before the first install'
}

case_desktop_snap_both_options() {
    setup_case
    make_packages
    printf 'code classic channel=latest/edge\n' > "$t/repo/packages/linux/snap.txt"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    grep -Fxq 'sudo snap install code --classic --channel=latest/edge' "$t/calls" \
        || fail "wrong install line: $(grep 'snap install' "$t/calls")"
}

case_desktop_snap_failure_continues() {
    setup_case
    make_packages
    printf 'a\nb\n' > "$t/repo/packages/linux/snap.txt"
    printf '1\n' > "$t/stub/snap-install.rc"
    run_bootstrap
    (( rc == 1 )) || fail "exited $rc, want 1"
    output_has_status ERROR snap/a 'install failed' || fail 'missing ERROR snap/a'
    grep -Fxq 'sudo snap install b' "$t/calls" || fail 'the loop stopped at the failed snap'
}

case_desktop_snap_present() {
    setup_case
    make_packages
    printf 'code classic\n' > "$t/repo/packages/linux/snap.txt"
    : > "$t/stub/snap-present/code"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    ! grep -Fq 'snap install code' "$t/calls" || fail 'code was installed again'
    output_has_status UNCHANGED snap/code || fail 'missing UNCHANGED snap/code'
}

case_desktop_snap_down() {
    setup_case
    make_packages
    printf 'code classic\n' > "$t/repo/packages/linux/snap.txt"
    printf '1\n' > "$t/stub/snap.rc"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    output_has_status SKIPPED packages/linux/snap.txt 'snapd not running' \
        || fail 'missing SKIPPED for the snap list'
    ! grep -Fq 'snap install' "$t/calls" || fail 'snap install was called'
}

case_desktop_font_installs() {
    setup_case
    make_packages
    make_font_release TestFont v1.0.0
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    local dest=$t/home/.local/share/fonts/NerdFonts/TestFont
    [[ -f $dest/TestFont.ttf ]] || fail 'the font was not unpacked'
    [[ $(grep -c '^fc-cache -f' "$t/calls") == 1 ]] || fail 'fc-cache -f did not run exactly once'
    output_has_status INSTALLED font/TestFont || fail 'missing INSTALLED font/TestFont'
}

case_desktop_font_bad_hash() {
    setup_case
    make_packages
    make_font_release TestFont v1.0.0
    printf 'TestFont v1.0.0 %064d\n' 0 > "$t/repo/packages/linux/fonts.txt"
    run_bootstrap
    (( rc == 1 )) || fail "exited $rc, want 1"
    output_has_status ERROR font/TestFont 'download or hash failed' || fail 'missing ERROR for the bad hash'
    [[ ! -d $t/home/.local/share/fonts/NerdFonts/TestFont ]] || fail 'a font folder was left behind'
    ! grep -q '^fc-cache' "$t/calls" || fail 'fc-cache ran'
}

case_desktop_font_bad_archive() {
    setup_case
    make_packages
    make_font_release TestFont v1.0.0 'not a tarball' raw
    run_bootstrap
    (( rc == 1 )) || fail "exited $rc, want 1"
    output_has_status ERROR font/TestFont 'unpack failed' || fail 'missing ERROR for the bad archive'
    [[ ! -d $t/home/.local/share/fonts/NerdFonts/TestFont ]] || fail 'a font folder was left behind'
    ! grep -q '^fc-cache' "$t/calls" || fail 'fc-cache ran'
}

case_desktop_font_present() {
    setup_case
    make_packages
    make_font_release TestFont v1.0.0
    mkdir -p "$t/home/.local/share/fonts/NerdFonts/TestFont"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    ! grep -q '^curl ' "$t/calls" || fail 'curl was called'
    output_has_status UNCHANGED font/TestFont || fail 'missing UNCHANGED font/TestFont'
}

case_desktop_ext_installs() {
    setup_case
    make_packages
    make_extension_list test@example.com https://github.com/owner/repo 1111111111111111111111111111111111111111
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    local dest=$t/home/.local/share/gnome-shell/extensions/test@example.com f
    for f in extension.js metadata.json stylesheet.css schemas/x.xml; do
        [[ -f $dest/$f ]] || fail "missing $f"
    done
    for f in old.js install.sh src; do
        [[ ! -e $dest/$f ]] || fail "$f should not be copied"
    done
    grep -Fq 'glib-compile-schemas' "$t/calls" || fail 'glib-compile-schemas was not called'
    output_has_status INSTALLED extension/test@example.com || fail 'missing INSTALLED extension line'
}

case_desktop_ext_wrong_commit() {
    setup_case
    make_packages
    make_extension_list test@example.com https://github.com/owner/repo 1111111111111111111111111111111111111111
    printf '2222222222222222222222222222222222222222\n' > "$t/stub/git-rev.out"
    run_bootstrap
    (( rc == 1 )) || fail "exited $rc, want 1"
    output_has_status ERROR extension/test@example.com 'wrong commit' || fail 'missing ERROR for the wrong commit'
    [[ ! -d $t/home/.local/share/gnome-shell/extensions/test@example.com ]] || fail 'a folder was left behind'
}

case_desktop_ext_no_install_sh() {
    setup_case
    make_packages
    make_extension_list test@example.com https://github.com/owner/repo 1111111111111111111111111111111111111111
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    [[ ! -e $t/install-sh-ran ]] || fail 'the extension installer ran'
}

case_desktop_ext_present() {
    setup_case
    make_packages
    make_extension_list test@example.com https://github.com/owner/repo 1111111111111111111111111111111111111111
    mkdir -p "$t/home/.local/share/gnome-shell/extensions/test@example.com"
    : > "$t/home/.local/share/gnome-shell/extensions/test@example.com/metadata.json"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    ! grep -q '^git ' "$t/calls" || fail 'git was called'
    output_has_status UNCHANGED extension/test@example.com || fail 'missing UNCHANGED extension line'
}

case_desktop_ext_partial_folder() {
    setup_case
    make_packages
    make_extension_list test@example.com https://github.com/owner/repo 1111111111111111111111111111111111111111
    local dest=$t/home/.local/share/gnome-shell/extensions/test@example.com
    mkdir -p "$dest"
    : > "$dest/leftover"
    run_bootstrap
    (( rc == 1 )) || fail "exited $rc, want 1"
    output_has_status ERROR extension/test@example.com 'move failed' || fail 'missing ERROR for the move'
    [[ ! -e $dest/test@example.com ]] || fail 'the build was nested in the folder'
}

case_desktop_ext_fetch_fails() {
    setup_case
    make_packages
    make_extension_list test@example.com https://github.com/owner/repo 1111111111111111111111111111111111111111
    printf '1\n' > "$t/stub/git-fetch.rc"
    run_bootstrap
    (( rc == 1 )) || fail "exited $rc, want 1"
    output_has_status ERROR extension/test@example.com 'fetch failed' || fail 'missing ERROR for the fetch'
    [[ ! -d $t/home/.local/share/gnome-shell/extensions/test@example.com ]] || fail 'a folder was left behind'
}

case_desktop_dry_run() {
    setup_case
    make_packages
    printf 'code classic\n' > "$t/repo/packages/linux/snap.txt"
    make_font_release TestFont v1.0.0
    make_extension_list test@example.com https://github.com/owner/repo 1111111111111111111111111111111111111111
    run_bootstrap --dry-run
    (( rc == 0 )) || fail "exited $rc, want 0"
    output_has_status WOULD snap/code || fail 'missing WOULD snap/code'
    output_has_status WOULD font/TestFont || fail 'missing WOULD font/TestFont'
    output_has_status WOULD extension/test@example.com || fail 'missing WOULD extension line'
    ! grep -Eq '^(sudo snap install|sudo snap wait|curl |git )' "$t/calls" \
        || fail 'a step ran under --dry-run'
}

# -- Node, npm, pipx -----------------------------------------------------------

case_node_installs_nvm() {
    setup_case
    make_packages
    rm -rf "$t/home/.nvm"
    make_nvm_release
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    grep -Fxq "nvm-install PROFILE=/dev/null NVM_DIR=$t/home/.nvm" "$t/calls" \
        || fail "installer did not run with PROFILE=/dev/null: $(cat "$t/calls")"
    output_has_status INSTALLED nvm || fail 'missing INSTALLED nvm'
}

case_node_bad_hash() {
    setup_case
    make_packages
    rm -rf "$t/home/.nvm"
    make_nvm_release
    printf 'nvm https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh %064d\n' 0 \
        > "$t/repo/packages/linux/tools.txt"
    run_bootstrap
    (( rc == 1 )) || fail "exited $rc, want 1"
    output_has_status ERROR nvm 'download or hash failed' || fail 'missing ERROR for the bad hash'
    ! grep -q '^nvm-install ' "$t/calls" || fail 'the installer ran'
}

case_node_profile_untouched() {
    setup_case
    make_packages
    rm -rf "$t/home/.nvm"
    printf 'keep\n' > "$t/home/.bashrc"
    make_nvm_release
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    [[ $(cat "$t/home/.bashrc") == keep ]] || fail 'the installer edited the profile'
    grep -Fxq "nvm-install PROFILE=/dev/null NVM_DIR=$t/home/.nvm" "$t/calls" \
        || fail 'PROFILE was not /dev/null'
    output_has_status INSTALLED nvm || fail 'missing INSTALLED nvm'
}

case_node_installs_lts() {
    setup_case
    make_packages
    rm -rf "$t/home/.nvm"
    make_nvm_sh "$t/home"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    grep -Fxq 'nvm install --lts' "$t/calls" || fail 'nvm install --lts was not called'
    grep -Fxq 'nvm alias default lts/*' "$t/calls" || fail 'nvm alias default was not called'
    output_has_status UNCHANGED nvm || fail 'missing UNCHANGED nvm'
    output_has_status INSTALLED node || fail 'missing INSTALLED node'
}

case_node_present() {
    setup_case
    make_packages
    make_nvm_sh "$t/home"
    make_node_version v22.1.0
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    ! grep -q '^nvm ' "$t/calls" || fail 'nvm was called'
    ! grep -q '^curl ' "$t/calls" || fail 'curl was called'
    output_has_status UNCHANGED nvm || fail 'missing UNCHANGED nvm'
    output_has_status UNCHANGED node || fail 'missing UNCHANGED node'
}

case_node_npm_missing() {
    setup_case
    make_packages
    make_nvm_sh "$t/home"
    make_node_version v22.1.0 beta
    printf 'alpha\nbeta\n' > "$t/repo/packages/linux/npm.txt"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    grep -Fxq 'npm install -g -- alpha' "$t/calls" || fail "wrong npm call: $(grep '^npm ' "$t/calls")"
    ! grep -Fq 'npm install -g -- beta' "$t/calls" || fail 'beta was installed again'
    output_has_status INSTALLED npm/alpha || fail 'missing INSTALLED npm/alpha'
    output_has_status UNCHANGED npm/beta || fail 'missing UNCHANGED npm/beta'
}

case_node_npm_newest() {
    setup_case
    make_packages
    make_nvm_sh "$t/home"
    make_node_version v20.0.0
    make_node_version v22.1.0 beta
    printf 'alpha\nbeta\n' > "$t/repo/packages/linux/npm.txt"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    grep -Fxq 'npm install -g -- alpha' "$t/calls" || fail "wrong npm call: $(grep '^npm ' "$t/calls")"
    ! grep -Fq 'npm install -g -- beta' "$t/calls" || fail 'beta was installed again'
    grep -Fq "npm-path $t/home/.nvm/versions/node/v22.1.0/bin:" "$t/calls" \
        || fail 'npm did not run with the newest Node first on PATH'
    output_has_status INSTALLED npm/alpha || fail 'missing INSTALLED npm/alpha'
}

case_node_npm_scoped() {
    setup_case
    make_packages
    make_nvm_sh "$t/home"
    make_node_version v22.1.0 '@scope/name'
    printf '@scope/name\n' > "$t/repo/packages/linux/npm.txt"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    ! grep -q '^npm ' "$t/calls" || fail "npm was called: $(grep '^npm ' "$t/calls")"
    output_has_status UNCHANGED npm/@scope/name || fail 'missing UNCHANGED for the scope'
}

case_node_npm_present() {
    setup_case
    make_packages
    make_nvm_sh "$t/home"
    make_node_version v22.1.0 alpha beta
    printf 'alpha\nbeta\n' > "$t/repo/packages/linux/npm.txt"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    ! grep -q '^npm ' "$t/calls" || fail 'npm was called'
    output_has_status UNCHANGED npm/alpha || fail 'missing UNCHANGED npm/alpha'
    output_has_status UNCHANGED npm/beta || fail 'missing UNCHANGED npm/beta'
}

case_node_pipx_installs() {
    setup_case
    make_packages
    make_nvm_sh "$t/home"
    make_node_version v22.1.0
    printf 'poetry\n' > "$t/repo/packages/linux/pipx.txt"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    grep -Fxq 'pipx install poetry' "$t/calls" || fail 'poetry was not installed'
    output_has_status INSTALLED pipx/poetry || fail 'missing INSTALLED pipx/poetry'
}

case_node_pipx_present() {
    setup_case
    make_packages
    make_nvm_sh "$t/home"
    make_node_version v22.1.0
    printf 'poetry\n' > "$t/repo/packages/linux/pipx.txt"
    printf 'poetry 2.0.0\n' > "$t/stub/pipx.out"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    ! grep -Fq 'pipx install' "$t/calls" || fail 'poetry was installed again'
    output_has_status UNCHANGED pipx/poetry || fail 'missing UNCHANGED pipx/poetry'
}

case_node_pipx_missing_tool() {
    setup_case
    make_packages
    make_nvm_sh "$t/home"
    make_node_version v22.1.0
    rm "$t/bin/pipx"
    printf 'poetry\n' > "$t/repo/packages/linux/pipx.txt"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    output_has_status SKIPPED packages/linux/pipx.txt 'pipx not installed' \
        || fail 'missing SKIPPED for pipx'
    ! grep -Fq 'pipx install' "$t/calls" || fail 'pipx install was called'
}

case_node_dry_run() {
    setup_case
    make_packages
    rm -rf "$t/home/.nvm"
    printf 'poetry\n' > "$t/repo/packages/linux/pipx.txt"
    run_bootstrap --dry-run
    (( rc == 0 )) || fail "exited $rc, want 0"
    output_has_status WOULD nvm || fail 'missing WOULD nvm'
    output_has_status WOULD node || fail 'missing WOULD node'
    output_has_status WOULD pipx/poetry || fail 'missing WOULD pipx/poetry'
    ! grep -q '^curl ' "$t/calls" || fail 'curl was called'
    ! grep -q '^nvm-install ' "$t/calls" || fail 'the installer ran'
    ! grep -q '^npm ' "$t/calls" || fail 'npm was called'
    ! grep -q '^pipx install' "$t/calls" || fail 'pipx install was called'
}

# -- Standalone tools ---------------------------------------------------------

case_tools_bun() {
    setup_case
    make_packages
    local url=https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64.zip
    rm -rf "$t/home/.bun"
    : > "$t/repo/packages/linux/tools.txt"
    make_tool_asset bun "$url" zip
    write_tool_line bun "$url"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    local dest=$t/home/.bun/bin/bun
    [[ -f $dest ]] || fail 'bun was not installed'
    [[ $(stat -c %a "$dest") == 755 ]] || fail "bun has mode $(stat -c %a "$dest")"
    [[ $(readlink "$t/home/.bun/bin/bunx") == "$dest" ]] || fail 'bunx does not link to bun'
    output_has_status INSTALLED tool/bun || fail 'missing INSTALLED tool/bun'
}

case_tools_rtk() {
    setup_case
    make_packages
    local url=https://github.com/rtk-ai/rtk/releases/download/v1.1.0/rtk-x86_64-unknown-linux-musl.tar.gz
    rm -f "$t/home/.local/bin/rtk"
    : > "$t/repo/packages/linux/tools.txt"
    make_tool_asset rtk "$url" tar
    write_tool_line rtk "$url"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    local dest=$t/home/.local/bin/rtk
    [[ -f $dest ]] || fail 'rtk was not installed'
    [[ $(stat -c %a "$dest") == 755 ]] || fail "rtk has mode $(stat -c %a "$dest")"
    [[ ! -e $t/home/.local/bin/LICENSE ]] || fail 'the LICENSE was copied into ~/.local/bin'
    output_has_status INSTALLED tool/rtk || fail 'missing INSTALLED tool/rtk'
}

case_tools_copilot() {
    setup_case
    make_packages
    local url=https://github.com/github/copilot-cli/releases/download/v1.0.105/copilot-linux-x64.tar.gz
    rm -f "$t/home/.local/bin/copilot"
    : > "$t/repo/packages/linux/tools.txt"
    make_tool_asset copilot "$url" tar
    write_tool_line copilot "$url"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    local dest=$t/home/.local/bin/copilot
    [[ -f $dest ]] || fail 'copilot was not installed'
    [[ $(stat -c %a "$dest") == 755 ]] || fail "copilot has mode $(stat -c %a "$dest")"
    output_has_status INSTALLED tool/copilot || fail 'missing INSTALLED tool/copilot'
}

case_tools_bad_hash() {
    setup_case
    make_packages
    local rtk_url=https://github.com/rtk-ai/rtk/releases/download/v1.1.0/rtk-x86_64-unknown-linux-musl.tar.gz
    local copilot_url=https://github.com/github/copilot-cli/releases/download/v1.0.105/copilot-linux-x64.tar.gz
    rm -f "$t/home/.local/bin/rtk" "$t/home/.local/bin/copilot"
    : > "$t/repo/packages/linux/tools.txt"
    make_tool_asset copilot "$copilot_url" tar
    write_tool_line copilot "$copilot_url"
    make_tool_asset rtk "$rtk_url" tar
    write_tool_line rtk "$rtk_url" "$(printf '%064d' 0)"
    run_bootstrap
    (( rc == 1 )) || fail "exited $rc, want 1"
    output_has_status ERROR tool/rtk 'download or hash failed' || fail 'missing ERROR for the bad hash'
    [[ ! -e $t/home/.local/bin/rtk ]] || fail 'rtk was left behind'
    output_has_status INSTALLED tool/copilot || fail 'the next tool did not install'
}

case_tools_bad_archive() {
    setup_case
    make_packages
    local url=https://github.com/rtk-ai/rtk/releases/download/v1.1.0/rtk-x86_64-unknown-linux-musl.tar.gz
    rm -f "$t/home/.local/bin/rtk"
    : > "$t/repo/packages/linux/tools.txt"
    make_tool_asset rtk "$url" raw 'not a tarball'
    write_tool_line rtk "$url"
    run_bootstrap
    (( rc == 1 )) || fail "exited $rc, want 1"
    output_has_status ERROR tool/rtk 'unpack failed' || fail 'missing ERROR for the bad archive'
    [[ ! -e $t/home/.local/bin/rtk ]] || fail 'a file was left at the target'
}

case_tools_present() {
    setup_case
    make_packages
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    ! grep -q '^curl ' "$t/calls" || fail 'curl was called'
    output_has_status UNCHANGED tool/bun || fail 'missing UNCHANGED tool/bun'
    output_has_status UNCHANGED tool/rtk || fail 'missing UNCHANGED tool/rtk'
    output_has_status UNCHANGED tool/copilot || fail 'missing UNCHANGED tool/copilot'
    output_has_status UNCHANGED tool/claude || fail 'missing UNCHANGED tool/claude'
}

case_tools_claude_file_first() {
    setup_case
    make_packages
    rm -f "$t/home/.local/bin/claude"
    cat > "$t/net/install.sh" <<EOF
#!/bin/sh
printf 'claude-install script=%s stdin=%s\n' "\$0" "\$(readlink /proc/self/fd/0)" >> "$t/calls"
printf '#!/bin/sh\n' > "$t/home/.local/bin/claude"
chmod +x "$t/home/.local/bin/claude"
EOF
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    local line script
    line=$(grep '^claude-install ' "$t/calls") || fail 'the installer did not run'
    script=${line#*script=}
    script=${script%% *}
    [[ $script == "$t/tmp/"*/claude-install.sh ]] || fail "the installer ran from $script"
    grep -Fq 'stdin=/dev/null' "$t/calls" || fail 'stdin was not /dev/null'
    output_has_status INSTALLED tool/claude || fail 'missing INSTALLED tool/claude'
}

case_tools_claude_fails() {
    setup_case
    make_packages
    rm -f "$t/home/.local/bin/claude"
    printf '#!/bin/sh\nexit 1\n' > "$t/net/install.sh"
    run_bootstrap
    (( rc == 1 )) || fail "exited $rc, want 1"
    output_has_status ERROR tool/claude 'installer failed' || fail 'missing ERROR for the failed installer'
    [[ -e $t/home/.local/bin/rtk ]] || fail 'the failed claude step touched the other tools'
}

case_tools_claude_no_binary() {
    setup_case
    make_packages
    rm -f "$t/home/.local/bin/claude"
    printf '#!/bin/sh\nexit 0\n' > "$t/net/install.sh"
    run_bootstrap
    (( rc == 1 )) || fail "exited $rc, want 1"
    output_has_status ERROR tool/claude 'installer left no claude' || fail 'missing ERROR for the empty installer'
    ! output_has_status INSTALLED tool/claude || fail 'reported INSTALLED without a claude'
}

case_tools_nvm_skipped() {
    setup_case
    make_packages
    printf 'nvm https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh %064d\n' 0 \
        > "$t/repo/packages/linux/tools.txt"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    ! grep -q '^curl ' "$t/calls" || fail 'curl was called'
    ! grep -Fq 'tool/nvm' "$out" || fail 'step_tools handled the nvm line'
    output_has_status UNCHANGED nvm || fail 'missing UNCHANGED nvm'
}

case_tools_dry_run() {
    setup_case
    make_packages
    rm -rf "$t/home/.bun" "$t/home/.local/bin"
    run_bootstrap --dry-run
    (( rc == 0 )) || fail "exited $rc, want 0"
    output_has_status WOULD tool/bun || fail 'missing WOULD tool/bun'
    output_has_status WOULD tool/rtk || fail 'missing WOULD tool/rtk'
    output_has_status WOULD tool/copilot || fail 'missing WOULD tool/copilot'
    output_has_status WOULD tool/claude || fail 'missing WOULD tool/claude'
    ! grep -q '^curl ' "$t/calls" || fail 'curl was called'
    ! grep -q '^claude-install ' "$t/calls" || fail 'the installer ran'
    [[ ! -e $t/home/.bun && ! -e $t/home/.local/bin ]] || fail 'a dry run wrote a target'
}

# -- VS Code extensions --------------------------------------------------------

case_vscode_installs_missing() {
    setup_case
    make_packages
    printf 'baz.qux\nfoo.bar\n' > "$t/repo/packages/linux/vscode-extensions.txt"
    printf 'foo.bar\n' > "$t/stub/code.out"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    grep -Fxq 'code --install-extension baz.qux' "$t/calls" || fail 'baz.qux was not installed'
    [[ $(grep -c '^code --install-extension' "$t/calls") == 1 ]] || fail 'more than one install ran'
    output_has_status UNCHANGED vscode/foo.bar || fail 'missing UNCHANGED vscode/foo.bar'
    output_has_status INSTALLED vscode/baz.qux || fail 'missing INSTALLED vscode/baz.qux'
}

# code may print an id in a different case than the lowercase list.
case_vscode_case_insensitive() {
    setup_case
    make_packages
    printf 'foo.bar\n' > "$t/repo/packages/linux/vscode-extensions.txt"
    printf 'Foo.Bar\n' > "$t/stub/code.out"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    ! grep -Fq -- '--install-extension' "$t/calls" || fail 'foo.bar was installed again'
    output_has_status UNCHANGED vscode/foo.bar || fail 'missing UNCHANGED vscode/foo.bar'
}

case_vscode_one_fails() {
    setup_case
    make_packages
    printf 'aa.one\nbb.two\n' > "$t/repo/packages/linux/vscode-extensions.txt"
    : > "$t/stub/code.out"
    : > "$t/stub/code-fail/aa.one"
    run_bootstrap
    (( rc == 1 )) || fail "exited $rc, want 1"
    grep -Fxq 'code --install-extension aa.one' "$t/calls" || fail 'aa.one was not tried'
    grep -Fxq 'code --install-extension bb.two' "$t/calls" || fail 'the loop stopped at the failed id'
    output_has_status ERROR vscode/aa.one 'install failed' || fail 'missing ERROR vscode/aa.one'
    output_has_status INSTALLED vscode/bb.two || fail 'missing INSTALLED vscode/bb.two'
}

case_vscode_no_code() {
    setup_case
    make_packages
    printf 'foo.bar\n' > "$t/repo/packages/linux/vscode-extensions.txt"
    rm "$t/bin/code"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    output_has_status SKIPPED packages/linux/vscode-extensions.txt 'code not installed' \
        || fail 'missing SKIPPED for the missing code'
    ! grep -q '^code ' "$t/calls" || fail 'code was called'
}

case_vscode_snap_path() {
    setup_case
    make_packages
    printf 'foo.bar\n' > "$t/repo/packages/linux/vscode-extensions.txt"
    rm "$t/bin/code"
    mkdir -p "$t/root/snap/bin"
    cat > "$t/root/snap/bin/code" <<EOF
#!/bin/sh
printf 'snapcode %s\n' "\$*" >> "$t/calls"
exit 0
EOF
    chmod +x "$t/root/snap/bin/code"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    grep -Fxq 'snapcode --list-extensions' "$t/calls" || fail 'the snap code was not used to list'
    grep -Fxq 'snapcode --install-extension foo.bar' "$t/calls" || fail 'the snap code was not used to install'
    ! grep -q '^code ' "$t/calls" || fail 'a PATH code was called'
    output_has_status INSTALLED vscode/foo.bar || fail 'missing INSTALLED vscode/foo.bar'
}

case_vscode_dry_run() {
    setup_case
    make_packages
    printf 'baz.qux\nfoo.bar\n' > "$t/repo/packages/linux/vscode-extensions.txt"
    printf 'foo.bar\n' > "$t/stub/code.out"
    run_bootstrap --dry-run
    (( rc == 0 )) || fail "exited $rc, want 0"
    output_has_status WOULD vscode/baz.qux || fail 'missing WOULD vscode/baz.qux'
    ! output_has_status WOULD vscode/foo.bar || fail 'WOULD printed for an installed id'
    [[ $(grep -c 'WOULD[[:space:]]*vscode/' "$out") == 1 ]] || fail 'not exactly one WOULD vscode line'
    ! grep -Fq -- '--install-extension' "$t/calls" || fail 'an install ran under --dry-run'
}

# -- Restore: import, links, plugins, preview ---------------------------------

case_restore_import_runs() {
    setup_case
    seed_restore
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    grep -Fxq 'import' "$t/calls" || fail 'import was not called with no arguments'
}

case_restore_import_fails() {
    setup_case
    seed_restore
    printf '1\n' > "$t/stub/import.rc"
    run_bootstrap
    (( rc == 1 )) || fail "exited $rc, want 1"
    output_has_status ERROR import 'failed' || fail 'summary does not name import'
}

case_restore_import_error_line() {
    setup_case
    seed_restore
    printf '  ERROR      dotfiles/x  (cannot write)\n' > "$t/stub/import.out"
    run_bootstrap
    (( rc == 1 )) || fail "exited $rc, want 1"
    output_has_status ERROR import 'failed' || fail 'summary does not name import'
}

case_restore_no_session() {
    setup_case
    seed_restore
    bootstrap_session=''
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    ! grep -q '^import' "$t/calls" || fail 'import ran without a session'
    ! grep -q '^sync ' "$t/calls" || fail 'preview ran without a session'
    output_has_status SKIPPED import 'no desktop session; rerun from a terminal on the desktop' \
        || fail 'missing SKIPPED import'
    grep -Fq 'Rerun ./bootstrap/linux.sh from a terminal on the desktop to finish.' "$out" \
        || fail 'missing rerun line'
}

case_restore_order() {
    setup_case
    seed_restore
    make_claude_stub
    make_claude_settings '{"m":{"source":{"source":"github","repo":"a/b"}}}' '{"x@m":true}'
    seed_claude_bin
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    local iimport iadd iinstall isync
    iimport=$(grep -n '^import' "$t/calls" | head -n1 | cut -d: -f1)
    iadd=$(grep -n 'claude plugin marketplace add a/b' "$t/calls" | head -n1 | cut -d: -f1)
    iinstall=$(grep -n 'claude plugin install x@m' "$t/calls" | head -n1 | cut -d: -f1)
    isync=$(grep -n '^sync preview' "$t/calls" | head -n1 | cut -d: -f1)
    [[ -n $iimport && -n $iadd && -n $iinstall && -n $isync ]] || fail "missing a call: $(cat "$t/calls")"
    (( iimport < iadd && iadd < iinstall && iinstall < isync )) \
        || fail "wrong order: import=$iimport add=$iadd install=$iinstall sync=$isync"
    output_has_status INSTALLED link/mk-exec || fail 'links did not run before plugins'
}

case_restore_link_new() {
    setup_case
    seed_restore
    seed_claude_bin
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    [[ -L $t/home/.local/bin/mk-exec ]] || fail 'no link was created'
    [[ $(readlink "$t/home/.local/bin/mk-exec") == "$t/home/.claude/bin/mk-exec" ]] || fail 'link points elsewhere'
    output_has_status INSTALLED link/mk-exec || fail 'missing INSTALLED link/mk-exec'
}

case_restore_link_same() {
    setup_case
    seed_restore
    seed_claude_bin
    mkdir -p "$t/home/.local/bin"
    ln -s "$t/home/.claude/bin/mk-exec" "$t/home/.local/bin/mk-exec"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    output_has_status UNCHANGED link/mk-exec || fail 'missing UNCHANGED link/mk-exec'
}

case_restore_link_real_file() {
    setup_case
    seed_restore
    seed_claude_bin
    mkdir -p "$t/home/.local/bin"
    printf 'keep\n' > "$t/home/.local/bin/mk-exec"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    output_has_status SKIPPED link/mk-exec 'exists; left alone' || fail 'missing SKIPPED link/mk-exec'
    [[ $(cat "$t/home/.local/bin/mk-exec") == keep ]] || fail 'the regular file was touched'
}

case_restore_link_other_target() {
    setup_case
    seed_restore
    seed_claude_bin
    mkdir -p "$t/home/.local/bin"
    ln -s /somewhere/else "$t/home/.local/bin/mk-exec"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    output_has_status SKIPPED link/mk-exec 'exists; left alone' || fail 'missing SKIPPED link/mk-exec'
    [[ $(readlink "$t/home/.local/bin/mk-exec") == /somewhere/else ]] || fail 'the link was touched'
}

case_restore_link_dangling() {
    setup_case
    seed_restore
    seed_claude_bin
    mkdir -p "$t/home/.local/bin"
    ln -s "$t/home/.claude/bin/gone" "$t/home/.local/bin/mk-exec"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    output_has_status SKIPPED link/mk-exec 'exists; left alone' || fail 'a dangling link was not skipped'
    [[ $(readlink "$t/home/.local/bin/mk-exec") == "$t/home/.claude/bin/gone" ]] || fail 'the dangling link was touched'
}

case_restore_plugins_ref() {
    setup_case
    seed_restore
    make_claude_stub
    make_claude_settings '{"m":{"source":{"source":"github","repo":"a/b","ref":"c"}}}' '{}'
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    grep -Fxq 'claude plugin marketplace add a/b#c' "$t/calls" || fail 'the ref was not passed to add'
    output_has_status INSTALLED plugin/a/b#c || fail 'missing INSTALLED plugin/a/b#c'
}

case_restore_plugins_no_ref() {
    setup_case
    seed_restore
    make_claude_stub
    make_claude_settings '{"m":{"source":{"source":"github","repo":"a/b"}}}' '{}'
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    grep -Fxq 'claude plugin marketplace add a/b' "$t/calls" || fail 'the marketplace was not added'
    output_has_status INSTALLED plugin/a/b || fail 'missing INSTALLED plugin/a/b'
}

case_restore_plugins_disabled() {
    setup_case
    seed_restore
    make_claude_stub
    make_claude_settings '{"m":{"source":{"source":"github","repo":"a/b"}}}' '{"x@m":false}'
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    grep -Fxq 'claude plugin marketplace add a/b' "$t/calls" || fail 'the marketplace was not added'
    ! grep -Fq 'plugin install' "$t/calls" || fail 'a disabled plugin was installed'
    ! output_has_status INSTALLED plugin/x@m || fail 'a disabled plugin was reported installed'
}

case_restore_plugins_settings_back() {
    setup_case
    seed_restore
    make_claude_stub
    make_claude_settings '{"m":{"source":{"source":"github","repo":"a/b"},"autoUpdate":true}}' '{"x@m":true}'
    local settings=$t/home/.claude/settings.json before
    before=$(sha256sum "$settings" | cut -d' ' -f1)
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    [[ $(sha256sum "$settings" | cut -d' ' -f1) == "$before" ]] || fail 'settings.json changed'
}

case_restore_plugins_settings_back_on_failure() {
    setup_case
    seed_restore
    make_claude_stub
    make_claude_settings '{"m":{"source":{"source":"github","repo":"a/b"},"autoUpdate":true}}' '{"x@m":true}'
    printf '1\n' > "$t/stub/claude.rc"
    local settings=$t/home/.claude/settings.json before
    before=$(sha256sum "$settings" | cut -d' ' -f1)
    run_bootstrap
    (( rc == 1 )) || fail "exited $rc, want 1"
    [[ $(sha256sum "$settings" | cut -d' ' -f1) == "$before" ]] || fail 'settings.json changed after a failure'
    output_has_status ERROR plugin/a/b 'add failed' || fail 'missing ERROR plugin/a/b'
}

case_restore_plugins_no_settings() {
    setup_case
    seed_restore
    # No make_claude_stub here: seed_tools left a non-executable claude, and
    # there is no settings.json either.
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    output_has_status SKIPPED plugins 'settings.json or claude not installed' || fail 'missing SKIPPED plugins'
    ! grep -q '^claude ' "$t/calls" || fail 'claude was called'
}

case_restore_plugins_present() {
    setup_case
    seed_restore
    make_claude_stub
    make_claude_settings '{"m":{"source":{"source":"github","repo":"a/b"}}}' '{"x@m":true}'
    mkdir -p "$t/home/.claude/plugins"
    printf '{"m":{}}\n' > "$t/home/.claude/plugins/known_marketplaces.json"
    printf '{"plugins":{"x@m":{}}}\n' > "$t/home/.claude/plugins/installed_plugins.json"
    local settings=$t/home/.claude/settings.json before
    before=$(stat -c %Y "$settings")
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    ! grep -q '^claude ' "$t/calls" || fail 'claude was called'
    [[ $(stat -c %Y "$settings") == "$before" ]] || fail 'settings.json mtime changed'
    output_has_status UNCHANGED plugins || fail 'missing UNCHANGED plugins'
}

case_restore_plugins_partial() {
    setup_case
    seed_restore
    make_claude_stub
    make_claude_settings '{"m":{"source":{"source":"github","repo":"a/b"}}}' '{"x@m":true,"y@m":true}'
    mkdir -p "$t/home/.claude/plugins"
    printf '{"m":{}}\n' > "$t/home/.claude/plugins/known_marketplaces.json"
    printf '{"plugins":{"x@m":{}}}\n' > "$t/home/.claude/plugins/installed_plugins.json"
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    grep -Fxq 'claude plugin install y@m' "$t/calls" || fail 'y@m was not installed'
    ! grep -Fq 'plugin install x@m' "$t/calls" || fail 'x@m was installed again'
    [[ $(grep -c 'claude plugin install' "$t/calls") == 1 ]] || fail 'more than one plugin was installed'
}

case_restore_plugins_no_state() {
    setup_case
    seed_restore
    make_claude_stub
    make_claude_settings '{"m":{"source":{"source":"github","repo":"a/b"}}}' '{"x@m":true}'
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    grep -Fxq 'claude plugin marketplace add a/b' "$t/calls" || fail 'the marketplace was not added'
    grep -Fxq 'claude plugin install x@m' "$t/calls" || fail 'the plugin was not installed'
    output_has_status INSTALLED plugin/a/b || fail 'missing INSTALLED plugin/a/b'
    output_has_status INSTALLED plugin/x@m || fail 'missing INSTALLED plugin/x@m'
}

case_restore_plugins_dry_run() {
    setup_case
    seed_restore
    make_claude_stub
    make_claude_settings '{"m":{"source":{"source":"github","repo":"a/b"}}}' '{"x@m":true}'
    mkdir -p "$t/home/.claude/plugins"
    printf '{"m":{}}\n' > "$t/home/.claude/plugins/known_marketplaces.json"
    printf '{"plugins":{"x@m":{}}}\n' > "$t/home/.claude/plugins/installed_plugins.json"
    run_bootstrap --dry-run
    (( rc == 0 )) || fail "exited $rc, want 0"
    ! grep -q WOULD "$out" || fail "a finished machine printed a WOULD line: $(grep WOULD "$out")"
    ! grep -q '^claude ' "$t/calls" || fail 'claude was called'
}

case_restore_plugins_bun_on_path() {
    setup_case
    seed_restore
    make_claude_stub
    make_claude_settings '{"m":{"source":{"source":"github","repo":"a/b"}}}' '{"x@m":true}'
    run_bootstrap
    (( rc == 0 )) || fail "exited $rc, want 0"
    [[ :$(cat "$t/stub/claude.path"): == *":$t/home/.bun/bin:"* ]] || fail 'bun was not on PATH for plugin install'
}

case_restore_dry_run_no_import() {
    setup_case
    seed_restore
    make_claude_stub
    make_claude_settings '{"m":{"source":{"source":"github","repo":"a/b"}}}' '{"x@m":true}'
    run_bootstrap --dry-run
    (( rc == 0 )) || fail "exited $rc, want 0"
    ! grep -q '^import' "$t/calls" || fail 'import ran under --dry-run'
    ! grep -q '^sync ' "$t/calls" || fail 'preview ran under --dry-run'
}

case_restore_idempotent() {
    setup_case
    seed_restore
    make_claude_stub
    make_claude_settings '{"m":{"source":{"source":"github","repo":"a/b"},"autoUpdate":true}}' '{"x@m":true}'
    seed_claude_bin
    run_bootstrap
    (( rc == 0 )) || fail "first run exited $rc, want 0"
    grep -Fxq 'claude plugin marketplace add a/b' "$t/calls" || fail 'first run did not add the marketplace'
    grep -Fxq 'claude plugin install x@m' "$t/calls" || fail 'first run did not install the plugin'
    grep -q '^import' "$t/calls" || fail 'first run did not import'
    [[ -L $t/home/.local/bin/mk-exec ]] || fail 'first run did not link mk-exec'
    : > "$t/calls"
    run_bootstrap
    (( rc == 0 )) || fail "second run exited $rc, want 0"
    if grep -Eq '^curl |^git fetch|^claude |^sudo .*install|^ln ' "$t/calls"; then
        fail "the second run did work: $(cat "$t/calls")"
    fi
    output_has_status UNCHANGED link/mk-exec || fail 'second run did not report the link unchanged'
    output_has_status UNCHANGED plugins || fail 'second run did not report plugins unchanged'
}

for case_name in guard-root guard-arch guard-not-ubuntu guard-bad-list guard-sudo-refused guard-other-release guard-unknown-option guard-help guard-dry-run-no-sudo guard-step-order guard-sourced-no-main guard-no-jq guard-step-failure-continues guard-sudo-dropped apt-sources-fresh apt-sources-comment-ignored apt-sources-bad-key-path apt-sources-same apt-sources-differs apt-sources-before-install apt-install-missing apt-nothing-missing apt-install-fails apt-dry-run apt-update-new-source apt-certs-long-list deb-installs deb-bad-hash deb-wrong-package deb-already-installed deb-loop-keeps-going desktop-snap-args desktop-snap-both-options desktop-snap-failure-continues desktop-snap-present desktop-snap-down desktop-font-installs desktop-font-bad-hash desktop-font-bad-archive desktop-font-present desktop-ext-installs desktop-ext-wrong-commit desktop-ext-no-install-sh desktop-ext-present desktop-ext-partial-folder desktop-ext-fetch-fails desktop-dry-run node-installs-nvm node-bad-hash node-profile-untouched node-installs-lts node-present node-npm-missing node-npm-newest node-npm-scoped node-npm-present node-pipx-installs node-pipx-present node-pipx-missing-tool node-dry-run tools-bun tools-rtk tools-copilot tools-bad-hash tools-bad-archive tools-present tools-claude-file-first tools-claude-fails tools-claude-no-binary tools-nvm-skipped tools-dry-run vscode-installs-missing vscode-case-insensitive vscode-one-fails vscode-no-code vscode-snap-path vscode-dry-run restore-import-runs restore-import-fails restore-import-error-line restore-no-session restore-order restore-link-new restore-link-same restore-link-real-file restore-link-other-target restore-link-dangling restore-plugins-ref restore-plugins-no-ref restore-plugins-disabled restore-plugins-settings-back restore-plugins-settings-back-on-failure restore-plugins-no-settings restore-plugins-present restore-plugins-partial restore-plugins-no-state restore-plugins-dry-run restore-plugins-bun-on-path restore-dry-run-no-import restore-idempotent; do
    if [[ -n $filter && $case_name != *"$filter"* ]]; then
        continue
    fi
    # Each case runs in a subshell so its EXIT trap (new_tmp) cleans up its temp dir.
    # set -e is off inside this command substitution (it is an if condition), so
    # every assertion must end in || fail.
    if out_text=$(case "$case_name" in
        guard-root) case_guard_root ;;
        guard-arch) case_guard_arch ;;
        guard-not-ubuntu) case_guard_not_ubuntu ;;
        guard-bad-list) case_guard_bad_list ;;
        guard-sudo-refused) case_guard_sudo_refused ;;
        guard-other-release) case_guard_other_release ;;
        guard-unknown-option) case_guard_unknown_option ;;
        guard-help) case_guard_help ;;
        guard-dry-run-no-sudo) case_guard_dry_run_no_sudo ;;
        guard-step-order) case_guard_step_order ;;
        guard-sourced-no-main) case_guard_sourced_no_main ;;
        guard-no-jq) case_guard_no_jq ;;
        guard-step-failure-continues) case_guard_step_failure_continues ;;
        guard-sudo-dropped) case_guard_sudo_dropped ;;
        apt-sources-fresh) case_apt_sources_fresh ;;
        apt-sources-comment-ignored) case_apt_sources_comment_ignored ;;
        apt-sources-bad-key-path) case_apt_sources_bad_key_path ;;
        apt-sources-same) case_apt_sources_same ;;
        apt-sources-differs) case_apt_sources_differs ;;
        apt-sources-before-install) case_apt_sources_before_install ;;
        apt-install-missing) case_apt_install_missing ;;
        apt-nothing-missing) case_apt_nothing_missing ;;
        apt-install-fails) case_apt_install_fails ;;
        apt-dry-run) case_apt_dry_run ;;
        apt-update-new-source) case_apt_update_new_source ;;
        apt-certs-long-list) case_apt_certs_long_list ;;
        deb-installs) case_deb_installs ;;
        deb-bad-hash) case_deb_bad_hash ;;
        deb-wrong-package) case_deb_wrong_package ;;
        deb-already-installed) case_deb_already_installed ;;
        deb-loop-keeps-going) case_deb_loop_keeps_going ;;
        desktop-snap-args) case_desktop_snap_args ;;
        desktop-snap-both-options) case_desktop_snap_both_options ;;
        desktop-snap-failure-continues) case_desktop_snap_failure_continues ;;
        desktop-snap-present) case_desktop_snap_present ;;
        desktop-snap-down) case_desktop_snap_down ;;
        desktop-font-installs) case_desktop_font_installs ;;
        desktop-font-bad-hash) case_desktop_font_bad_hash ;;
        desktop-font-bad-archive) case_desktop_font_bad_archive ;;
        desktop-font-present) case_desktop_font_present ;;
        desktop-ext-installs) case_desktop_ext_installs ;;
        desktop-ext-wrong-commit) case_desktop_ext_wrong_commit ;;
        desktop-ext-no-install-sh) case_desktop_ext_no_install_sh ;;
        desktop-ext-present) case_desktop_ext_present ;;
        desktop-ext-partial-folder) case_desktop_ext_partial_folder ;;
        desktop-ext-fetch-fails) case_desktop_ext_fetch_fails ;;
        desktop-dry-run) case_desktop_dry_run ;;
        node-installs-nvm) case_node_installs_nvm ;;
        node-bad-hash) case_node_bad_hash ;;
        node-profile-untouched) case_node_profile_untouched ;;
        node-installs-lts) case_node_installs_lts ;;
        node-present) case_node_present ;;
        node-npm-missing) case_node_npm_missing ;;
        node-npm-newest) case_node_npm_newest ;;
        node-npm-scoped) case_node_npm_scoped ;;
        node-npm-present) case_node_npm_present ;;
        node-pipx-installs) case_node_pipx_installs ;;
        node-pipx-present) case_node_pipx_present ;;
        node-pipx-missing-tool) case_node_pipx_missing_tool ;;
        node-dry-run) case_node_dry_run ;;
        tools-bun) case_tools_bun ;;
        tools-rtk) case_tools_rtk ;;
        tools-copilot) case_tools_copilot ;;
        tools-bad-hash) case_tools_bad_hash ;;
        tools-bad-archive) case_tools_bad_archive ;;
        tools-present) case_tools_present ;;
        tools-claude-file-first) case_tools_claude_file_first ;;
        tools-claude-fails) case_tools_claude_fails ;;
        tools-claude-no-binary) case_tools_claude_no_binary ;;
        tools-nvm-skipped) case_tools_nvm_skipped ;;
        tools-dry-run) case_tools_dry_run ;;
        vscode-installs-missing) case_vscode_installs_missing ;;
        vscode-case-insensitive) case_vscode_case_insensitive ;;
        vscode-one-fails) case_vscode_one_fails ;;
        vscode-no-code) case_vscode_no_code ;;
        vscode-snap-path) case_vscode_snap_path ;;
        vscode-dry-run) case_vscode_dry_run ;;
        restore-import-runs) case_restore_import_runs ;;
        restore-import-fails) case_restore_import_fails ;;
        restore-import-error-line) case_restore_import_error_line ;;
        restore-no-session) case_restore_no_session ;;
        restore-order) case_restore_order ;;
        restore-link-new) case_restore_link_new ;;
        restore-link-same) case_restore_link_same ;;
        restore-link-real-file) case_restore_link_real_file ;;
        restore-link-other-target) case_restore_link_other_target ;;
        restore-link-dangling) case_restore_link_dangling ;;
        restore-plugins-ref) case_restore_plugins_ref ;;
        restore-plugins-no-ref) case_restore_plugins_no_ref ;;
        restore-plugins-disabled) case_restore_plugins_disabled ;;
        restore-plugins-settings-back) case_restore_plugins_settings_back ;;
        restore-plugins-settings-back-on-failure) case_restore_plugins_settings_back_on_failure ;;
        restore-plugins-no-settings) case_restore_plugins_no_settings ;;
        restore-plugins-present) case_restore_plugins_present ;;
        restore-plugins-partial) case_restore_plugins_partial ;;
        restore-plugins-no-state) case_restore_plugins_no_state ;;
        restore-plugins-dry-run) case_restore_plugins_dry_run ;;
        restore-plugins-bun-on-path) case_restore_plugins_bun_on_path ;;
        restore-dry-run-no-import) case_restore_dry_run_no_import ;;
        restore-idempotent) case_restore_idempotent ;;
        *) fail "no such case: $case_name" ;;
    esac); then
        printf 'ok   %s\n' "$case_name"
    else
        printf '%s\n' "$out_text"
        failed=1
    fi
done

exit "$failed"
