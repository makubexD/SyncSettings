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
run_layer parity-bash tests/parity/run.sh

if tests/windows-vm/vm.sh status >/dev/null 2>&1; then
    run_layer windows-exe bun build --compile --target bun-windows-x64 src/main.ts --outfile dist/mksync.exe
    run_layer windows-program tests/windows-vm/vm.sh run \
        'powershell -NoProfile -ExecutionPolicy Bypass -File tests/parity/run.ps1 -Engine dist/mksync.exe'
    run_layer windows-powershell tests/windows-vm/vm.sh run \
        'powershell -NoProfile -ExecutionPolicy Bypass -File tests/parity/run.ps1'
else
    printf 'Windows: VM not running, skipped\n'
fi

printf 'all: ok\n'
