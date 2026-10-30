#!/usr/bin/env bash
# Baseline engine tests: run the bash engine against the step-3 fixtures in a
# throwaway HOME/repo, asserting byte-exact results, file modes and status lines.
# Usage: tests/linux/engine.sh [case-name-filter]

set -euo pipefail

SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$SOURCE_DIR/../.." && pwd)
FIXTURES=$REPO/tests/fixtures

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

# The exact status line the engine prints (scripts/linux/sync.sh status()).
status_line() {
    local s=$1 label=$2 note=${3:-}
    printf '  %-10s %s%s\n' "$s" "$label" "${note:+  ($note)}"
}

# True when the engine output contains the given status line.
output_has_status() {
    local word=$1 label=$2 note=${3:-}
    grep -Fqx "$(status_line "$word" "$label" "$note")" "$out"
}

# Fresh throwaway working dir; removed when this case's subshell exits.
new_tmp() {
    t=$(mktemp -d)
    out=$t/out
    trap 'rm -rf "$t"' EXIT
}

# Copy the engine entry points + helpers, config and seeded values into $t/repo.
setup_repo() {
    mkdir -p "$t/repo/scripts"
    cp -a "$REPO/export.sh" "$REPO/import.sh" "$REPO/commit.sh" "$t/repo/"
    cp -a "$REPO/scripts/linux" "$t/repo/scripts/"
    cp "$FIXTURES/sync-config.json" "$t/repo/sync-config.json"
    cp "$FIXTURES/user-values.json" "$t/repo/.user-values.json"
}

setup_home_fixture() {
    mkdir -p "$t/home"
    cp -a "$FIXTURES/home/." "$t/home/"
}

setup_repo_fixture() {
    mkdir -p "$t/repo/dotfiles"
    cp -a "$FIXTURES/repo/dotfiles/." "$t/repo/dotfiles/"
}

# Run one engine entry point from $t/repo with a throwaway HOME and < /dev/null.
run_engine() {
    local home=$1 script=$2
    shift 2
    rc=0
    (cd "$t/repo" && HOME="$home" "./$script" "$@" < /dev/null) > "$out" 2>&1 || rc=$?
}

# -- Cases ---------------------------------------------------------------------

case_import_creates() {
    new_tmp
    setup_repo
    setup_repo_fixture
    mkdir -p "$t/home"

    run_engine "$t/home" import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"

    local f
    for f in plain.txt tool.sh named.conf no-trailing.txt; do
        cmp -s "$FIXTURES/home/.config/fixture/$f" "$t/home/.config/fixture/$f" \
            || fail "$f differs from fixture"
    done
    [[ $(stat -c %a "$t/home/.config/fixture/tool.sh") == 755 ]] \
        || fail "tool.sh mode is $(stat -c %a "$t/home/.config/fixture/tool.sh"), want 755"
    [[ ! -e "$t/home/.config/fixture/win.conf" ]] || fail "win.conf was created"
}

case_export_adds() {
    new_tmp
    setup_repo
    mkdir -p "$t/repo/dotfiles"
    setup_home_fixture

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    local f
    for f in plain.txt tool.sh named.conf no-trailing.txt; do
        cmp -s "$FIXTURES/repo/dotfiles/linux/$f" "$t/repo/dotfiles/linux/$f" \
            || fail "dotfiles/linux/$f differs from fixture"
    done
    [[ $(stat -c %a "$t/repo/dotfiles/linux/tool.sh") == 755 ]] \
        || fail "tool.sh mode is $(stat -c %a "$t/repo/dotfiles/linux/tool.sh"), want 755"
    [[ ! -e "$t/repo/dotfiles/windows" ]] || fail "dotfiles/windows exists"

    output_has_status ADDED dotfiles/linux/plain.txt || fail "missing ADDED line for plain.txt"
    output_has_status ADDED dotfiles/linux/tool.sh || fail "missing ADDED line for tool.sh"
    output_has_status ADDED dotfiles/linux/named.conf sanitized || fail "missing ADDED (sanitized) line for named.conf"
    output_has_status ADDED dotfiles/linux/no-trailing.txt || fail "missing ADDED line for no-trailing.txt"
}

case_roundtrip_unchanged() {
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    local f
    for f in plain.txt tool.sh named.conf no-trailing.txt; do
        output_has_status UNCHANGED "dotfiles/linux/$f" || fail "export: missing UNCHANGED line for $f"
    done
    if grep -qE '^  (ADDED|MODIFIED|REMOVED)[[:space:]]' "$out"; then
        fail "export printed a changed status"
    fi

    run_engine "$t/home" import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    for f in plain.txt tool.sh named.conf no-trailing.txt; do
        output_has_status UNCHANGED "dotfiles/linux/$f" || fail "import: missing UNCHANGED line for $f"
    done
    if grep -qE '^  (CREATED|UPDATED)[[:space:]]' "$out"; then
        fail "import printed a changed status"
    fi

    [[ -z "$(find "$t/home" -name '*.bak')" ]] || fail "a .bak file was created"
}

case_import_backup() {
    new_tmp
    setup_repo
    setup_repo_fixture
    mkdir -p "$t/home/.config/fixture"
    printf 'old\n' > "$t/home/.config/fixture/plain.txt"

    run_engine "$t/home" import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"

    output_has_status UPDATED dotfiles/linux/plain.txt 'backup saved as plain.txt.bak' \
        || fail "missing UPDATED (backup) line for plain.txt"
    cmp -s "$FIXTURES/home/.config/fixture/plain.txt" "$t/home/.config/fixture/plain.txt" \
        || fail "plain.txt does not match the fixture after update"
    printf 'old\n' > "$t/expected.bak"
    cmp -s "$t/expected.bak" "$t/home/.config/fixture/plain.txt.bak" \
        || fail "plain.txt.bak does not contain the old content"
}

case_excluded() {
    new_tmp
    setup_repo
    jq '.files += [{"repoPath": "dotfiles/linux/x.secret", "localPath": "~/.config/fixture/x.secret", "platform": "linux", "description": "excluded fixture"}]' \
        "$t/repo/sync-config.json" > "$t/repo/sync-config.json.tmp"
    mv "$t/repo/sync-config.json.tmp" "$t/repo/sync-config.json"
    mkdir -p "$t/home/.config/fixture"
    printf 'secret\n' > "$t/home/.config/fixture/x.secret"

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    output_has_status SKIPPED dotfiles/linux/x.secret 'matches exclude pattern' \
        || fail "missing SKIPPED (exclude) line for x.secret"
    [[ ! -e "$t/repo/dotfiles/linux/x.secret" ]] || fail "x.secret was copied to the repo"
}

case_noninteractive_missing_value() {
    new_tmp
    setup_repo
    setup_repo_fixture
    printf '{}\n' > "$t/repo/.user-values.json"
    mkdir -p "$t/home"

    run_engine "$t/home" import.sh
    (( rc == 1 )) || fail "import.sh exited $rc, want 1"
    grep -q 'missing value for <NAME>' "$out" || fail "missing 'missing value for <NAME>' message"
    [[ -z "$(find "$t/home" -type f)" ]] || fail "a file was written despite the missing value"
}

# -- Runner --------------------------------------------------------------------

for case_name in import-creates export-adds roundtrip-unchanged import-backup excluded noninteractive-missing-value; do
    if [[ -n $filter && $case_name != *"$filter"* ]]; then
        continue
    fi
    # Each case runs in a subshell so its EXIT trap (new_tmp) cleans up its temp
    # dir even when set -e aborts the case after a failing assertion.
    if out_text=$(case "$case_name" in
        import-creates) case_import_creates ;;
        export-adds) case_export_adds ;;
        roundtrip-unchanged) case_roundtrip_unchanged ;;
        import-backup) case_import_backup ;;
        excluded) case_excluded ;;
        noninteractive-missing-value) case_noninteractive_missing_value ;;
    esac); then
        printf 'ok   %s\n' "$case_name"
    else
        printf '%s\n' "$out_text"
        failed=1
    fi
done

exit "$failed"
