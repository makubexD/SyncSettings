#!/usr/bin/env bash
# Import repo config files onto the machine (linux entries only).
set -euo pipefail

cd "$(dirname "$0")"
source scripts/linux/sync.sh

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

check_upstream

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
done < <(platform_entries)

load_values
if [[ $ALL_RULES != '[]' ]]; then
    if [[ $RESET_VALUES != 1 ]]; then
        infer_values "$(platform_entries)"
    fi
    request_values import "$RESET_VALUES" "$ALL_RULES"
    save_values
fi

# -- Process each entry ---------------------------------------------------------

# Copy one repo file onto its local path: compare, prompt unless --force, back up
# the old file, then copy. Used for plain file entries and every file in a dir
# entry. Prints the status line and updates APPLIED/SKIPPED; returns 1 after an
# ERROR so the caller can move on to the next file.
apply_plain() {
    local repo_file=$1 local_file=$2 label=$3
    local answer backup

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
    return 0
}

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
        apply_plain "$repo_file" "$local_file" "$label" || return 1
    fi
    return 0
}

# Sync a type:dir entry from the repo onto the machine. Import never deletes:
# a local file the repo does not have is reported as EXTRA and kept.
import_dir() {
    local entry=$1
    local repo_path local_path repo_dir local_dir rel label f local_file

    repo_path=$(jq -r '.repoPath' <<<"$entry")
    local_path=$(jq -r '.localPath' <<<"$entry")
    repo_dir=$REPO_ROOT/$repo_path
    local_dir=$(resolve_local "$local_path")

    if [[ ! -d $repo_dir ]]; then
        status SKIPPED "$repo_path/" 'not found in repo'
        SKIPPED=$((SKIPPED + 1))
        return 0
    fi

    # Repo files arrive on fd 5 so the overwrite prompt inside apply_plain reads
    # the user's answer from stdin.
    while IFS= read -r -d '' f <&5; do
        rel=${f#"$repo_dir"/}
        label="$repo_path/$rel"
        local_file=$local_dir/$rel

        if is_excluded "$local_file"; then
            status SKIPPED "$label" 'matches exclude pattern'
            continue
        fi

        if ! mkdir -p "${local_file%/*}"; then
            status ERROR "$label" "cannot create ${local_file%/*}"
            continue
        fi

        apply_plain "$f" "$local_file" "$label" || true
    done 5< <(find "$repo_dir" -type f -print0 | sort -z)

    # Report local files the repo does not have; never delete them. Excluded
    # files (including .bak written above) are silent.
    if [[ -d $local_dir ]]; then
        while IFS= read -r -d '' f <&5; do
            rel=${f#"$local_dir"/}
            label="$repo_path/$rel"
            if [[ -f $repo_dir/$rel ]]; then
                continue
            fi
            if is_excluded "$f"; then
                continue
            fi
            status EXTRA "$label" 'not in repo; kept'
        done 5< <(find "$local_dir/" -type f -print0 | sort -z)
    fi

    return 0
}

# Entries arrive on fd 3 so the overwrite prompt inside process_entry reads the user's answer from stdin.
while IFS= read -r entry <&3; do
    if [[ $(jq -r '.type // "file"' <<<"$entry") == dir ]]; then
        import_dir "$entry"
    elif ! process_entry "$entry"; then
        # process_entry already printed an ERROR line for this file.
        :
    fi
done 3< <(platform_entries)

# -- Summary ---------------------------------------------------------------------

printf '\n  %s\n' "--------------------------------------------------"

printf '\n  %d file(s) applied.\n\n' "$APPLIED"
printf '  Link the scripts:\n'
printf '    ln -sf ~/.claude/bin/mk-exec ~/.claude/bin/workflow-report ~/.claude/bin/worker-mode ~/.local/bin/\n'
printf '  Then add DEEPSEEK_API_KEY to ~/.config/claude-workers/env (chmod 600).\n'

printf '\n  %s\n\n' "--------------------------------------------------"

exit 0
