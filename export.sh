#!/usr/bin/env bash
# Export local config files into the repo (linux entries only).
set -euo pipefail

cd "$(dirname "$0")"
source scripts/linux/sync.sh

RESET_VALUES=0
PREVIEW=0
for arg in "$@"; do
    case $arg in
        --reset-values) RESET_VALUES=1 ;;
        --preview) PREVIEW=1 ;;
        *) printf 'Unknown option: %s\nUsage: export.sh [--preview] [--reset-values]\n' "$arg" >&2; exit 1 ;;
    esac
done

if (( PREVIEW )); then
    if (( RESET_VALUES )); then
        printf 'ERROR: --preview cannot be combined with --reset-values.\n' >&2
        exit 1
    fi
    run_preview
    exit
fi

CHANGED=0
SKIPPED=0

printf '\n  SyncSettings -- EXPORT (linux)\n\n'
printf '  HOME       : %s\n' "$HOME"
printf '  Repo root  : %s\n\n' "$REPO_ROOT"

check_upstream

# -- Collect sanitize rules from linux entries whose local file exists ----------

ALL_RULES='[]'
while IFS= read -r entry; do
    rules_n=$(jq -r '(.sanitizeRules // []) | length' <<<"$entry")
    if (( rules_n == 0 )); then
        continue
    fi
    local_path=$(resolve_local "$(jq -r '.localPath' <<<"$entry")")
    if [[ -f $local_path ]]; then
        ALL_RULES=$(jq -c --argjson old "$ALL_RULES" '$old + (.sanitizeRules // [])' <<<"$entry")
    fi
done < <(platform_entries)

load_values
if [[ $ALL_RULES != '[]' ]]; then
    request_values export "$RESET_VALUES" "$ALL_RULES"
    save_values
fi

# -- Process each entry ---------------------------------------------------------

process_entry() {
    local entry=$1
    local repo_path local_path label rules repo_file local_file repo_dir

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

    if [[ ! -f $local_file ]]; then
        status SKIPPED "$label" "local file not found: $local_file"
        SKIPPED=$((SKIPPED + 1))
        return 0
    fi

    repo_dir=${repo_file%/*}
    if ! mkdir -p "$repo_dir"; then
        status ERROR "$label" "cannot create $repo_dir"
        return 1
    fi

    if [[ $rules != '[]' ]]; then
        local sane repo_text
        read_text sane "$local_file" || { status ERROR "$label" 'cannot read local file'; return 1; }
        sane=$(sanitize "$sane" "$rules"; printf x)
        sane=${sane%x}
        if [[ -f $repo_file ]]; then
            read_text repo_text "$repo_file" || { status ERROR "$label" 'cannot read repo file'; return 1; }
            if same_normalized "$sane" "$repo_text"; then
                status UNCHANGED "$label"
            else
                write_text sane "$repo_file" || { status ERROR "$label" 'cannot write repo file'; return 1; }
                status MODIFIED "$label" 'sanitized'
                CHANGED=$((CHANGED + 1))
            fi
        else
            write_text sane "$repo_file" || { status ERROR "$label" 'cannot write repo file'; return 1; }
            if ! chmod --reference="$local_file" "$repo_file"; then
                status ERROR "$label" 'cannot copy file mode'
                return 1
            fi
            status ADDED "$label" 'sanitized'
            CHANGED=$((CHANGED + 1))
        fi
    else
        if [[ ! -f $repo_file ]]; then
            if ! cp -p "$local_file" "$repo_file"; then
                status ERROR "$label" 'cannot copy to repo'
                return 1
            fi
            status ADDED "$label"
            CHANGED=$((CHANGED + 1))
        elif cmp -s "$local_file" "$repo_file"; then
            status UNCHANGED "$label"
        else
            if ! cp -p "$local_file" "$repo_file"; then
                status ERROR "$label" 'cannot copy to repo'
                return 1
            fi
            status MODIFIED "$label"
            CHANGED=$((CHANGED + 1))
        fi
    fi
    return 0
}

export_dir() {
    local entry=$1
    local repo_path local_path local_dir repo_dir rel label src dst repo_file local_file

    repo_path=$(jq -r '.repoPath' <<<"$entry")
    local_path=$(jq -r '.localPath' <<<"$entry")
    local_dir=$(resolve_local "$local_path")
    repo_dir=$REPO_ROOT/$repo_path

    if [[ ! -d $local_dir ]]; then
        status SKIPPED "$repo_path/" "local folder not found: $local_dir"
        SKIPPED=$((SKIPPED + 1))
        return 0
    fi

    # Copy or update every regular file under the local dir; symlinks and
    # excluded files are skipped.
    while IFS= read -r -d '' src; do
        rel=${src#"$local_dir"/}
        label="$repo_path/$rel"

        if [[ -L $src ]]; then
            status SKIPPED "$label" 'symlink'
            continue
        fi
        if is_excluded "$src"; then
            status SKIPPED "$label" 'matches exclude pattern'
            continue
        fi

        dst=$repo_dir/$rel
        if [[ ! -e $dst ]]; then
            if ! mkdir -p "${dst%/*}"; then
                status ERROR "$label" 'cannot create parent folder'
                continue
            fi
            if ! cp -p "$src" "$dst"; then
                status ERROR "$label" 'cannot copy to repo'
                continue
            fi
            status ADDED "$label"
            CHANGED=$((CHANGED + 1))
        elif cmp -s "$src" "$dst"; then
            status UNCHANGED "$label"
        else
            if ! cp -p "$src" "$dst"; then
                status ERROR "$label" 'cannot copy to repo'
                continue
            fi
            status MODIFIED "$label"
            CHANGED=$((CHANGED + 1))
        fi
    done < <(find "$local_dir/" \( -type f -o -type l \) -print0 | sort -z)

    # Remove repo files whose local counterpart is gone, a symlink, or now
    # excluded; then prune empty folders under the entry's repo dir.
    if [[ -d $repo_dir ]]; then
        while IFS= read -r -d '' repo_file; do
            rel=${repo_file#"$repo_dir"/}
            label="$repo_path/$rel"
            local_file=$local_dir/$rel

            if [[ ! -f $local_file || -L $local_file ]] || is_excluded "$local_file"; then
                if ! rm -f "$repo_file"; then
                    status ERROR "$label" 'cannot remove from repo'
                    continue
                fi
                status REMOVED "$label" 'no longer in source'
                CHANGED=$((CHANGED + 1))
            fi
        done < <(find "$repo_dir" -type f -print0 | sort -z)

        # A folder that cannot be pruned is left behind; it holds no files, so git ignores it.
        find "$repo_dir" -mindepth 1 -type d -empty -delete || true
    fi

    return 0
}

while IFS= read -r entry; do
    if [[ $(jq -r '.type // "file"' <<<"$entry") == dir ]]; then
        export_dir "$entry"
    elif ! process_entry "$entry"; then
        # process_entry already printed an ERROR line for this file.
        :
    fi
done < <(platform_entries)

# Report files under dotfiles/ that no entry owns; this never changes the counts
# or the exit code.
report_orphans

# -- Summary ---------------------------------------------------------------------

printf '\n  %s\n' "--------------------------------------------------"

if (( CHANGED > 0 )); then
    if [[ -n ${SYNC_PREVIEW:-} ]]; then
        printf '\n  %d file(s) would change.\n\n' "$CHANGED"
    else
        printf '\n  %d file(s) copied to the repo.\n\n' "$CHANGED"
        printf '  Review the changes, then run  ./commit.sh\n'
    fi
else
    printf '\n  Repo is up to date. No changes detected.\n'
    if (( SKIPPED > 0 )); then
        printf '\n  Note: %d file(s) skipped because they do not exist locally.\n' "$SKIPPED"
        printf '  If this is a new machine, run  ./import.sh  first to apply the repo settings.\n'
    fi
fi

printf '\n  %s\n\n' "--------------------------------------------------"

exit 0
