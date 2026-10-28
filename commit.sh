#!/usr/bin/env bash
# Commit (and optionally push) changes in dotfiles/.
set -euo pipefail

cd "$(dirname "$0")"
source scripts/sync.sh

MESSAGE=''
PUSH=0

while (( $# > 0 )); do
    case $1 in
        -m)
            if (( $# < 2 )); then
                printf 'Missing value for -m\nUsage: commit.sh [-m <message>] [--push]\n' >&2
                exit 1
            fi
            MESSAGE=$2
            shift 2
            ;;
        --push)
            PUSH=1
            shift
            ;;
        *)
            printf 'Unknown option: %s\nUsage: commit.sh [-m <message>] [--push]\n' "$1" >&2
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

# Check for staged/unstaged changes in dotfiles/
if ! status_output=$(git status --porcelain -- dotfiles/); then
    printf 'ERROR: git status failed.\n' >&2
    exit 1
fi

if [[ -z $status_output ]]; then
    printf '  Nothing to commit -- dotfiles/ is clean.\n\n'
    exit 0
fi

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

# Stage dotfiles/
if ! git add dotfiles/; then
    printf 'ERROR: git add failed.\n' >&2
    exit 1
fi

# Commit
if ! git commit -m "$commit_msg"; then
    printf 'ERROR: git commit failed.\n' >&2
    exit 1
fi

printf '\n  Committed successfully.\n'

# Push
if (( ! PUSH )); then
    printf '\n  Push to remote? [Y/n] '
    answer=''
    if read -r answer; then
        if [[ -z $answer || $answer == [Yy]* ]]; then
            PUSH=1
        fi
    fi
    printf '\n'
fi

if (( PUSH )); then
    printf '  Pushing...\n'
    if ! git push; then
        printf '  Push failed. Make sure a remote is configured: git remote add origin <url>\n'
        exit 1
    fi
    printf '  Pushed successfully.\n'
fi

printf '\n'
exit 0
