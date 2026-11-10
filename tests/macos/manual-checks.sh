#!/bin/bash
# The macOS checks M1-M4 from TODO.md, on a real Mac (13 or newer, Homebrew installed):
#
#   curl -fsSLo /tmp/mksync-checks.sh https://raw.githubusercontent.com/makubexD/SyncSettings/master/tests/macos/manual-checks.sh
#   /bin/bash /tmp/mksync-checks.sh
#
# M1 runs the README install line for real: it clones (or updates) ~/SyncSettings, links mksync and runs
# setup, which asks before it installs anything or applies settings to this Mac. M2-M4 write nothing.
# The report goes to ~/mksync-macos-checks-<time>.txt; it holds file names and command output, never file
# contents. Read it before sharing it.
#
# This runs under the stock /bin/bash 3.2 (M1 is what installs a newer one), so no bash 4 features.
set -u

INSTALL_URL=https://raw.githubusercontent.com/makubexD/SyncSettings/master/install.sh
DIR=${SYNCSETTINGS_DIR:-$HOME/SyncSettings}
BIN=${SYNCSETTINGS_BIN:-$HOME/.local/bin}
REPORT=$HOME/mksync-macos-checks-$(date +%Y%m%d-%H%M%S).txt
WORK=$(mktemp -d "${TMPDIR:-/tmp}/mksync-checks.XXXXXX") || exit 1
SUMMARY=''

trap 'rm -rf "$WORK"' EXIT

say() { printf '%s\n' "$*" | tee -a "$REPORT"; }
header() { say ''; say "=== $* ==="; }
# result <check> <PASS|FAIL|INFO|SKIP> <why>
result() {
    say "--> $1 $2: $3"
    SUMMARY="$SUMMARY$(printf '  %-3s %-5s %s' "$1" "$2" "$3")
"
}
# run_logged <name> <command...>: runs the command, shows and records its output, returns its exit code.
run_logged() {
    local name=$1 rc
    shift
    say "\$ $*"
    "$@" > "$WORK/$name.log" 2>&1 < /dev/null
    rc=$?
    tee -a "$REPORT" < "$WORK/$name.log"
    say "(exit $rc)"
    return "$rc"
}

: > "$REPORT"
say "SyncSettings macOS checks, $(date '+%Y-%m-%d %H:%M:%S')"

# -- Preflight -------------------------------------------------------------------
header 'Preflight'
if [ "$(uname -s)" != Darwin ]; then
    say 'ERROR: this is not macOS.'
    exit 1
fi
MACOS_VERSION=$(sw_vers -productVersion)
say "macOS $MACOS_VERSION, $(uname -m)"
if [ "${MACOS_VERSION%%.*}" -lt 13 ]; then
    say 'ERROR: these checks need macOS 13 or newer.'
    exit 1
fi
if ! command -v brew > /dev/null 2>&1; then
    say 'ERROR: brew is not on PATH. Install Homebrew from https://brew.sh (and run the shellenv line it prints), then run this again.'
    exit 1
fi
say "brew: $(command -v brew)"

BREW_BASH=''
for b in /opt/homebrew/bin/bash /usr/local/bin/bash; do
    if [ -x "$b" ]; then
        BREW_BASH=$b
        break
    fi
done
HAD_TOOLS=0
if [ -n "$BREW_BASH" ] && command -v jq > /dev/null 2>&1; then
    HAD_TOOLS=1
    say "Homebrew bash and jq are already installed ($BREW_BASH, $(command -v jq)): the installer won't ask"
    say 'to install them, so M1 cannot see that question. To see it, run brew uninstall bash jq first.'
else
    say 'Homebrew bash or jq is missing: M1 expects the installer to ask to install them.'
fi
if [ -e "$DIR" ]; then
    say "$DIR already exists: the installer updates it instead of cloning."
fi

# -- M1 --------------------------------------------------------------------------
header 'M1: the README install line'
say "\$ curl -fsSL $INSTALL_URL | bash"
say '(answer its questions here; the output is recorded)'
# The installer reads its answers from /dev/tty, so the pipe through tee doesn't take them.
curl -fsSL "$INSTALL_URL" | bash 2>&1 | tee "$WORK/install.log"
rc=${PIPESTATUS[1]}
cat "$WORK/install.log" >> "$REPORT"
say "(exit $rc)"

MKSYNC=$BIN/mksync
if command -v mksync > /dev/null 2>&1; then
    MKSYNC=$(command -v mksync)
else
    say "mksync is not on PATH in this shell; using $MKSYNC. Add the PATH line the installer printed."
fi

m1_fail=''
[ "$rc" -eq 0 ] || m1_fail="${m1_fail}installer exited $rc; "
grep -q 'Installed\.' "$WORK/install.log" || m1_fail="${m1_fail}no 'Installed.' line; "
if [ "$HAD_TOOLS" -eq 0 ] && ! grep -q 'brew install bash jq' "$WORK/install.log"; then
    m1_fail="${m1_fail}no 'brew install bash jq' question; "
fi
if [ ! -x "$MKSYNC" ]; then
    m1_fail="${m1_fail}$MKSYNC missing; "
else
    run_logged doctor "$MKSYNC" doctor
    rc=$?
    [ "$rc" -eq 0 ] || m1_fail="${m1_fail}mksync doctor exited $rc; "
    if grep -q '^ *MISSING' "$WORK/doctor.log"; then
        m1_fail="${m1_fail}mksync doctor has a MISSING line; "
    fi
fi
if [ -z "$m1_fail" ]; then
    if [ "$HAD_TOOLS" -eq 1 ]; then
        result M1 PASS "Installed., doctor clean (brew question not seen: tools already installed)"
    else
        result M1 PASS "brew question, Installed., doctor clean"
    fi
else
    result M1 FAIL "${m1_fail%; }"
fi

# Everything below needs the clone, jq and the Homebrew bash.
if [ ! -f "$DIR/sync-config.json" ]; then
    result M2 SKIP "no clone at $DIR"
    result M3 SKIP "no clone at $DIR"
else
    JQ=$(command -v jq || true)
    for j in /opt/homebrew/bin/jq /usr/local/bin/jq; do
        [ -n "$JQ" ] && break
        [ -x "$j" ] && JQ=$j
    done

    # -- M2 ----------------------------------------------------------------------
    header 'M2: mksync status and import --check'
    m2_fail=''
    run_logged status "$MKSYNC"
    if ! grep -qF "SyncSettings  macos ($MACOS_VERSION)" "$WORK/status.log"; then
        m2_fail="${m2_fail}status doesn't show 'macos ($MACOS_VERSION)'; "
    fi

    say ''
    # $1 is for the inner sh, not this shell.
    # shellcheck disable=SC2016
    run_logged check /bin/sh -c 'cd "$1" && ./import.sh --check' sh "$DIR"
    rc=$?
    if [ "$rc" -ne 0 ] && [ "$rc" -ne 3 ]; then
        m2_fail="${m2_fail}import.sh --check exited $rc (expected 0 or 3); "
    fi

    if [ -z "$JQ" ]; then
        m2_fail="${m2_fail}jq not found, can't read the expected list; "
    else
        # The entries this Mac should get: platform common, macos, or a list naming macos.
        "$JQ" -r '.files[]
            | select(.platform == "common" or .platform == "macos"
                or ((.platform | type) == "array" and (.platform | index("macos"))))
            | .repoPath' "$DIR/sync-config.json" > "$WORK/expected.txt"
        say ''
        say "Entries for macOS in sync-config.json: $(wc -l < "$WORK/expected.txt" | tr -d ' ')"
        missing=''
        while IFS= read -r rp; do
            if ! awk -v rp="$rp" '$2 == rp || index($2, rp "/") == 1 { found = 1 } END { exit !found }' \
                "$WORK/check.log"; then
                missing="$missing $rp"
            fi
        done < "$WORK/expected.txt"
        if [ -n "$missing" ]; then
            say "Not listed by import --check:$missing"
            m2_fail="${m2_fail}import --check skips$missing; "
        fi
        for rp in dotfiles/macos/shell/.zshrc dotfiles/macos/shell/.zprofile dotfiles/macos/git/.gitconfig.local; do
            grep -qx "$rp" "$WORK/expected.txt" || m2_fail="${m2_fail}$rp is no longer a macOS entry; "
        done
        if grep -qE '^ +[A-Z]+ +dotfiles/(linux|windows)/' "$WORK/check.log"; then
            say 'Listed but not for macOS:'
            grep -E '^ +[A-Z]+ +dotfiles/(linux|windows)/' "$WORK/check.log" | tee -a "$REPORT"
            m2_fail="${m2_fail}import --check lists linux or windows entries; "
        fi

        # The status lines show repo paths, so record where VS Code's files are on this Mac.
        say ''
        say 'VS Code (import --check labels show repo paths; the local side should be under ~/Library):'
        "$JQ" -r '.files[] | select(.localPaths.macos != null) | "\(.repoPath)\t\(.localPaths.macos)"' \
            "$DIR/sync-config.json" > "$WORK/vscode.txt"
        while IFS="$(printf '\t')" read -r rp lp; do
            local_path=$HOME/${lp#\~/}
            if [ -e "$local_path" ]; then state=exists; else state='not there'; fi
            say "  $rp -> $lp ($state)"
            # localPaths.macos holds a literal ~/, so match it unexpanded.
            # shellcheck disable=SC2088
            case $lp in
                '~/Library/Application Support/Code/User/'*) ;;
                *) m2_fail="${m2_fail}$rp maps to $lp, not ~/Library/Application Support/Code/User/; " ;;
            esac
        done < "$WORK/vscode.txt"
        if [ -e "$HOME/.config/Code/User" ]; then
            say '  Note: ~/.config/Code/User exists too; it is not the macOS VS Code folder.'
        fi
    fi
    if [ -z "$m2_fail" ]; then
        result M2 PASS "macos ($MACOS_VERSION) shown; import --check lists every macOS entry and no others"
    else
        result M2 FAIL "${m2_fail%; }"
    fi

    # -- M3 ----------------------------------------------------------------------
    header 'M3: /bin/bash ./sync doctor re-runs under Homebrew bash'
    # $1 is for the inner sh, not this shell.
    # shellcheck disable=SC2016
    run_logged m3 /bin/sh -c 'cd "$1" && /bin/bash ./sync doctor' sh "$DIR"
    rc=$?
    m3_fail=''
    [ "$rc" -eq 0 ] || m3_fail="${m3_fail}exited $rc; "
    if grep -qE 'declare: -A|invalid option|bad substitution|needs bash 4\.4' "$WORK/m3.log"; then
        m3_fail="${m3_fail}bash 3.2 error in the output; "
    fi
    if ! grep -qE '^ *OK +bash ([5-9]|4\.[4-9])' "$WORK/m3.log"; then
        m3_fail="${m3_fail}doctor's bash line isn't OK with 4.4 or newer; "
    fi
    if [ -z "$m3_fail" ]; then
        result M3 PASS "$(grep -E '^ *OK +bash' "$WORK/m3.log" | sed 's/^ *OK *//')"
    else
        result M3 FAIL "${m3_fail%; }"
    fi
fi

# -- M4 --------------------------------------------------------------------------
header "M4: where RTK keeps its config"
if command -v rtk > /dev/null 2>&1; then
    say "rtk: $(command -v rtk), $(rtk --version 2>&1 | head -1)"
    rtk --help 2>&1 | grep -i config | sed 's/^/  help: /' | tee -a "$REPORT"
else
    say 'rtk is not on PATH.'
fi
found=''
for d in "$HOME/Library/Application Support/rtk" "$HOME/.config/rtk" "${XDG_CONFIG_HOME:+$XDG_CONFIG_HOME/rtk}" \
    "$HOME/Library/Preferences/rtk"; do
    [ -n "$d" ] || continue
    if [ -d "$d" ]; then
        say "Folder: $d"
        (cd "$d" && find . -type f | sed 's|^\./|  |' | sort) | tee -a "$REPORT"
        found="$found $d;"
    fi
done
say 'Other rtk folders or files nearby:'
find "$HOME/Library/Application Support" "$HOME/Library/Preferences" "$HOME/.config" -maxdepth 2 -iname '*rtk*' \
    2> /dev/null | sed 's/^/  /' | tee -a "$REPORT"
if [ -f "$DIR/sync-config.json" ] && [ -d "$DIR/dotfiles/linux/rtk" ]; then
    say "Files the repo syncs for Linux (~/.config/rtk):"
    (cd "$DIR/dotfiles/linux/rtk" && find . -type f | sed 's|^\./|  |' | sort) | tee -a "$REPORT"
fi
if [ -n "$found" ]; then
    result M4 INFO "rtk config found at:${found%;}; decide on localPaths.macos from this"
elif command -v rtk > /dev/null 2>&1; then
    result M4 INFO "rtk installed but no config folder yet; run rtk once (or rtk's config command) and rerun"
else
    result M4 INFO "rtk not installed; install it, run it once, and rerun to find its folder"
fi

# -- Summary ---------------------------------------------------------------------
header 'Summary'
printf '%s' "$SUMMARY" | tee -a "$REPORT"
say ''
say "Report: $REPORT"
