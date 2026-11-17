#!/usr/bin/env bash
# Stub tests for the mksync launcher: bun and node exist only as stubs on a
# throwaway PATH, so no real runtime runs. Usage: tests/linux/launcher.sh
# [case-name-filter]

set -euo pipefail

SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO=$(cd "$SOURCE_DIR/../.." && pwd -P)
LAUNCHER=$REPO/mksync

filter=${1:-}
failed=0
passed=0
failed_cases=0
case_name=''
t=''
out=''
err=''
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
    err=$t/err
    trap 'rm -rf "$t"' EXIT
}

# A runtime stub on the case's PATH: logs "<name> <args>" to stdout, and prints
# the version for `-p process.versions.node` (it is passed as $2) or the value
# of MKSYNC_LAUNCHER for `--launcher`. It exits with the rc in
# $t/stub/<tool>.rc, or 0 when that file is absent.
make_stub() {
    local tool=$1 version=${2-}
    cat > "$t/bin/$tool" <<EOF
#!/bin/sh
if [ "\$1" = -p ]; then
    printf '%s\n' '$version'
    exit 0
fi
for arg in "\$@"; do
    [ "\$arg" = --launcher ] || continue
    printf '%s\n' "\${MKSYNC_LAUNCHER-}"
    exit 0
done
printf '%s %s\n' '$tool' "\$*"
if [ -f "$t/stub/$tool.rc" ]; then
    read -r rc < "$t/stub/$tool.rc"
    exit "\$rc"
fi
exit 0
EOF
    chmod +x "$t/bin/$tool"
}

# $t/bin holds the runtime stubs and symlinks to the few system tools the
# launcher itself uses, and nothing else, so a real bun or node never runs.
setup_case() {
    new_tmp
    mkdir -p "$t/bin" "$t/stub"
    local tool p
    for tool in sh readlink; do
        p=$(command -v "$tool") || fail "$tool is not installed"
        ln -s "$p" "$t/bin/$tool"
    done
}

# Run the launcher with PATH=$t/bin only. $1 is the MKSYNC_RUNTIME value, an
# empty string leaving it unset; the rest are the launcher's arguments.
run_launcher() {
    local runtime=$1
    shift
    local -a env_args=(env -i "PATH=$t/bin")
    [[ -z $runtime ]] || env_args+=("MKSYNC_RUNTIME=$runtime")
    rc=0
    (cd "$t" && "${env_args[@]}" "$LAUNCHER" "$@" < /dev/null) > "$out" 2> "$err" || rc=$?
}

# Exact stdout, and no stderr at all.
expect_stdout() {
    [[ $(<"$out") == "$1" ]] || fail "stdout was '$(<"$out")', want '$1'"
    [[ ! -s $err ]] || fail "unexpected stderr: $(<"$err")"
}

# Exact stderr, no stdout, and the launcher's exit code 2.
expect_usage_error() {
    [[ ! -s $out ]] || fail "unexpected stdout: $(<"$out")"
    [[ $(<"$err") == "$1" ]] || fail "stderr was '$(<"$err")', want '$1'"
    (( rc == 2 )) || fail "exited $rc, want 2"
}

# -- Cases ---------------------------------------------------------------------

case_runtime_node() {
    setup_case
    make_stub bun
    make_stub node 22.18.0
    run_launcher node status --x
    (( rc == 0 )) || fail "exited $rc, want 0"
    expect_stdout "node $REPO/src/main.ts status --x"
}

case_runtime_bun() {
    setup_case
    make_stub bun
    make_stub node 22.18.0
    run_launcher bun status --x
    (( rc == 0 )) || fail "exited $rc, want 0"
    expect_stdout "bun $REPO/src/main.ts status --x"
}

case_default_bun() {
    setup_case
    make_stub bun
    make_stub node 22.18.0
    run_launcher '' status --x
    (( rc == 0 )) || fail "exited $rc, want 0"
    expect_stdout "bun $REPO/src/main.ts status --x"
}

case_default_node() {
    setup_case
    make_stub node 22.18.0
    run_launcher '' status --x
    (( rc == 0 )) || fail "exited $rc, want 0"
    expect_stdout "node $REPO/src/main.ts status --x"
}

case_node_too_old() {
    setup_case
    make_stub node 22.17.1
    run_launcher '' status --x
    expect_usage_error 'ERROR: mksync needs Bun or Node 22.18 or newer to run from the clone.'
}

case_node_new_major() {
    setup_case
    make_stub node 23.0.0
    run_launcher '' status --x
    (( rc == 0 )) || fail "exited $rc, want 0"
    expect_stdout "node $REPO/src/main.ts status --x"
}

case_neither() {
    setup_case
    run_launcher '' status --x
    expect_usage_error 'ERROR: mksync needs Bun or Node 22.18 or newer to run from the clone.'
}

case_bad_runtime() {
    setup_case
    make_stub bun
    make_stub node 22.18.0
    run_launcher deno status --x
    expect_usage_error 'ERROR: MKSYNC_RUNTIME must be bun or node.'
}

case_exit_code() {
    setup_case
    make_stub bun
    printf '3\n' > "$t/stub/bun.rc"
    run_launcher bun status --x
    expect_stdout "bun $REPO/src/main.ts status --x"
    (( rc == 3 )) || fail "exited $rc, want 3"
}

case_launcher_env() {
    setup_case
    make_stub bun
    run_launcher bun --launcher
    (( rc == 0 )) || fail "exited $rc, want 0"
    expect_stdout '1'
}

for case_name in runtime-node runtime-bun default-bun default-node node-too-old node-new-major neither bad-runtime exit-code launcher-env; do
    if [[ -n $filter && $case_name != *"$filter"* ]]; then
        continue
    fi
    # Each case runs in a subshell so its EXIT trap (new_tmp) cleans up its temp dir.
    # set -e is off inside this command substitution (it is an if condition), so
    # every assertion must end in || fail.
    if out_text=$(case "$case_name" in
        runtime-node) case_runtime_node ;;
        runtime-bun) case_runtime_bun ;;
        default-bun) case_default_bun ;;
        default-node) case_default_node ;;
        node-too-old) case_node_too_old ;;
        node-new-major) case_node_new_major ;;
        neither) case_neither ;;
        bad-runtime) case_bad_runtime ;;
        exit-code) case_exit_code ;;
        launcher-env) case_launcher_env ;;
        *) fail "no such case: $case_name" ;;
    esac); then
        printf 'ok   %s\n' "$case_name"
        passed=$((passed + 1))
    else
        printf '%s\n' "$out_text"
        failed=1
        failed_cases=$((failed_cases + 1))
    fi
done

printf '%d passed, %d failed\n' "$passed" "$failed_cases"

exit "$failed"
