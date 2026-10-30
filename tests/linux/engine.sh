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

case_error_continues() {
    # The repo copy of plain.txt is read-only, so the copy fails; export must
    # still report that file as ERROR and process the remaining entries.
    if (( EUID == 0 )); then
        printf '__SKIP_ROOT__\n'
        return 0
    fi
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture
    printf 'new\n' > "$t/home/.config/fixture/plain.txt"
    chmod 444 "$t/repo/dotfiles/linux/plain.txt"

    run_engine "$t/home" export.sh
    chmod u+w "$t/repo/dotfiles/linux/plain.txt"
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    grep -qE '^  ERROR +dotfiles/linux/plain\.txt' "$out" \
        || fail "missing ERROR line for plain.txt"
    local f
    for f in tool.sh named.conf no-trailing.txt; do
        grep -qE "^  [A-Z]+ +dotfiles/linux/$f" "$out" \
            || fail "missing status line for $f"
    done
}

case_import_eof_overwrites() {
    new_tmp
    setup_repo
    setup_repo_fixture
    mkdir -p "$t/home/.config/fixture"
    printf 'old\n' > "$t/home/.config/fixture/plain.txt"

    # No --force, stdin is /dev/null: the overwrite prompt reads EOF, which
    # counts as accepting the default, so the file is overwritten.
    run_engine "$t/home" import.sh
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"

    # The prompt has no trailing newline, so the status line follows it on the
    # same output line; match the status text as a substring.
    grep -Fq "$(status_line UPDATED dotfiles/linux/plain.txt 'backup saved as plain.txt.bak')" "$out" \
        || fail "missing UPDATED (backup) line for plain.txt"
    cmp -s "$FIXTURES/home/.config/fixture/plain.txt" "$t/home/.config/fixture/plain.txt" \
        || fail "plain.txt does not match the fixture after update"
    printf 'old\n' > "$t/expected.bak"
    cmp -s "$t/expected.bak" "$t/home/.config/fixture/plain.txt.bak" \
        || fail "plain.txt.bak does not contain the old content"
}

case_crlf_unchanged() {
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture
    # Two lines: a CR before the last line is not removed by the end-of-file trim,
    # so this only passes if the compare really ignores CRLF.
    printf '# fixture\nname = <NAME>\n' > "$t/repo/dotfiles/linux/named.conf"
    cp "$t/repo/dotfiles/linux/named.conf" "$t/expected-repo"
    printf '# fixture\r\nname = Fixture User\r\n' > "$t/home/.config/fixture/named.conf"

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status UNCHANGED dotfiles/linux/named.conf \
        || fail "export: missing UNCHANGED line for named.conf"
    cmp -s "$t/expected-repo" "$t/repo/dotfiles/linux/named.conf" \
        || fail "export rewrote the repo named.conf"

    run_engine "$t/home" import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    output_has_status UNCHANGED dotfiles/linux/named.conf \
        || fail "import: missing UNCHANGED line for named.conf"
    printf '# fixture\r\nname = Fixture User\r\n' > "$t/expected-crlf"
    cmp -s "$t/expected-crlf" "$t/home/.config/fixture/named.conf" \
        || fail "local named.conf did not keep its CRLF ending"
    [[ -z "$(find "$t/home" -name '*.bak')" ]] || fail "a .bak file was created"
}

case_common_import() {
    new_tmp
    setup_repo
    setup_repo_fixture
    mkdir -p "$t/home"

    run_engine "$t/home" import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"

    cmp -s "$FIXTURES/home/.config/fixture/shared.conf" "$t/home/.config/fixture/shared.conf" \
        || fail "shared.conf differs from fixture"
    output_has_status CREATED dotfiles/common/shared.conf \
        || fail "missing CREATED line for shared.conf"
}

case_common_export() {
    new_tmp
    setup_repo
    mkdir -p "$t/repo/dotfiles"
    setup_home_fixture

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    cmp -s "$FIXTURES/repo/dotfiles/common/shared.conf" "$t/repo/dotfiles/common/shared.conf" \
        || fail "dotfiles/common/shared.conf differs from fixture"
    output_has_status ADDED dotfiles/common/shared.conf sanitized \
        || fail "missing ADDED (sanitized) line for shared.conf"
}

case_missing_platform() {
    new_tmp
    setup_repo
    mkdir -p "$t/repo/dotfiles" "$t/home"
    jq '.files |= map(if .repoPath == "dotfiles/linux/plain.txt" then del(.platform) else . end)' \
        "$t/repo/sync-config.json" > "$t/repo/sync-config.json.tmp"
    mv "$t/repo/sync-config.json.tmp" "$t/repo/sync-config.json"

    local msg='ERROR: sync-config.json: entry dotfiles/linux/plain.txt needs "platform": "common", "windows" or "linux".'

    run_engine "$t/home" export.sh
    (( rc == 1 )) || fail "export.sh exited $rc, want 1"
    grep -Fqx "$msg" "$out" || fail "export did not print the platform error"

    run_engine "$t/home" import.sh --force
    (( rc == 1 )) || fail "import.sh exited $rc, want 1"
    grep -Fqx "$msg" "$out" || fail "import did not print the platform error"

    [[ -z "$(find "$t/home" -type f)" ]] || fail "a file was written under the home dir"
    [[ -z "$(find "$t/repo/dotfiles" -type f)" ]] || fail "a file was written under dotfiles/"
}

case_escape_import() {
    new_tmp
    setup_repo
    setup_repo_fixture
    mkdir -p "$t/home"

    run_engine "$t/home" import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"

    cmp -s "$FIXTURES/home/.config/fixture/paths.ini" "$t/home/.config/fixture/paths.ini" \
        || fail "paths.ini differs from fixture"
    output_has_status CREATED dotfiles/common/paths.ini \
        || fail "missing CREATED line for paths.ini"
}

case_escape_export() {
    new_tmp
    setup_repo
    mkdir -p "$t/repo/dotfiles"
    setup_home_fixture

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    cmp -s "$FIXTURES/repo/dotfiles/common/paths.ini" "$t/repo/dotfiles/common/paths.ini" \
        || fail "dotfiles/common/paths.ini differs from fixture"
    output_has_status ADDED dotfiles/common/paths.ini sanitized \
        || fail "missing ADDED (sanitized) line for paths.ini"
}

case_escape_roundtrip_unchanged() {
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status UNCHANGED dotfiles/common/paths.ini \
        || fail "export: missing UNCHANGED line for paths.ini"

    run_engine "$t/home" import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    output_has_status UNCHANGED dotfiles/common/paths.ini \
        || fail "import: missing UNCHANGED line for paths.ini"

    [[ -z "$(find "$t/home" -name '*.bak')" ]] || fail "a .bak file was created"
}

case_sanitize_longest_first() {
    new_tmp
    setup_repo
    mkdir -p "$t/repo/dotfiles"
    setup_home_fixture

    # A second, shorter value (<TOOLS> = C:\Tools) must not be replaced inside <WINPATH>'s value.
    jq '(.files[] | select(.repoPath == "dotfiles/common/paths.ini") | .sanitizeRules) +=
        [{"placeholder": "<TOOLS>", "prompt": "Tools dir"}]' \
        "$t/repo/sync-config.json" > "$t/repo/sync-config.json.tmp"
    mv "$t/repo/sync-config.json.tmp" "$t/repo/sync-config.json"
    jq --arg v 'C:\Tools' '. + {"<TOOLS>": $v}' \
        "$t/repo/.user-values.json" > "$t/repo/.user-values.json.tmp"
    mv "$t/repo/.user-values.json.tmp" "$t/repo/.user-values.json"

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    cmp -s "$FIXTURES/repo/dotfiles/common/paths.ini" "$t/repo/dotfiles/common/paths.ini" \
        || fail "dotfiles/common/paths.ini is not exactly 'gh = <WINPATH>'"
}

case_infer_name() {
    new_tmp
    setup_repo
    setup_repo_fixture
    jq -n --arg v 'C:\Tools\gh.exe' '{"<WINPATH>": $v}' > "$t/repo/.user-values.json"
    mkdir -p "$t/home/.config/fixture"
    printf 'name = Jane Roe\n' > "$t/home/.config/fixture/named.conf"

    # No --force: the inferred <NAME> makes the hydrated repo file match the
    # local one, so there is no overwrite prompt and nothing is rewritten.
    run_engine "$t/home" import.sh
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"

    [[ $(jq -r '."<NAME>"' "$t/repo/.user-values.json") == 'Jane Roe' ]] \
        || fail ".user-values.json does not have the inferred <NAME>"
    output_has_status UNCHANGED dotfiles/linux/named.conf \
        || fail "missing UNCHANGED line for named.conf"
    printf 'name = Jane Roe\n' > "$t/expected"
    cmp -s "$t/expected" "$t/home/.config/fixture/named.conf" \
        || fail "local named.conf was rewritten"
}

case_infer_reset() {
    new_tmp
    setup_repo
    setup_repo_fixture
    jq -n --arg v 'C:\Tools\gh.exe' '{"<WINPATH>": $v}' > "$t/repo/.user-values.json"
    mkdir -p "$t/home/.config/fixture"
    printf 'name = Jane Roe\n' > "$t/home/.config/fixture/named.conf"

    # --reset-values skips inference, so <NAME> has no value in a non-interactive run.
    run_engine "$t/home" import.sh --reset-values
    (( rc == 1 )) || fail "import.sh exited $rc, want 1"
    grep -q 'missing value for <NAME>' "$out" || fail "missing 'missing value for <NAME>' message"
}

case_infer_keeps_cache() {
    new_tmp
    setup_repo
    setup_repo_fixture
    mkdir -p "$t/home/.config/fixture"
    printf 'name = Jane Roe\n' > "$t/home/.config/fixture/named.conf"

    # The fixture cache (<NAME> = Fixture User) must beat the inferred value.
    run_engine "$t/home" import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"

    [[ $(jq -r '."<NAME>"' "$t/repo/.user-values.json") == 'Fixture User' ]] \
        || fail "cached <NAME> was overwritten"
    output_has_status UPDATED dotfiles/linux/named.conf 'backup saved as named.conf.bak' \
        || fail "missing UPDATED line for named.conf"
    cmp -s "$FIXTURES/home/.config/fixture/named.conf" "$t/home/.config/fixture/named.conf" \
        || fail "named.conf does not match the fixture after update"
}

case_infer_escaped() {
    new_tmp
    setup_repo
    setup_repo_fixture
    jq -n '{"<NAME>": "Fixture User"}' > "$t/repo/.user-values.json"
    mkdir -p "$t/home/.config/fixture"
    cp "$FIXTURES/home/.config/fixture/paths.ini" "$t/home/.config/fixture/paths.ini"

    # The local file holds the doubled form, so inference stores the un-doubled
    # value; hydrate doubles it back and the repo file matches the local one.
    run_engine "$t/home" import.sh
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"

    [[ $(jq -r '."<WINPATH>"' "$t/repo/.user-values.json") == 'C:\Tools\gh.exe' ]] \
        || fail ".user-values.json does not have the un-doubled <WINPATH>"
    output_has_status UNCHANGED dotfiles/common/paths.ini \
        || fail "missing UNCHANGED line for paths.ini"
    cmp -s "$FIXTURES/home/.config/fixture/paths.ini" "$t/home/.config/fixture/paths.ini" \
        || fail "paths.ini was rewritten"
    [[ -z "$(find "$t/home" -name '*.bak')" ]] || fail "a .bak file was created"
}

case_dir_export_adds() {
    new_tmp
    setup_repo
    mkdir -p "$t/repo/dotfiles"
    setup_home_fixture
    chmod 600 "$t/home/.config/fixture/dir/a/b.txt"
    chmod 755 "$t/home/.config/fixture/dir/c.txt"

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    cmp -s "$FIXTURES/repo/dotfiles/common/dir/a/b.txt" "$t/repo/dotfiles/common/dir/a/b.txt" \
        || fail "dotfiles/common/dir/a/b.txt differs from fixture"
    cmp -s "$FIXTURES/repo/dotfiles/common/dir/c.txt" "$t/repo/dotfiles/common/dir/c.txt" \
        || fail "dotfiles/common/dir/c.txt differs from fixture"
    [[ $(stat -c %a "$t/repo/dotfiles/common/dir/a/b.txt") == 600 ]] \
        || fail "a/b.txt mode is $(stat -c %a "$t/repo/dotfiles/common/dir/a/b.txt"), want 600"
    [[ $(stat -c %a "$t/repo/dotfiles/common/dir/c.txt") == 755 ]] \
        || fail "c.txt mode is $(stat -c %a "$t/repo/dotfiles/common/dir/c.txt"), want 755"

    output_has_status ADDED dotfiles/common/dir/a/b.txt || fail "missing ADDED line for dir/a/b.txt"
    output_has_status ADDED dotfiles/common/dir/c.txt || fail "missing ADDED line for dir/c.txt"
}

case_dir_export_modify_remove() {
    new_tmp
    setup_repo
    setup_repo_fixture
    mkdir -p "$t/repo/dotfiles/common/dir/old"
    printf 'old\n' > "$t/repo/dotfiles/common/dir/old/old.txt"
    setup_home_fixture
    printf 'c2\n' > "$t/home/.config/fixture/dir/c.txt"

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    output_has_status MODIFIED dotfiles/common/dir/c.txt || fail "missing MODIFIED line for dir/c.txt"
    output_has_status REMOVED dotfiles/common/dir/old/old.txt 'no longer in source' \
        || fail "missing REMOVED line for dir/old/old.txt"
    output_has_status UNCHANGED dotfiles/common/dir/a/b.txt || fail "missing UNCHANGED line for dir/a/b.txt"

    printf 'c2\n' > "$t/expected"
    cmp -s "$t/expected" "$t/repo/dotfiles/common/dir/c.txt" \
        || fail "repo dir/c.txt does not contain c2"
    [[ ! -e "$t/repo/dotfiles/common/dir/old" ]] || fail "repo dir old/ still exists"
}

case_dir_export_excluded() {
    new_tmp
    setup_repo
    mkdir -p "$t/repo/dotfiles"
    setup_home_fixture
    printf 'x\n' > "$t/home/.config/fixture/dir/x.bak"

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    output_has_status SKIPPED dotfiles/common/dir/x.bak 'matches exclude pattern' \
        || fail "missing SKIPPED (exclude) line for dir/x.bak"
    [[ ! -e "$t/repo/dotfiles/common/dir/x.bak" ]] || fail "x.bak was copied to the repo"
}

case_dir_export_missing() {
    new_tmp
    setup_repo
    mkdir -p "$t/repo/dotfiles"
    setup_home_fixture
    rm -rf "$t/home/.config/fixture/dir"

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    output_has_status SKIPPED 'dotfiles/common/dir/' "local folder not found: $t/home/.config/fixture/dir" \
        || fail "missing SKIPPED (folder missing) line for the dir entry"
}

case_dir_export_symlink() {
    new_tmp
    setup_repo
    mkdir -p "$t/repo/dotfiles"
    setup_home_fixture
    ln -s c.txt "$t/home/.config/fixture/dir/link.txt"

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    output_has_status SKIPPED dotfiles/common/dir/link.txt symlink \
        || fail "missing SKIPPED (symlink) line for dir/link.txt"
    [[ ! -e "$t/repo/dotfiles/common/dir/link.txt" && ! -L "$t/repo/dotfiles/common/dir/link.txt" ]] \
        || fail "link.txt was copied to the repo"
}

# -- Runner --------------------------------------------------------------------

for case_name in import-creates export-adds roundtrip-unchanged import-backup excluded noninteractive-missing-value error-continues import-eof-overwrites crlf-unchanged common-import common-export missing-platform escape-import escape-export escape-roundtrip-unchanged sanitize-longest-first infer-name infer-reset infer-keeps-cache infer-escaped dir-export-adds dir-export-modify-remove dir-export-excluded dir-export-missing dir-export-symlink; do
    if [[ -n $filter && $case_name != *"$filter"* ]]; then
        continue
    fi
    # Each case runs in a subshell so its EXIT trap (new_tmp) cleans up its temp dir.
    # set -e is off inside this command substitution (it is an if condition), so
    # every assertion must end in || fail.
    if out_text=$(case "$case_name" in
        import-creates) case_import_creates ;;
        export-adds) case_export_adds ;;
        roundtrip-unchanged) case_roundtrip_unchanged ;;
        import-backup) case_import_backup ;;
        excluded) case_excluded ;;
        noninteractive-missing-value) case_noninteractive_missing_value ;;
        error-continues) case_error_continues ;;
        import-eof-overwrites) case_import_eof_overwrites ;;
        crlf-unchanged) case_crlf_unchanged ;;
        common-import) case_common_import ;;
        common-export) case_common_export ;;
        missing-platform) case_missing_platform ;;
        escape-import) case_escape_import ;;
        escape-export) case_escape_export ;;
        escape-roundtrip-unchanged) case_escape_roundtrip_unchanged ;;
        sanitize-longest-first) case_sanitize_longest_first ;;
        infer-name) case_infer_name ;;
        infer-reset) case_infer_reset ;;
        infer-keeps-cache) case_infer_keeps_cache ;;
        infer-escaped) case_infer_escaped ;;
        dir-export-adds) case_dir_export_adds ;;
        dir-export-modify-remove) case_dir_export_modify_remove ;;
        dir-export-excluded) case_dir_export_excluded ;;
        dir-export-missing) case_dir_export_missing ;;
        dir-export-symlink) case_dir_export_symlink ;;
    esac); then
        if [[ $out_text == '__SKIP_ROOT__' ]]; then
            printf 'ok   %s (skipped: root)\n' "$case_name"
        else
            printf 'ok   %s\n' "$case_name"
        fi
    else
        printf '%s\n' "$out_text"
        failed=1
    fi
done

exit "$failed"
