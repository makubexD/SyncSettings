#!/usr/bin/env bash
# Prove packages/linux on a clean Ubuntu: install the base tools, apply the apt
# sources, dry-run every listed package, download every pinned file, build the
# GNOME extension into a throwaway home, then run bootstrap --dry-run as a
# normal user. Prints "PASS <check>" per check, or "FAIL <check>: <reason>" and
# exits 1 on the first failure.
# Run it as root from the repo root, in a container: it needs root, the network
# and /etc/apt, and it writes to the machine it runs on. It never changes the
# repo it runs from.
# Usage: scripts/ci/bootstrap-check.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
export DEBIAN_FRONTEND=noninteractive

pass() {
    printf 'PASS %s\n' "$1"
}

die() {
    printf 'FAIL %s: %s\n' "$1" "$2" >&2
    exit 1
}

# -- 1. Base tools --------------------------------------------------------------
# curl and sha256sum for fetch_verified, and the unpackers the steps use.

apt-get update || die 'base tools' 'apt-get update failed'
apt-get install -y ca-certificates curl git jq xz-utils unzip libglib2.0-bin \
    || die 'base tools' 'apt-get install failed'
pass 'base tools'

# -- 2. Bootstrap steps ---------------------------------------------------------
# The steps come from bootstrap itself, so this checks the real recipes. Sourcing
# never runs main: its guard compares BASH_SOURCE with $0.

# shellcheck source=bootstrap/linux.sh
source bootstrap/linux.sh
SUDO=()
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
pass 'bootstrap sourced'

# -- 3. APT sources -------------------------------------------------------------
# The repo's sources and keys must load without a bad key or URI. apt prints a
# bad key or source as an E: or W: line, sometimes with exit code 0.

step_apt_sources || die 'apt sources' 'step_apt_sources failed'
if ! out=$(apt-get update 2>&1); then
    printf '%s\n' "$out" >&2
    die 'apt sources' 'apt-get update failed'
fi
printf '%s\n' "$out"
bad=$(grep -E '^[EW]:' <<<"$out" || true)
if [[ -n $bad ]]; then
    die 'apt sources' "apt-get update reported: ${bad%%$'\n'*}"
fi
pass 'apt sources'

# -- 4. apt.txt -----------------------------------------------------------------
# Every name must resolve from the sources just applied.

mapfile -t names < <(package_names "$PACKAGES_DIR/apt.txt")
(( ${#names[@]} > 0 )) || die 'apt.txt' 'no packages listed'
apt-get install -s -- "${names[@]}" >/dev/null || die 'apt.txt' 'apt-get install -s failed'
pass 'apt.txt'

# -- 5. deb.txt -----------------------------------------------------------------
# Each pinned .deb must download, hash, be the package its line names, and
# resolve against the sources. apt reads the file as _apt, so the temp folder
# and the file need the modes step_debs gives them.

while read -r name url sha <&3; do
    [[ -n $name ]] || continue
    deb=$WORK/$name.deb
    fetch_verified "$url" "$sha" "$deb" </dev/null || die "deb.txt $name" 'download or hash failed'
    chmod 755 "$WORK"
    chmod 644 "$deb"
    [[ $(dpkg-deb -f "$deb" Package 2>/dev/null) == "$name" ]] || die "deb.txt $name" 'Package field does not match the name'
    apt-get install -s "$deb" >/dev/null || die "deb.txt $name" 'apt-get install -s failed'
done 3< <(list_lines "$PACKAGES_DIR/deb.txt")
pass 'deb.txt'

# -- 6. fonts.txt and tools.txt -------------------------------------------------
# Every pinned download must match its hash. Each file is deleted once it
# passes, so a full run never holds them all at once.

while read -r asset tag sha <&3; do
    [[ -n $asset ]] || continue
    dest=$WORK/$asset.tar.xz
    fetch_verified \
        "https://github.com/ryanoasis/nerd-fonts/releases/download/$tag/$asset.tar.xz" \
        "$sha" "$dest" </dev/null || die "fonts.txt $asset" 'download or hash failed'
    rm -f "$dest"
done 3< <(list_lines "$PACKAGES_DIR/fonts.txt")
pass 'fonts.txt'

while read -r name url sha <&3; do
    [[ -n $name ]] || continue
    dest=$WORK/$name.download
    fetch_verified "$url" "$sha" "$dest" </dev/null || die "tools.txt $name" 'download or hash failed'
    rm -f "$dest"
done 3< <(list_lines "$PACKAGES_DIR/tools.txt")
pass 'tools.txt'

# -- 7. GNOME extension ---------------------------------------------------------
# Build it into a throwaway HOME, exactly as bootstrap would, then check the
# files it must leave behind.

tmp=$(mktemp -d)
HOME=$tmp step_extensions || die 'extensions' 'step_extensions failed'
while IFS= read -r uuid <&3; do
    [[ -n $uuid ]] || continue
    dir=$tmp/.local/share/gnome-shell/extensions/$uuid
    [[ -f $dir/metadata.json ]] || die "extensions $uuid" 'metadata.json missing'
    [[ -f $dir/extension.js ]] || die "extensions $uuid" 'extension.js missing'
    [[ -f $dir/schemas/gschemas.compiled ]] || die "extensions $uuid" 'schemas/gschemas.compiled missing'
done 3< <(package_names "$PACKAGES_DIR/gnome-extensions.txt")
rm -rf "$tmp"
pass 'extensions'

# -- 8. bootstrap --dry-run -----------------------------------------------------
# It must survive as a normal user. The runner may sit under a path ci cannot
# traverse, so run a readable copy from /tmp; always, so there is one code path.
# An ERROR status line fails even when the exit code is 0.

useradd -m ci || die 'bootstrap --dry-run' 'useradd ci failed'
dir=$(mktemp -d)
cp -a . "$dir" || die 'bootstrap --dry-run' 'copy to a temp folder failed'
chown -R ci "$dir" || die 'bootstrap --dry-run' 'chown of the temp copy failed'
if ! out=$(runuser -u ci -- "$dir/bootstrap/linux.sh" --dry-run </dev/null 2>&1); then
    printf '%s\n' "$out" >&2
    die 'bootstrap --dry-run' 'dry run exited non-zero'
fi
errors=$(grep -F 'ERROR' <<<"$out" || true)
if [[ -n $errors ]]; then
    printf '%s\n' "$errors" >&2
    die 'bootstrap --dry-run' 'output has an ERROR line'
fi
rm -rf "$dir"
pass 'bootstrap --dry-run'
