# Local Windows VM

The Windows layer of `tests/all.sh`: a Windows 11 Enterprise evaluation VM, run by
[dockurr/windows](https://github.com/dockur/windows) in podman with KVM, so the shared cases and the PowerShell
engine's suite run on this Linux machine as they do in CI. Windows PowerShell 5.1 is the one Windows ships.

```bash
tests/windows-vm/vm.sh up                 # start; the first run downloads the ISO and installs Windows
tests/windows-vm/vm.sh run 'powershell -NoProfile -ExecutionPolicy Bypass -File tests/parity/run.ps1'
tests/windows-vm/vm.sh down
tests/windows-vm/vm.sh status             # exit 0 when up and answering
tests/windows-vm/vm.sh snapshot           # after the first install, with the VM down
```

## How it works

- **State** lives in `${SYNC_VM_HOME:-~/.cache/syncsettings-vm}`: `storage/` (the VM disk), `snapshot/` (the saved
  disk), `data/` (shared with the guest as `\\host.lan\Data`).
- **The repo** is mounted read-only at `\\host.lan\Data\repo`. Each job copies it to `C:\work\repo` first, so every
  run starts from the working tree as it is on the host and nothing written in the guest reaches the host repo. The
  copy leaves out `.git` (slow over SMB; the cases make their own repos) and clears the Hidden attribute the share
  puts on dot-files.
- **First install** runs `oem/install.bat`, which runs `oem/setup.ps1`: PortableGit (pinned; it has the `bash.exe`
  the leak scan needs), Pester 5.5+, Defender exclusions for the work folders, and a scheduled task that runs
  `oem/start.ps1` at logon. The image logs on by itself.
- **The agent** is `oem/agent.ps1`. `start.ps1` copies it from the mounted repo at every logon, so a change to the
  agent needs a restart (`down`, `up`), never a reinstall. It turns the SMB client's caches off: the host writes job
  files behind the SMB server's back, and with the cache on a new job goes unseen for minutes.
- **Jobs.** `vm.sh run` writes `data/jobs/<id>.job`; the agent runs it with `powershell.exe -Command` in the fresh
  copy and writes `<id>.out` and `<id>.exit`. `vm.sh` prints the output and exits with the job's code.
- **Snapshot.** `vm.sh snapshot` saves the installed disk; each `up` restores it, so a run never sees a previous
  run's leftovers. Without a snapshot the disk is reused.
- The screen is at <http://127.0.0.1:8006> while the VM runs (local only).

## Limits

- The evaluation licence lasts 90 days from install. When it runs out, delete `storage/` and `snapshot/` and run
  `up` again.
- The VM takes 4 GB of RAM and 4 cores while it runs, and about 46 GB of disk (disk plus snapshot).
- Starting from the snapshot takes about 6 minutes; the first install about an hour, most of it the ISO download.
- A job's output is what PowerShell wrote to stdout, then stderr. Use `vm.sh down` when done: nothing stops the VM
  by itself.

Measured numbers and the licence date are in `docs/design-layers.md`, "Tests".
