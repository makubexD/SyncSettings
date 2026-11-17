#!/usr/bin/env bash
# Stub tests for scripts/ci/release-files.sh: bun exists only as a stub on a
# throwaway PATH, so the four cross-compile builds never download a runtime.
# Usage: tests/linux/release-files.sh [case-name-filter]

set -euo pipefail

SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO=$(cd "$SOURCE_DIR/../.." && pwd -P)
RELEASE_FILES=$REPO/scripts/ci/release-files.sh

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

# File names in a folder, one per line, sorted by name.
dir_names() {
    local f
    for f in "$1"/*; do
        [[ -e $f ]] || continue
        printf '%s\n' "${f##*/}"
    done | LC_ALL=C sort
}

# Fresh throwaway working dir; removed when this case's subshell exits.
new_tmp() {
    t=$(mktemp -d)
    out=$t/stdout
    err=$t/stderr
    trap 'rm -rf "$t"' EXIT
}

# A bun stub: logs its arguments to $t/calls, and for `build ... --target <t>
# ... --outfile <f>` writes the target into <f>, so no real cross-compile runs.
make_bun_stub() {
    cat > "$t/bin/bun" <<EOF
#!/bin/sh
printf 'bun %s\n' "\$*" >> "$t/calls"
target=''
dest=''
while [ "\$#" -gt 0 ]; do
    case \$1 in
        --target) target=\$2; shift 2 ;;
        --outfile) dest=\$2; shift 2 ;;
        *) shift ;;
    esac
done
[ -n "\$dest" ] || exit 1
printf '%s\n' "\$target" > "\$dest"
EOF
    chmod +x "$t/bin/bun"
}

setup_case() {
    new_tmp
    mkdir -p "$t/bin" "$t/out-dir"
    : > "$t/calls"
    make_bun_stub
}

# Run the release script from $t, not the repo root, with the bun stub first on
# PATH; the script must find its own repo and build there.
run_release() {
    rc=0
    (cd "$t" && PATH="$t/bin:$PATH" bash "$RELEASE_FILES" "$@" < /dev/null) > "$out" 2> "$err" || rc=$?
}

# -- Cases ---------------------------------------------------------------------

case_mismatched_tag() {
    setup_case
    run_release v0.8.0 "$t/out-dir"
    (( rc == 1 )) || fail "exited $rc, want 1"
    local want='ERROR: tag v0.8.0 does not match package.json version 0.9.0.'
    [[ $(<"$err") == "$want" ]] || fail "stderr was '$(<"$err")', want '$want'"
    [[ ! -s $out ]] || fail "unexpected stdout: $(<"$out")"
    [[ ! -s $t/calls ]] || fail "bun ran: $(<"$t/calls")"
    [[ -z $(dir_names "$t/out-dir") ]] || fail "out dir holds $(dir_names "$t/out-dir")"
}

case_matching_tag() {
    setup_case
    run_release v0.9.0 "$t/out-dir"
    (( rc == 0 )) || fail "exited $rc, stderr: $(<"$err")"
    local dir=$t/out-dir want got
    want=$(printf '%s\n' mksync-darwin-arm64 mksync-linux-arm64 mksync-linux-x64 mksync-windows-x64.exe SHA256SUMS | LC_ALL=C sort)
    got=$(dir_names "$dir")
    [[ $got == "$want" ]] || fail "files were '$got', want '$want'"
    [[ $(($(wc -l < "$t/calls"))) -eq 4 ]] || fail "bun ran $(wc -l < "$t/calls") times, want 4"
    local pair name target
    for pair in \
        'mksync-linux-x64 bun-linux-x64' \
        'mksync-linux-arm64 bun-linux-arm64' \
        'mksync-darwin-arm64 bun-darwin-arm64' \
        'mksync-windows-x64.exe bun-windows-x64'; do
        name=${pair% *}
        target=${pair#* }
        [[ $(<"$dir/$name") == "$target" ]] || fail "$name holds '$(<"$dir/$name")', want '$target'"
    done
    (cd "$dir" && sha256sum -c SHA256SUMS) > /dev/null || fail 'sha256sum -c SHA256SUMS failed'
    local names
    names=$(awk '{print $2}' "$dir/SHA256SUMS")
    [[ $names == "$(printf '%s\n' "$names" | LC_ALL=C sort)" ]] || fail "SHA256SUMS is not sorted: $names"
    [[ $names != */* ]] || fail "SHA256SUMS holds a path: $names"
    [[ $(printf '%s\n' "$names" | wc -l) -eq 4 ]] || fail "SHA256SUMS has $(printf '%s\n' "$names" | wc -l) lines, want 4"
}

for case_name in mismatched-tag matching-tag; do
    if [[ -n $filter && $case_name != *"$filter"* ]]; then
        continue
    fi
    # Each case runs in a subshell so its EXIT trap (new_tmp) cleans up its temp dir.
    # set -e is off inside this command substitution (it is an if condition), so
    # every assertion must end in || fail.
    if out_text=$(case "$case_name" in
        mismatched-tag) case_mismatched_tag ;;
        matching-tag) case_matching_tag ;;
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
