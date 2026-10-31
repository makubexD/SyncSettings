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

for case_name in guard-root guard-arch guard-not-ubuntu guard-bad-list guard-sudo-refused guard-other-release guard-unknown-option guard-help guard-dry-run-no-sudo guard-step-order guard-sourced-no-main guard-no-jq; do
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
        *) fail "no such case: $case_name" ;;
    esac); then
        printf 'ok   %s\n' "$case_name"
    else
        printf '%s\n' "$out_text"
        failed=1
    fi
done

exit "$failed"
