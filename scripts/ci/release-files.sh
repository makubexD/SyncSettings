#!/usr/bin/env bash
# Build the four release programs and their SHA256SUMS for a tag. The tag must
# equal "v" plus package.json's version, so a release never ships a mismatched
# version. Builds happen in <out-dir>, which is created when the tag matches.
# Usage: scripts/ci/release-files.sh <tag> <out-dir>

set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

if [[ $# -ne 2 ]]; then
    printf 'usage: scripts/ci/release-files.sh <tag> <out-dir>\n' >&2
    exit 2
fi

tag=$1
out_dir=$2

version=$(jq -r .version "$REPO/package.json")

if [[ $tag != "v$version" ]]; then
    printf 'ERROR: tag %s does not match package.json version %s.\n' "$tag" "$version" >&2
    exit 1
fi

mkdir -p "$out_dir"
out=$(cd "$out_dir" && pwd)
cd "$REPO"

# Same targets and names as .github/workflows/ci.yml's program-build. A failing
# build stops the run through errexit.
build() {
    local target=$1 name=$2
    bun build --compile --target "$target" src/main.ts --outfile "$out/$name"
}

build bun-linux-x64 mksync-linux-x64
build bun-linux-arm64 mksync-linux-arm64
build bun-darwin-arm64 mksync-darwin-arm64
build bun-windows-x64 mksync-windows-x64.exe

# Run inside the folder so the lines hold bare file names, sorted by name, and
# `sha256sum -c SHA256SUMS` works from there.
(
    cd "$out"
    sha256sum mksync-linux-x64 mksync-linux-arm64 mksync-darwin-arm64 mksync-windows-x64.exe \
        | LC_ALL=C sort -k2 > SHA256SUMS
)
