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

    run_engine "$t/home" export.sh
    (( rc == 0 )) || fail "export.sh exited $rc, want 0"
    grep -Fq 'Repo is up to date' "$out" || fail "export did not print 'Repo is up to date'"
    if grep -qE '^  (MODIFIED|ADDED|REMOVED|ORPHAN)[[:space:]]|ERROR' "$out"; then
        fail "export printed a changed status or an error"
    fi

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

case_lint_real_config() {
    new_tmp

    # No argument: the default file and the default output line.
    rc=0
    (cd "$REPO" && scripts/ci/check-config.sh) > "$out" 2>&1 || rc=$?
    (( rc == 0 )) || fail "check-config.sh exited $rc, want 0"
    grep -Fqx 'sync-config.json: OK' "$out" || fail "missing 'sync-config.json: OK' line"
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
        fail "host $scope config is not ignored"
    fi
}

# -- Runner --------------------------------------------------------------------

for case_name in import-creates export-adds roundtrip-unchanged import-backup excluded excluded-credentials noninteractive-missing-value prompt-empty-stops defaultenv-invalid defaultenv-valid values-mode-new values-mode-tightened error-continues import-eof-overwrites crlf-unchanged common-import common-export missing-platform path-repo-traversal path-repo-outside path-local-traversal path-local-absolute path-repo-symlink path-real-config real-config-roundtrip lint-real-config lint-platform-missing lint-platform-bad lint-linux-prefix lint-dir-with-rules lint-file-in-dir lint-typed-file-in-dir lint-dir-in-dir lint-dir-trailing-slash lint-sibling-prefix lint-windows-root lint-windows-sibling lint-windows-linux-prefix lint-windows-ok path-dotted-name escape-import escape-export escape-roundtrip-unchanged sanitize-longest-first sanitized-large-file sanitized-case-change infer-name infer-reset infer-keeps-cache infer-escaped infer-skips-unhydrated-local infer-overlapping-context dir-export-adds dir-export-modify-remove dir-export-excluded dir-export-missing dir-export-symlink dir-export-empty-keeps-repo dir-export-only-excluded dir-export-only-symlink dir-export-one-left dir-export-empty-both dir-root-symlink dir-symlink-removed dir-import-creates dir-import-update-backup dir-import-extra dir-roundtrip-unchanged dir-import-prompt-reads-stdin orphan-reported orphan-none orphan-linked-ok orphan-no-dir-entries upstream-none upstream-current upstream-behind-noninteractive upstream-behind-pull upstream-unreachable upstream-off-master preview-writes-nothing preview-shows-diff preview-matches-export preview-includes-uncommitted preview-no-changes preview-sanitized preview-leak-found preview-cleans-up preview-reset-rejected preview-not-a-repo commit-happy commit-leak-blocked commit-scan-missing commit-outside-changes commit-value-blocked commit-value-case-variant commit-value-doubled commit-value-untracked commit-value-placeholder-only commit-value-not-printed preview-scan-missing sync-usage sync-unknown sync-routes-export sync-routes-import sync-routes-preview sync-missing-tool host-git-config-ignored; do
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
        lint-real-config) case_lint_real_config ;;
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
