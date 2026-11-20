#!/usr/bin/env bash
# The one local test command: every layer in order, stopping at the first
# failure. Each layer prints one summary line; the run ends with `all: ok`.
# The Windows layer runs only when the local VM answers (tests/windows-vm/).

set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$REPO"

run_layer() { # $1: layer name, rest: command
    local name=$1
    shift
    local status=0
    "$@" || status=$?
    if (( status == 0 )); then
        printf '%s: ok\n' "$name"
    else
        printf '%s: FAILED (exit %d)\n' "$name" "$status"
        exit "$status"
    fi
}

run_layer lint bun run lint
run_layer unit bun test src
run_layer config bun run tools/check-config.ts
run_layer build bun run build
run_layer parity-program tests/parity/run.sh --engine dist/mksync

# Node 22.18 runs the TypeScript source with no flag. nvm keeps node off PATH
# until its shell is loaded; sourcing must not fail the run under set -u/-e.
if [[ -f $HOME/.nvm/nvm.sh ]]; then
    set +u
    # shellcheck source=/dev/null
    . "$HOME/.nvm/nvm.sh" > /dev/null 2>&1 || true
    set -u
fi
node_version=''
if command -v node > /dev/null 2>&1; then
    node_version=$(node -p 'process.versions.node' 2> /dev/null) || node_version=''
fi
node_major=${node_version%%.*}
node_minor=${node_version#*.}
node_minor=${node_minor%%.*}
if [[ -n $node_version ]] \
    && (( node_major > 22 || (node_major == 22 && node_minor >= 18) )); then
    MKSYNC_RUNTIME=node run_layer parity-node tests/parity/run.sh --engine ./mksync
else
    printf 'parity-node: Node 22.18 not found, skipped\n'
fi

if tests/windows-vm/vm.sh status >/dev/null 2>&1; then
    run_layer windows-exe bun build --compile --target bun-windows-x64 src/main.ts --outfile dist/mksync.exe
    run_layer windows-program tests/windows-vm/vm.sh run \
        'powershell -NoProfile -ExecutionPolicy Bypass -File tests/parity/run.ps1 -Engine dist/mksync.exe'
else
    printf 'Windows: VM not running, skipped\n'
fi

printf 'all: ok\n'
