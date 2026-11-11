#!/usr/bin/env bash
# Local Windows VM for the Windows test layer: Windows 11 Enterprise evaluation in
# dockurr/windows (podman + KVM). See tests/windows-vm/README.md.
#
#   vm.sh up              start the VM (installs it on the first run), wait for the agent
#   vm.sh run '<command>' run a Windows PowerShell 5.1 command in a fresh copy of the repo
#   vm.sh down            shut the VM down
#   vm.sh status          exit 0 only when the VM is up and its agent answers
#   vm.sh snapshot        save the installed disk (VM must be down); later `up`s start from it
set -euo pipefail

IMAGE='docker.io/dockurr/windows@sha256:59f8bed19cfd49cf1701debe34f9df6311e61a4e2ae68aa9f41206e2184e31cc' # 6.06
NAME='syncsettings-win'
VM_HOME="${SYNC_VM_HOME:-$HOME/.cache/syncsettings-vm}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATA="$VM_HOME/data"
JOBS="$DATA/jobs"

die() { printf 'vm.sh: %s\n' "$*" >&2; exit 1; }

running() { [[ "$(podman inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" == true ]]; }

wait_ready() { # $1: seconds
    local deadline=$((SECONDS + $1))
    while ((SECONDS < deadline)); do
        [[ -f $DATA/ready ]] && return 0
        running || die 'the VM stopped while starting; see: podman logs syncsettings-win'
        sleep 5
    done
    die "the agent didn't answer within $1 s; watch the screen at http://127.0.0.1:8006"
}

cmd_up() {
    running && { wait_ready 60; return; }
    mkdir -p "$VM_HOME/storage" "$JOBS" "$DATA/repo"
    rm -f "$DATA/ready" "$JOBS"/*
    if [[ -f $VM_HOME/snapshot/data.img ]]; then
        cp --sparse=always --reflink=auto "$VM_HOME/snapshot/"* "$VM_HOME/storage/"
    fi
    local first=false
    [[ -f $VM_HOME/storage/data.img ]] || first=true
    podman rm -f "$NAME" >/dev/null 2>&1 || true
    podman run -d --name "$NAME" \
        --device /dev/kvm --device /dev/net/tun --cap-add NET_ADMIN \
        -e VERSION=11e -e RAM_SIZE=4G -e CPU_CORES=4 -e DISK_SIZE=40G \
        -p 127.0.0.1:8006:8006 --stop-timeout 120 \
        -v "$VM_HOME/storage:/storage" -v "$DATA:/data" -v "$REPO:/data/repo:ro" \
        -v "$REPO/tests/windows-vm/oem:/oem:ro" \
        "$IMAGE" >/dev/null
    if $first; then wait_ready 7200; else wait_ready 900; fi
}

cmd_run() {
    [[ $# -eq 1 ]] || die "usage: vm.sh run '<powershell command>'"
    cmd_status || die 'the VM is not up; run: tests/windows-vm/vm.sh up'
    local id
    id="$(date +%s)-$$"
    printf '%s' "$1" >"$JOBS/$id.tmp"
    mv "$JOBS/$id.tmp" "$JOBS/$id.job"
    while [[ ! -f $JOBS/$id.exit ]]; do
        running || die 'the VM stopped during the job'
        sleep 1
    done
    [[ -f $JOBS/$id.out ]] && tr -d '\r' <"$JOBS/$id.out"
    local code
    code="$(tr -dc '0-9' <"$JOBS/$id.exit")"
    rm -f "$JOBS/$id".*
    return "${code:-1}"
}

cmd_down() {
    running || return 0
    podman stop -t 120 "$NAME" >/dev/null
    rm -f "$DATA/ready"
}

cmd_status() { running && [[ -f $DATA/ready ]]; }

cmd_snapshot() {
    running && die 'shut the VM down first: tests/windows-vm/vm.sh down'
    [[ -f $VM_HOME/storage/data.img ]] || die 'no installed disk to save'
    # The disk plus the firmware state (windows.rom, windows.vars, …); the ISO isn't needed once installed.
    rm -rf "$VM_HOME/snapshot"
    mkdir -p "$VM_HOME/snapshot"
    cp --sparse=always --reflink=auto "$VM_HOME/storage/data.img" "$VM_HOME/storage/"windows.* "$VM_HOME/snapshot/"
}

case "${1:-}" in
    up) cmd_up ;;
    run) shift; cmd_run "$@" ;;
    down) cmd_down ;;
    status) cmd_status ;;
    snapshot) cmd_snapshot ;;
    *) die 'usage: vm.sh up | run <command> | down | status | snapshot' ;;
esac
