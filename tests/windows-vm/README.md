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

## Lookup check

`lookup-check.ps1` runs after the shared cases in `tests/all.sh`'s Windows layer. In a throwaway clone with a local
bare origin, it runs `mksync status`, puts `whoami.exe` in the clone as `git.exe` and runs it again: the outputs must
match, with no `not a git clone` (commands are found on `PATH` only; work #1 found the clone's `git.exe` ran). It
also checks that the statusline prints a Windows directory's last part. A build from before `v1.1.4` fails both.
Then `mksync doctor`, with the VM's `PATH` (Git's `cmd` folder only, as on work #2), must read `OK bash`, since the
leak scan finds Git Bash from `git`; and with only `System32` and `WindowsApps` on `PATH` (no git), the `bash` line must
name `winget install --id Git.Git -e`, which needs winget's app execution alias found. A build from before `v1.1.5`
fails both.

## Limits

- The evaluation licence lasts 90 days from install. When it runs out, delete `storage/` and `snapshot/` and run
  `up` again.
- The VM takes 4 GB of RAM (`SYNC_VM_RAM`) and 4 cores (`SYNC_VM_CPUS`) while it runs, and about 46 GB of disk (disk
  plus snapshot).
- Starting from the snapshot takes about 6 minutes; the first install about an hour, most of it the ISO download.
- A job's output is what PowerShell wrote to stdout, then stderr. Use `vm.sh down` when done: nothing stops the VM
  by itself.

## Run time of the shared cases

`run.ps1` in this VM (4 cores, 4 GB, 4 shares), 148 passed and 0 failed in every run, 2026-11-25:

| How each case gets `mksync.exe`                      | Time             |
| ---------------------------------------------------- | ---------------- |
| a copy per case (before)                             | 5m17, 5m32, 6m25 |
| a copy per case, `mksync.exe` as an excluded process | 6m23             |
| a hard link per case to the one `dist/mksync.exe`    | 1m44, 1m47, 1m55 |
| a hard link per case to one copy per share (kept)    | 1m18, 1m19, 1m21 |

The first run with a hard link took 6m05, and it is not in the table: that job didn't print which `run.ps1` the guest
ran, and no later link run came close to it. The process exclusion didn't help and isn't set.

Measured numbers and the licence date are in `docs/design-layers.md`, "Tests".
