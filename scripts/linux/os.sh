# shellcheck shell=bash
# OS detection shared by the bash entry points and the front door.
# Source this file; never execute it directly.

# The system the bash engine runs for: `SYNC_OS` when set, else `uname -s`
# (`Linux` is `linux`, `Darwin` is `macos`). Any other value stops the run.
sync_os() {
    local os=${SYNC_OS:-} uname_s
    if [[ -n $os ]]; then
        case $os in
            linux|macos)
                printf '%s' "$os"
                return 0
                ;;
            *)
                printf 'ERROR: SyncSettings runs on Linux, macOS and Windows; this is %s.\n' "$os" >&2
                return 1
                ;;
        esac
    fi
    uname_s=$(uname -s 2>/dev/null) || uname_s='unknown'
    case $uname_s in
        Linux) printf 'linux' ;;
        Darwin) printf 'macos' ;;
        *)
            printf 'ERROR: SyncSettings runs on Linux, macOS and Windows; this is %s.\n' "$uname_s" >&2
            return 1
            ;;
    esac
}

# A jq function that selects the entries for one system: `common`, the system's
# own value, or a list holding it. Callers pass --arg os and this prefix.
if [[ -z ${PLATFORM_SELECT_JQ:-} ]]; then
    # shellcheck disable=SC2016  # $os is a jq parameter, not a shell variable
    PLATFORM_SELECT_JQ='def selected($os): (.platform == "common") or (.platform == $os) or (((.platform | type) == "array") and ((.platform | index($os)) != null));'
    readonly PLATFORM_SELECT_JQ
fi
