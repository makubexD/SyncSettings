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

# sudo logs like the other stubs, then runs the command it was given. `-v`
# only validates, so it just succeeds.
make_sudo_stub() {
    cat > "$t/bin/sudo" <<EOF
#!/bin/sh
printf 'sudo %s\n' "\$*" >> "$t/calls"
cat "$t/stub/sudo.out" 2>/dev/null
rc=\$(cat "$t/stub/sudo.rc" 2>/dev/null || echo 0)
[ "\$rc" -eq 0 ] || exit "\$rc"
if [ "\$1" = -v ]; then
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

# Build $t/repo from the real bootstrap/, scripts/ and packages/linux/, plus a
# stub home, a fake root holding /etc/os-release, and the tool stubs. Cases
# overwrite stub outputs/rc files or package lists before running.
setup_case() {
    new_tmp
    mkdir -p "$t/repo" "$t/home" "$t/root/etc" "$t/bin" "$t/sysbin" "$t/stub" "$t/net"
    : > "$t/calls"
    cp -a "$REPO/bootstrap" "$t/repo/"
    cp -a "$REPO/scripts" "$t/repo/"
    mkdir -p "$t/repo/packages"
    cp -a "$REPO/packages/linux" "$t/repo/packages/"
    # Entry points used by later steps: log their arguments, do nothing else.
    cat > "$t/repo/import.sh" <<EOF
#!/bin/sh
printf 'import %s\n' "\$*" >> "$t/calls"
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
    for tool in apt-get dpkg-query dpkg-deb snap code pipx git claude glib-compile-schemas fc-cache id uname; do
        make_stub "$tool"
    done
    make_sudo_stub
    make_curl_stub
    # Nothing is installed unless a case writes `installed <name>` lines here,
    # which is the format dpkg_installed parses.
    : > "$t/stub/dpkg-query.out"
    local p
    for tool in bash awk sed grep sort comm cmp cp mv rm mkdir mktemp chmod ln cat tar unzip sha256sum install env dirname basename tr cut head tail find jq xz gzip ls wc; do
        p=$(command -v "$tool") || fail "$tool is not installed"
        ln -s "$p" "$t/sysbin/$tool"
    done
}

# Run bootstrap from $t/repo with a throwaway HOME and a PATH that holds only
# the stubs and an allowlist of harmless tools.
run_bootstrap() {
    rc=0
    (cd "$t/repo" && env -i HOME="$t/home" PATH="$t/bin:$t/sysbin" \
        BOOTSTRAP_ROOT="$t/root" DBUS_SESSION_BUS_ADDRESS=unix:path=/dev/null \
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

for case_name in guard-root guard-arch guard-not-ubuntu guard-bad-list guard-sudo-refused guard-other-release guard-unknown-option guard-help guard-dry-run-no-sudo guard-step-order guard-sourced-no-main guard-no-jq guard-step-failure-continues apt-sources-fresh apt-sources-same apt-sources-differs apt-sources-before-install apt-install-missing apt-nothing-missing apt-install-fails apt-dry-run apt-update-new-source apt-certs-long-list deb-installs deb-bad-hash deb-wrong-package deb-already-installed deb-loop-keeps-going; do
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
        apt-sources-fresh) case_apt_sources_fresh ;;
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
        *) fail "no such case: $case_name" ;;
    esac); then
        printf 'ok   %s\n' "$case_name"
    else
        printf '%s\n' "$out_text"
        failed=1
    fi
done

exit "$failed"
