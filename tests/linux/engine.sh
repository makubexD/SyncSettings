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

# Cases build repos with git outside the throwaway HOME. Keep the host's git
# config, ignore and attributes files out of them: core.autocrlf=input rewrites
# fixture line endings in the commit.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 XDG_CONFIG_HOME=/nonexistent

# -- Helpers -------------------------------------------------------------------

fail() {
    printf 'FAIL %s: %s\n' "$case_name" "$*"
    # Cases run in a command-substitution subshell, where errexit does not abort
    # function bodies; exit the subshell so the runner reports the failure.
    exit 1
}

# The copy keeps the source's mode and is executable. Compare with the fixture
# rather than a literal 755: git checks files out under the user's umask.
same_mode() {
    local want=$1 got=$2
    [[ -x $got ]] || fail "${got##*/} is not executable"
    [[ $(stat -c %a "$got") == "$(stat -c %a "$want")" ]] \
        || fail "${got##*/} mode is $(stat -c %a "$got"), want $(stat -c %a "$want") like ${want#"$FIXTURES"/}"
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

# Turn $t/repo (after setup_repo + fixtures) into a git repo on master with one
# commit, plus a bare origin at $t/origin.git holding the same commit.
make_git_repo() {
    git -C "$t/repo" init -q -b master
    git -C "$t/repo" add -A
    git -C "$t/repo" -c user.name=t -c user.email=t@example.com commit -q -m init
    git init -q --bare -b master "$t/origin.git"
    git -C "$t/repo" remote add origin "$t/origin.git"
    git -C "$t/repo" push -q origin master
}

# Run one engine entry point from $t/repo with a throwaway HOME and < /dev/null.
run_engine() {
    local home=$1 script=$2
    shift 2
    rc=0
    (cd "$t/repo" && HOME="$home" "./$script" "$@" < /dev/null) > "$out" 2>&1 || rc=$?
}

# Run one engine entry point feeding a line on stdin instead of < /dev/null, so
# the overwrite prompt reads a real answer.
run_engine_input() {
    local home=$1 input=$2 script=$3
    shift 3
    rc=0
    (cd "$t/repo" && printf '%s\n' "$input" | HOME="$home" "./$script" "$@") > "$out" 2>&1 || rc=$?
}

# dconf writes go over the session bus, not through $HOME, so every dconf case
# runs on its own bus. The fake getent makes $t/home the login home for the engine.
setup_dconf_bus() {
    command -v dconf > /dev/null || fail 'dconf is not installed (dconf-cli)'
    command -v dbus-run-session > /dev/null || fail 'dbus-run-session is not installed (dbus)'
    mkdir -p "$t/bin" "$t/home"
    cat > "$t/bin/getent" <<EOF
#!/bin/sh
printf 'x:x:%s:%s::%s:/bin/bash\n' "$(id -u)" "$(id -g)" "$t/home"
EOF
    chmod +x "$t/bin/getent"
}

on_test_bus() {
    PATH="$t/bin:$PATH" HOME="$t/home" XDG_CONFIG_HOME="$t/home/.config" XDG_RUNTIME_DIR="$t" \
        dbus-run-session -- "$@"
}

# run_engine on the private bus, with stdin from the given file.
run_engine_bus() {
    local input=$1 script=$2
    shift 2
    rc=0
    (cd "$t/repo" && on_test_bus "./$script" "$@" < "$input") > "$out" 2>&1 || rc=$?
}

# Seed the private bus: load ini text from stdin under a dconf path.
dconf_seed() {
    on_test_bus dconf load "$1"
}

# Sorted SHA256 and mode of every file under $1, .git excluded. A stable
# fingerprint used to assert a preview wrote nothing outside its temp dir.
tree_hash() {
    local dir=$1 f
    (cd "$dir" \
        && while IFS= read -r f; do
            printf '%s %s %s\n' "$(sha256sum "$f" | awk '{print $1}')" "$(stat -c %a "$f")" "$f"
        done < <(find . -name .git -prune -o -type f -print | sed 's#^\./##' | sort))
}

# Engine + fixtures + scripts/ci as a git repo with one commit (preview cases).
setup_preview_repo() {
    setup_repo
    mkdir -p "$t/repo/scripts/ci"
    cp -a "$REPO/scripts/ci/." "$t/repo/scripts/ci/"
    setup_repo_fixture
    setup_home_fixture
    make_git_repo
}

# The default local change for preview cases: modify plain.txt, add dir/new.txt,
# delete dir/c.txt.
preview_change_default() {
    printf 'preview change\n' > "$t/home/.config/fixture/plain.txt"
    mkdir -p "$t/home/.config/fixture/dir"
    printf 'new file\n' > "$t/home/.config/fixture/dir/new.txt"
    rm -f "$t/home/.config/fixture/dir/c.txt"
}

# The sync wrapper is not part of the engine copy; the sync cases add it.
add_sync() {
    cp -a "$REPO/sync" "$t/repo/"
}

# Run the config lint on the repo's real sync-config.json after applying a jq
# filter to it; stores the exit code in rc and the output in $out.
lint_run() {
    local filter=$1
    jq "$filter" "$REPO/sync-config.json" > "$t/config.json"
    rc=0
    "$REPO/scripts/ci/check-config.sh" "$t/config.json" > "$out" 2>&1 || rc=$?
}

# Write one line to a file under $t and run the leak scan on it. $1 is the
# repo-relative path, $2 the line; rc and $out hold the result. The scan reads
# $t/dotfiles, not the file alone: grep -r prints no filename for a lone file,
# and the scan parses hits as "<file>:<line>: <text>".
leak_scan_on() {
    local rel=$1 line=$2
    mkdir -p "$t/${rel%/*}"
    printf '%s\n' "$line" > "$t/$rel"
    rc=0
    "$REPO/scripts/ci/leak-scan.sh" "$t/${rel%%/*}" > "$out" 2>&1 || rc=$?
}

# A stub GH that logs each invocation to $t/gh.log and prints a fixed URL.
make_gh_stub() {
    mkdir -p "$t/bin"
    cat > "$t/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${GH_LOG:?}"
printf 'https://github.com/example/pr/1\n'
EOF
    chmod +x "$t/bin/gh"
}

# A fixture repo (commit.sh + scripts/ + sync paths) committed on master and
# pushed to a bare origin, plus a fresh clone where commit.sh actually runs.
setup_commit_repo() {
    setup_repo
    mkdir -p "$t/repo/scripts/ci"
    cp -a "$REPO/scripts/ci/." "$t/repo/scripts/ci/"
    setup_repo_fixture
    make_git_repo
    git clone -q "$t/origin.git" "$t/clone"
    git -C "$t/clone" config syncsettings.machine testbox
    git -C "$t/clone" config user.name t
    git -C "$t/clone" config user.email t@example.com
    make_gh_stub
    mkdir -p "$t/home"
}

# Run commit.sh in the clone with the stub GH and a throwaway HOME.
run_commit() {
    local home=$1
    shift
    rc=0
    (cd "$t/clone" && HOME="$home" GH="$t/bin/gh" GH_LOG="$t/gh.log" ./commit.sh "$@" < /dev/null) > "$out" 2>&1 || rc=$?
}

# Refnames of every branch on the bare origin.
origin_branches() {
    git --git-dir="$t/origin.git" for-each-ref --format='%(refname)' refs/heads
}

# Common setup for the drift cases: a repo and home with the fixture files, a
# packages folder, and stubs for every tool the drift report runs, so no case
# can reach the real apt-mark, dpkg-query, snap, pipx or code.
setup_drift_case() {
    new_tmp
    setup_repo
    setup_home_fixture
    setup_repo_fixture
    mkdir -p "$t/repo/packages/linux" "$t/root" "$t/bin" "$t/stub"
    mkdir -p "$t/home/.nvm/versions/node/v1.0.0/lib/node_modules"
    local tool
    for tool in apt-mark dpkg-query snap pipx code; do
        cat > "$t/bin/$tool" <<EOF
#!/bin/sh
cat "$t/stub/$tool.out" 2>/dev/null
exit "\$(cat "$t/stub/$tool.rc" 2>/dev/null || echo 0)"
EOF
        chmod +x "$t/bin/$tool"
    done
}

# Run export.sh on a drift case: the stub PATH stands in for the package tools.
run_drift() {
    PATH="$t/bin:$PATH" DRIFT_ROOT="$t/root" run_engine "$t/home" export.sh
}

assert_no_drift() {
    if grep -qE '^  DRIFT[[:space:]]' "$out"; then
        fail "unexpected DRIFT line: $(grep -E '^  DRIFT[[:space:]]' "$out" | head -n1)"
    fi
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
    same_mode "$FIXTURES/repo/dotfiles/linux/tool.sh" "$t/home/.config/fixture/tool.sh"
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
    same_mode "$FIXTURES/home/.config/fixture/tool.sh" "$t/repo/dotfiles/linux/tool.sh"
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

case_prompt_empty_stops() {
    new_tmp
    setup_repo
    setup_repo_fixture
    printf '{}\n' > "$t/repo/.user-values.json"
    mkdir -p "$t/home"

    local repo_before
    repo_before=$(tree_hash "$t/repo")

    # Run on a pseudo-terminal and answer the <NAME> prompt with an empty line.
    # <NAME> has no default, so the empty answer must stop the run, not count as
    # a value. script -e propagates import.sh's exit code.
    rc=0
    printf '\n' | script -qec "cd $(printf %q "$t/repo") && HOME=$(printf %q "$t/home") ./import.sh" /dev/null \
        > "$out" 2>&1 || rc=$?
    (( rc == 1 )) || fail "import.sh exited $rc, want 1"
    grep -Fq 'missing value for <NAME>: add it to .user-values.json' "$out" \
        || fail "missing 'missing value for <NAME>' message"
    [[ -z "$(find "$t/home" -type f)" ]] || fail "a file was written despite the empty answer"
    [[ $(tree_hash "$t/repo") == "$repo_before" ]] || fail "repo changed despite the empty answer"
}

case_defaultenv_invalid() {
    new_tmp
    setup_repo
    mkdir -p "$t/repo/dotfiles" "$t/home"
    add_entry '{"repoPath": "dotfiles/linux/env.conf", "localPath": "~/.config/fixture/env.conf", "platform": "linux", "description": "invalid defaultEnv", "sanitizeRules": [{"placeholder": "<ENV>", "prompt": "Env value", "defaultEnv": "BAD-NAME"}]}'

    local msg='ERROR: sync-config.json: entry dotfiles/linux/env.conf has an invalid defaultEnv.'

    run_engine "$t/home" export.sh
    (( rc == 1 )) || fail "export.sh exited $rc, want 1"
    grep -Fqx "$msg" "$out" || fail "export did not print the defaultEnv error"

    run_engine "$t/home" import.sh --force
    (( rc == 1 )) || fail "import.sh exited $rc, want 1"
    grep -Fqx "$msg" "$out" || fail "import did not print the defaultEnv error"

    [[ -z "$(find "$t/home" -type f)" ]] || fail "a file was written under the home dir"
    [[ -z "$(find "$t/repo/dotfiles" -type f)" ]] || fail "a file was written under dotfiles/"

    # A leading digit is not a valid variable name either.
    jq '.files |= map(if .repoPath == "dotfiles/linux/env.conf"
        then .sanitizeRules[0].defaultEnv = "1BAD" else . end)' \
        "$t/repo/sync-config.json" > "$t/repo/sync-config.json.tmp"
    mv "$t/repo/sync-config.json.tmp" "$t/repo/sync-config.json"

    run_engine "$t/home" export.sh
    (( rc == 1 )) || fail "export.sh exited $rc with 1BAD, want 1"
    grep -Fqx "$msg" "$out" || fail "export did not print the defaultEnv error for 1BAD"
    [[ -z "$(find "$t/home" -type f)" ]] || fail "a file was written for 1BAD"
    [[ -z "$(find "$t/repo/dotfiles" -type f)" ]] || fail "a file was written under dotfiles/ for 1BAD"
}

case_defaultenv_valid() {
    new_tmp
    setup_repo
    setup_repo_fixture
    jq '.files |= map(if .repoPath == "dotfiles/linux/named.conf"
        then .sanitizeRules[0].defaultEnv = "FIXTURE_NAME" else . end)' \
        "$t/repo/sync-config.json" > "$t/repo/sync-config.json.tmp"
    mv "$t/repo/sync-config.json.tmp" "$t/repo/sync-config.json"
    jq 'del(."<NAME>")' "$t/repo/.user-values.json" > "$t/repo/.user-values.json.tmp"
    mv "$t/repo/.user-values.json.tmp" "$t/repo/.user-values.json"
    mkdir -p "$t/home"

    # <NAME> has no cached value, so the prompt offers FIXTURE_NAME's value as
    # its default. Answer it with Enter on a pseudo-terminal, as a user would.
    rc=0
    printf '\n' | FIXTURE_NAME='Env Value' \
        script -qec "cd $(printf %q "$t/repo") && HOME=$(printf %q "$t/home") ./import.sh" /dev/null \
        > "$out" 2>&1 || rc=$?
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    printf 'name = Env Value\n' > "$t/expected"
    cmp -s "$t/expected" "$t/home/.config/fixture/named.conf" \
        || fail "named.conf was not hydrated with FIXTURE_NAME's value"
}

case_values_mode_new() {
    new_tmp
    setup_repo
    setup_repo_fixture
    rm "$t/repo/.user-values.json"
    jq '.files |= map(if .sanitizeRules then .sanitizeRules |= map(.default = "Fixture Default") else . end)' \
        "$t/repo/sync-config.json" > "$t/repo/sync-config.json.tmp"
    mv "$t/repo/sync-config.json.tmp" "$t/repo/sync-config.json"
    mkdir -p "$t/home"

    # Without its own umask, save_values would leave this file at 644.
    umask 022
    run_engine "$t/home" import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    [[ $(stat -c '%a' "$t/repo/.user-values.json") == 600 ]] || fail ".user-values.json is not mode 600"
}

case_values_mode_tightened() {
    new_tmp
    setup_repo
    setup_repo_fixture
    jq 'del(."<NAME>")' "$t/repo/.user-values.json" > "$t/repo/.user-values.json.tmp"
    mv "$t/repo/.user-values.json.tmp" "$t/repo/.user-values.json"
    chmod 644 "$t/repo/.user-values.json"
    jq '.files |= map(if .sanitizeRules then .sanitizeRules |= map(.default = "Fixture Default") else . end)' \
        "$t/repo/sync-config.json" > "$t/repo/sync-config.json.tmp"
    mv "$t/repo/sync-config.json.tmp" "$t/repo/sync-config.json"
    mkdir -p "$t/home"

    run_engine "$t/home" import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    [[ $(stat -c '%a' "$t/repo/.user-values.json") == 600 ]] || fail ".user-values.json is not mode 600"
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

# Append one JSON entry to the fixture sync-config.json in $t/repo.
add_entry() {
    jq --argjson e "$1" '.files += [$e]' "$t/repo/sync-config.json" > "$t/repo/sync-config.json.tmp"
    mv "$t/repo/sync-config.json.tmp" "$t/repo/sync-config.json"
}

# Both engines must stop with the same path error before touching anything.
assert_path_stop() {
    local msg=$1

    run_engine "$t/home" export.sh
    (( rc == 1 )) || fail "export.sh exited $rc, want 1"
    grep -Fqx "$msg" "$out" || fail "export did not print the path error"

    run_engine "$t/home" import.sh --force
    (( rc == 1 )) || fail "import.sh exited $rc, want 1"
    grep -Fqx "$msg" "$out" || fail "import did not print the path error"

    [[ -z "$(find "$t/home" -type f)" ]] || fail "a file was written under the home dir"
    [[ -z "$(find "$t/repo/dotfiles" -type f)" ]] || fail "a file was written under dotfiles/"
}

case_path_repo_traversal() {
    new_tmp
    setup_repo
    mkdir -p "$t/repo/dotfiles" "$t/home"
    add_entry '{"repoPath": "dotfiles/../evil.txt", "localPath": "~\\evil.txt", "platform": "windows", "description": "unsafe repoPath"}'
    assert_path_stop 'ERROR: sync-config.json: entry dotfiles/../evil.txt has an unsafe path.'
}

case_path_repo_outside() {
    new_tmp
    setup_repo
    mkdir -p "$t/repo/dotfiles" "$t/home"
    add_entry '{"repoPath": "outside/evil.txt", "localPath": "~\\evil.txt", "platform": "windows", "description": "unsafe repoPath"}'
    assert_path_stop 'ERROR: sync-config.json: entry outside/evil.txt has an unsafe path.'
}

case_path_local_traversal() {
    new_tmp
    setup_repo
    mkdir -p "$t/repo/dotfiles" "$t/home"
    add_entry '{"repoPath": "dotfiles/windows/evil.txt", "localPath": "~\\..\\evil.txt", "platform": "windows", "description": "unsafe localPath"}'
    assert_path_stop 'ERROR: sync-config.json: entry dotfiles/windows/evil.txt has an unsafe path.'
}

case_path_local_absolute() {
    new_tmp
    setup_repo
    mkdir -p "$t/repo/dotfiles" "$t/home"
    add_entry '{"repoPath": "dotfiles/windows/evil.txt", "localPath": "/etc/passwd", "platform": "windows", "description": "unsafe localPath"}'
    assert_path_stop 'ERROR: sync-config.json: entry dotfiles/windows/evil.txt has an unsafe path.'
}

case_path_repo_symlink() {
    new_tmp
    setup_repo
    mkdir -p "$t/repo/dotfiles/linux" "$t/home"
    ln -s nowhere "$t/repo/dotfiles/linux/plain.txt"
    assert_path_stop 'ERROR: sync-config.json: entry dotfiles/linux/plain.txt has an unsafe path.'
}

case_path_real_config() {
    new_tmp
    setup_repo
    cp "$REPO/sync-config.json" "$t/repo/sync-config.json"
    mkdir -p "$t/home"

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    if grep -Fq 'has an unsafe path' "$out"; then
        fail "check_paths rejected the repo's own sync-config.json"
    fi

    run_engine "$t/home" import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    if grep -Fq 'has an unsafe path' "$out"; then
        fail "check_paths rejected the repo's own sync-config.json"
    fi
}

case_real_config_roundtrip() {
    new_tmp
    setup_repo
    cp "$REPO/sync-config.json" "$t/repo/sync-config.json"
    cp -a "$REPO/dotfiles" "$t/before"
    cp -a "$REPO/dotfiles" "$t/repo/"
    mkdir -p "$t/home"

    # The real dconf entries, read from the config so a new one is covered too.
    local -a dconf_repo_paths=() dconf_paths=()
    mapfile -d '' dconf_repo_paths < <(jq -j '.files[] | select(.type == "dconf") | .repoPath, "\u0000"' "$t/repo/sync-config.json")
    mapfile -d '' dconf_paths < <(jq -j '.files[] | select(.type == "dconf") | .path, "\u0000"' "$t/repo/sync-config.json")
    (( ${#dconf_repo_paths[@]} == 10 )) \
        || fail "sync-config.json has ${#dconf_repo_paths[@]} dconf entries, want 10"

    # Fake values, escaped by jq, so the round trip never reads the real home.
    jq -n --arg name 'Fixture User' --arg email 'fixture@example.com' \
        --arg gh 'fixture-user' --arg home "$t/home" \
        '{ "<YOUR_NAME>": $name, "<YOUR_EMAIL>": $email,
           "<YOUR_GH_USERNAME>": $gh, "<HOME>": $home,
           "<YOUR_WORK_MARKETPLACE>": "https://example.com/plugins" }' > "$t/repo/.user-values.json"

    run_engine "$t/home" import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    if grep -Fq 'ERROR' "$out"; then
        fail "import printed an ERROR line"
    fi

    # Without a private bus the guard refuses every dconf entry, and no backup.
    local i
    for i in "${!dconf_repo_paths[@]}"; do
        output_has_status SKIPPED "${dconf_repo_paths[$i]}" \
            'HOME is not the login home; dconf left alone' \
            || fail "import: missing guarded SKIPPED line for ${dconf_repo_paths[$i]}"
    done
    [[ ! -e "$t/home/.local/state/sync-settings" ]] \
        || fail "a dconf backup was written under the throwaway HOME"

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    grep -Fq 'Repo is up to date' "$out" || fail "export did not print 'Repo is up to date'"
    if grep -qE '^  (MODIFIED|ADDED|REMOVED|ORPHAN)[[:space:]]|ERROR' "$out"; then
        fail "export printed a changed status or an error"
    fi
    # Export reads the database under XDG_CONFIG_HOME, which is /nonexistent
    # here, so every dconf path comes back empty.
    for i in "${!dconf_repo_paths[@]}"; do
        output_has_status SKIPPED "${dconf_repo_paths[$i]}" \
            "no settings under ${dconf_paths[$i]}" \
            || fail "export: missing empty SKIPPED line for ${dconf_repo_paths[$i]}"
    done

    if ! diff -r "$t/before" "$t/repo/dotfiles" > "$t/dotfiles.diff" 2>&1; then
        fail "dotfiles changed during the round trip: $(head -n 3 "$t/dotfiles.diff")"
    fi

    local name helpers
    name=$(HOME="$t/home" git config --file "$t/home/.gitconfig" --includes --get user.name)
    [[ $name == 'Fixture User' ]] || fail "user.name is '$name', want 'Fixture User'"

    helpers=$(HOME="$t/home" git config --file "$t/home/.gitconfig" --includes \
        --get-all credential.https://github.com.helper)
    [[ $(printf '%s\n' "$helpers" | tail -n 1) == '!/usr/bin/gh auth git-credential' ]] \
        || fail "the last credential.https://github.com.helper value is not the gh helper"

    if grep -Fq '<YOUR_' "$t/home/.gitconfig"; then
        fail ".gitconfig still holds an unfilled placeholder"
    fi
    cmp -s "$t/home/.bashrc" "$t/repo/dotfiles/linux/shell/.bashrc" \
        || fail ".bashrc does not match the linux entry"
    [[ ! -e "$t/home/.claude/plugins" ]] || fail ".claude/plugins was imported"
    [[ ! -e "$t/home/.gitconfig.bak" ]] || fail ".gitconfig.bak was created"
    [[ -x "$t/home/.claude/hooks/worker-mode-guard.sh" ]] \
        || fail "worker-mode-guard.sh is not executable"

    cmp -s "$t/home/.config/git/ignore" "$t/repo/dotfiles/common/git/ignore" \
        || fail ".config/git/ignore does not match the repo"
    [[ -x "$t/home/.local/bin/wezterm-xwayland" ]] || fail "wezterm-xwayland is not executable"
    grep -Fq "Exec=$t/home/.local/bin/wezterm-xwayland" \
        "$t/home/.local/share/applications/wezterm-xwayland.desktop" \
        || fail "wezterm-xwayland.desktop has no Exec line for the launcher"
    if grep -Fq '<HOME>' "$t/home/.local/share/applications/wezterm-xwayland.desktop"; then
        fail "wezterm-xwayland.desktop still holds <HOME>"
    fi
    grep -Fq "file://$t/home/Documents" "$t/home/.config/gtk-3.0/bookmarks" \
        || fail "bookmarks has no file:// line for Documents"
    if grep -Fq '<HOME>' "$t/home/.config/gtk-3.0/bookmarks"; then
        fail "bookmarks still holds <HOME>"
    fi
    grep -Fq 'https://example.com/plugins' "$t/home/.config/Code/User/settings.json" \
        || fail "settings.json has no marketplace URL"
    if grep -Fq '<YOUR_' "$t/home/.config/Code/User/settings.json"; then
        fail "settings.json still holds a <YOUR_ placeholder"
    fi
    compgen -G "$t/home/.config/Code/User/snippets/*" > /dev/null \
        || fail "no snippet files were imported"
    [[ ! -e "$t/home/.config/gh/hosts.yml" ]] || fail "gh/hosts.yml was imported"
    [[ -e "$t/home/.config/rtk/config.toml" ]] || fail "rtk/config.toml was not imported"

    local leftover
    leftover=$(grep -rlE '<(HOME|YOUR_[A-Z_]+)>' "$t/home" || true)
    leftover=${leftover%%$'\n'*}
    [[ -z $leftover ]] || fail "unfilled placeholder in $leftover"
}

# The real dconf entries restored on a private bus: the first import creates
# every key, and import and export then settle on UNCHANGED.
case_real_config_dconf_restore() {
    new_tmp
    setup_repo
    cp "$REPO/sync-config.json" "$t/repo/sync-config.json"
    cp -a "$REPO/dotfiles" "$t/before"
    cp -a "$REPO/dotfiles" "$t/repo/"
    setup_dconf_bus

    # Fake values, escaped by jq, so the round trip never reads the real home.
    jq -n --arg name 'Fixture User' --arg email 'fixture@example.com' \
        --arg gh 'fixture-user' --arg home "$t/home" \
        '{ "<YOUR_NAME>": $name, "<YOUR_EMAIL>": $email,
           "<YOUR_GH_USERNAME>": $gh, "<HOME>": $home,
           "<YOUR_WORK_MARKETPLACE>": "https://example.com/plugins" }' > "$t/repo/.user-values.json"

    # The real dconf entries, read from the config so a new one is covered too.
    local -a dconf_repo_paths=() dconf_paths=()
    mapfile -d '' dconf_repo_paths < <(jq -j '.files[] | select(.type == "dconf") | .repoPath, "\u0000"' "$t/repo/sync-config.json")
    mapfile -d '' dconf_paths < <(jq -j '.files[] | select(.type == "dconf") | .path, "\u0000"' "$t/repo/sync-config.json")
    (( ${#dconf_repo_paths[@]} == 10 )) \
        || fail "sync-config.json has ${#dconf_repo_paths[@]} dconf entries, want 10"

    local i repo_path dconf_path line dump
    run_engine_bus /dev/null import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    for i in "${!dconf_repo_paths[@]}"; do
        output_has_status CREATED "${dconf_repo_paths[$i]}" \
            || fail "import: missing CREATED line for ${dconf_repo_paths[$i]}"
    done

    # The key the plan names; its expected value comes from the repo file.
    local wm_repo expected got
    wm_repo=$(jq -r '.files[] | select(.type == "dconf" and .path == "/org/gnome/desktop/wm/keybindings/") | .repoPath' \
        "$t/repo/sync-config.json")
    expected=$(sed -n 's/^switch-to-workspace-up=//p' "$t/repo/$wm_repo")
    got=$(on_test_bus dconf read /org/gnome/desktop/wm/keybindings/switch-to-workspace-up)
    [[ $got == "$expected" ]] \
        || fail "switch-to-workspace-up is '$got', want '$expected'"

    # Every key line in each repo file must be in the dump of its path.
    for i in "${!dconf_repo_paths[@]}"; do
        repo_path=${dconf_repo_paths[$i]}
        dconf_path=${dconf_paths[$i]}
        dump=$(on_test_bus dconf dump "$dconf_path") \
            || fail "dconf dump $dconf_path failed"
        while IFS= read -r line; do
            [[ $line == *=* ]] || continue
            grep -Fqx -- "$line" <<<"$dump" \
                || fail "$repo_path: $line is missing from the dump of $dconf_path"
        done < "$t/repo/$repo_path"
    done

    run_engine_bus /dev/null import.sh
    (( rc == 0 )) || fail "second import.sh exited $rc, want 0"
    for i in "${!dconf_repo_paths[@]}"; do
        output_has_status UNCHANGED "${dconf_repo_paths[$i]}" \
            || fail "second import: missing UNCHANGED line for ${dconf_repo_paths[$i]}"
    done

    run_engine_bus /dev/null export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    for i in "${!dconf_repo_paths[@]}"; do
        output_has_status UNCHANGED "${dconf_repo_paths[$i]}" \
            || fail "export: missing UNCHANGED line for ${dconf_repo_paths[$i]}"
    done
    grep -Fq 'Repo is up to date' "$out" || fail "export did not print 'Repo is up to date'"
    if ! diff -r "$t/before" "$t/repo/dotfiles" > "$t/dotfiles.diff" 2>&1; then
        fail "dotfiles changed during the restore: $(head -n 3 "$t/dotfiles.diff")"
    fi
}

case_lint_real_config() {
    new_tmp

    # No argument: the default file and the default output line.
    rc=0
    (cd "$REPO" && scripts/ci/check-config.sh) > "$out" 2>&1 || rc=$?
    (( rc == 0 )) || fail "check-config.sh exited $rc, want 0"
    grep -Fqx 'sync-config.json: OK' "$out" || fail "missing 'sync-config.json: OK' line"
}

case_lint_real_packages() {
    new_tmp

    rc=0
    (cd "$REPO" && scripts/ci/check-packages.sh) > "$out" 2>&1 || rc=$?
    (( rc == 0 )) || fail "check-packages.sh exited $rc, want 0"
    grep -Fqx 'packages/linux: OK' "$out" || fail "missing 'packages/linux: OK' line"
}

case_lint_platform_missing() {
    new_tmp
    lint_run '.files |= map(if .repoPath == "dotfiles/linux/claude/CLAUDE.md" then del(.platform) else . end)'

    (( rc == 1 )) || fail "check-config.sh exited $rc, want 1"
    grep -Fqx 'dotfiles/linux/claude/CLAUDE.md' "$out" || fail "output does not name the repoPath"
}

case_lint_platform_bad() {
    new_tmp
    lint_run '.files |= map(if .repoPath == "dotfiles/linux/claude/CLAUDE.md" then .platform = "mac" else . end)'

    (( rc == 1 )) || fail "check-config.sh exited $rc, want 1"
    grep -Fqx 'dotfiles/linux/claude/CLAUDE.md' "$out" || fail "output does not name the repoPath"
}

case_lint_linux_prefix() {
    new_tmp
    lint_run '.files |= map(if .repoPath == "dotfiles/linux/claude/CLAUDE.md" then .repoPath = "dotfiles/x/CLAUDE.md" else . end)'

    (( rc == 1 )) || fail "check-config.sh exited $rc, want 1"
    grep -Fqx 'dotfiles/x/CLAUDE.md' "$out" || fail "output does not name the new repoPath"
}

case_lint_dir_with_rules() {
    new_tmp
    lint_run '.files += [{"repoPath": "dotfiles/linux/d", "localPath": "~/d", "platform": "linux", "type": "dir", "sanitizeRules": []}]'

    (( rc == 1 )) || fail "check-config.sh exited $rc, want 1"
    grep -Fqx 'dotfiles/linux/d' "$out" || fail "output does not name the dir entry"
}

case_lint_file_in_dir() {
    new_tmp
    lint_run '.files += [{"repoPath": "dotfiles/linux/d", "localPath": "~/d", "platform": "linux", "type": "dir"},
                         {"repoPath": "dotfiles/linux/d/x.txt", "localPath": "~/d/x.txt", "platform": "linux"}]'

    (( rc == 1 )) || fail "check-config.sh exited $rc, want 1"
    grep -Fqx 'dotfiles/linux/d/x.txt' "$out" || fail "output does not name the file entry"
}

case_lint_typed_file_in_dir() {
    new_tmp
    lint_run '.files += [{"repoPath": "dotfiles/linux/d", "localPath": "~/d", "platform": "linux", "type": "dir"},
                         {"repoPath": "dotfiles/linux/d/x.txt", "localPath": "~/d/x.txt", "platform": "linux", "type": "file"}]'

    (( rc == 1 )) || fail "check-config.sh exited $rc, want 1"
    grep -Fqx 'dotfiles/linux/d/x.txt' "$out" || fail "output does not name the file entry"
}

case_lint_dir_in_dir() {
    new_tmp
    lint_run '.files += [{"repoPath": "dotfiles/linux/d", "localPath": "~/d", "platform": "linux", "type": "dir"},
                         {"repoPath": "dotfiles/linux/d/e", "localPath": "~/d/e", "platform": "linux", "type": "dir"}]'

    (( rc == 1 )) || fail "check-config.sh exited $rc, want 1"
    grep -Fqx 'dotfiles/linux/d/e' "$out" || fail "output does not name the nested dir entry"
}

case_lint_dir_trailing_slash() {
    new_tmp
    lint_run '.files += [{"repoPath": "dotfiles/linux/d/", "localPath": "~/d", "platform": "linux", "type": "dir"},
                         {"repoPath": "dotfiles/linux/d/x.txt", "localPath": "~/d/x.txt", "platform": "linux"}]'

    (( rc == 1 )) || fail "check-config.sh exited $rc, want 1"
    grep -Fqx 'dotfiles/linux/d/x.txt' "$out" || fail "output does not name the file entry"
}

case_lint_sibling_prefix() {
    new_tmp
    lint_run '.files += [{"repoPath": "dotfiles/linux/d", "localPath": "~/d", "platform": "linux", "type": "dir"},
                         {"repoPath": "dotfiles/linux/d-old/x.txt", "localPath": "~/d-old/x.txt", "platform": "linux"}]'

    (( rc == 0 )) || fail "check-config.sh exited $rc, want 0"
    if grep -Fq 'd-old' "$out"; then fail "output names the sibling entry"; fi
}

case_lint_windows_root() {
    new_tmp
    lint_run '.files |= map(if .repoPath == "dotfiles/windows/shell/.bashrc" then .repoPath = "dotfiles/.bashrc" else . end)'

    (( rc == 1 )) || fail "check-config.sh exited $rc, want 1"
    grep -Fqx 'dotfiles/.bashrc' "$out" || fail "output does not name the new repoPath"
}

case_lint_windows_sibling() {
    new_tmp
    lint_run '.files |= map(if .repoPath == "dotfiles/windows/shell/.bashrc" then .repoPath = "dotfiles/windows-old/.bashrc" else . end)'

    (( rc == 1 )) || fail "check-config.sh exited $rc, want 1"
    grep -Fqx 'dotfiles/windows-old/.bashrc' "$out" || fail "output does not name the new repoPath"
}

case_lint_windows_linux_prefix() {
    new_tmp
    lint_run '.files |= map(if .repoPath == "dotfiles/windows/shell/.bashrc" then .repoPath = "dotfiles/linux/.bashrc" else . end)'

    (( rc == 1 )) || fail "check-config.sh exited $rc, want 1"
    grep -Fqx 'dotfiles/linux/.bashrc' "$out" || fail "output does not name the new repoPath"
}

case_lint_windows_ok() {
    new_tmp
    lint_run '.'

    (( rc == 0 )) || fail "check-config.sh exited $rc, want 0"
}

# The hash and commit fields of the valid packages fixture: invented values
# only, so no real address or home path reaches a test.
PACKAGES_HASH=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
PACKAGES_COMMIT=0123456789abcdef0123456789abcdef01234567

# A valid packages folder under $t/packages: one line per list, one apt source
# and the key it names.
lint_packages_valid() {
    new_tmp
    mkdir -p "$t/packages/apt-sources/keyrings"
    printf 'foo\n' > "$t/packages/apt.txt"
    printf 'bar https://example.com/bar_1.0.deb %s\n' "$PACKAGES_HASH" > "$t/packages/deb.txt"
    printf 'baz\n' > "$t/packages/snap.txt"
    printf 'qux\n' > "$t/packages/npm.txt"
    printf 'quux\n' > "$t/packages/pipx.txt"
    printf 'pub.name\n' > "$t/packages/vscode-extensions.txt"
    printf 'Font v1.2.3 %s\n' "$PACKAGES_HASH" > "$t/packages/fonts.txt"
    printf 'uuid@example https://github.com/owner/repo %s\n' "$PACKAGES_COMMIT" \
        > "$t/packages/gnome-extensions.txt"
    printf 'apt ignored-one\n' > "$t/packages/drift-ignore.txt"
    printf 'Types: deb\nURIs: https://example.com/repo\nSuites: stable\nComponents: main\nSigned-By: /usr/share/keyrings/example.gpg\n' \
        > "$t/packages/apt-sources/example.sources"
    printf 'placeholder key\n' > "$t/packages/apt-sources/keyrings/example.gpg"
}

# Run the packages lint on one directory; rc and $out hold the result.
lint_packages_check() {
    rc=0
    "$REPO/scripts/ci/check-packages.sh" "$1" > "$out" 2>&1 || rc=$?
}

# Build the valid folder, apply a change inside it (a shell snippet run from
# the folder), and run the lint.
lint_packages_run() {
    local change=${1:-:}
    lint_packages_valid
    (cd "$t/packages" && eval "$change")
    lint_packages_check "$t/packages"
}

lint_should_pass() {
    (( rc == 0 )) || fail "check-packages.sh exited $rc, want 0"
    grep -Fqx "$t/packages: OK" "$out" || fail "missing '<dir>: OK' line"
}

lint_should_fail() {
    (( rc == 1 )) || fail "check-packages.sh exited $rc, want 1"
    grep -Fqx "$t/packages: invalid entries above" "$out" \
        || fail "missing '<dir>: invalid entries above' line"
    local want
    for want in "$@"; do
        grep -Fq -- "$want" "$out" || fail "output does not contain '$want'"
    done
}

case_lint_packages_ok() {
    lint_packages_run
    lint_should_pass
}

case_lint_packages_empty_dir() {
    new_tmp
    mkdir -p "$t/packages"
    lint_packages_check "$t/packages"
    lint_should_pass
}

case_lint_packages_no_dir() {
    new_tmp
    lint_packages_check "$t/packages"
    (( rc == 2 )) || fail "check-packages.sh exited $rc, want 2"
    grep -Fq "ERROR: no such directory: $t/packages" "$out" \
        || fail "missing the missing-directory error"
}

case_lint_packages_comments() {
    lint_packages_run "printf 'foo\n# aaa\n\nzzz\n' > apt.txt"
    lint_should_pass
}

case_lint_packages_apt_shell() {
    lint_packages_run "printf 'foo;rm\n' >> apt.txt"
    lint_should_fail 'apt.txt:2:'
}

case_lint_packages_apt_upper() {
    lint_packages_run "printf 'Foo\n' >> apt.txt"
    lint_should_fail 'apt.txt:2:'
}

case_lint_packages_apt_two_fields() {
    lint_packages_run "printf 'foo bar\n' >> apt.txt"
    lint_should_fail 'apt.txt:2:'
}

case_lint_packages_unsorted() {
    lint_packages_run "printf 'b\na\n' > apt.txt"
    lint_should_fail 'not sorted'
}

case_lint_packages_duplicate() {
    lint_packages_run "printf 'a\na\n' > apt.txt"
    lint_should_fail 'duplicate'
}

case_lint_packages_deb_http() {
    lint_packages_run "printf 'bar http://example.com/bar_1.0.deb $PACKAGES_HASH\n' > deb.txt"
    lint_should_fail 'deb.txt:1:'
}

case_lint_packages_deb_no_hash() {
    lint_packages_run "printf 'bar https://example.com/bar_1.0.deb\n' > deb.txt"
    lint_should_fail 'deb.txt:1:'
}

case_lint_packages_deb_short_hash() {
    lint_packages_run "printf 'bar https://example.com/bar_1.0.deb ${PACKAGES_HASH:0:63}\n' > deb.txt"
    lint_should_fail 'deb.txt:1:'
}

case_lint_packages_deb_subshell() {
    lint_packages_run "printf 'bar https://example.com/\$(x).deb $PACKAGES_HASH\n' > deb.txt"
    lint_should_fail 'deb.txt:1:'
}

case_lint_packages_tools_ok() {
    lint_packages_run "printf 'bun https://github.com/a/b/c.zip %s\nrtk https://raw.githubusercontent.com/a/b/c.sh %s\n' $PACKAGES_HASH $PACKAGES_HASH > tools.txt"
    lint_should_pass
}

case_lint_packages_tools_unknown() {
    lint_packages_run "printf 'make https://github.com/a/b/c.zip %s\n' $PACKAGES_HASH > tools.txt"
    lint_should_fail 'tools.txt:1:'
}

case_lint_packages_tools_http() {
    lint_packages_run "printf 'rtk http://github.com/a/b/c.zip %s\n' $PACKAGES_HASH > tools.txt"
    lint_should_fail 'tools.txt:1:'
}

case_lint_packages_tools_host() {
    lint_packages_run "printf 'rtk https://example.com/c.zip %s\n' $PACKAGES_HASH > tools.txt"
    lint_should_fail 'tools.txt:1:'
}

case_lint_packages_tools_short_hash() {
    lint_packages_run "printf 'rtk https://github.com/a/b/c.zip %s\n' ${PACKAGES_HASH:0:63} > tools.txt"
    lint_should_fail 'tools.txt:1:'
}

case_lint_packages_tools_unsorted() {
    lint_packages_run "printf 'rtk https://github.com/a/b/c.zip %s\nbun https://github.com/a/b/c.zip %s\n' $PACKAGES_HASH $PACKAGES_HASH > tools.txt"
    lint_should_fail 'not sorted'
}

case_lint_packages_snap_options() {
    lint_packages_run "printf 'a classic channel=v1/stable\n' > snap.txt"
    lint_should_pass
}

case_lint_packages_snap_order() {
    lint_packages_run "printf 'a channel=v1/stable classic\n' > snap.txt"
    lint_should_fail 'snap.txt:1:'
}

case_lint_packages_npm_scoped() {
    lint_packages_run "printf '@scope/name\n' > npm.txt"
    lint_should_pass
}

case_lint_packages_snap_flag() {
    lint_packages_run "printf -- '--dangerous\n' > snap.txt"
    lint_should_fail 'snap.txt:1:'
}

case_lint_packages_npm_flag() {
    lint_packages_run "printf -- '--ignore-scripts\n' > npm.txt"
    lint_should_fail 'npm.txt:1:'
}

case_lint_packages_npm_scope_flag() {
    lint_packages_run "printf -- '@-x/name\n' > npm.txt"
    lint_should_fail 'npm.txt:1:'
}

case_lint_packages_npm_path() {
    lint_packages_run "printf '..\n' > npm.txt"
    lint_should_fail 'npm.txt:1:'
}

case_lint_packages_pipx_flag() {
    lint_packages_run "printf -- '--pip-args\n' > pipx.txt"
    lint_should_fail 'pipx.txt:1:'
}

case_lint_packages_pipx_path() {
    lint_packages_run "printf '.\n' > pipx.txt"
    lint_should_fail 'pipx.txt:1:'
}

case_lint_packages_vscode_flag() {
    lint_packages_run "printf -- '--a.b\n' > vscode-extensions.txt"
    lint_should_fail 'vscode-extensions.txt:1:'
}

case_lint_packages_extension_flag() {
    lint_packages_run "printf -- '-uuid@example https://github.com/owner/repo $PACKAGES_COMMIT\n' > gnome-extensions.txt"
    lint_should_fail 'gnome-extensions.txt:1:'
}

case_lint_packages_extension_repo_path() {
    lint_packages_run "printf 'uuid@example https://github.com/owner/.. $PACKAGES_COMMIT\n' > gnome-extensions.txt"
    lint_should_fail 'gnome-extensions.txt:1:'
}

case_lint_packages_vscode_upper() {
    lint_packages_run "printf 'Pub.Name\n' > vscode-extensions.txt"
    lint_should_fail 'vscode-extensions.txt:1:'
}

case_lint_packages_font_no_tag() {
    lint_packages_run "printf 'Name abc\n' > fonts.txt"
    lint_should_fail 'fonts.txt:1:'
}

case_lint_packages_extension_other_host() {
    lint_packages_run "printf 'uuid@example https://example.com/a/b $PACKAGES_COMMIT\n' > gnome-extensions.txt"
    lint_should_fail 'gnome-extensions.txt:1:'
}

case_lint_packages_extension_branch() {
    lint_packages_run "printf 'uuid@example https://github.com/owner/repo main\n' > gnome-extensions.txt"
    lint_should_fail 'gnome-extensions.txt:1:'
}

case_lint_packages_ignore_manager() {
    lint_packages_run "printf 'brew x\n' > drift-ignore.txt"
    lint_should_fail 'drift-ignore.txt:1:'
}

case_lint_packages_unknown_file() {
    lint_packages_run "printf 'x\n' > extra.txt"
    lint_should_fail 'extra.txt:1: unknown list'
}

case_lint_packages_apt_and_deb() {
    lint_packages_run "printf 'foo https://example.com/foo_1.0.deb $PACKAGES_HASH\n' > deb.txt"
    lint_should_fail 'deb.txt:1:' 'foo is also in apt.txt'
}

case_lint_packages_listed_and_ignored() {
    lint_packages_run "printf 'apt foo\n' > drift-ignore.txt"
    lint_should_fail 'apt.txt:1:' 'foo is ignored'
}

case_lint_packages_same_name_other_manager() {
    lint_packages_run "printf 'snap foo\n' > drift-ignore.txt"
    lint_should_pass
}

case_lint_packages_source_http() {
    lint_packages_run "printf 'Types: deb\nURIs: http://example.com/repo\nSuites: stable\nComponents: main\nSigned-By: /usr/share/keyrings/example.gpg\n' > apt-sources/example.sources"
    lint_should_fail 'example.sources'
}

case_lint_packages_list_http() {
    lint_packages_run "rm apt-sources/example.sources; printf 'deb [signed-by=/usr/share/keyrings/example.gpg] http://example.com/stable stable main\n' > apt-sources/example.list"
    lint_should_fail 'example.list'
}

case_lint_packages_source_unsigned() {
    lint_packages_run "printf 'Types: deb\nURIs: https://example.com/repo\nSuites: stable\nComponents: main\n' > apt-sources/example.sources"
    lint_should_fail 'example.sources'
}

case_lint_packages_source_key_missing() {
    lint_packages_run "printf 'Types: deb\nURIs: https://example.com/repo\nSuites: stable\nComponents: main\nSigned-By: /usr/share/keyrings/missing.gpg\n' > apt-sources/example.sources"
    lint_should_fail 'example.sources'
}

case_lint_packages_source_key_elsewhere() {
    lint_packages_run "printf 'Types: deb\nURIs: https://example.com/repo\nSuites: stable\nComponents: main\nSigned-By: /tmp/k.gpg\n' > apt-sources/example.sources"
    lint_should_fail 'example.sources'
}

case_lint_packages_key_unused() {
    lint_packages_run "printf 'unused\n' > apt-sources/keyrings/unused.gpg"
    lint_should_fail 'unused.gpg'
}

case_lint_packages_source_other_file() {
    lint_packages_run "printf 'notes\n' > apt-sources/notes.md"
    lint_should_fail 'apt-sources/notes.md:1: unknown list'
}

case_lint_packages_source_real_shapes() {
    lint_packages_run "printf '# leading one\n# leading two\nTypes: deb\nURIs: https://example.com/repo\nSuites: stable\nComponents: main\nX-Repolib-Name: Example\nArchitectures: amd64 arm64\n# between fields\nSigned-By: /usr/share/keyrings/example.gpg\n' > apt-sources/example.sources; printf 'deb [arch=amd64 signed-by=/etc/apt/keyrings/example.gpg] https://example.com/packages stable main\ndeb [signed-by=/usr/share/keyrings/example.gpg] https://example.com/r/ * *\n' > apt-sources/example.list"
    lint_should_pass
}

case_lint_packages_source_uris_lowercase() {
    lint_packages_run "printf 'Types: deb\nuris: http://example.com/repo\nSuites: stable\nComponents: main\nSigned-By: /usr/share/keyrings/example.gpg\n' > apt-sources/example.sources"
    lint_should_fail 'example.sources'
}

case_lint_packages_source_uri_continuation() {
    lint_packages_run "printf 'Types: deb\nURIs: https://example.com/repo\n http://example.com/other\nSuites: stable\nComponents: main\nSigned-By: /usr/share/keyrings/example.gpg\n' > apt-sources/example.sources"
    lint_should_fail 'example.sources'
}

case_lint_packages_source_second_stanza() {
    lint_packages_run "printf 'Types: deb\nURIs: https://example.com/repo\nSuites: stable\nComponents: main\nSigned-By: /usr/share/keyrings/example.gpg\n\nTypes: deb\nURIs: https://example.com/other\nSuites: stable\nComponents: main\n' > apt-sources/example.sources"
    lint_should_fail 'example.sources'
}

case_lint_packages_source_trusted() {
    lint_packages_run "printf 'Types: deb\nURIs: https://example.com/repo\nSuites: stable\nComponents: main\nTrusted: yes\nSigned-By: /usr/share/keyrings/example.gpg\n' > apt-sources/example.sources"
    lint_should_fail 'example.sources'
}

case_lint_packages_source_key_dotdot() {
    lint_packages_run "printf 'Types: deb\nURIs: https://example.com/repo\nSuites: stable\nComponents: main\nSigned-By: /usr/share/keyrings/../../tmp/example.gpg\n' > apt-sources/example.sources"
    lint_should_fail 'example.sources'
}

case_lint_packages_source_key_empty() {
    lint_packages_run "printf 'Types: deb\nURIs: https://example.com/repo\nSuites: stable\nComponents: main\nSigned-By: /usr/share/keyrings/\n' > apt-sources/example.sources"
    lint_should_fail 'example.sources'
    if grep -q 'bad array subscript' "$out"; then
        fail "output contains 'bad array subscript'"
    fi
}

case_lint_packages_list_second_line() {
    lint_packages_run "rm apt-sources/example.sources; printf 'deb [signed-by=/usr/share/keyrings/example.gpg] https://example.com/stable stable main\ndeb https://example.com/other other main\n' > apt-sources/example.list"
    lint_should_fail 'example.list'
}

case_lint_packages_list_deb_src_http() {
    lint_packages_run "rm apt-sources/example.sources; printf 'deb-src [signed-by=/usr/share/keyrings/example.gpg] http://example.com/stable stable main\n' > apt-sources/example.list"
    lint_should_fail 'example.list'
}

case_lint_packages_list_trusted() {
    lint_packages_run "rm apt-sources/example.sources; printf 'deb [trusted=yes signed-by=/usr/share/keyrings/example.gpg] https://example.com/stable stable main\n' > apt-sources/example.list"
    lint_should_fail 'example.list'
}

case_lint_packages_list_other_line() {
    lint_packages_run "rm apt-sources/example.sources; printf 'deb [signed-by=/usr/share/keyrings/example.gpg] https://example.com/stable stable main\nfoo bar\n' > apt-sources/example.list"
    lint_should_fail 'example.list'
}

case_lint_packages_symlink() {
    lint_packages_run "ln -s nowhere extra.txt"
    lint_should_fail 'extra.txt' 'symlink'
}

case_lint_packages_other_dir() {
    lint_packages_run "mkdir -p other; printf 'x\n' > other/n.txt"
    lint_should_fail 'other' 'unknown list'
}

case_lint_packages_key_deep() {
    lint_packages_run "mkdir -p apt-sources/keyrings/sub; printf 'x\n' > apt-sources/keyrings/sub/n.gpg"
    lint_should_fail 'apt-sources/keyrings/sub/n.gpg' 'unknown list'
}

case_lint_packages_source_key_continuation() {
    lint_packages_run "printf 'Types: deb\nURIs: https://example.com/repo\nSuites: stable\nComponents: main\nSigned-By: /usr/share/keyrings/example.gpg\n /tmp/other.gpg\n' > apt-sources/example.sources"
    lint_should_fail 'example.sources'
}

case_lint_packages_source_allow_insecure() {
    lint_packages_run "printf 'Types: deb\nURIs: https://example.com/repo\nSuites: stable\nComponents: main\nAllow-Insecure: yes\nSigned-By: /usr/share/keyrings/example.gpg\n' > apt-sources/example.sources"
    lint_should_fail 'example.sources'
}

case_lint_packages_source_field_space() {
    lint_packages_run "printf 'Types: deb\nURIs : http://example.com/repo\nSuites: stable\nComponents: main\nSigned-By: /usr/share/keyrings/example.gpg\n' > apt-sources/example.sources"
    lint_should_fail 'example.sources'
}

case_lint_packages_list_allow_insecure() {
    lint_packages_run "rm apt-sources/example.sources; printf 'deb [Allow-Insecure=yes signed-by=/usr/share/keyrings/example.gpg] https://example.com/stable stable main\n' > apt-sources/example.list"
    lint_should_fail 'example.list'
}

# A valid plugin settings file under $t/settings.json: one marketplace and one
# enabled plugin that names it.
lint_plugins_valid() {
    new_tmp
    settings=$t/settings.json
    jq -n '{
        enabledPlugins: {"plugin-a@market-a": true},
        extraKnownMarketplaces: {"market-a": {source: {source: "github", repo: "owner/repo"}}}
    }' > "$settings"
}

# Run the plugin lint on one settings file; rc and $out hold the result.
lint_plugins_check() {
    rc=0
    "$REPO/scripts/ci/check-plugins.sh" "$1" > "$out" 2>&1 || rc=$?
}

# Build the valid settings file, apply a jq change, and run the lint.
lint_plugins_run() {
    local change=${1:-.}
    lint_plugins_valid
    jq "$change" "$settings" > "$settings.tmp"
    mv "$settings.tmp" "$settings"
    lint_plugins_check "$settings"
}

lint_plugins_should_pass() {
    (( rc == 0 )) || fail "check-plugins.sh exited $rc, want 0"
    grep -Fqx "$settings: OK" "$out" || fail "missing '<file>: OK' line"
}

lint_plugins_should_fail() {
    (( rc == 1 )) || fail "check-plugins.sh exited $rc, want 1"
    grep -Fqx "$settings: invalid entries above" "$out" \
        || fail "missing '<file>: invalid entries above' line"
    local want
    for want in "$@"; do
        grep -Fq -- "$want" "$out" || fail "output does not contain '$want'"
    done
}

case_lint_plugins_ok() {
    lint_plugins_run
    lint_plugins_should_pass
}

case_lint_plugins_undeclared() {
    lint_plugins_run '.enabledPlugins = {"x@nowhere": true}'
    lint_plugins_should_fail 'x@nowhere'
}

case_lint_plugins_no_at() {
    lint_plugins_run '.enabledPlugins = {"x": true}'
    lint_plugins_should_fail 'enabledPlugins "x"'
}

case_lint_plugins_url_source() {
    lint_plugins_run '.extraKnownMarketplaces["market-a"].source.source = "url"'
    lint_plugins_should_fail 'source.source is "url"'
}

case_lint_plugins_bad_repo() {
    lint_plugins_run '.extraKnownMarketplaces["market-a"].source.repo = "a/b;rm"'
    lint_plugins_should_fail 'a/b;rm'
}

case_lint_plugins_bad_ref() {
    lint_plugins_run '.extraKnownMarketplaces["market-a"].source.ref = "-x"'
    lint_plugins_should_fail '"-x"'
}

case_lint_plugins_placeholder() {
    lint_plugins_run '.extraKnownMarketplaces["market-a"].source.repo = "<YOUR_GH_USERNAME>/sigil"'
    lint_plugins_should_pass
}

case_lint_plugins_newline() {
    lint_plugins_run '.extraKnownMarketplaces["market-a"].source.repo = "a/b\n"'
    lint_plugins_should_fail 'market-a'
}

case_lint_plugins_missing() {
    new_tmp
    lint_plugins_check "$t/nope.json"
    (( rc == 2 )) || fail "check-plugins.sh exited $rc, want 2"
    grep -Fq "ERROR: no such file: $t/nope.json" "$out" \
        || fail "missing the missing-file error"
}

case_lint_real_plugins() {
    new_tmp

    rc=0
    (cd "$REPO" && scripts/ci/check-plugins.sh) > "$out" 2>&1 || rc=$?
    (( rc == 0 )) || fail "check-plugins.sh exited $rc, want 0"
    grep -Fqx 'dotfiles/linux/claude/settings.json: OK' "$out" \
        || fail "missing 'dotfiles/linux/claude/settings.json: OK' line"
}

case_path_dotted_name() {
    new_tmp
    setup_repo
    mkdir -p "$t/repo/dotfiles" "$t/home/.config/fixture"
    add_entry '{"repoPath": "dotfiles/linux/foo..bar.txt", "localPath": "~/.config/fixture/foo..bar.txt", "platform": "linux", "description": "dotted name"}'
    printf 'dotted\n' > "$t/home/.config/fixture/foo..bar.txt"

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status ADDED dotfiles/linux/foo..bar.txt || fail "missing ADDED line for foo..bar.txt"
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

case_sanitized_large_file() {
    new_tmp
    setup_repo
    mkdir -p "$t/repo/dotfiles/linux" "$t/home/.config/fixture"

    # 128 KB of x lines: the old extglob trim took minutes on files this size.
    local xline body i
    printf -v xline '%128s' ''
    xline=${xline// /x}
    body=$t/body
    for ((i = 0; i < 1024; i++)); do printf '%s\n' "$xline"; done > "$body"

    # Local and repo differ only by the sanitized value and the local trailing
    # blank lines, which normalization ignores, so the export must be UNCHANGED.
    { printf 'name = <NAME>\n'; cat "$body"; } > "$t/repo/dotfiles/linux/named.conf"
    { printf 'name = Fixture User\n'; cat "$body"; printf '\n\n'; } > "$t/home/.config/fixture/named.conf"

    rc=0
    (cd "$t/repo" && HOME="$t/home" timeout 20 ./export.sh < /dev/null) > "$out" 2>&1 || rc=$?
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status UNCHANGED dotfiles/linux/named.conf \
        || fail "missing UNCHANGED line for the large named.conf"
}

case_sanitized_case_change() {
    new_tmp
    setup_repo
    mkdir -p "$t/repo/dotfiles/linux" "$t/home/.config/fixture"

    # The lines differ only by case, and the sanitized form of the local file is
    # itself, so only a case-sensitive compare sees a change.
    printf 'editor = vim\n' > "$t/repo/dotfiles/linux/named.conf"
    printf 'EDITOR = VIM\n' > "$t/home/.config/fixture/named.conf"

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status MODIFIED dotfiles/linux/named.conf sanitized \
        || fail "missing MODIFIED (sanitized) line for named.conf"
    printf 'EDITOR = VIM\n' > "$t/expected"
    cmp -s "$t/expected" "$t/repo/dotfiles/linux/named.conf" \
        || fail "repo named.conf does not hold the local text"
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

case_infer_skips_unhydrated_local() {
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture
    jq 'del(."<NAME>")' "$t/repo/.user-values.json" > "$t/repo/.user-values.json.tmp"
    mv "$t/repo/.user-values.json.tmp" "$t/repo/.user-values.json"
    rm "$t/home/.config/fixture/shared.conf"
    printf 'name = <NAME>\n' > "$t/home/.config/fixture/named.conf"

    # The local line still holds the placeholder, so there is nothing to infer.
    run_engine "$t/home" import.sh
    (( rc == 1 )) || fail "import.sh exited $rc, want 1"
    grep -Fq 'missing value for <NAME>: add it to .user-values.json' "$out" \
        || fail "missing message for an unfilled <NAME>"
}

case_infer_overlapping_context() {
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture
    jq 'del(."<NAME>")' "$t/repo/.user-values.json" > "$t/repo/.user-values.json.tmp"
    mv "$t/repo/.user-values.json.tmp" "$t/repo/.user-values.json"
    rm "$t/home/.config/fixture/shared.conf"
    printf 'abc<NAME>cba\n' > "$t/repo/dotfiles/linux/named.conf"
    printf 'abcba\n' > "$t/home/.config/fixture/named.conf"

    # The local text is shorter than prefix + suffix; it must not infer "b".
    run_engine "$t/home" import.sh
    (( rc == 1 )) || fail "import.sh exited $rc, want 1"
    grep -Fq 'missing value for <NAME>: add it to .user-values.json' "$out" \
        || fail "missing message for an unfilled <NAME>"
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

case_dir_symlink_removed() {
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture
    rm "$t/home/.config/fixture/dir/c.txt"
    ln -s a/b.txt "$t/home/.config/fixture/dir/c.txt"

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    output_has_status REMOVED dotfiles/common/dir/c.txt 'no longer in source' \
        || fail "missing REMOVED line for dir/c.txt"
    [[ ! -e "$t/repo/dotfiles/common/dir/c.txt" ]] || fail "repo dir/c.txt still exists"
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

case_excluded_credentials() {
    new_tmp
    setup_repo
    # Tests copy the fixture config; use the repo's real exclude patterns so this
    # case covers the shipped list.
    jq --argjson patterns "$(jq '.excludePatterns' "$REPO/sync-config.json")" \
        '.excludePatterns = $patterns
         | .files += [{"repoPath": "dotfiles/common/creds", "localPath": "~/.config/fixture/creds", "platform": "common", "type": "dir", "description": "excluded credentials fixture"}]' \
        "$t/repo/sync-config.json" > "$t/repo/sync-config.json.tmp"
    mv "$t/repo/sync-config.json.tmp" "$t/repo/sync-config.json"
    mkdir -p "$t/repo/dotfiles" "$t/home/.config/fixture/creds"

    local f
    local -a names=(.git-credentials .netrc .npmrc .pgpass hosts.yml auth.json secrets.yaml token app.env id_dsa)
    for f in "${names[@]}"; do
        printf 'secret\n' > "$t/home/.config/fixture/creds/$f"
    done
    printf 'ordinary\n' > "$t/home/.config/fixture/creds/ordinary.txt"

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    for f in "${names[@]}"; do
        output_has_status SKIPPED "dotfiles/common/creds/$f" 'matches exclude pattern' \
            || fail "missing SKIPPED (exclude) line for $f"
        [[ ! -e "$t/repo/dotfiles/common/creds/$f" ]] || fail "$f was copied to the repo"
    done
    output_has_status ADDED dotfiles/common/creds/ordinary.txt \
        || fail "missing ADDED line for ordinary.txt"
    cmp -s "$t/home/.config/fixture/creds/ordinary.txt" "$t/repo/dotfiles/common/creds/ordinary.txt" \
        || fail "ordinary.txt differs from the local file"
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

case_dir_export_empty_keeps_repo() {
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture
    rm -rf "$t/home/.config/fixture/dir"/*
    [[ -z $(find "$t/home/.config/fixture/dir" -mindepth 1) ]] || fail "local dir/ is not empty"

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    output_has_status SKIPPED 'dotfiles/common/dir/' 'local folder is empty; repo files kept' \
        || fail "missing SKIPPED (empty folder) line for the dir entry"
    if grep -Fq 'REMOVED' "$out"; then
        fail "output has a REMOVED line for an empty local folder"
    fi
    cmp -s "$FIXTURES/repo/dotfiles/common/dir/a/b.txt" "$t/repo/dotfiles/common/dir/a/b.txt" \
        || fail "dotfiles/common/dir/a/b.txt differs from fixture"
    cmp -s "$FIXTURES/repo/dotfiles/common/dir/c.txt" "$t/repo/dotfiles/common/dir/c.txt" \
        || fail "dotfiles/common/dir/c.txt differs from fixture"
}

case_dir_export_only_excluded() {
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture
    rm -rf "$t/home/.config/fixture/dir"/*
    printf 'x\n' > "$t/home/.config/fixture/dir/x.secret"

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    output_has_status SKIPPED dotfiles/common/dir/x.secret 'matches exclude pattern' \
        || fail "missing SKIPPED (exclude) line for dir/x.secret"
    output_has_status SKIPPED 'dotfiles/common/dir/' 'local folder is empty; repo files kept' \
        || fail "missing SKIPPED (empty folder) line for the dir entry"
    if grep -Fq 'REMOVED' "$out"; then
        fail "output has a REMOVED line for a folder holding only excluded files"
    fi
    cmp -s "$FIXTURES/repo/dotfiles/common/dir/a/b.txt" "$t/repo/dotfiles/common/dir/a/b.txt" \
        || fail "dotfiles/common/dir/a/b.txt differs from fixture"
    cmp -s "$FIXTURES/repo/dotfiles/common/dir/c.txt" "$t/repo/dotfiles/common/dir/c.txt" \
        || fail "dotfiles/common/dir/c.txt differs from fixture"
}

case_dir_export_only_symlink() {
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture
    rm -rf "$t/home/.config/fixture/dir"/*
    ln -s c.txt "$t/home/.config/fixture/dir/link.txt"

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    output_has_status SKIPPED dotfiles/common/dir/link.txt symlink \
        || fail "missing SKIPPED (symlink) line for dir/link.txt"
    output_has_status SKIPPED 'dotfiles/common/dir/' 'local folder is empty; repo files kept' \
        || fail "missing SKIPPED (empty folder) line for the dir entry"
    if grep -Fq 'REMOVED' "$out"; then
        fail "output has a REMOVED line for a folder holding only a symlink"
    fi
    cmp -s "$FIXTURES/repo/dotfiles/common/dir/a/b.txt" "$t/repo/dotfiles/common/dir/a/b.txt" \
        || fail "dotfiles/common/dir/a/b.txt differs from fixture"
    cmp -s "$FIXTURES/repo/dotfiles/common/dir/c.txt" "$t/repo/dotfiles/common/dir/c.txt" \
        || fail "dotfiles/common/dir/c.txt differs from fixture"
}

case_dir_export_one_left() {
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture
    rm "$t/home/.config/fixture/dir/a/b.txt"

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    output_has_status REMOVED dotfiles/common/dir/a/b.txt 'no longer in source' \
        || fail "missing REMOVED line for dir/a/b.txt"
    [[ ! -e "$t/repo/dotfiles/common/dir/a/b.txt" ]] || fail "repo dir/a/b.txt still exists"
    output_has_status UNCHANGED dotfiles/common/dir/c.txt || fail "missing UNCHANGED line for dir/c.txt"
    cmp -s "$FIXTURES/repo/dotfiles/common/dir/c.txt" "$t/repo/dotfiles/common/dir/c.txt" \
        || fail "dotfiles/common/dir/c.txt differs from fixture"
}

case_dir_export_empty_both() {
    new_tmp
    setup_repo
    mkdir -p "$t/repo/dotfiles"
    setup_home_fixture
    rm -rf "$t/home/.config/fixture/dir"/*

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    if output_has_status SKIPPED 'dotfiles/common/dir/' 'local folder is empty; repo files kept'; then
        fail "printed a SKIPPED line for a folder empty on both sides"
    fi
    if grep -Fq 'REMOVED' "$out"; then
        fail "output has a REMOVED line with no repo folder"
    fi
    [[ ! -e "$t/repo/dotfiles/common/dir" ]] || fail "repo dir/ was created"
}

case_dir_root_symlink() {
    new_tmp
    setup_repo
    setup_repo_fixture
    rm -rf "$t/repo/dotfiles/common/dir"
    setup_home_fixture
    mv "$t/home/.config/fixture/dir" "$t/home/real-dir"
    ln -s "$t/home/real-dir" "$t/home/.config/fixture/dir"

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    output_has_status ADDED dotfiles/common/dir/a/b.txt || fail "missing ADDED line for dir/a/b.txt"
    output_has_status ADDED dotfiles/common/dir/c.txt || fail "missing ADDED line for dir/c.txt"
    if grep -Fq '(symlink)' "$out"; then
        fail "output has a (symlink) line for the symlinked folder root"
    fi
    cmp -s "$FIXTURES/home/.config/fixture/dir/a/b.txt" "$t/repo/dotfiles/common/dir/a/b.txt" \
        || fail "dotfiles/common/dir/a/b.txt differs from fixture"
    cmp -s "$FIXTURES/home/.config/fixture/dir/c.txt" "$t/repo/dotfiles/common/dir/c.txt" \
        || fail "dotfiles/common/dir/c.txt differs from fixture"

    run_engine "$t/home" import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    output_has_status UNCHANGED dotfiles/common/dir/c.txt || fail "missing UNCHANGED line for dir/c.txt"
    if grep -qE '^  EXTRA[[:space:]]' "$out"; then
        fail "import printed an EXTRA line for the symlinked folder root"
    fi
}

case_dir_import_creates() {
    new_tmp
    setup_repo
    setup_repo_fixture
    mkdir -p "$t/home"

    run_engine "$t/home" import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"

    cmp -s "$FIXTURES/home/.config/fixture/dir/a/b.txt" "$t/home/.config/fixture/dir/a/b.txt" \
        || fail "dir/a/b.txt differs from fixture"
    cmp -s "$FIXTURES/home/.config/fixture/dir/c.txt" "$t/home/.config/fixture/dir/c.txt" \
        || fail "dir/c.txt differs from fixture"

    output_has_status CREATED dotfiles/common/dir/a/b.txt || fail "missing CREATED line for dir/a/b.txt"
    output_has_status CREATED dotfiles/common/dir/c.txt || fail "missing CREATED line for dir/c.txt"
}

case_dir_import_update_backup() {
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture
    printf 'c2\n' > "$t/home/.config/fixture/dir/c.txt"

    run_engine "$t/home" import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"

    output_has_status UPDATED dotfiles/common/dir/c.txt 'backup saved as c.txt.bak' \
        || fail "missing UPDATED (backup) line for dir/c.txt"
    cmp -s "$FIXTURES/home/.config/fixture/dir/c.txt" "$t/home/.config/fixture/dir/c.txt" \
        || fail "dir/c.txt does not match the fixture after update"
    printf 'c2\n' > "$t/expected.bak"
    cmp -s "$t/expected.bak" "$t/home/.config/fixture/dir/c.txt.bak" \
        || fail "dir/c.txt.bak does not contain the old content"
    if grep -qE '^  EXTRA[[:space:]]' "$out"; then
        fail "unexpected EXTRA line"
    fi
}

case_dir_import_extra() {
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture
    printf 'mine\n' > "$t/home/.config/fixture/dir/mine.txt"

    run_engine "$t/home" import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"

    output_has_status EXTRA dotfiles/common/dir/mine.txt 'not in repo; kept' \
        || fail "missing EXTRA line for dir/mine.txt"
    printf 'mine\n' > "$t/expected"
    cmp -s "$t/expected" "$t/home/.config/fixture/dir/mine.txt" \
        || fail "dir/mine.txt was deleted or changed"
}

case_dir_roundtrip_unchanged() {
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status UNCHANGED dotfiles/common/dir/a/b.txt || fail "export: missing UNCHANGED line for dir/a/b.txt"
    output_has_status UNCHANGED dotfiles/common/dir/c.txt || fail "export: missing UNCHANGED line for dir/c.txt"
    if grep -qE '^  (ADDED|MODIFIED|REMOVED)[[:space:]]+dotfiles/common/dir/' "$out"; then
        fail "export printed a changed status for a dotfiles/common/dir/ path"
    fi

    run_engine "$t/home" import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    output_has_status UNCHANGED dotfiles/common/dir/a/b.txt || fail "import: missing UNCHANGED line for dir/a/b.txt"
    output_has_status UNCHANGED dotfiles/common/dir/c.txt || fail "import: missing UNCHANGED line for dir/c.txt"
    if grep -qE '^  (CREATED|UPDATED|EXTRA)[[:space:]]+dotfiles/common/dir/' "$out"; then
        fail "import printed a changed or extra status for a dotfiles/common/dir/ path"
    fi

    [[ -z "$(find "$t/home" -name '*.bak')" ]] || fail "a .bak file was created"
}

case_dir_import_prompt_reads_stdin() {
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture
    printf 'c2\n' > "$t/home/.config/fixture/dir/c.txt"

    run_engine_input "$t/home" 'n' import.sh
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"

    # The prompt has no trailing newline, so the status line follows it on the
    # same output line; match the status text as a substring.
    grep -Fq "$(status_line SKIPPED dotfiles/common/dir/c.txt 'user skipped')" "$out" \
        || fail "missing SKIPPED (user skipped) line for dir/c.txt"
    printf 'c2\n' > "$t/expected"
    cmp -s "$t/expected" "$t/home/.config/fixture/dir/c.txt" \
        || fail "dir/c.txt was overwritten despite the 'n' answer"
    [[ ! -e "$t/home/.config/fixture/dir/c.txt.bak" ]] || fail "c.txt.bak was created"
}

case_orphan_reported() {
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture
    mkdir -p "$t/repo/dotfiles/linux"
    printf 'stray\n' > "$t/repo/dotfiles/linux/stray.txt"

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    local count
    count=$(grep -cE '^  ORPHAN[[:space:]]' "$out" || true)
    (( count == 1 )) || fail "found $count ORPHAN lines, want 1"
    output_has_status ORPHAN dotfiles/linux/stray.txt \
        'no entry in sync-config.json; git rm it or add an entry' \
        || fail "missing ORPHAN line for dotfiles/linux/stray.txt"
}

case_orphan_none() {
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    # dotfiles/windows/win.conf is owned by a windows entry, so it is not reported.
    if grep -qE '^  ORPHAN[[:space:]]' "$out"; then
        fail "unexpected ORPHAN line"
    fi
}

case_orphan_linked_ok() {
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture
    jq '.files += [{"repoPath": "dotfiles/windows/linked.sh", "localPath": "~\\linked.sh", "platform": "windows", "detectLinkedPaths": true}]' \
        "$t/repo/sync-config.json" > "$t/repo/sync-config.json.tmp"
    mv "$t/repo/sync-config.json.tmp" "$t/repo/sync-config.json"
    mkdir -p "$t/repo/dotfiles/windows/linked.sh.linked/tool"
    printf 'script\n' > "$t/repo/dotfiles/windows/linked.sh"
    printf 'tool\n' > "$t/repo/dotfiles/windows/linked.sh.linked/tool/x.bat"

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    if grep -qE '^  ORPHAN[[:space:]]' "$out"; then
        fail "unexpected ORPHAN line for a detectLinkedPaths entry"
    fi
}

case_orphan_no_dir_entries() {
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture
    jq '.files |= map(select(.type != "dir"))' "$t/repo/sync-config.json" > "$t/repo/sync-config.json.tmp"
    mv "$t/repo/sync-config.json.tmp" "$t/repo/sync-config.json"
    rm -rf "$t/repo/dotfiles/common/dir"
    printf 'stray\n' > "$t/repo/dotfiles/stray.txt"

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    output_has_status ORPHAN dotfiles/stray.txt 'no entry in sync-config.json; git rm it or add an entry' \
        || fail "missing ORPHAN line for dotfiles/stray.txt"
}

case_upstream_none() {
    # $t/repo is not a git repo, so the up-to-date check stays silent.
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    if grep -qE 'NOTE:|WARNING: repo is' "$out"; then
        fail "unexpected up-to-date message in a non-git repo"
    fi
}

case_upstream_current() {
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture
    make_git_repo

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    if grep -qE 'NOTE:|WARNING: repo is' "$out"; then
        fail "unexpected up-to-date message when origin is up to date"
    fi
}

case_upstream_behind_noninteractive() {
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture
    make_git_repo

    # A second clone pushes a commit that $t/repo does not have. The new file
    # stays outside dotfiles/, so the export itself sees unchanged fixtures.
    git clone -q "$t/origin.git" "$t/other"
    printf 'readme\n' > "$t/other/README"
    git -C "$t/other" add README
    git -C "$t/other" -c user.name=t -c user.email=t@example.com commit -q -m second
    git -C "$t/other" push -q origin master
    local head_before
    head_before=$(git -C "$t/repo" rev-parse HEAD)

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    grep -Fqx '  WARNING: repo is 1 commit(s) behind origin/master; run git pull --ff-only.' "$out" \
        || fail "missing WARNING line for a repo behind origin/master"
    output_has_status UNCHANGED dotfiles/linux/plain.txt \
        || fail "export did not run after the up-to-date check"
    [[ $(git -C "$t/repo" rev-parse HEAD) == "$head_before" ]] || fail "the export moved HEAD"
}

case_upstream_behind_pull() {
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture
    make_git_repo

    git clone -q "$t/origin.git" "$t/other"
    printf 'readme\n' > "$t/other/README"
    git -C "$t/other" add README
    git -C "$t/other" -c user.name=t -c user.email=t@example.com commit -q -m second
    git -C "$t/other" push -q origin master
    # make_git_repo pushes without -u; give master the tracking a real clone has,
    # so the engine's plain `git pull --ff-only` works.
    git -C "$t/repo" branch -q --set-upstream-to=origin/master master

    # Run on a pseudo-terminal so the pull prompt sees a real answer.
    rc=0
    printf 'y\n' | script -qec "cd $(printf %q "$t/repo") && HOME=$(printf %q "$t/home") ./export.sh" /dev/null \
        > "$out" 2>&1 || rc=$?
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    grep -Fq '  Pulled 1 commit(s); run the command again.' "$out" \
        || fail "missing Pulled line after a successful pull"
    [[ $(git -C "$t/repo" rev-parse HEAD) == "$(git -C "$t/repo" rev-parse origin/master)" ]] \
        || fail "the pull did not move HEAD to origin/master"
    if grep -q 'UNCHANGED' "$out"; then
        fail "the export ran after the pull"
    fi
}

case_upstream_unreachable() {
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture
    make_git_repo
    git -C "$t/repo" remote set-url origin "$t/missing.git"

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    grep -Fqx '  NOTE: could not reach origin; skipping the up-to-date check.' "$out" \
        || fail "missing NOTE line for an unreachable origin"
    output_has_status UNCHANGED dotfiles/linux/plain.txt \
        || fail "export did not run after the reachability check"
}

case_upstream_off_master() {
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture
    make_git_repo

    git clone -q "$t/origin.git" "$t/other"
    printf 'readme\n' > "$t/other/README"
    git -C "$t/other" add README
    git -C "$t/other" -c user.name=t -c user.email=t@example.com commit -q -m second
    git -C "$t/other" push -q origin master
    git -C "$t/repo" switch -q -c feature

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    if grep -qE 'WARNING: repo is|NOTE:' "$out"; then
        fail "up-to-date check ran on a branch other than master"
    fi
}

case_preview_writes_nothing() {
    new_tmp
    setup_preview_repo
    preview_change_default

    local repo_before home_before
    repo_before=$(tree_hash "$t/repo")
    home_before=$(tree_hash "$t/home")

    run_engine "$t/home" export.sh --preview
    (( rc == 0 )) || fail "preview exited $rc, want 0"

    [[ $(tree_hash "$t/repo") == "$repo_before" ]] || fail "repo changed during preview"
    [[ $(tree_hash "$t/home") == "$home_before" ]] || fail "home changed during preview"
    [[ -z "$(git -C "$t/repo" status --short)" ]] || fail "git status not clean after preview"

    grep -qE '^  MODIFIED[[:space:]]' "$out" || fail "missing MODIFIED line"
    grep -qE '^  ADDED[[:space:]]' "$out" || fail "missing ADDED line"
    grep -qE '^  REMOVED[[:space:]]' "$out" || fail "missing REMOVED line"
    grep -Fq 'Nothing was written.' "$out" || fail "missing 'Nothing was written.' line"
}

case_preview_shows_diff() {
    new_tmp
    setup_preview_repo
    preview_change_default

    run_engine "$t/home" export.sh --preview
    (( rc == 0 )) || fail "preview exited $rc, want 0"

    grep -Fq '+preview change' "$out" || fail "missing '+preview change' line in the diff"
    grep -Fq 'before/dotfiles/linux/plain.txt' "$out" || fail "missing before/ path in the diff"
}

case_preview_matches_export() {
    new_tmp
    setup_preview_repo
    preview_change_default

    run_engine "$t/home" export.sh --preview
    (( rc == 0 )) || fail "preview exited $rc, want 0"

    local preview_paths
    preview_paths=$(sed -nE 's/^  (MODIFIED|ADDED|REMOVED) +([^ ]+).*/\2/p' "$out" | sort -u)

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export exited $rc, want 0"

    local export_paths
    export_paths=$(git -C "$t/repo" status --short -- dotfiles | sed -E 's/^.. //' | sort -u)

    [[ "$preview_paths" == "$export_paths" ]] \
        || fail "preview changed paths ($preview_paths) != export changed paths ($export_paths)"
}

case_preview_includes_uncommitted() {
    new_tmp
    setup_preview_repo
    preview_change_default

    # Export for real but do not commit, so the change is only in the working tree.
    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export exited $rc, want 0"

    run_engine "$t/home" export.sh --preview
    (( rc == 0 )) || fail "preview exited $rc, want 0"

    grep -Fq '+preview change' "$out" || fail "uncommitted change did not appear in the preview"
}

case_preview_no_changes() {
    new_tmp
    setup_preview_repo

    run_engine "$t/home" export.sh --preview
    (( rc == 0 )) || fail "preview exited $rc, want 0"

    grep -Fq 'Nothing would be sent' "$out" || fail "missing 'Nothing would be sent' line"
}

case_preview_sanitized() {
    new_tmp
    setup_preview_repo
    printf 'name = Fixture User\n# comment\n' > "$t/home/.config/fixture/named.conf"

    run_engine "$t/home" export.sh --preview
    (( rc == 0 )) || fail "preview exited $rc, want 0"

    grep -Fq '<NAME>' "$out" || fail "output does not show the <NAME> placeholder"
    if grep -Fq 'Fixture User' "$out"; then
        fail "output leaked the actual name 'Fixture User'"
    fi
}

case_preview_leak_found() {
    new_tmp
    setup_preview_repo
    printf '/home/someone/x\n' > "$t/home/.config/fixture/plain.txt"

    run_engine "$t/home" export.sh --preview
    (( rc == 1 )) || fail "preview exited $rc, want 1"

    grep -Fq 'WARNING: the leak scan' "$out" || fail "missing leak scan WARNING line"
    if grep -Fq '/home/someone' "$out"; then
        fail "output leaked the text '/home/someone'"
    fi
}

# Extension UUIDs have the shape of an address. Only the two extension keys in
# dconf .ini files are exempt; everything else must still be reported.
case_leak_extension_enabled() {
    new_tmp
    leak_scan_on dotfiles/linux/gnome/dconf/shell.ini \
        "enabled-extensions=['clip@someone.github.io']"
    (( rc == 0 )) || fail "leak-scan exited $rc, want 0"
    [[ ! -s $out ]] || fail "leak-scan reported a hit"
}

case_leak_extension_disabled() {
    new_tmp
    leak_scan_on dotfiles/linux/gnome/dconf/shell.ini \
        "disabled-extensions=['ding@rastersoft.com']"
    (( rc == 0 )) || fail "leak-scan exited $rc, want 0"
    [[ ! -s $out ]] || fail "leak-scan reported a hit"
}

case_leak_email_other_key() {
    new_tmp
    leak_scan_on dotfiles/linux/gnome/dconf/shell.ini "label='person@gmail.com'"
    (( rc == 1 )) || fail "leak-scan exited $rc, want 1"
    grep -Fq 'email' "$out" || fail "missing email hit"
}

case_leak_email_other_file() {
    new_tmp
    leak_scan_on dotfiles/linux/tool/shell.ini "enabled-extensions=['person@gmail.com']"
    (( rc == 1 )) || fail "leak-scan exited $rc, want 1"
    grep -Fq 'email' "$out" || fail "missing email hit"
}

case_leak_email_other_suffix() {
    new_tmp
    leak_scan_on dotfiles/linux/gnome/dconf/shell.txt "enabled-extensions=['person@gmail.com']"
    (( rc == 1 )) || fail "leak-scan exited $rc, want 1"
    grep -Fq 'email' "$out" || fail "missing email hit"
}

# The key name inside another key's value doesn't make it an extension list.
case_leak_email_key_in_value() {
    new_tmp
    leak_scan_on dotfiles/linux/gnome/dconf/shell.ini "label='enabled-extensions=person@gmail.com'"
    (( rc == 1 )) || fail "leak-scan exited $rc, want 1"
    grep -Fq 'email' "$out" || fail "missing email hit"
}

# A whole, well-formed line of the extension list is not an address; an
# address anywhere else on the line, or the line in another file, still is.
case_leak_gnome_list_ok() {
    new_tmp
    leak_scan_on packages/linux/gnome-extensions.txt \
        "clip@someone.github.io https://github.com/someone/clip 0123456789abcdef0123456789abcdef01234567"
    (( rc == 0 )) || fail "leak-scan exited $rc, want 0"
    [[ ! -s $out ]] || fail "leak-scan reported a hit"
}

case_leak_gnome_list_comment() {
    new_tmp
    leak_scan_on packages/linux/gnome-extensions.txt "# ask person@gmail.com"
    (( rc == 1 )) || fail "leak-scan exited $rc, want 1"
    grep -Fq 'email' "$out" || fail "missing email hit"
}

case_leak_gnome_list_extra_field() {
    new_tmp
    leak_scan_on packages/linux/gnome-extensions.txt \
        "clip@someone.github.io https://github.com/someone/clip 0123456789abcdef0123456789abcdef01234567 person@gmail.com"
    (( rc == 1 )) || fail "leak-scan exited $rc, want 1"
    grep -Fq 'email' "$out" || fail "missing email hit"
}

case_leak_gnome_list_url_address() {
    new_tmp
    leak_scan_on packages/linux/gnome-extensions.txt \
        "clip@someone.github.io https://person@gmail.com/x 0123456789abcdef0123456789abcdef01234567"
    (( rc == 1 )) || fail "leak-scan exited $rc, want 1"
    grep -Fq 'email' "$out" || fail "missing email hit"
}

case_leak_gnome_list_short_commit() {
    new_tmp
    leak_scan_on packages/linux/gnome-extensions.txt \
        "clip@someone.github.io https://github.com/someone/clip 0123456"
    (( rc == 1 )) || fail "leak-scan exited $rc, want 1"
    grep -Fq 'email' "$out" || fail "missing email hit"
}

case_leak_gnome_other_file() {
    new_tmp
    leak_scan_on packages/linux/npm.txt \
        "clip@someone.github.io https://github.com/someone/clip 0123456789abcdef0123456789abcdef01234567"
    (( rc == 1 )) || fail "leak-scan exited $rc, want 1"
    grep -Fq 'email' "$out" || fail "missing email hit"
}

case_preview_cleans_up() {
    new_tmp
    mkdir -p "$t/tmp"
    setup_preview_repo
    preview_change_default

    # Passing run.
    rc=0
    (cd "$t/repo" && HOME="$t/home" TMPDIR="$t/tmp" ./export.sh --preview < /dev/null) > "$out" 2>&1 || rc=$?
    (( rc == 0 )) || fail "passing preview exited $rc, want 0"
    [[ -z "$(find "$t/tmp" -mindepth 1 -print -quit)" ]] || fail "TMPDIR not empty after a passing preview"

    # Failing run: a leak makes the preview exit 1.
    printf '/home/someone/x\n' > "$t/home/.config/fixture/plain.txt"
    rc=0
    (cd "$t/repo" && HOME="$t/home" TMPDIR="$t/tmp" ./export.sh --preview < /dev/null) > "$out" 2>&1 || rc=$?
    (( rc == 1 )) || fail "leak preview exited $rc, want 1"
    [[ -z "$(find "$t/tmp" -mindepth 1 -print -quit)" ]] || fail "TMPDIR not empty after a failing preview"
}

case_preview_reset_rejected() {
    new_tmp
    setup_preview_repo
    preview_change_default

    local repo_before home_before
    repo_before=$(tree_hash "$t/repo")
    home_before=$(tree_hash "$t/home")

    run_engine "$t/home" export.sh --preview --reset-values
    (( rc == 1 )) || fail "preview exited $rc, want 1"
    grep -Fqx 'ERROR: --preview cannot be combined with --reset-values.' "$out" \
        || fail "missing --preview/--reset-values error"

    [[ $(tree_hash "$t/repo") == "$repo_before" ]] || fail "repo changed during preview"
    [[ $(tree_hash "$t/home") == "$home_before" ]] || fail "home changed during preview"
}

case_preview_not_a_repo() {
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture

    run_engine "$t/home" export.sh --preview
    (( rc == 1 )) || fail "preview exited $rc, want 1"
    grep -Fqx 'ERROR: --preview needs a git repo with a commit.' "$out" \
        || fail "missing 'needs a git repo' error"
}

case_commit_happy() {
    new_tmp
    setup_commit_repo

    local origin_master
    origin_master=$(git --git-dir="$t/origin.git" rev-parse master)

    printf 'changed\n' > "$t/clone/dotfiles/linux/plain.txt"

    run_commit "$t/home"
    (( rc == 0 )) || fail "commit.sh exited $rc, want 0"

    [[ $(git --git-dir="$t/origin.git" rev-parse master) == "$origin_master" ]] \
        || fail "origin master moved"

    [[ $(git -C "$t/clone" symbolic-ref --short HEAD) == master ]] \
        || fail "HEAD is not back on master"

    local branches sync_count
    branches=$(origin_branches)
    sync_count=$(printf '%s\n' "$branches" | grep -c '^refs/heads/sync/linux-testbox-' || true)
    (( sync_count == 1 )) || fail "want 1 sync branch on origin, got: $branches"

    [[ $(wc -l < "$t/gh.log") == 1 ]] || fail "GH stub called $(wc -l < "$t/gh.log") times, want 1"
}

case_commit_leak_blocked() {
    new_tmp
    setup_commit_repo

    # A home-style path the scan flags, built by concatenation so the literal
    # never appears in this file.
    local leaky
    leaky='/ho'"me/someone/x"
    printf '%s\n' "$leaky" > "$t/clone/dotfiles/linux/plain.txt"

    run_commit "$t/home"
    (( rc == 1 )) || fail "commit.sh exited $rc, want 1"

    grep -Fq 'ERROR: the leak scan found the lines above; nothing was committed.' "$out" \
        || fail "missing leak-blocked ERROR line"

    [[ $(origin_branches) == 'refs/heads/master' ]] \
        || fail "origin has branches besides master: $(origin_branches)"
    [[ -z "$(git -C "$t/clone" branch --list 'sync/*')" ]] || fail "a sync branch was created locally"
    [[ ! -e "$t/gh.log" ]] || fail "GH stub was called"
}

case_commit_packages() {
    new_tmp
    setup_commit_repo

    local origin_master
    origin_master=$(git --git-dir="$t/origin.git" rev-parse master)

    mkdir -p "$t/clone/packages/linux"
    printf 'foo\n' > "$t/clone/packages/linux/apt.txt"

    run_commit "$t/home"
    (( rc == 0 )) || fail "commit.sh exited $rc, want 0"

    [[ $(git --git-dir="$t/origin.git" rev-parse master) == "$origin_master" ]] \
        || fail "origin master moved"

    local branch
    branch=$(origin_branches | grep '^refs/heads/sync/linux-testbox-' || true)
    [[ -n $branch ]] || fail "no sync branch on origin"
    [[ $(printf '%s\n' "$branch" | wc -l) == 1 ]] || fail "want 1 sync branch, got: $branch"

    [[ $(git --git-dir="$t/origin.git" diff --name-only master "$branch") == 'packages/linux/apt.txt' ]] \
        || fail "the branch commit does not hold only packages/linux/apt.txt"
    [[ $(git --git-dir="$t/origin.git" show "$branch:packages/linux/apt.txt") == 'foo' ]] \
        || fail "the branch commit does not hold packages/linux/apt.txt"
}

case_commit_packages_leak_blocked() {
    new_tmp
    setup_commit_repo

    # A home-style path the scan flags, built by concatenation so the literal
    # never appears in this file.
    local leaky
    leaky='/ho'"me/someone/x"
    mkdir -p "$t/clone/packages/linux"
    printf '%s\n' "$leaky" > "$t/clone/packages/linux/apt.txt"

    run_commit "$t/home"
    (( rc == 1 )) || fail "commit.sh exited $rc, want 1"

    grep -Fq 'ERROR: the leak scan found the lines above; nothing was committed.' "$out" \
        || fail "missing leak-blocked ERROR line"
    grep -Fq 'packages/linux/apt.txt' "$out" \
        || fail "the output does not name packages/linux/apt.txt"
    grep -Fq 'home-path' "$out" || fail "the output does not name the home-path rule"
    if grep -Fq -- "$leaky" "$out"; then
        fail "the output holds the offending text"
    fi

    [[ $(origin_branches) == 'refs/heads/master' ]] \
        || fail "origin has branches besides master: $(origin_branches)"
    [[ -z "$(git -C "$t/clone" branch --list 'sync/*')" ]] || fail "a sync branch was created locally"
    [[ ! -e "$t/gh.log" ]] || fail "GH stub was called"
}

case_commit_scan_missing() {
    new_tmp
    setup_commit_repo
    # Removed in a commit: an uncommitted removal stops at the outside-changes check.
    git -C "$t/clone" rm -q scripts/ci/leak-scan.sh
    git -C "$t/clone" commit -qm 'remove the scan'

    printf 'changed\n' > "$t/clone/dotfiles/linux/plain.txt"

    run_commit "$t/home"
    (( rc == 1 )) || fail "commit.sh exited $rc, want 1"

    grep -Fq 'ERROR: leak scan could not run; nothing was committed.' "$out" \
        || fail "missing scan-missing ERROR line"

    [[ $(origin_branches) == 'refs/heads/master' ]] \
        || fail "origin has branches besides master: $(origin_branches)"
    [[ ! -e "$t/gh.log" ]] || fail "GH stub was called"
}

case_commit_outside_changes() {
    new_tmp
    setup_commit_repo

    printf 'outside\n' > "$t/clone/outside.txt"

    run_commit "$t/home"
    (( rc == 1 )) || fail "commit.sh exited $rc, want 1"

    grep -Fq 'ERROR: commit or stash changes outside dotfiles/ first.' "$out" \
        || fail "missing outside-changes ERROR line"

    [[ $(origin_branches) == 'refs/heads/master' ]] \
        || fail "origin has branches besides master: $(origin_branches)"
    [[ ! -e "$t/gh.log" ]] || fail "GH stub was called"
}

# A commit repo with the fixture values cached, ignored the way the real repo ignores them.
setup_commit_values() {
    setup_commit_repo
    cp "$FIXTURES/user-values.json" "$t/clone/.user-values.json"
    printf '.user-values.json\n' >> "$t/clone/.git/info/exclude"
}

assert_commit_blocked() {
    (( rc == 1 )) || fail "commit.sh exited $rc, want 1"
    grep -Fq "ERROR: a cached value for $1 is in dotfiles/linux/plain.txt; nothing was committed." "$out" \
        || fail "missing cached-value ERROR line"
    [[ $(origin_branches) == 'refs/heads/master' ]] \
        || fail "origin has branches besides master: $(origin_branches)"
    [[ -z "$(git -C "$t/clone" branch --list 'sync/*')" ]] || fail "a sync branch was created locally"
    [[ ! -e "$t/gh.log" ]] || fail "GH stub was called"
}

case_commit_value_blocked() {
    new_tmp
    setup_commit_values
    printf 'author = Fixture User\n' > "$t/clone/dotfiles/linux/plain.txt"

    run_commit "$t/home"
    assert_commit_blocked '<NAME>'
}

case_commit_value_case_variant() {
    new_tmp
    setup_commit_values
    printf 'author = FIXTURE user\n' > "$t/clone/dotfiles/linux/plain.txt"

    run_commit "$t/home"
    assert_commit_blocked '<NAME>'
}

case_commit_value_doubled() {
    new_tmp
    setup_commit_values
    printf '%s\n' 'tool = C:\\Tools\\gh.exe' > "$t/clone/dotfiles/linux/plain.txt"

    run_commit "$t/home"
    assert_commit_blocked '<WINPATH>'
}

case_commit_value_untracked() {
    # A new file is as much a change as an edited one.
    new_tmp
    setup_commit_values
    mkdir "$t/clone/dotfiles/linux/new"
    printf 'author = Fixture User\n' > "$t/clone/dotfiles/linux/new/added.txt"

    run_commit "$t/home"
    (( rc == 1 )) || fail "commit.sh exited $rc, want 1"
    grep -Fq 'ERROR: a cached value for <NAME> is in dotfiles/linux/new/added.txt; nothing was committed.' "$out" \
        || fail "missing cached-value ERROR line"
}

case_commit_value_placeholder_only() {
    new_tmp
    setup_commit_values
    printf 'author = <NAME>\n' > "$t/clone/dotfiles/linux/plain.txt"

    run_commit "$t/home"
    (( rc == 0 )) || fail "commit.sh exited $rc, want 0"
    [[ $(wc -l < "$t/gh.log") == 1 ]] || fail "GH stub was not called once"
}

case_commit_value_not_printed() {
    new_tmp
    setup_commit_values
    printf 'author = Fixture User\n' > "$t/clone/dotfiles/linux/plain.txt"

    run_commit "$t/home"
    (( rc == 1 )) || fail "commit.sh exited $rc, want 1"
    if grep -Fiq 'Fixture User' "$out"; then
        fail "the output holds the cached value"
    fi
}

case_preview_scan_missing() {
    new_tmp
    setup_preview_repo
    preview_change_default
    rm "$t/repo/scripts/ci/leak-scan.sh"

    run_engine "$t/home" export.sh --preview
    (( rc == 1 )) || fail "preview exited $rc, want 1"

    grep -Fqx 'ERROR: leak scan could not run; nothing was committed.' "$out" \
        || fail "missing scan-missing ERROR line"
    if grep -Fq 'before/dotfiles' "$out"; then
        fail "output contains a diff"
    fi
}

case_sync_usage() {
    new_tmp
    setup_repo
    add_sync

    run_engine "$t/home" sync
    (( rc == 0 )) || fail "sync exited $rc, want 0"

    grep -Fq 'usage: ./sync <preview|export|commit|import> [options]' "$out" \
        || fail "missing usage line"
    grep -Fq 'Detected: linux' "$out" || fail "missing 'Detected: linux' line"
}

case_sync_unknown() {
    new_tmp
    setup_repo
    add_sync

    run_engine "$t/home" sync bogus
    (( rc == 1 )) || fail "sync exited $rc, want 1"

    grep -Fq 'Unknown command: bogus' "$out" || fail "missing 'Unknown command: bogus' line"
}

case_sync_routes_export() {
    new_tmp
    setup_repo
    add_sync
    mkdir -p "$t/repo/dotfiles"
    setup_home_fixture

    run_engine "$t/home" sync export
    (( rc == 0 )) || fail "sync export exited $rc, want 0"

    output_has_status ADDED dotfiles/linux/plain.txt || fail "missing ADDED line for plain.txt"
}

case_sync_routes_import() {
    new_tmp
    setup_repo
    add_sync
    setup_repo_fixture
    mkdir -p "$t/home/.config/fixture"
    printf 'old\n' > "$t/home/.config/fixture/plain.txt"

    # --force must reach import.sh, or it would prompt before overwriting.
    run_engine "$t/home" sync import --force
    (( rc == 0 )) || fail "sync import exited $rc, want 0"

    output_has_status UPDATED dotfiles/linux/plain.txt 'backup saved as plain.txt.bak' \
        || fail "missing UPDATED (backup) line for plain.txt"
    if grep -Fq 'Overwrite ' "$out"; then
        fail "import prompted despite --force being passed through"
    fi
}

case_sync_routes_preview() {
    new_tmp
    setup_preview_repo
    add_sync
    preview_change_default

    run_engine "$t/home" sync preview
    (( rc == 0 )) || fail "sync preview exited $rc, want 0"

    grep -Fq 'Nothing was written.' "$out" || fail "missing 'Nothing was written.' line"
}

case_sync_missing_tool() {
    new_tmp
    mkdir -p "$t/repo" "$t/stub"
    add_sync
    # A PATH with bash and git but no jq. uname and dirname are there so the
    # script gets past its first lines to the tool checks.
    local tool
    for tool in bash git uname dirname; do
        ln -s "$(command -v "$tool")" "$t/stub/$tool"
    done

    rc=0
    (cd "$t/repo" && PATH="$t/stub" ./sync export) > "$out" 2>&1 || rc=$?
    (( rc == 1 )) || fail "sync exited $rc, want 1"

    grep -Fq 'ERROR: jq is not installed. Install it and run the command again.' "$out" \
        || fail "missing jq error"
}

case_host_git_config_ignored() {
    local config scope
    config=$(git config --list --show-scope)
    if scope=$(grep -Em1 '^(global|system)' <<< "$config"); then
        fail "host ${scope%%$'\t'*} config is not ignored"
    fi
}

case_dconf_test_bus() {
    new_tmp
    setup_dconf_bus

    # The real database must not move while a case runs. Hash it first, but only
    # if this machine has one.
    local real_db=$HOME/.config/dconf/user real_before='' real_after=''
    if [[ -e $real_db ]]; then
        real_before=$(sha256sum "$real_db")
    fi

    printf '[/]\nkey=1\n' | dconf_seed /test/app/ \
        || fail "dconf load on the test bus failed"

    local value
    rc=0
    value=$(on_test_bus dconf read /test/app/key) || rc=$?
    (( rc == 0 )) || fail "dconf read on the test bus exited $rc"
    [[ $value == 1 ]] || fail "dconf read printed '$value', want 1"

    [[ -e "$t/home/.config/dconf/user" ]] \
        || fail "$t/home/.config/dconf/user was not created"

    # The engine must see $t/home as both HOME and the login home on this bus.
    mkdir -p "$t/repo"
    cat > "$t/repo/probe.sh" <<'EOF'
#!/bin/sh
getent passwd "$(id -u)" | cut -d: -f6
echo "$HOME"
EOF
    chmod +x "$t/repo/probe.sh"
    run_engine_bus /dev/null probe.sh
    (( rc == 0 )) || fail "probe on the test bus exited $rc"
    [[ $(grep -cFx "$t/home" "$out") == 2 ]] \
        || fail "HOME and the login home aren't both $t/home on the test bus"

    if [[ -n $real_before ]]; then
        real_after=$(sha256sum "$real_db")
        [[ $real_after == "$real_before" ]] || fail "the real dconf database changed"
    fi
}

# Add the base dconf entry to the fixture config. $1 is an optional jq filter
# applied to it, so a case can break exactly one field.
add_dconf_entry() {
    local filter=${1:-.}
    add_entry "$(jq -c "$filter" <<<'{"repoPath": "dotfiles/linux/dconf/app.ini", "path": "/test/app/", "type": "dconf", "platform": "linux"}')"
}

# The exact line scripts/linux/sync.sh prints for an invalid dconf entry.
dconf_error() {
    printf 'ERROR: sync-config.json: entry %s needs "platform": "linux" and a dconf path like /org/gnome/shell/.' "$1"
}

# A dconf entry is valid config: both engines accept it and write nothing.
case_dconf_config_valid() {
    new_tmp
    setup_repo
    mkdir -p "$t/repo/dotfiles" "$t/home"
    add_dconf_entry

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    if grep -Fq 'has an unsafe path' "$out"; then fail "export rejected the valid dconf entry"; fi
    if grep -Fq 'dconf path' "$out"; then fail "export rejected the valid dconf path"; fi

    run_engine "$t/home" import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    if grep -Fq 'has an unsafe path' "$out"; then fail "import rejected the valid dconf entry"; fi
    if grep -Fq 'dconf path' "$out"; then fail "import rejected the valid dconf path"; fi
}

# One dconf entry with a bad "path" or platform: both engines must stop.
assert_dconf_stop() {
    local filter=$1
    new_tmp
    setup_repo
    mkdir -p "$t/repo/dotfiles" "$t/home"
    add_dconf_entry "$filter"
    assert_path_stop "$(dconf_error dotfiles/linux/dconf/app.ini)"
}

case_dconf_path_missing() {
    assert_dconf_stop 'del(.path)'
}

case_dconf_path_relative() {
    assert_dconf_stop '.path = "org/gnome/"'
}

case_dconf_path_no_slash() {
    assert_dconf_stop '.path = "/org/gnome"'
}

case_dconf_path_root() {
    assert_dconf_stop '.path = "/"'
}

case_dconf_path_double_slash() {
    assert_dconf_stop '.path = "/org//gnome/"'
}

case_dconf_path_dotdot() {
    assert_dconf_stop '.path = "/org/../etc/"'
}

case_dconf_path_space() {
    assert_dconf_stop '.path = "/org/gno me/"'
}

case_dconf_platform_common() {
    assert_dconf_stop '.platform = "common"'
}

case_dconf_platform_windows() {
    assert_dconf_stop '.platform = "windows"'
}

case_dconf_repo_unsafe() {
    new_tmp
    setup_repo
    mkdir -p "$t/repo/dotfiles" "$t/home"
    add_dconf_entry '.repoPath = "dotfiles/../app.ini"'
    assert_path_stop 'ERROR: sync-config.json: entry dotfiles/../app.ini has an unsafe path.'
}

case_dconf_symlink_named() {
    new_tmp
    setup_repo
    mkdir -p "$t/repo/dotfiles/linux/dconf" "$t/home"
    add_dconf_entry
    ln -s nowhere "$t/repo/dotfiles/linux/dconf/app.ini"
    assert_path_stop 'ERROR: sync-config.json: entry dotfiles/linux/dconf/app.ini has an unsafe path.'
}

case_dconf_orphan_owned() {
    new_tmp
    setup_repo
    setup_repo_fixture
    setup_home_fixture
    mkdir -p "$t/repo/dotfiles/linux/dconf"
    add_dconf_entry
    printf '[/]\na=1\n' > "$t/repo/dotfiles/linux/dconf/app.ini"

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    if grep -qE '^  ORPHAN[[:space:]]' "$out"; then
        fail "an ORPHAN line was printed for the dconf entry's repo file"
    fi
}

# The base dconf entry the lint cases add to the real config.
lint_dconf() {
    lint_run ".files += [$1]"
}

case_lint_dconf_ok() {
    new_tmp
    lint_dconf '{"repoPath": "dotfiles/linux/dconf/app.ini", "path": "/test/app/", "type": "dconf", "platform": "linux"}'

    (( rc == 0 )) || fail "check-config.sh exited $rc, want 0"
}

case_lint_dconf_path() {
    new_tmp
    lint_dconf '{"repoPath": "dotfiles/linux/dconf/app.ini", "path": "/org/gnome", "type": "dconf", "platform": "linux"}'

    (( rc == 1 )) || fail "check-config.sh exited $rc, want 1"
    grep -Fqx 'dotfiles/linux/dconf/app.ini' "$out" || fail "output does not name the entry"
}

case_lint_dconf_root() {
    new_tmp
    lint_dconf '{"repoPath": "dotfiles/linux/dconf/app.ini", "path": "/", "type": "dconf", "platform": "linux"}'

    (( rc == 1 )) || fail "check-config.sh exited $rc, want 1"
    grep -Fqx 'dotfiles/linux/dconf/app.ini' "$out" || fail "output does not name the entry"
}

case_lint_dconf_platform() {
    new_tmp
    lint_dconf '{"repoPath": "dotfiles/common/dconf/app.ini", "path": "/test/app/", "type": "dconf", "platform": "common"}'

    (( rc == 1 )) || fail "check-config.sh exited $rc, want 1"
    grep -Fqx 'dotfiles/common/dconf/app.ini' "$out" || fail "output does not name the entry"
}

case_lint_dconf_localpath() {
    new_tmp
    lint_dconf '{"repoPath": "dotfiles/linux/dconf/app.ini", "path": "/test/app/", "type": "dconf", "platform": "linux", "localPath": "~/x"}'

    (( rc == 1 )) || fail "check-config.sh exited $rc, want 1"
    grep -Fqx 'dotfiles/linux/dconf/app.ini' "$out" || fail "output does not name the entry"
}

case_lint_dconf_rules() {
    new_tmp
    lint_dconf '{"repoPath": "dotfiles/linux/dconf/app.ini", "path": "/test/app/", "type": "dconf", "platform": "linux", "sanitizeRules": []}'

    (( rc == 1 )) || fail "check-config.sh exited $rc, want 1"
    grep -Fqx 'dotfiles/linux/dconf/app.ini' "$out" || fail "output does not name the entry"
}

case_lint_dconf_linked() {
    new_tmp
    lint_dconf '{"repoPath": "dotfiles/linux/dconf/app.ini", "path": "/test/app/", "type": "dconf", "platform": "linux", "detectLinkedPaths": true}'

    (( rc == 1 )) || fail "check-config.sh exited $rc, want 1"
    grep -Fqx 'dotfiles/linux/dconf/app.ini' "$out" || fail "output does not name the entry"
}

case_lint_dconf_keys_empty() {
    new_tmp
    lint_dconf '{"repoPath": "dotfiles/linux/dconf/app.ini", "path": "/test/app/", "type": "dconf", "platform": "linux", "keys": []}'

    (( rc == 1 )) || fail "check-config.sh exited $rc, want 1"
    grep -Fqx 'dotfiles/linux/dconf/app.ini' "$out" || fail "output does not name the entry"
}

case_lint_dconf_keys_type() {
    new_tmp
    lint_dconf '{"repoPath": "dotfiles/linux/dconf/app.ini", "path": "/test/app/", "type": "dconf", "platform": "linux", "keys": "font-name"}'

    (( rc == 1 )) || fail "check-config.sh exited $rc, want 1"
    grep -Fqx 'dotfiles/linux/dconf/app.ini' "$out" || fail "output does not name the entry"
}

case_lint_keys_on_file() {
    new_tmp
    lint_run '.files |= map(if .repoPath == "dotfiles/linux/claude/CLAUDE.md" then .keys = ["x"] else . end)'

    (( rc == 1 )) || fail "check-config.sh exited $rc, want 1"
    grep -Fqx 'dotfiles/linux/claude/CLAUDE.md' "$out" || fail "output does not name the entry"
}

case_lint_path_on_dir() {
    new_tmp
    lint_run '.files += [{"repoPath": "dotfiles/linux/dd", "localPath": "~/dd", "platform": "linux", "type": "dir", "path": "/x/"}]'

    (( rc == 1 )) || fail "check-config.sh exited $rc, want 1"
    grep -Fqx 'dotfiles/linux/dd' "$out" || fail "output does not name the entry"
}

case_lint_type_unknown() {
    new_tmp
    lint_dconf '{"repoPath": "dotfiles/linux/dconf/app.ini", "path": "/test/app/", "type": "gsettings", "platform": "linux"}'

    (( rc == 1 )) || fail "check-config.sh exited $rc, want 1"
    grep -Fqx 'dotfiles/linux/dconf/app.ini' "$out" || fail "output does not name the entry"
}

# Common setup for the dconf export cases: fixtures on both sides, then a
# private bus, so every dconf command the engine runs stays off the real one.
setup_dconf_export_case() {
    new_tmp
    setup_repo
    setup_home_fixture
    setup_repo_fixture
    setup_dconf_bus
}

# dconf dump of /test/app/ on the private bus, as the export would write it.
dconf_dump_app() {
    on_test_bus dconf dump /test/app/
}

case_dconf_export_adds() {
    setup_dconf_export_case
    add_dconf_entry
    printf '[/]\na=1\n' | dconf_seed /test/app/

    run_engine_bus /dev/null export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status ADDED dotfiles/linux/dconf/app.ini \
        || fail "missing ADDED line for the dconf entry"

    dconf_dump_app > "$t/expected"
    cmp -s "$t/expected" "$t/repo/dotfiles/linux/dconf/app.ini" \
        || fail "repo file does not equal dconf dump /test/app/ byte for byte"
}

case_dconf_export_unchanged() {
    setup_dconf_export_case
    add_dconf_entry
    printf '[/]\na=1\n' | dconf_seed /test/app/

    run_engine_bus /dev/null export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status ADDED dotfiles/linux/dconf/app.ini \
        || fail "missing ADDED line on the first export"

    local hash_before
    hash_before=$(sha256sum "$t/repo/dotfiles/linux/dconf/app.ini")

    run_engine_bus /dev/null export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status UNCHANGED dotfiles/linux/dconf/app.ini \
        || fail "missing UNCHANGED line on the second export"
    [[ $(sha256sum "$t/repo/dotfiles/linux/dconf/app.ini") == "$hash_before" ]] \
        || fail "repo file changed on an UNCHANGED export"
}

case_dconf_export_modifies() {
    setup_dconf_export_case
    add_dconf_entry
    printf '[/]\na=1\n' | dconf_seed /test/app/

    run_engine_bus /dev/null export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    on_test_bus dconf write /test/app/a 2 || fail "dconf write failed"

    run_engine_bus /dev/null export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status MODIFIED dotfiles/linux/dconf/app.ini \
        || fail "missing MODIFIED line for the dconf entry"
    printf '[/]\na=2\n' > "$t/expected"
    cmp -s "$t/expected" "$t/repo/dotfiles/linux/dconf/app.ini" \
        || fail "repo file does not hold a=2"
}

case_dconf_export_keys() {
    setup_dconf_export_case
    add_dconf_entry '.keys = ["keep", "sub/*"]'
    printf '[/]\nkeep=1\ndrop=2\n\n[sub]\nx=3\n\n[other]\ny=4\n' | dconf_seed /test/app/

    run_engine_bus /dev/null export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    printf '[/]\nkeep=1\n\n[sub]\nx=3\n' > "$t/expected"
    cmp -s "$t/expected" "$t/repo/dotfiles/linux/dconf/app.ini" \
        || fail "filtered dump differs: want keep and sub, nothing else"
}

case_dconf_export_keys_no_root() {
    setup_dconf_export_case
    add_dconf_entry '.keys = ["sub/*"]'
    printf '[/]\nkeep=1\ndrop=2\n\n[sub]\nx=3\n\n[other]\ny=4\n' | dconf_seed /test/app/

    run_engine_bus /dev/null export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    printf '[sub]\nx=3\n' > "$t/expected"
    cmp -s "$t/expected" "$t/repo/dotfiles/linux/dconf/app.ini" \
        || fail "filtered dump differs: want only the sub section"
}

case_dconf_export_keys_nested() {
    setup_dconf_export_case
    add_dconf_entry '.keys = ["sub/*"]'
    printf '[sub/deep]\nz=1\n' | dconf_seed /test/app/

    run_engine_bus /dev/null export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    grep -Fqx '[sub/deep]' "$t/repo/dotfiles/linux/dconf/app.ini" \
        || fail "missing [sub/deep] section"
    grep -Fqx 'z=1' "$t/repo/dotfiles/linux/dconf/app.ini" \
        || fail "missing z=1 key"
}

case_dconf_export_keys_glob() {
    setup_dconf_export_case
    add_dconf_entry '.keys = ["show-*"]'
    printf '[/]\nshow-hidden=true\nshown=1\n' | dconf_seed /test/app/

    run_engine_bus /dev/null export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    grep -Fq 'show-hidden=true' "$t/repo/dotfiles/linux/dconf/app.ini" \
        || fail "show-hidden was not kept"
    if grep -Fq 'shown=1' "$t/repo/dotfiles/linux/dconf/app.ini"; then
        fail "shown was kept despite the show-* pattern"
    fi
}

# The real entry's keys: a profile's commands, links and containers stay out.
case_dconf_ptyxis_profile_keys() {
    setup_dconf_export_case
    local keys key
    keys=$(jq -c '.files[] | select(.path == "/org/gnome/Ptyxis/") | .keys' "$REPO/sync-config.json")
    [[ -n $keys ]] || fail "no /org/gnome/Ptyxis/ entry in sync-config.json"
    add_dconf_entry ".keys = $keys"
    printf "[Profiles/abc]\nlabel='Main'\npalette='Tango'\ncustom-command='/opt/run'\nuse-custom-command=true\ncustom-links=['x']\ndefault-container='box'\npreserve-container='always'\n" \
        | dconf_seed /test/app/

    run_engine_bus /dev/null export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    local file=$t/repo/dotfiles/linux/dconf/app.ini
    grep -Fqx "label='Main'" "$file" || fail "label was not kept"
    grep -Fqx "palette='Tango'" "$file" || fail "palette was not kept"
    for key in custom-command use-custom-command custom-links default-container preserve-container; do
        if grep -q "^$key=" "$file"; then
            fail "$key was kept"
        fi
    done
}

case_dconf_export_keep_all() {
    setup_dconf_export_case
    add_dconf_entry '.keys = ["*"]'
    printf '[/]\na=1\n\n[sub]\nx=2\n\n[other]\ny=3\n' | dconf_seed /test/app/

    run_engine_bus /dev/null export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    dconf_dump_app > "$t/expected"
    cmp -s "$t/expected" "$t/repo/dotfiles/linux/dconf/app.ini" \
        || fail "keep-all result differs from the raw dump byte for byte"
}

case_dconf_export_no_settings() {
    setup_dconf_export_case
    add_dconf_entry

    run_engine_bus /dev/null export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status SKIPPED dotfiles/linux/dconf/app.ini 'no settings under /test/app/' \
        || fail "missing SKIPPED (no settings) line"
    [[ ! -e "$t/repo/dotfiles/linux/dconf/app.ini" ]] \
        || fail "repo file was created for an empty dump"
}

case_dconf_export_no_settings_keeps_repo() {
    setup_dconf_export_case
    add_dconf_entry
    mkdir -p "$t/repo/dotfiles/linux/dconf"
    printf '[/]\nold=1\n' > "$t/repo/dotfiles/linux/dconf/app.ini"
    local hash_before
    hash_before=$(sha256sum "$t/repo/dotfiles/linux/dconf/app.ini")

    run_engine_bus /dev/null export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status SKIPPED dotfiles/linux/dconf/app.ini 'no settings under /test/app/' \
        || fail "missing SKIPPED (no settings) line"
    [[ $(sha256sum "$t/repo/dotfiles/linux/dconf/app.ini") == "$hash_before" ]] \
        || fail "repo file changed despite the empty dump"
}

case_dconf_export_keys_empty_result() {
    setup_dconf_export_case
    add_dconf_entry '.keys = ["absent"]'
    mkdir -p "$t/repo/dotfiles/linux/dconf"
    printf '[/]\nold=1\n' > "$t/repo/dotfiles/linux/dconf/app.ini"
    local hash_before
    hash_before=$(sha256sum "$t/repo/dotfiles/linux/dconf/app.ini")
    printf '[/]\na=1\n' | dconf_seed /test/app/

    run_engine_bus /dev/null export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status SKIPPED dotfiles/linux/dconf/app.ini 'no settings under /test/app/' \
        || fail "missing SKIPPED (no settings) line"
    [[ $(sha256sum "$t/repo/dotfiles/linux/dconf/app.ini") == "$hash_before" ]] \
        || fail "repo file changed when the filter kept nothing"
}

case_dconf_export_missing_tool() {
    setup_dconf_export_case
    add_dconf_entry
    # A PATH with every tool the engine needs but no dconf, so export_dconf
    # reports the tool as missing instead of failing on jq or another command.
    local stub=$t/stub tool
    mkdir -p "$stub"
    for tool in bash dirname jq find sort cat cp cmp chmod mkdir rm git uname; do
        ln -s "$(command -v "$tool")" "$stub/$tool"
    done

    rc=0
    (cd "$t/repo" && HOME="$t/home" PATH="$stub" ./export.sh < /dev/null) > "$out" 2>&1 || rc=$?
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status SKIPPED dotfiles/linux/dconf/app.ini 'dconf not installed' \
        || fail "missing SKIPPED (dconf not installed) line"
}

case_dconf_export_fails() {
    setup_dconf_export_case
    # The dconf entry goes first, so the fixture entries after it are the
    # "later entries" that must still print a status after the ERROR.
    jq '.files = [{"repoPath": "dotfiles/linux/dconf/app.ini", "path": "/test/app/", "type": "dconf", "platform": "linux"}] + .files' \
        "$t/repo/sync-config.json" > "$t/repo/sync-config.json.tmp"
    mv "$t/repo/sync-config.json.tmp" "$t/repo/sync-config.json"
    cat > "$t/bin/dconf" <<'EOF'
#!/bin/sh
exit 1
EOF
    chmod +x "$t/bin/dconf"

    run_engine_bus /dev/null export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status ERROR dotfiles/linux/dconf/app.ini 'dconf dump failed' \
        || fail "missing ERROR (dconf dump failed) line"
    output_has_status UNCHANGED dotfiles/linux/plain.txt \
        || fail "a later fixture entry did not print a status"
}

# A repo write that fails is one entry's ERROR, and export.sh runs under set -e.
case_dconf_export_write_fails() {
    setup_dconf_export_case
    jq '.files = [{"repoPath": "dotfiles/linux/dconf/app.ini", "path": "/test/app/", "type": "dconf", "platform": "linux"}] + .files' \
        "$t/repo/sync-config.json" > "$t/repo/sync-config.json.tmp"
    mv "$t/repo/sync-config.json.tmp" "$t/repo/sync-config.json"
    printf 'in the way\n' > "$t/repo/dotfiles/linux/dconf"
    printf '[/]\na=1\n' | dconf_seed /test/app/

    run_engine_bus /dev/null export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status ERROR dotfiles/linux/dconf/app.ini "cannot create $t/repo/dotfiles/linux/dconf" \
        || fail "missing ERROR line for the dconf entry"
    output_has_status UNCHANGED dotfiles/linux/plain.txt \
        || fail "a later fixture entry did not print a status"
}

case_dconf_preview_read_only() {
    new_tmp
    setup_repo
    mkdir -p "$t/repo/scripts/ci"
    cp -a "$REPO/scripts/ci/." "$t/repo/scripts/ci/"
    setup_repo_fixture
    setup_home_fixture
    make_git_repo
    setup_dconf_bus
    add_dconf_entry
    printf '[/]\na=1\n' | dconf_seed /test/app/

    # Export and commit the initial state, so the preview has a base to diff.
    run_engine_bus /dev/null export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    git -C "$t/repo" add -A
    git -C "$t/repo" -c user.name=t -c user.email=t@example.com commit -q -m 'dconf export'

    on_test_bus dconf write /test/app/a 2 || fail "dconf write failed"

    local repo_before home_before
    repo_before=$(tree_hash "$t/repo")
    home_before=$(tree_hash "$t/home")

    run_engine_bus /dev/null export.sh --preview
    (( rc == 0 )) || fail "preview exited $rc, want 0"

    grep -Fq 'a=2' "$out" || fail "the preview diff does not show the changed key"
    [[ $(tree_hash "$t/repo") == "$repo_before" ]] || fail "repo changed during preview"
    [[ $(tree_hash "$t/home") == "$home_before" ]] || fail "home changed during preview"
}

case_dconf_import_creates() {
    setup_dconf_export_case
    add_dconf_entry
    mkdir -p "$t/repo/dotfiles/linux/dconf"
    printf '[/]\na=1\n' > "$t/repo/dotfiles/linux/dconf/app.ini"

    # No --force: an empty database must not prompt before CREATED.
    run_engine_bus /dev/null import.sh
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    output_has_status CREATED dotfiles/linux/dconf/app.ini \
        || fail "missing CREATED line for the dconf entry"
    if grep -Fq 'Overwrite ' "$out"; then
        fail "import prompted despite the empty database"
    fi
    [[ ! -e "$t/home/.local/state/sync-settings" ]] \
        || fail "a backup was written for an empty database"
    [[ $(on_test_bus dconf read /test/app/a) == 1 ]] \
        || fail "dconf read /test/app/a is not 1"
}

case_dconf_import_unchanged() {
    setup_dconf_export_case
    add_dconf_entry
    mkdir -p "$t/repo/dotfiles/linux/dconf"
    printf '[/]\na=1\n' > "$t/repo/dotfiles/linux/dconf/app.ini"
    printf '[/]\na=1\n' | dconf_seed /test/app/

    local hash_before
    hash_before=$(sha256sum "$t/home/.config/dconf/user")

    run_engine_bus /dev/null import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    output_has_status UNCHANGED dotfiles/linux/dconf/app.ini \
        || fail "missing UNCHANGED line for the dconf entry"
    [[ $(sha256sum "$t/home/.config/dconf/user") == "$hash_before" ]] \
        || fail "the dconf database changed on an UNCHANGED import"
}

case_dconf_import_local_extra() {
    setup_dconf_export_case
    add_dconf_entry
    mkdir -p "$t/repo/dotfiles/linux/dconf"
    printf '[/]\na=1\n' > "$t/repo/dotfiles/linux/dconf/app.ini"
    printf '[/]\na=1\nextra=1\n' | dconf_seed /test/app/

    run_engine_bus /dev/null import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    output_has_status UNCHANGED dotfiles/linux/dconf/app.ini \
        || fail "missing UNCHANGED line for the dconf entry"
    [[ $(on_test_bus dconf read /test/app/extra) == 1 ]] \
        || fail "the local extra key was not kept"
}

case_dconf_import_update_yes() {
    setup_dconf_export_case
    add_dconf_entry
    mkdir -p "$t/repo/dotfiles/linux/dconf"
    printf '[/]\na=2\n' > "$t/repo/dotfiles/linux/dconf/app.ini"
    printf '[/]\na=1\n' | dconf_seed /test/app/
    printf 'y\n' > "$t/answers"

    run_engine_bus "$t/answers" import.sh
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    grep -Fq 'Overwrite /test/app/? [Y/n]' "$out" \
        || fail "the prompt does not name the dconf path"
    # The prompt has no trailing newline, so the status line follows it on the same line.
    grep -Fq "$(status_line UPDATED dotfiles/linux/dconf/app.ini 'backup saved as app.ini.bak')" "$out" \
        || fail "missing UPDATED (backup) line for the dconf entry"
    [[ $(on_test_bus dconf read /test/app/a) == 2 ]] \
        || fail "dconf read /test/app/a is not 2"
    printf '[/]\na=1\n' > "$t/expected.bak"
    cmp -s "$t/expected.bak" "$t/home/.local/state/sync-settings/dconf/app.ini.bak" \
        || fail "the backup does not hold the old dump"
}

case_dconf_import_update_no() {
    setup_dconf_export_case
    add_dconf_entry
    mkdir -p "$t/repo/dotfiles/linux/dconf"
    printf '[/]\na=2\n' > "$t/repo/dotfiles/linux/dconf/app.ini"
    printf '[/]\na=1\n' | dconf_seed /test/app/
    printf 'n\n' > "$t/answers"

    run_engine_bus "$t/answers" import.sh
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    grep -Fq "$(status_line SKIPPED dotfiles/linux/dconf/app.ini 'user skipped')" "$out" \
        || fail "missing SKIPPED (user skipped) line for the dconf entry"
    [[ $(on_test_bus dconf read /test/app/a) == 1 ]] \
        || fail "dconf read /test/app/a changed despite the 'n' answer"
    [[ ! -e "$t/home/.local/state/sync-settings" ]] \
        || fail "a backup was written despite the 'n' answer"
}

case_dconf_import_force() {
    setup_dconf_export_case
    add_dconf_entry
    mkdir -p "$t/repo/dotfiles/linux/dconf"
    printf '[/]\na=2\n' > "$t/repo/dotfiles/linux/dconf/app.ini"
    printf '[/]\na=1\n' | dconf_seed /test/app/

    run_engine_bus /dev/null import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    if grep -Fq 'Overwrite ' "$out"; then
        fail "import prompted despite --force"
    fi
    output_has_status UPDATED dotfiles/linux/dconf/app.ini 'backup saved as app.ini.bak' \
        || fail "missing UPDATED (backup) line for the dconf entry"
    [[ -e "$t/home/.local/state/sync-settings/dconf/app.ini.bak" ]] \
        || fail "no backup was written"
}

case_dconf_import_eof() {
    setup_dconf_export_case
    add_dconf_entry
    mkdir -p "$t/repo/dotfiles/linux/dconf"
    printf '[/]\na=2\n' > "$t/repo/dotfiles/linux/dconf/app.ini"
    printf '[/]\na=1\n' | dconf_seed /test/app/

    # No --force, stdin /dev/null: the prompt reads EOF, which counts as yes.
    run_engine_bus /dev/null import.sh
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    grep -Fq "$(status_line UPDATED dotfiles/linux/dconf/app.ini 'backup saved as app.ini.bak')" "$out" \
        || fail "missing UPDATED (backup) line for the dconf entry"
    [[ $(on_test_bus dconf read /test/app/a) == 2 ]] \
        || fail "dconf read /test/app/a is not 2"
}

case_dconf_import_merge() {
    setup_dconf_export_case
    add_dconf_entry
    mkdir -p "$t/repo/dotfiles/linux/dconf"
    printf '[/]\na=2\n' > "$t/repo/dotfiles/linux/dconf/app.ini"
    printf '[/]\na=1\nextra=1\n' | dconf_seed /test/app/

    run_engine_bus /dev/null import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    [[ $(on_test_bus dconf read /test/app/a) == 2 ]] \
        || fail "dconf read /test/app/a is not 2"
    [[ $(on_test_bus dconf read /test/app/extra) == 1 ]] \
        || fail "the local extra key was not kept through the merge"
}

case_dconf_import_no_repo_file() {
    setup_dconf_export_case
    add_dconf_entry
    # No repo file under the entry's repoPath.

    run_engine_bus /dev/null import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    output_has_status SKIPPED dotfiles/linux/dconf/app.ini 'not found in repo' \
        || fail "missing SKIPPED (not found in repo) line for the dconf entry"
}

case_dconf_import_wrong_home() {
    setup_dconf_export_case
    add_dconf_entry
    mkdir -p "$t/repo/dotfiles/linux/dconf"
    printf '[/]\na=1\n' > "$t/repo/dotfiles/linux/dconf/app.ini"
    # Drop the fake getent so the real one answers with the real login home,
    # which is not $t/home; dconf_home_ok must then refuse to touch dconf.
    rm "$t/bin/getent"

    run_engine_bus /dev/null import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    output_has_status SKIPPED dotfiles/linux/dconf/app.ini 'HOME is not the login home; dconf left alone' \
        || fail "missing SKIPPED (wrong home) line for the dconf entry"
    [[ -z $(on_test_bus dconf read /test/app/a) ]] \
        || fail "dconf read /test/app/a is set despite the wrong-home skip"
    [[ ! -e "$t/home/.local/state/sync-settings" ]] \
        || fail "a backup was written despite the wrong-home skip"
}

# The test bus's dconf service keeps $t/home/.config, as the desktop's keeps
# ~/.config, so only the engine sees this config dir: its dump comes back empty
# while its load would still reach the service.
case_dconf_import_other_config() {
    setup_dconf_export_case
    add_dconf_entry
    mkdir -p "$t/repo/dotfiles/linux/dconf" "$t/other"
    printf '[/]\na=1\n' > "$t/repo/dotfiles/linux/dconf/app.ini"
    printf '[/]\na=2\n' | dconf_seed /test/app/

    rc=0
    (cd "$t/repo" && on_test_bus env XDG_CONFIG_HOME="$t/other" ./import.sh --force < /dev/null) > "$out" 2>&1 || rc=$?
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    output_has_status SKIPPED dotfiles/linux/dconf/app.ini 'XDG_CONFIG_HOME is not ~/.config; dconf left alone' \
        || fail "missing SKIPPED (other config dir) line for the dconf entry"
    [[ $(on_test_bus dconf read /test/app/a) == 2 ]] \
        || fail "/test/app/a changed despite the config dir skip"
    [[ ! -e "$t/home/.local/state/sync-settings" ]] \
        || fail "a backup was written despite the config dir skip"
}

case_dconf_import_config_unset() {
    setup_dconf_export_case
    add_dconf_entry
    mkdir -p "$t/repo/dotfiles/linux/dconf"
    printf '[/]\na=1\n' > "$t/repo/dotfiles/linux/dconf/app.ini"

    rc=0
    (cd "$t/repo" && on_test_bus env -u XDG_CONFIG_HOME ./import.sh --force < /dev/null) > "$out" 2>&1 || rc=$?
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    output_has_status CREATED dotfiles/linux/dconf/app.ini \
        || fail "missing CREATED line with XDG_CONFIG_HOME unset"
    [[ $(on_test_bus dconf read /test/app/a) == 1 ]] \
        || fail "/test/app/a is not 1 after import"
}

case_dconf_import_missing_tool() {
    setup_dconf_export_case
    add_dconf_entry
    mkdir -p "$t/repo/dotfiles/linux/dconf"
    printf '[/]\na=1\n' > "$t/repo/dotfiles/linux/dconf/app.ini"
    # A PATH with every tool the engine needs but no dconf, so import_dconf
    # reports the tool as missing instead of failing on jq or another command.
    local stub=$t/stub tool
    mkdir -p "$stub"
    for tool in bash dirname jq find sort cat cp cmp chmod mkdir rm git uname; do
        ln -s "$(command -v "$tool")" "$stub/$tool"
    done

    rc=0
    (cd "$t/repo" && HOME="$t/home" PATH="$stub" ./import.sh --force < /dev/null) > "$out" 2>&1 || rc=$?
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    output_has_status SKIPPED dotfiles/linux/dconf/app.ini 'dconf not installed' \
        || fail "missing SKIPPED (dconf not installed) line"
}

case_dconf_import_bad_file() {
    setup_dconf_export_case
    # The dconf entry goes first, so the fixture entries after it are the
    # "later entries" that must still print a status after the ERROR.
    jq '.files = [{"repoPath": "dotfiles/linux/dconf/app.ini", "path": "/test/app/", "type": "dconf", "platform": "linux"}] + .files' \
        "$t/repo/sync-config.json" > "$t/repo/sync-config.json.tmp"
    mv "$t/repo/sync-config.json.tmp" "$t/repo/sync-config.json"
    mkdir -p "$t/repo/dotfiles/linux/dconf"
    printf '[/]\na=2\nbad=notvalid value\n' > "$t/repo/dotfiles/linux/dconf/app.ini"
    printf '[/]\na=1\n' | dconf_seed /test/app/

    run_engine_bus /dev/null import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    output_has_status ERROR dotfiles/linux/dconf/app.ini 'dconf load failed' \
        || fail "missing ERROR (dconf load failed) line"
    [[ $(on_test_bus dconf read /test/app/a) == 1 ]] \
        || fail "dconf read /test/app/a changed despite the failed load"
    output_has_status UNCHANGED dotfiles/linux/plain.txt \
        || fail "a later fixture entry did not print a status"
}

case_dconf_import_prompt_reads_stdin() {
    setup_dconf_export_case
    add_dconf_entry
    add_dconf_entry '.repoPath = "dotfiles/linux/dconf/other.ini" | .path = "/test/other/"'
    mkdir -p "$t/repo/dotfiles/linux/dconf"
    printf '[/]\na=2\n' > "$t/repo/dotfiles/linux/dconf/app.ini"
    printf '[/]\nb=2\n' > "$t/repo/dotfiles/linux/dconf/other.ini"
    printf '[/]\na=1\n' | dconf_seed /test/app/
    printf '[/]\nb=1\n' | dconf_seed /test/other/
    printf 'n\ny\n' > "$t/answers"

    run_engine_bus "$t/answers" import.sh
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    grep -Fq "$(status_line SKIPPED dotfiles/linux/dconf/app.ini 'user skipped')" "$out" \
        || fail "missing SKIPPED (user skipped) line for the first dconf entry"
    grep -Fq "$(status_line UPDATED dotfiles/linux/dconf/other.ini 'backup saved as other.ini.bak')" "$out" \
        || fail "missing UPDATED (backup) line for the second dconf entry"
    [[ $(on_test_bus dconf read /test/app/a) == 1 ]] \
        || fail "the first entry was overwritten despite the 'n' answer"
    [[ $(on_test_bus dconf read /test/other/b) == 2 ]] \
        || fail "the second entry was not overwritten despite the 'y' answer"
}

case_dconf_roundtrip_values() {
    setup_dconf_export_case
    add_dconf_entry
    cat > "$t/seed" <<'EOF'
[/]
s='x=y'
m="it's\nline2"
l=['a', 'b']
e=@as []
u=uint32 3
t=(1, 'x')
EOF
    dconf_seed /test/app/ < "$t/seed" \
        || fail "seeding the test bus failed"

    run_engine_bus /dev/null export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status ADDED dotfiles/linux/dconf/app.ini \
        || fail "missing ADDED line for the dconf entry"

    # A fresh, empty database: the exported repo file must round-trip byte for byte.
    mv "$t/home" "$t/old"
    mkdir "$t/home"

    run_engine_bus /dev/null import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"

    dconf_dump_app > "$t/dumped"
    cmp -s "$t/repo/dotfiles/linux/dconf/app.ini" "$t/dumped" \
        || fail "the imported dump does not equal the repo file byte for byte"
}

case_dconf_roundtrip_settles() {
    setup_dconf_export_case
    add_dconf_entry
    printf '[/]\na=1\n' | dconf_seed /test/app/

    run_engine_bus /dev/null export.sh
    (( rc == 0 )) || fail "first export.sh exited $rc, want 0"
    output_has_status ADDED dotfiles/linux/dconf/app.ini \
        || fail "missing ADDED line on the first export"

    run_engine_bus /dev/null import.sh --force
    (( rc == 0 )) || fail "first import.sh exited $rc, want 0"
    output_has_status UNCHANGED dotfiles/linux/dconf/app.ini \
        || fail "missing UNCHANGED line on the first import"

    run_engine_bus /dev/null export.sh
    (( rc == 0 )) || fail "second export.sh exited $rc, want 0"
    output_has_status UNCHANGED dotfiles/linux/dconf/app.ini \
        || fail "missing UNCHANGED line on the second export"

    run_engine_bus /dev/null import.sh --force
    (( rc == 0 )) || fail "second import.sh exited $rc, want 0"
    output_has_status UNCHANGED dotfiles/linux/dconf/app.ini \
        || fail "missing UNCHANGED line on the second import"

    [[ ! -e "$t/home/.local/state/sync-settings" ]] \
        || fail "a backup was written during a settled round trip"
}

# -- Package drift --------------------------------------------------------------

case_drift_no_packages() {
    setup_drift_case
    rm -rf "$t/repo/packages"
    # Something to report, so the case fails if the report runs without a folder.
    printf 'foo\n' > "$t/stub/apt-mark.out"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    assert_no_drift
    if grep -Fq 'packages/' "$out"; then
        fail "output names packages/ despite no packages folder"
    fi
}

case_drift_none() {
    setup_drift_case
    printf 'installed foo\ninstalled bar\n' > "$t/stub/dpkg-query.out"
    printf 'foo\nbar\n' > "$t/stub/apt-mark.out"
    printf 'foo\nbar\n' > "$t/repo/packages/linux/apt.txt"
    printf 'Name  Version  Rev  Tracking  Publisher  Notes\ncode  1.0  1  latest/stable  vscode**  classic\n' > "$t/stub/snap.out"
    printf 'code classic\n' > "$t/repo/packages/linux/snap.txt"
    mkdir -p "$t/home/.nvm/versions/node/v1.0.0/lib/node_modules/foo"
    printf 'foo\n' > "$t/repo/packages/linux/npm.txt"
    printf 'bar 1.2.3\n' > "$t/stub/pipx.out"
    printf 'bar\n' > "$t/repo/packages/linux/pipx.txt"
    printf 'a.b\n' > "$t/stub/code.out"
    printf 'a.b\n' > "$t/repo/packages/linux/vscode-extensions.txt"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    assert_no_drift
}

case_drift_empty_list() {
    setup_drift_case
    printf '# nothing installed\n' > "$t/repo/packages/linux/apt.txt"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    assert_no_drift
    if grep -qE '^  DRIFT +apt/[[:space:]]' "$out"; then
        fail "output has a DRIFT line with a blank apt name"
    fi
}

case_drift_apt_extra() {
    setup_drift_case
    printf 'foo\n' > "$t/stub/apt-mark.out"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status DRIFT apt/foo 'installed, not in packages/linux/apt.txt' \
        || fail "missing DRIFT apt/foo line"
}

case_drift_apt_missing() {
    setup_drift_case
    printf 'foo\n' > "$t/repo/packages/linux/apt.txt"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status DRIFT apt/foo 'in packages/linux/apt.txt, not installed' \
        || fail "missing DRIFT apt/foo line"
}

case_drift_apt_auto_listed() {
    setup_drift_case
    printf 'foo\n' > "$t/repo/packages/linux/apt.txt"
    printf 'installed foo\n' > "$t/stub/dpkg-query.out"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    assert_no_drift
}

case_drift_apt_not_installed_state() {
    setup_drift_case
    printf 'foo\n' > "$t/repo/packages/linux/apt.txt"
    printf 'config-files foo\n' > "$t/stub/dpkg-query.out"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status DRIFT apt/foo 'in packages/linux/apt.txt, not installed' \
        || fail "missing DRIFT apt/foo (not installed state) line"
}

case_drift_apt_ignored() {
    setup_drift_case
    printf 'foo\n' > "$t/stub/apt-mark.out"
    printf 'apt foo\n' > "$t/repo/packages/linux/drift-ignore.txt"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    assert_no_drift
}

case_drift_apt_ignore_other_manager() {
    setup_drift_case
    printf 'foo\n' > "$t/stub/apt-mark.out"
    printf 'snap foo\n' > "$t/repo/packages/linux/drift-ignore.txt"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status DRIFT apt/foo 'installed, not in packages/linux/apt.txt' \
        || fail "missing DRIFT apt/foo line"
}

case_drift_apt_arch_suffix() {
    setup_drift_case
    printf 'foo:i386\n' > "$t/stub/apt-mark.out"
    printf 'installed foo\n' > "$t/stub/dpkg-query.out"
    printf 'foo\n' > "$t/repo/packages/linux/apt.txt"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    assert_no_drift
}

case_drift_deb_listed() {
    setup_drift_case
    printf 'foo https://example.com/foo.deb %s\n' "$PACKAGES_HASH" > "$t/repo/packages/linux/deb.txt"
    printf 'installed foo\n' > "$t/stub/dpkg-query.out"
    printf 'foo\n' > "$t/stub/apt-mark.out"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    assert_no_drift
}

case_drift_deb_missing() {
    setup_drift_case
    printf 'foo https://example.com/foo.deb %s\n' "$PACKAGES_HASH" > "$t/repo/packages/linux/deb.txt"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status DRIFT apt/foo 'in packages/linux/deb.txt, not installed' \
        || fail "missing DRIFT apt/foo line"
}

case_drift_snap_notes() {
    setup_drift_case
    printf 'foo\nbar\n' > "$t/repo/packages/linux/snap.txt"
    printf 'Name  Version  Rev  Tracking  Publisher  Notes\ncore22  20250101  1  latest/stable  canonical**  base\ncore24  20250101  1  latest/stable  canonical**  base,held\nsnapd  2.66  1  latest/stable  canonical**  snapd\nfoo  1.0  1  latest/stable  someone  -\nbar  2.0  1  latest/stable  someone  classic\n' > "$t/stub/snap.out"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    assert_no_drift
}

case_drift_snap_options() {
    setup_drift_case
    printf 'foo classic channel=v1/stable\n' > "$t/repo/packages/linux/snap.txt"
    printf 'Name  Version  Rev  Tracking  Publisher  Notes\nfoo  1.0  1  v1/stable  someone  classic\n' > "$t/stub/snap.out"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    assert_no_drift
}

case_drift_snap_extra() {
    setup_drift_case
    printf 'Name  Version  Rev  Tracking  Publisher  Notes\nfoo  1.0  1  latest/stable  someone  classic\n' > "$t/stub/snap.out"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status DRIFT snap/foo 'installed, not in packages/linux/snap.txt' \
        || fail "missing DRIFT snap/foo line"
}

case_drift_snap_missing() {
    setup_drift_case
    printf 'foo\n' > "$t/repo/packages/linux/snap.txt"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status DRIFT snap/foo 'in packages/linux/snap.txt, not installed' \
        || fail "missing DRIFT snap/foo line"
}

case_drift_npm_extra() {
    setup_drift_case
    mkdir -p "$t/home/.nvm/versions/node/v1.0.0/lib/node_modules/foo"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status DRIFT npm/foo 'installed, not in packages/linux/npm.txt' \
        || fail "missing DRIFT npm/foo line"
}

case_drift_npm_scoped() {
    setup_drift_case
    mkdir -p "$t/home/.nvm/versions/node/v1.0.0/lib/node_modules/@a/b"
    printf '@a/b\n' > "$t/repo/packages/linux/npm.txt"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    assert_no_drift
}

case_drift_npm_newest() {
    setup_drift_case
    mkdir -p "$t/home/.nvm/versions/node/v9.0.0/lib/node_modules/x"
    mkdir -p "$t/home/.nvm/versions/node/v10.0.0/lib/node_modules/y"
    printf 'y\n' > "$t/repo/packages/linux/npm.txt"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    assert_no_drift
}

case_drift_npm_hidden() {
    setup_drift_case
    mkdir -p "$t/home/.nvm/versions/node/v1.0.0/lib/node_modules/.bin"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    assert_no_drift
}

case_drift_npm_no_call() {
    setup_drift_case
    cat > "$t/bin/npm" <<EOF
#!/bin/sh
touch "$t/called"
EOF
    chmod +x "$t/bin/npm"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    [[ ! -e "$t/called" ]] || fail "the npm stub was called"
}

case_drift_npm_no_nvm() {
    setup_drift_case
    rm -rf "$t/home/.nvm"
    printf 'foo\n' > "$t/stub/apt-mark.out"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status SKIPPED packages/linux/npm.txt 'nvm not installed' \
        || fail "missing SKIPPED nvm not installed line"
    output_has_status DRIFT apt/foo 'installed, not in packages/linux/apt.txt' \
        || fail "apt did not still report after npm was skipped"
}

case_drift_pipx() {
    setup_drift_case
    printf 'foo 1.2.3\n' > "$t/stub/pipx.out"
    printf 'foo\n' > "$t/repo/packages/linux/pipx.txt"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    assert_no_drift
}

case_drift_vscode() {
    setup_drift_case
    printf 'a.b\n' > "$t/stub/code.out"
    printf 'c.d\n' > "$t/repo/packages/linux/vscode-extensions.txt"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status DRIFT vscode/a.b 'installed, not in packages/linux/vscode-extensions.txt' \
        || fail "missing DRIFT vscode/a.b line"
    output_has_status DRIFT vscode/c.d 'in packages/linux/vscode-extensions.txt, not installed' \
        || fail "missing DRIFT vscode/c.d line"
}

case_drift_font_ok() {
    setup_drift_case
    printf 'NerdFont v1.2.3 %s\n' "$PACKAGES_HASH" > "$t/repo/packages/linux/fonts.txt"
    mkdir -p "$t/home/.local/share/fonts/NerdFonts/NerdFont"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    assert_no_drift
}

case_drift_font_missing() {
    setup_drift_case
    printf 'NerdFont v1.2.3 %s\n' "$PACKAGES_HASH" > "$t/repo/packages/linux/fonts.txt"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status DRIFT font/NerdFont 'in packages/linux/fonts.txt, not installed' \
        || fail "missing DRIFT font/NerdFont line"
}

case_drift_font_extra() {
    setup_drift_case
    mkdir -p "$t/home/.local/share/fonts/NerdFonts/Other"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status DRIFT font/Other 'installed, not in packages/linux/fonts.txt' \
        || fail "missing DRIFT font/Other line"
}

case_drift_font_loose_file() {
    setup_drift_case
    mkdir -p "$t/home/.local/share/fonts/NerdFonts"
    printf 'not a package\n' > "$t/home/.local/share/fonts/NerdFonts/.uuid"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    assert_no_drift
}

case_drift_extension_ok() {
    setup_drift_case
    printf 'uuid@example https://github.com/a/b %s\n' "${PACKAGES_HASH:0:40}" \
        > "$t/repo/packages/linux/gnome-extensions.txt"
    mkdir -p "$t/home/.local/share/gnome-shell/extensions/uuid@example"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    assert_no_drift
}

case_drift_extension_missing() {
    setup_drift_case
    printf 'uuid@example https://github.com/a/b %s\n' "${PACKAGES_HASH:0:40}" \
        > "$t/repo/packages/linux/gnome-extensions.txt"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status DRIFT extension/uuid@example 'in packages/linux/gnome-extensions.txt, not installed' \
        || fail "missing DRIFT extension/uuid@example line"
}

case_drift_extension_extra() {
    setup_drift_case
    mkdir -p "$t/home/.local/share/gnome-shell/extensions/uuid@example"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status DRIFT extension/uuid@example 'installed, not in packages/linux/gnome-extensions.txt' \
        || fail "missing DRIFT extension/uuid@example line"
}

case_drift_no_folders() {
    setup_drift_case
    : > "$t/repo/packages/linux/fonts.txt"
    : > "$t/repo/packages/linux/gnome-extensions.txt"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    assert_no_drift
    if grep -qE '^  SKIPPED' "$out"; then
        fail "unexpected SKIPPED line for a missing folder"
    fi
}

case_drift_source_ok() {
    setup_drift_case
    mkdir -p "$t/repo/packages/linux/apt-sources" "$t/root/etc/apt/sources.list.d"
    printf 'Types: deb\nURIs: https://example.com/repo\n' \
        > "$t/repo/packages/linux/apt-sources/example.sources"
    printf 'Types: deb\nURIs: https://example.com/repo\n' \
        > "$t/root/etc/apt/sources.list.d/example.sources"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    assert_no_drift
}

case_drift_source_differs() {
    setup_drift_case
    mkdir -p "$t/repo/packages/linux/apt-sources" "$t/root/etc/apt/sources.list.d"
    printf 'Types: deb\nURIs: https://example.com/repo\n' \
        > "$t/repo/packages/linux/apt-sources/example.sources"
    printf 'Types: deb\nURIs: https://example.com/repoo\n' \
        > "$t/root/etc/apt/sources.list.d/example.sources"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status DRIFT apt-source/example.sources 'differs from packages/linux/apt-sources' \
        || fail "missing DRIFT apt-source/example.sources differs line"
}

case_drift_source_missing() {
    setup_drift_case
    mkdir -p "$t/repo/packages/linux/apt-sources"
    printf 'Types: deb\nURIs: https://example.com/repo\n' \
        > "$t/repo/packages/linux/apt-sources/example.sources"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status DRIFT apt-source/example.sources 'in packages/linux/apt-sources, not installed' \
        || fail "missing DRIFT apt-source/example.sources line"
}

case_drift_source_extra() {
    setup_drift_case
    mkdir -p "$t/root/etc/apt/sources.list.d"
    printf 'Types: deb\nURIs: https://example.com/repo\n' \
        > "$t/root/etc/apt/sources.list.d/example.sources"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status DRIFT apt-source/example.sources 'installed, not in packages/linux/apt-sources' \
        || fail "missing DRIFT apt-source/example.sources extra line"
}

case_drift_source_ignored() {
    setup_drift_case
    mkdir -p "$t/root/etc/apt/sources.list.d"
    printf 'Types: deb\nURIs: https://example.com/repo\n' \
        > "$t/root/etc/apt/sources.list.d/example.sources"
    printf 'apt-source example.sources\n' > "$t/repo/packages/linux/drift-ignore.txt"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    assert_no_drift
}

case_drift_key_usr_share() {
    setup_drift_case
    mkdir -p "$t/repo/packages/linux/apt-sources/keyrings" "$t/root/usr/share/keyrings"
    printf 'key\n' > "$t/repo/packages/linux/apt-sources/keyrings/example.gpg"
    printf 'key\n' > "$t/root/usr/share/keyrings/example.gpg"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    assert_no_drift
}

case_drift_key_etc_apt() {
    setup_drift_case
    mkdir -p "$t/repo/packages/linux/apt-sources/keyrings" "$t/root/etc/apt/keyrings"
    printf 'key\n' > "$t/repo/packages/linux/apt-sources/keyrings/example.gpg"
    printf 'key\n' > "$t/root/etc/apt/keyrings/example.gpg"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    assert_no_drift
}

case_drift_key_differs() {
    setup_drift_case
    mkdir -p "$t/repo/packages/linux/apt-sources/keyrings" "$t/root/usr/share/keyrings"
    printf 'key\n' > "$t/repo/packages/linux/apt-sources/keyrings/example.gpg"
    printf 'kex\n' > "$t/root/usr/share/keyrings/example.gpg"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status DRIFT apt-key/example.gpg 'differs from packages/linux/apt-sources' \
        || fail "missing DRIFT apt-key/example.gpg differs line"
}

case_drift_key_missing() {
    setup_drift_case
    mkdir -p "$t/repo/packages/linux/apt-sources/keyrings"
    printf 'key\n' > "$t/repo/packages/linux/apt-sources/keyrings/example.gpg"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status DRIFT apt-key/example.gpg 'in packages/linux/apt-sources, not installed' \
        || fail "missing DRIFT apt-key/example.gpg line"
}

case_drift_key_stock_ignored() {
    setup_drift_case
    mkdir -p "$t/repo/packages/linux/apt-sources/keyrings" "$t/root/usr/share/keyrings"
    printf 'key\n' > "$t/repo/packages/linux/apt-sources/keyrings/example.gpg"
    printf 'key\n' > "$t/root/usr/share/keyrings/example.gpg"
    printf 'stock\n' > "$t/root/usr/share/keyrings/stock.gpg"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    assert_no_drift
}

case_drift_tool_missing() {
    setup_drift_case
    # A PATH with every tool export.sh needs but none of the drift tools, so the
    # report prints "not installed" for each instead of reaching the real ones.
    local stub=$t/stubpath tool
    mkdir -p "$stub"
    for tool in bash dirname jq find sort cat cp cmp chmod mkdir rm git uname awk sed comm tail; do
        ln -s "$(command -v "$tool")" "$stub/$tool"
    done

    rc=0
    (cd "$t/repo" && HOME="$t/home" PATH="$stub" DRIFT_ROOT="$t/root" ./export.sh < /dev/null) > "$out" 2>&1 || rc=$?
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status SKIPPED packages/linux/snap.txt 'snap not installed' \
        || fail "missing SKIPPED (snap not installed) line"
}

case_drift_tool_fails() {
    setup_drift_case
    printf '1\n' > "$t/stub/snap.rc"
    printf 'bar 1.0\n' > "$t/stub/pipx.out"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status SKIPPED packages/linux/snap.txt 'snap failed' \
        || fail "missing SKIPPED (snap failed) line"
    output_has_status DRIFT pipx/bar 'installed, not in packages/linux/pipx.txt' \
        || fail "pipx did not still report after snap failed"
}

case_drift_counts_unchanged() {
    setup_drift_case
    printf 'foo\n' > "$t/stub/apt-mark.out"
    printf 'bar 1.0\n' > "$t/stub/pipx.out"
    printf 'c.d\n' > "$t/repo/packages/linux/vscode-extensions.txt"
    printf '1\n' > "$t/stub/snap.rc"

    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"

    local drift_count
    drift_count=$(grep -cE '^  DRIFT[[:space:]]' "$out" || true)
    (( drift_count == 3 )) || fail "found $drift_count DRIFT lines, want 3"
    output_has_status DRIFT apt/foo 'installed, not in packages/linux/apt.txt' \
        || fail "missing DRIFT apt/foo line"
    output_has_status DRIFT pipx/bar 'installed, not in packages/linux/pipx.txt' \
        || fail "missing DRIFT pipx/bar line"
    output_has_status DRIFT vscode/c.d 'in packages/linux/vscode-extensions.txt, not installed' \
        || fail "missing DRIFT vscode/c.d line"
    output_has_status SKIPPED packages/linux/snap.txt 'snap failed' \
        || fail "missing SKIPPED (snap failed) line"
    grep -Fq 'Repo is up to date' "$out" || fail "missing 'Repo is up to date' line"
    if grep -Fq 'file(s) skipped' "$out"; then
        fail "unexpected 'file(s) skipped' note"
    fi
}

case_drift_unreadable_list() {
    setup_drift_case
    printf 'foo\n' > "$t/repo/packages/linux/apt.txt"
    chmod 000 "$t/repo/packages/linux/apt.txt"
    printf 'bar 1.0\n' > "$t/stub/pipx.out"

    run_drift
    chmod 644 "$t/repo/packages/linux/apt.txt"
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    output_has_status DRIFT pipx/bar 'installed, not in packages/linux/pipx.txt' \
        || fail "pipx did not still report after an unreadable list"
    grep -Fq 'Repo is up to date' "$out" || fail "the export stopped before its summary"
}

case_drift_writes_nothing() {
    setup_drift_case
    printf 'foo\n' > "$t/repo/packages/linux/apt.txt"
    printf 'foo\n' > "$t/stub/apt-mark.out"

    local before
    before=$(tree_hash "$t/repo/packages")
    run_drift
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    [[ $(tree_hash "$t/repo/packages") == "$before" ]] || fail "packages/ changed during export"
}

case_drift_preview() {
    setup_drift_case
    mkdir -p "$t/repo/scripts/ci"
    cp -a "$REPO/scripts/ci/." "$t/repo/scripts/ci/"
    printf '# no apt packages\n' > "$t/repo/packages/linux/apt.txt"
    printf 'foo\n' > "$t/stub/apt-mark.out"
    make_git_repo

    local repo_before
    repo_before=$(tree_hash "$t/repo")

    PATH="$t/bin:$PATH" DRIFT_ROOT="$t/root" run_engine "$t/home" export.sh --preview
    (( rc == 0 )) || fail "preview exited $rc, want 0"
    output_has_status DRIFT apt/foo 'installed, not in packages/linux/apt.txt' \
        || fail "missing DRIFT line in preview"
    grep -Fq 'Nothing would be sent' "$out" || fail "missing 'Nothing would be sent' line"
    [[ $(tree_hash "$t/repo") == "$repo_before" ]] || fail "repo changed during preview"
}

case_drift_import_silent() {
    setup_drift_case
    printf 'foo\n' > "$t/stub/apt-mark.out"

    PATH="$t/bin:$PATH" DRIFT_ROOT="$t/root" run_engine "$t/home" import.sh --force
    (( rc == 0 )) || fail "import.sh exited $rc, want 0"
    if grep -qE '^  DRIFT[[:space:]]' "$out"; then
        fail "import printed a DRIFT line"
    fi
}

# -- Runner --------------------------------------------------------------------

for case_name in import-creates export-adds roundtrip-unchanged import-backup excluded excluded-credentials noninteractive-missing-value prompt-empty-stops defaultenv-invalid defaultenv-valid values-mode-new values-mode-tightened error-continues import-eof-overwrites crlf-unchanged common-import common-export missing-platform path-repo-traversal path-repo-outside path-local-traversal path-local-absolute path-repo-symlink path-real-config real-config-roundtrip real-config-dconf-restore lint-real-config lint-real-packages lint-platform-missing lint-platform-bad lint-linux-prefix lint-dir-with-rules lint-file-in-dir lint-typed-file-in-dir lint-dir-in-dir lint-dir-trailing-slash lint-sibling-prefix lint-windows-root lint-windows-sibling lint-windows-linux-prefix lint-windows-ok lint-packages-ok lint-packages-empty-dir lint-packages-no-dir lint-packages-comments lint-packages-apt-shell lint-packages-apt-upper lint-packages-apt-two-fields lint-packages-unsorted lint-packages-duplicate lint-packages-deb-http lint-packages-deb-no-hash lint-packages-deb-short-hash lint-packages-deb-subshell lint-packages-tools-ok lint-packages-tools-unknown lint-packages-tools-http lint-packages-tools-host lint-packages-tools-short-hash lint-packages-tools-unsorted lint-packages-snap-options lint-packages-snap-order lint-packages-npm-scoped lint-packages-snap-flag lint-packages-npm-flag lint-packages-npm-scope-flag lint-packages-npm-path lint-packages-pipx-flag lint-packages-pipx-path lint-packages-vscode-flag lint-packages-extension-flag lint-packages-extension-repo-path lint-packages-vscode-upper lint-packages-font-no-tag lint-packages-extension-other-host lint-packages-extension-branch lint-packages-ignore-manager lint-packages-unknown-file lint-packages-apt-and-deb lint-packages-listed-and-ignored lint-packages-same-name-other-manager lint-packages-source-http lint-packages-list-http lint-packages-source-unsigned lint-packages-source-key-missing lint-packages-source-key-elsewhere lint-packages-key-unused lint-packages-source-other-file lint-packages-source-real-shapes lint-packages-source-uris-lowercase lint-packages-source-uri-continuation lint-packages-source-second-stanza lint-packages-source-trusted lint-packages-source-key-dotdot lint-packages-source-key-empty lint-packages-list-second-line lint-packages-list-deb-src-http lint-packages-list-trusted lint-packages-list-other-line lint-packages-symlink lint-packages-other-dir lint-packages-key-deep lint-packages-source-key-continuation lint-packages-source-allow-insecure lint-packages-source-field-space lint-packages-list-allow-insecure lint-plugins-ok lint-plugins-undeclared lint-plugins-no-at lint-plugins-url-source lint-plugins-bad-repo lint-plugins-bad-ref lint-plugins-placeholder lint-plugins-newline lint-plugins-missing lint-real-plugins path-dotted-name escape-import escape-export escape-roundtrip-unchanged sanitize-longest-first sanitized-large-file sanitized-case-change infer-name infer-reset infer-keeps-cache infer-escaped infer-skips-unhydrated-local infer-overlapping-context dir-export-adds dir-export-modify-remove dir-export-excluded dir-export-missing dir-export-symlink dir-export-empty-keeps-repo dir-export-only-excluded dir-export-only-symlink dir-export-one-left dir-export-empty-both dir-root-symlink dir-symlink-removed dir-import-creates dir-import-update-backup dir-import-extra dir-roundtrip-unchanged dir-import-prompt-reads-stdin orphan-reported orphan-none orphan-linked-ok orphan-no-dir-entries upstream-none upstream-current upstream-behind-noninteractive upstream-behind-pull upstream-unreachable upstream-off-master preview-writes-nothing preview-shows-diff preview-matches-export preview-includes-uncommitted preview-no-changes preview-sanitized preview-leak-found preview-cleans-up preview-reset-rejected preview-not-a-repo commit-happy commit-leak-blocked commit-packages commit-packages-leak-blocked commit-scan-missing commit-outside-changes commit-value-blocked commit-value-case-variant commit-value-doubled commit-value-untracked commit-value-placeholder-only commit-value-not-printed preview-scan-missing sync-usage sync-unknown sync-routes-export sync-routes-import sync-routes-preview sync-missing-tool host-git-config-ignored leak-extension-enabled leak-extension-disabled leak-email-other-key leak-email-other-file leak-email-other-suffix leak-email-key-in-value leak-gnome-list-ok leak-gnome-list-comment leak-gnome-list-extra-field leak-gnome-list-url-address leak-gnome-list-short-commit leak-gnome-other-file dconf-test-bus dconf-config-valid dconf-path-missing dconf-path-relative dconf-path-no-slash dconf-path-root dconf-path-double-slash dconf-path-dotdot dconf-path-space dconf-platform-common dconf-platform-windows dconf-repo-unsafe dconf-symlink-named dconf-orphan-owned lint-dconf-ok lint-dconf-path lint-dconf-root lint-dconf-platform lint-dconf-localpath lint-dconf-rules lint-dconf-linked lint-dconf-keys-empty lint-dconf-keys-type lint-keys-on-file lint-path-on-dir lint-type-unknown dconf-export-adds dconf-export-unchanged dconf-export-modifies dconf-export-keys dconf-export-keys-no-root dconf-export-keys-nested dconf-export-keys-glob dconf-ptyxis-profile-keys dconf-export-keep-all dconf-export-no-settings dconf-export-no-settings-keeps-repo dconf-export-keys-empty-result dconf-export-missing-tool dconf-export-fails dconf-export-write-fails dconf-preview-read-only dconf-import-creates dconf-import-unchanged dconf-import-local-extra dconf-import-update-yes dconf-import-update-no dconf-import-force dconf-import-eof dconf-import-merge dconf-import-no-repo-file dconf-import-wrong-home dconf-import-other-config dconf-import-config-unset dconf-import-missing-tool dconf-import-bad-file dconf-import-prompt-reads-stdin dconf-roundtrip-values dconf-roundtrip-settles drift-no-packages drift-none drift-empty-list drift-apt-extra drift-apt-missing drift-apt-auto-listed drift-apt-not-installed-state drift-apt-ignored drift-apt-ignore-other-manager drift-apt-arch-suffix drift-deb-listed drift-deb-missing drift-snap-notes drift-snap-options drift-snap-extra drift-snap-missing drift-npm-extra drift-npm-scoped drift-npm-newest drift-npm-hidden drift-npm-no-call drift-npm-no-nvm drift-pipx drift-vscode drift-font-ok drift-font-missing drift-font-extra drift-font-loose-file drift-extension-ok drift-extension-missing drift-extension-extra drift-no-folders drift-source-ok drift-source-differs drift-source-missing drift-source-extra drift-source-ignored drift-key-usr-share drift-key-etc-apt drift-key-differs drift-key-missing drift-key-stock-ignored drift-tool-missing drift-tool-fails drift-counts-unchanged drift-writes-nothing drift-unreadable-list drift-preview drift-import-silent; do
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
        excluded-credentials) case_excluded_credentials ;;
        noninteractive-missing-value) case_noninteractive_missing_value ;;
        prompt-empty-stops) case_prompt_empty_stops ;;
        defaultenv-invalid) case_defaultenv_invalid ;;
        defaultenv-valid) case_defaultenv_valid ;;
        values-mode-new) case_values_mode_new ;;
        values-mode-tightened) case_values_mode_tightened ;;
        error-continues) case_error_continues ;;
        import-eof-overwrites) case_import_eof_overwrites ;;
        crlf-unchanged) case_crlf_unchanged ;;
        common-import) case_common_import ;;
        common-export) case_common_export ;;
        missing-platform) case_missing_platform ;;
        path-repo-traversal) case_path_repo_traversal ;;
        path-repo-outside) case_path_repo_outside ;;
        path-local-traversal) case_path_local_traversal ;;
        path-local-absolute) case_path_local_absolute ;;
        path-repo-symlink) case_path_repo_symlink ;;
        path-real-config) case_path_real_config ;;
        real-config-roundtrip) case_real_config_roundtrip ;;
        real-config-dconf-restore) case_real_config_dconf_restore ;;
        lint-real-config) case_lint_real_config ;;
        lint-real-packages) case_lint_real_packages ;;
        lint-platform-missing) case_lint_platform_missing ;;
        lint-platform-bad) case_lint_platform_bad ;;
        lint-linux-prefix) case_lint_linux_prefix ;;
        lint-dir-with-rules) case_lint_dir_with_rules ;;
        lint-file-in-dir) case_lint_file_in_dir ;;
        lint-typed-file-in-dir) case_lint_typed_file_in_dir ;;
        lint-dir-in-dir) case_lint_dir_in_dir ;;
        lint-dir-trailing-slash) case_lint_dir_trailing_slash ;;
        lint-sibling-prefix) case_lint_sibling_prefix ;;
        lint-windows-root) case_lint_windows_root ;;
        lint-windows-sibling) case_lint_windows_sibling ;;
        lint-windows-linux-prefix) case_lint_windows_linux_prefix ;;
        lint-windows-ok) case_lint_windows_ok ;;
        lint-packages-ok) case_lint_packages_ok ;;
        lint-packages-empty-dir) case_lint_packages_empty_dir ;;
        lint-packages-no-dir) case_lint_packages_no_dir ;;
        lint-packages-comments) case_lint_packages_comments ;;
        lint-packages-apt-shell) case_lint_packages_apt_shell ;;
        lint-packages-apt-upper) case_lint_packages_apt_upper ;;
        lint-packages-apt-two-fields) case_lint_packages_apt_two_fields ;;
        lint-packages-unsorted) case_lint_packages_unsorted ;;
        lint-packages-duplicate) case_lint_packages_duplicate ;;
        lint-packages-deb-http) case_lint_packages_deb_http ;;
        lint-packages-deb-no-hash) case_lint_packages_deb_no_hash ;;
        lint-packages-deb-short-hash) case_lint_packages_deb_short_hash ;;
        lint-packages-deb-subshell) case_lint_packages_deb_subshell ;;
        lint-packages-tools-ok) case_lint_packages_tools_ok ;;
        lint-packages-tools-unknown) case_lint_packages_tools_unknown ;;
        lint-packages-tools-http) case_lint_packages_tools_http ;;
        lint-packages-tools-host) case_lint_packages_tools_host ;;
        lint-packages-tools-short-hash) case_lint_packages_tools_short_hash ;;
        lint-packages-tools-unsorted) case_lint_packages_tools_unsorted ;;
        lint-packages-snap-options) case_lint_packages_snap_options ;;
        lint-packages-snap-order) case_lint_packages_snap_order ;;
        lint-packages-npm-scoped) case_lint_packages_npm_scoped ;;
        lint-packages-snap-flag) case_lint_packages_snap_flag ;;
        lint-packages-npm-flag) case_lint_packages_npm_flag ;;
        lint-packages-npm-scope-flag) case_lint_packages_npm_scope_flag ;;
        lint-packages-npm-path) case_lint_packages_npm_path ;;
        lint-packages-pipx-flag) case_lint_packages_pipx_flag ;;
        lint-packages-pipx-path) case_lint_packages_pipx_path ;;
        lint-packages-vscode-flag) case_lint_packages_vscode_flag ;;
        lint-packages-extension-flag) case_lint_packages_extension_flag ;;
        lint-packages-extension-repo-path) case_lint_packages_extension_repo_path ;;
        drift-unreadable-list) case_drift_unreadable_list ;;
        lint-packages-vscode-upper) case_lint_packages_vscode_upper ;;
        lint-packages-font-no-tag) case_lint_packages_font_no_tag ;;
        lint-packages-extension-other-host) case_lint_packages_extension_other_host ;;
        lint-packages-extension-branch) case_lint_packages_extension_branch ;;
        lint-packages-ignore-manager) case_lint_packages_ignore_manager ;;
        lint-packages-unknown-file) case_lint_packages_unknown_file ;;
        lint-packages-apt-and-deb) case_lint_packages_apt_and_deb ;;
        lint-packages-listed-and-ignored) case_lint_packages_listed_and_ignored ;;
        lint-packages-same-name-other-manager) case_lint_packages_same_name_other_manager ;;
        lint-packages-source-http) case_lint_packages_source_http ;;
        lint-packages-list-http) case_lint_packages_list_http ;;
        lint-packages-source-unsigned) case_lint_packages_source_unsigned ;;
        lint-packages-source-key-missing) case_lint_packages_source_key_missing ;;
        lint-packages-source-key-elsewhere) case_lint_packages_source_key_elsewhere ;;
        lint-packages-key-unused) case_lint_packages_key_unused ;;
        lint-packages-source-other-file) case_lint_packages_source_other_file ;;
        lint-packages-source-real-shapes) case_lint_packages_source_real_shapes ;;
        lint-packages-source-uris-lowercase) case_lint_packages_source_uris_lowercase ;;
        lint-packages-source-uri-continuation) case_lint_packages_source_uri_continuation ;;
        lint-packages-source-second-stanza) case_lint_packages_source_second_stanza ;;
        lint-packages-source-trusted) case_lint_packages_source_trusted ;;
        lint-packages-source-key-dotdot) case_lint_packages_source_key_dotdot ;;
        lint-packages-source-key-empty) case_lint_packages_source_key_empty ;;
        lint-packages-list-second-line) case_lint_packages_list_second_line ;;
        lint-packages-list-deb-src-http) case_lint_packages_list_deb_src_http ;;
        lint-packages-list-trusted) case_lint_packages_list_trusted ;;
        lint-packages-list-other-line) case_lint_packages_list_other_line ;;
        lint-packages-symlink) case_lint_packages_symlink ;;
        lint-packages-other-dir) case_lint_packages_other_dir ;;
        lint-packages-key-deep) case_lint_packages_key_deep ;;
        lint-packages-source-key-continuation) case_lint_packages_source_key_continuation ;;
        lint-packages-source-allow-insecure) case_lint_packages_source_allow_insecure ;;
        lint-packages-source-field-space) case_lint_packages_source_field_space ;;
        lint-packages-list-allow-insecure) case_lint_packages_list_allow_insecure ;;
        lint-plugins-ok) case_lint_plugins_ok ;;
        lint-plugins-undeclared) case_lint_plugins_undeclared ;;
        lint-plugins-no-at) case_lint_plugins_no_at ;;
        lint-plugins-url-source) case_lint_plugins_url_source ;;
        lint-plugins-bad-repo) case_lint_plugins_bad_repo ;;
        lint-plugins-bad-ref) case_lint_plugins_bad_ref ;;
        lint-plugins-placeholder) case_lint_plugins_placeholder ;;
        lint-plugins-newline) case_lint_plugins_newline ;;
        lint-plugins-missing) case_lint_plugins_missing ;;
        lint-real-plugins) case_lint_real_plugins ;;
        path-dotted-name) case_path_dotted_name ;;
        escape-import) case_escape_import ;;
        escape-export) case_escape_export ;;
        escape-roundtrip-unchanged) case_escape_roundtrip_unchanged ;;
        sanitize-longest-first) case_sanitize_longest_first ;;
        sanitized-large-file) case_sanitized_large_file ;;
        sanitized-case-change) case_sanitized_case_change ;;
        infer-name) case_infer_name ;;
        infer-reset) case_infer_reset ;;
        infer-keeps-cache) case_infer_keeps_cache ;;
        infer-escaped) case_infer_escaped ;;
        infer-skips-unhydrated-local) case_infer_skips_unhydrated_local ;;
        infer-overlapping-context) case_infer_overlapping_context ;;
        dir-export-adds) case_dir_export_adds ;;
        dir-export-modify-remove) case_dir_export_modify_remove ;;
        dir-export-excluded) case_dir_export_excluded ;;
        dir-export-missing) case_dir_export_missing ;;
        dir-export-symlink) case_dir_export_symlink ;;
        dir-export-empty-keeps-repo) case_dir_export_empty_keeps_repo ;;
        dir-export-only-excluded) case_dir_export_only_excluded ;;
        dir-export-only-symlink) case_dir_export_only_symlink ;;
        dir-export-one-left) case_dir_export_one_left ;;
        dir-export-empty-both) case_dir_export_empty_both ;;
        dir-root-symlink) case_dir_root_symlink ;;
        dir-symlink-removed) case_dir_symlink_removed ;;
        dir-import-creates) case_dir_import_creates ;;
        dir-import-update-backup) case_dir_import_update_backup ;;
        dir-import-extra) case_dir_import_extra ;;
        dir-roundtrip-unchanged) case_dir_roundtrip_unchanged ;;
        dir-import-prompt-reads-stdin) case_dir_import_prompt_reads_stdin ;;
        orphan-reported) case_orphan_reported ;;
        orphan-none) case_orphan_none ;;
        orphan-linked-ok) case_orphan_linked_ok ;;
        orphan-no-dir-entries) case_orphan_no_dir_entries ;;
        upstream-none) case_upstream_none ;;
        upstream-current) case_upstream_current ;;
        upstream-behind-noninteractive) case_upstream_behind_noninteractive ;;
        upstream-behind-pull) case_upstream_behind_pull ;;
        upstream-unreachable) case_upstream_unreachable ;;
        upstream-off-master) case_upstream_off_master ;;
        preview-writes-nothing) case_preview_writes_nothing ;;
        preview-shows-diff) case_preview_shows_diff ;;
        preview-matches-export) case_preview_matches_export ;;
        preview-includes-uncommitted) case_preview_includes_uncommitted ;;
        preview-no-changes) case_preview_no_changes ;;
        preview-sanitized) case_preview_sanitized ;;
        preview-leak-found) case_preview_leak_found ;;
        preview-cleans-up) case_preview_cleans_up ;;
        preview-reset-rejected) case_preview_reset_rejected ;;
        preview-not-a-repo) case_preview_not_a_repo ;;
        commit-happy) case_commit_happy ;;
        commit-leak-blocked) case_commit_leak_blocked ;;
        commit-packages) case_commit_packages ;;
        commit-packages-leak-blocked) case_commit_packages_leak_blocked ;;
        commit-scan-missing) case_commit_scan_missing ;;
        commit-outside-changes) case_commit_outside_changes ;;
        commit-value-blocked) case_commit_value_blocked ;;
        commit-value-case-variant) case_commit_value_case_variant ;;
        commit-value-doubled) case_commit_value_doubled ;;
        commit-value-untracked) case_commit_value_untracked ;;
        commit-value-placeholder-only) case_commit_value_placeholder_only ;;
        commit-value-not-printed) case_commit_value_not_printed ;;
        preview-scan-missing) case_preview_scan_missing ;;
        sync-usage) case_sync_usage ;;
        sync-unknown) case_sync_unknown ;;
        sync-routes-export) case_sync_routes_export ;;
        sync-routes-import) case_sync_routes_import ;;
        sync-routes-preview) case_sync_routes_preview ;;
        sync-missing-tool) case_sync_missing_tool ;;
        host-git-config-ignored) case_host_git_config_ignored ;;
        leak-extension-enabled) case_leak_extension_enabled ;;
        leak-extension-disabled) case_leak_extension_disabled ;;
        leak-email-other-key) case_leak_email_other_key ;;
        leak-email-other-file) case_leak_email_other_file ;;
        leak-email-other-suffix) case_leak_email_other_suffix ;;
        leak-email-key-in-value) case_leak_email_key_in_value ;;
        leak-gnome-list-ok) case_leak_gnome_list_ok ;;
        leak-gnome-list-comment) case_leak_gnome_list_comment ;;
        leak-gnome-list-extra-field) case_leak_gnome_list_extra_field ;;
        leak-gnome-list-url-address) case_leak_gnome_list_url_address ;;
        leak-gnome-list-short-commit) case_leak_gnome_list_short_commit ;;
        leak-gnome-other-file) case_leak_gnome_other_file ;;
        dconf-test-bus) case_dconf_test_bus ;;
        dconf-config-valid) case_dconf_config_valid ;;
        dconf-path-missing) case_dconf_path_missing ;;
        dconf-path-relative) case_dconf_path_relative ;;
        dconf-path-no-slash) case_dconf_path_no_slash ;;
        dconf-path-root) case_dconf_path_root ;;
        dconf-path-double-slash) case_dconf_path_double_slash ;;
        dconf-path-dotdot) case_dconf_path_dotdot ;;
        dconf-path-space) case_dconf_path_space ;;
        dconf-platform-common) case_dconf_platform_common ;;
        dconf-platform-windows) case_dconf_platform_windows ;;
        dconf-repo-unsafe) case_dconf_repo_unsafe ;;
        dconf-symlink-named) case_dconf_symlink_named ;;
        dconf-orphan-owned) case_dconf_orphan_owned ;;
        lint-dconf-ok) case_lint_dconf_ok ;;
        lint-dconf-path) case_lint_dconf_path ;;
        lint-dconf-root) case_lint_dconf_root ;;
        lint-dconf-platform) case_lint_dconf_platform ;;
        lint-dconf-localpath) case_lint_dconf_localpath ;;
        lint-dconf-rules) case_lint_dconf_rules ;;
        lint-dconf-linked) case_lint_dconf_linked ;;
        lint-dconf-keys-empty) case_lint_dconf_keys_empty ;;
        lint-dconf-keys-type) case_lint_dconf_keys_type ;;
        lint-keys-on-file) case_lint_keys_on_file ;;
        lint-path-on-dir) case_lint_path_on_dir ;;
        lint-type-unknown) case_lint_type_unknown ;;
        dconf-export-adds) case_dconf_export_adds ;;
        dconf-export-unchanged) case_dconf_export_unchanged ;;
        dconf-export-modifies) case_dconf_export_modifies ;;
        dconf-export-keys) case_dconf_export_keys ;;
        dconf-export-keys-no-root) case_dconf_export_keys_no_root ;;
        dconf-export-keys-nested) case_dconf_export_keys_nested ;;
        dconf-export-keys-glob) case_dconf_export_keys_glob ;;
        dconf-ptyxis-profile-keys) case_dconf_ptyxis_profile_keys ;;
        dconf-export-keep-all) case_dconf_export_keep_all ;;
        dconf-export-no-settings) case_dconf_export_no_settings ;;
        dconf-export-no-settings-keeps-repo) case_dconf_export_no_settings_keeps_repo ;;
        dconf-export-keys-empty-result) case_dconf_export_keys_empty_result ;;
        dconf-export-missing-tool) case_dconf_export_missing_tool ;;
        dconf-export-fails) case_dconf_export_fails ;;
        dconf-export-write-fails) case_dconf_export_write_fails ;;
        dconf-preview-read-only) case_dconf_preview_read_only ;;
        dconf-import-creates) case_dconf_import_creates ;;
        dconf-import-unchanged) case_dconf_import_unchanged ;;
        dconf-import-local-extra) case_dconf_import_local_extra ;;
        dconf-import-update-yes) case_dconf_import_update_yes ;;
        dconf-import-update-no) case_dconf_import_update_no ;;
        dconf-import-force) case_dconf_import_force ;;
        dconf-import-eof) case_dconf_import_eof ;;
        dconf-import-merge) case_dconf_import_merge ;;
        dconf-import-no-repo-file) case_dconf_import_no_repo_file ;;
        dconf-import-wrong-home) case_dconf_import_wrong_home ;;
        dconf-import-other-config) case_dconf_import_other_config ;;
        dconf-import-config-unset) case_dconf_import_config_unset ;;
        dconf-import-missing-tool) case_dconf_import_missing_tool ;;
        dconf-import-bad-file) case_dconf_import_bad_file ;;
        dconf-import-prompt-reads-stdin) case_dconf_import_prompt_reads_stdin ;;
        dconf-roundtrip-values) case_dconf_roundtrip_values ;;
        dconf-roundtrip-settles) case_dconf_roundtrip_settles ;;
        drift-no-packages) case_drift_no_packages ;;
        drift-none) case_drift_none ;;
        drift-empty-list) case_drift_empty_list ;;
        drift-apt-extra) case_drift_apt_extra ;;
        drift-apt-missing) case_drift_apt_missing ;;
        drift-apt-auto-listed) case_drift_apt_auto_listed ;;
        drift-apt-not-installed-state) case_drift_apt_not_installed_state ;;
        drift-apt-ignored) case_drift_apt_ignored ;;
        drift-apt-ignore-other-manager) case_drift_apt_ignore_other_manager ;;
        drift-apt-arch-suffix) case_drift_apt_arch_suffix ;;
        drift-deb-listed) case_drift_deb_listed ;;
        drift-deb-missing) case_drift_deb_missing ;;
        drift-snap-notes) case_drift_snap_notes ;;
        drift-snap-options) case_drift_snap_options ;;
        drift-snap-extra) case_drift_snap_extra ;;
        drift-snap-missing) case_drift_snap_missing ;;
        drift-npm-extra) case_drift_npm_extra ;;
        drift-npm-scoped) case_drift_npm_scoped ;;
        drift-npm-newest) case_drift_npm_newest ;;
        drift-npm-hidden) case_drift_npm_hidden ;;
        drift-npm-no-call) case_drift_npm_no_call ;;
        drift-npm-no-nvm) case_drift_npm_no_nvm ;;
        drift-pipx) case_drift_pipx ;;
        drift-vscode) case_drift_vscode ;;
        drift-font-ok) case_drift_font_ok ;;
        drift-font-missing) case_drift_font_missing ;;
        drift-font-extra) case_drift_font_extra ;;
        drift-font-loose-file) case_drift_font_loose_file ;;
        drift-extension-ok) case_drift_extension_ok ;;
        drift-extension-missing) case_drift_extension_missing ;;
        drift-extension-extra) case_drift_extension_extra ;;
        drift-no-folders) case_drift_no_folders ;;
        drift-source-ok) case_drift_source_ok ;;
        drift-source-differs) case_drift_source_differs ;;
        drift-source-missing) case_drift_source_missing ;;
        drift-source-extra) case_drift_source_extra ;;
        drift-source-ignored) case_drift_source_ignored ;;
        drift-key-usr-share) case_drift_key_usr_share ;;
        drift-key-etc-apt) case_drift_key_etc_apt ;;
        drift-key-differs) case_drift_key_differs ;;
        drift-key-missing) case_drift_key_missing ;;
        drift-key-stock-ignored) case_drift_key_stock_ignored ;;
        drift-tool-missing) case_drift_tool_missing ;;
        drift-tool-fails) case_drift_tool_fails ;;
        drift-counts-unchanged) case_drift_counts_unchanged ;;
        drift-writes-nothing) case_drift_writes_nothing ;;
        drift-preview) case_drift_preview ;;
        drift-import-silent) case_drift_import_silent ;;
        *) fail "no such case: $case_name" ;;
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
