#!/usr/bin/env bash
# Commit sync-path changes on a branch and open a PR.
set -euo pipefail

cd "$(dirname "$0")"
source scripts/linux/sync.sh

MESSAGE=''

while (( $# > 0 )); do
    case $1 in
        -m)
            if (( $# < 2 )); then
                printf 'Missing value for -m\nUsage: commit.sh [-m <message>]\n' >&2
                exit 1
            fi
            MESSAGE=$2
            shift 2
            ;;
        --push)
            # Accepted for backward compatibility; commits now open a PR instead.
            shift
            ;;
        *)
            printf 'Unknown option: %s\nUsage: commit.sh [-m <message>]\n' "$1" >&2
            exit 1
            ;;
    esac
done

# -- Helpers ------------------------------------------------------------------

join_by() {
    # Multi-character separators: IFS would only use the first character.
    local sep=$1 out=$2
    shift 2
    local item
    for item in "$@"; do out+=$sep$item; done
    printf '%s' "$out"
}

build_commit_message() {
    local -a lines=("$@")
    local -a added=() modified=() deleted=() parts=()
    local line code file name

    for line in "${lines[@]}"; do
        (( ${#line} >= 4 )) || continue
        code=${line:0:2}
        code=${code#"${code%%[![:space:]]*}"}
        code=${code%"${code##*[![:space:]]}"}
        file=${line:3}
        file=${file#"${file%%[![:space:]]*}"}
        file=${file%"${file##*[![:space:]]}"}
        name=${file##*/}

        case $code in
            A|'??') added+=("$name") ;;
            M) modified+=("$name") ;;
            D) deleted+=("$name") ;;
        esac
    done

    (( ${#added[@]} ))    && parts+=("add $(join_by ', ' "${added[@]}")")
    (( ${#modified[@]} )) && parts+=("update $(join_by ', ' "${modified[@]}")")
    (( ${#deleted[@]} ))  && parts+=("remove $(join_by ', ' "${deleted[@]}")")

    if (( ${#parts[@]} == 0 )); then
        printf '%s' 'sync: update config files'
        return 0
    fi

    local msg
    msg="sync: $(join_by '; ' "${parts[@]}")"

    if (( ${#msg} > 72 )); then
        local total=$(( ${#added[@]} + ${#modified[@]} + ${#deleted[@]} ))
        msg="sync: update $total config file(s)"
    fi

    printf '%s' "$msg"
}

resolve_machine_alias() {
    local alias

    if alias=$(git config --get syncsettings.machine 2>/dev/null) && [[ -n $alias ]]; then
        if [[ ! $alias =~ ^[a-z0-9][a-z0-9-]{0,23}$ ]]; then
            printf 'ERROR: invalid machine alias '\''%s'\'' in git config syncsettings.machine (use a-z, 0-9, -).\n' "$alias" >&2
            exit 1
        fi
    elif [[ -t 0 ]]; then
        printf '  Machine alias for branch names (e.g. laptop, desktop): ' >&2
        read -r alias || alias=''
        alias=${alias#"${alias%%[![:space:]]*}"}
        alias=${alias%"${alias##*[![:space:]]}"}
        if [[ ! $alias =~ ^[a-z0-9][a-z0-9-]{0,23}$ ]]; then
            printf 'ERROR: invalid machine alias '\''%s'\'' (use a-z, 0-9, -).\n' "$alias" >&2
            exit 1
        fi
        git config syncsettings.machine "$alias"
        printf '  Saved machine alias: %s\n' "$alias" >&2
    else
        printf 'ERROR: no machine alias set. Run: git config syncsettings.machine <alias>\n' >&2
        exit 1
    fi

    printf '%s' "$alias"
}

# -- Main ---------------------------------------------------------------------

printf '\n'
printf '  +==========================================+\n'
printf '  |        SyncSettings -- COMMIT           |\n'
printf '  +==========================================+\n'
printf '\n'

# Verify git is available
if ! command -v git >/dev/null 2>&1; then
    printf 'ERROR: git is not found in PATH. Please install Git and try again.\n' >&2
    exit 1
fi

# Verify the GitHub CLI is available (GH overrides the binary for tests).
GH=${GH:-gh}
if ! command -v "$GH" >/dev/null 2>&1; then
    printf 'ERROR: gh is not found in PATH. Install the GitHub CLI and run gh auth login.\n' >&2
    exit 1
fi

# Paths this script owns. `packages` is optional.
SYNC_PATHS=(dotfiles sync-config.json)
if [[ -d packages ]]; then
    SYNC_PATHS+=(packages)
fi

# Refuse to run while unrelated changes are in the tree.
outside=$(git status --porcelain -- . "${SYNC_PATHS[@]/#/:!}")
if [[ -n $outside ]]; then
    printf '  Changes outside sync paths:\n' >&2
    mapfile -t outside_lines <<<"$outside"
    for line in "${outside_lines[@]}"; do
        printf '    %s\n' "$line" >&2
    done
    printf 'ERROR: commit or stash changes outside dotfiles/ first.\n' >&2
    exit 1
fi

# Check for staged/unstaged changes in the sync paths.
if ! status_output=$(git status --porcelain -- "${SYNC_PATHS[@]}"); then
    printf 'ERROR: git status failed.\n' >&2
    exit 1
fi

if [[ -z $status_output ]]; then
    printf '  Nothing to commit -- dotfiles/ is clean.\n\n'
    exit 0
fi

# Scan the sync paths for personal data before branching or committing.
leak_code=0
if run_leak_scan "${SYNC_PATHS[@]}"; then
    :
else
    leak_code=$?
fi
if (( leak_code == 1 )); then
    printf 'ERROR: the leak scan found the lines above; nothing was committed.\n' >&2
    exit 1
fi
if (( leak_code == 2 )); then
    printf 'ERROR: leak scan could not run; nothing was committed.\n' >&2
    exit 1
fi

machine=$(resolve_machine_alias)

mapfile -t status_lines <<<"$status_output"

printf '  Changed files:\n'
for line in "${status_lines[@]}"; do
    printf '    %s\n' "$line"
done
printf '\n'

# Build commit message
commit_msg=$MESSAGE
if [[ -z $commit_msg ]]; then
    commit_msg=$(build_commit_message "${status_lines[@]}")
fi
printf '  Commit message: %s\n\n' "$commit_msg"

# Only commit from master.
branch_current=$(git symbolic-ref --short HEAD)
if [[ $branch_current != master ]]; then
    printf 'ERROR: run commit.sh from master (current: %s).\n' "$branch_current" >&2
    exit 1
fi

# Bring local master up to date; refuse to leave unpushed commits behind.
git fetch origin master
counts=$(git rev-list --left-right --count HEAD...origin/master)
read -r ahead behind <<<"$counts"

if (( behind > 0 )); then
    if ! git merge --ff-only origin/master; then
        printf 'ERROR: master is behind origin; pull first.\n' >&2
        exit 1
    fi
fi

if (( ahead > 0 )); then
    printf 'ERROR: local master has unpushed commits; push or move them to a branch first.\n' >&2
    exit 1
fi

# Branch this sync off master.
stamp=$(date +%Y%m%d-%H%M)
branch="sync/linux-$machine-$stamp"
git switch -c "$branch"

# Stage and commit.
if ! git add -- "${SYNC_PATHS[@]}"; then
    printf 'ERROR: git add failed.\n' >&2
    exit 1
fi

if ! git commit -m "$commit_msg"; then
    printf 'ERROR: git commit failed.\n' >&2
    exit 1
fi

# Push the branch.
if ! git push -u origin "$branch"; then
    printf 'ERROR: push failed; you are on %s. Fix and run: git push -u origin %s\n' "$branch" "$branch" >&2
    exit 1
fi

# PR body.
body=$(mktemp)
trap 'rm -f "$body"' EXIT
{
    printf '## What changed\n\n'
    for line in "${status_lines[@]}"; do
        printf '%s%s%s\n' '- `' "$line" '`'
    done
    printf '\nPlatform: linux · Machine: %s\n\n' "$machine"
    printf "When the review is done, add the **\`reviewed\`** label.\n"
} > "$body"

# Open the PR.
if ! pr_url=$("$GH" pr create --base master --head "$branch" --title "$commit_msg" --body-file "$body"); then
    printf 'ERROR: PR creation failed; branch %s is pushed. Run: gh pr create --base master --head %s\n' "$branch" "$branch" >&2
    exit 1
fi

# Return to master.
git switch master

printf '  PR opened: %s\n' "$pr_url"
printf '  Review it, add the '\''reviewed'\'' label, merge, then: git pull\n'
printf '\n'
exit 0
