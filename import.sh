#!/usr/bin/env bash
# Import repo config files onto the machine (linux entries only).
set -euo pipefail

cd "$(dirname "$0")"
source scripts/sync.sh

FORCE=0
RESET_VALUES=0
for arg in "$@"; do
    case $arg in
        --force) FORCE=1 ;;
        --reset-values) RESET_VALUES=1 ;;
        *) printf 'Unknown option: %s\nUsage: import.sh [--force] [--reset-values]\n' "$arg" >&2; exit 1 ;;
    esac
done

APPLIED=0
SKIPPED=0

printf '\n  SyncSettings -- IMPORT (linux)\n\n'
printf '  HOME       : %s\n' "$HOME"
printf '  Repo root  : %s\n\n' "$REPO_ROOT"

# -- Collect sanitize rules from linux entries whose repo file exists -----------

ALL_RULES='[]'
while IFS= read -r entry; do
    rules_n=$(jq -r '(.sanitizeRules // []) | length' <<<"$entry")
    if (( rules_n == 0 )); then
        continue
    fi
    repo_path=$(jq -r '.repoPath' <<<"$entry")
    if [[ -f $REPO_ROOT/$repo_path ]]; then
        ALL_RULES=$(jq -c --argjson old "$ALL_RULES" '$old + (.sanitizeRules // [])' <<<"$entry")
    fi
done < <(linux_entries)

load_values
if [[ $ALL_RULES != '[]' ]]; then
    request_values import "$RESET_VALUES" "$ALL_RULES"
    save_values
fi

# -- Process each entry ---------------------------------------------------------

process_entry() {
    local entry=$1
    local repo_path local_path label rules repo_file local_file local_dir
    local hydrated local_text answer backup

    repo_path=$(jq -r '.repoPath' <<<"$entry")
    local_path=$(jq -r '.localPath' <<<"$entry")
    label=$repo_path
    repo_file=$REPO_ROOT/$repo_path
    local_file=$(resolve_local "$local_path")
    rules=$(jq -c '(.sanitizeRules // [])' <<<"$entry")

    if is_excluded "$local_file"; then
        status SKIPPED "$label" 'matches exclude pattern'
        return 0
    fi

    if [[ ! -f $repo_file ]]; then
        status SKIPPED "$label" 'not found in repo'
        SKIPPED=$((SKIPPED + 1))
        return 0
    fi

    local_dir=${local_file%/*}
    if [[ ! -d $local_dir ]]; then
        if ! mkdir -p "$local_dir"; then
            status ERROR "$label" "cannot create $local_dir"
            return 1
        fi
    fi

    if [[ $rules != '[]' ]]; then
        local repo_text
        read_text repo_text "$repo_file" || { status ERROR "$label" 'cannot read repo file'; return 1; }
        hydrated=$(hydrate "$repo_text" "$rules"; printf x)
        hydrated=${hydrated%x}

        if [[ -f $local_file ]]; then
            read_text local_text "$local_file" || { status ERROR "$label" 'cannot read local file'; return 1; }
            if same_normalized "$hydrated" "$local_text"; then
                status UNCHANGED "$label"
                return 0
            fi

            if (( ! FORCE )); then
                printf '  Overwrite %s? [Y/n] ' "$local_file"
                answer=''
                read -r answer || answer=''
                if [[ -n $answer && $answer != [Yy]* ]]; then
                    status SKIPPED "$label" 'user skipped'
                    SKIPPED=$((SKIPPED + 1))
                    return 0
                fi
            fi

            backup=$local_file.bak
            if ! cp -p "$local_file" "$backup"; then
                status ERROR "$label" 'cannot create backup'
                return 1
            fi
            write_text hydrated "$local_file" || { status ERROR "$label" 'cannot write local file'; return 1; }
            status UPDATED "$label" "backup saved as ${backup##*/}"
            APPLIED=$((APPLIED + 1))
        else
            write_text hydrated "$local_file" || { status ERROR "$label" 'cannot write local file'; return 1; }
            if ! chmod --reference="$repo_file" "$local_file"; then
                status ERROR "$label" 'cannot copy file mode'
                return 1
            fi
            status CREATED "$label"
            APPLIED=$((APPLIED + 1))
        fi
    else
        if [[ -f $local_file ]]; then
            if cmp -s "$repo_file" "$local_file"; then
                status UNCHANGED "$label"
                return 0
            fi

            if (( ! FORCE )); then
                printf '  Overwrite %s? [Y/n] ' "$local_file"
                answer=''
                read -r answer || answer=''
                if [[ -n $answer && $answer != [Yy]* ]]; then
                    status SKIPPED "$label" 'user skipped'
                    SKIPPED=$((SKIPPED + 1))
                    return 0
                fi
            fi

            backup=$local_file.bak
            if ! cp -p "$local_file" "$backup"; then
                status ERROR "$label" 'cannot create backup'
                return 1
            fi
            if ! cp -p "$repo_file" "$local_file"; then
                status ERROR "$label" 'cannot copy from repo'
                return 1
            fi
            status UPDATED "$label" "backup saved as ${backup##*/}"
            APPLIED=$((APPLIED + 1))
        else
            if ! cp -p "$repo_file" "$local_file"; then
                status ERROR "$label" 'cannot copy from repo'
                return 1
            fi
            status CREATED "$label"
            APPLIED=$((APPLIED + 1))
        fi
    fi
    return 0
}

# Entries arrive on fd 3 so the overwrite prompt inside process_entry reads the user's answer from stdin.
while IFS= read -r entry <&3; do
    if ! process_entry "$entry"; then
        # process_entry already printed an ERROR line for this file.
        :
    fi
done 3< <(linux_entries)

# -- Summary ---------------------------------------------------------------------

printf '\n  %s\n' "--------------------------------------------------"

printf '\n  %d file(s) applied.\n\n' "$APPLIED"
printf '  Link the scripts:\n'
printf '    ln -sf ~/.claude/bin/mk-exec ~/.claude/bin/workflow-report ~/.claude/bin/worker-mode ~/.local/bin/\n'
printf '  Then add DEEPSEEK_API_KEY to ~/.config/claude-workers/env (chmod 600).\n'

printf '\n  %s\n\n' "--------------------------------------------------"

exit 0
