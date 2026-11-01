# Fresh VM run of bootstrap

Goal: the last open item of phase 7 in `docs/plan-restructure.md`. Run `./bootstrap/linux.sh` on a fresh Ubuntu 26.04
desktop in a VM, and end in a clean `./sync preview` and the checks in `docs/restore.md`. Snaps, VS Code and the desktop
session can't run in the `bootstrap-check` container, so this is their first real test.

Out of scope: changes to bootstrap before the run. Fixes come from what the run finds.

## Decisions

1. **GNOME Boxes on this PC.** A container already runs in CI and has no snaps or desktop session. A headless VM has no
   desktop session, so import and preview are skipped. Running on this PC isn't a fresh machine and changes the real setup.
2. **The VM gets no secrets.** No DeepSeek key, SSH keys or GPG keys. Their steps are recorded as not tested, not as failures.
3. **Claude drives the run.** Amended 2026-10-31 at the user's request, replacing a manual run. Claude builds the VM with
   an unattended install in libvirt's session, so it also shows up in Boxes, and runs bootstrap in a terminal on the VM's
   desktop, with SSH as the control channel. No step goes to the worker. The VM user is `vmtest`, so a hard-coded home
   shows up. It has passwordless `sudo`, so the `sudo` prompt is not tested. `.user-values.json` is copied in with `<HOME>`
   rewritten, so the value prompts are not tested either; the `Overwrite` prompts take Enter from end of input.
   Only the `claude` and `gh` sign-ins stay with the user.

## Checked on this PC, 2026-10-31

| Check | Result |
|---|---|
| Host | Ubuntu 26.04.1, 8 CPUs, 14 GB RAM, 406 GB free, `/dev/kvm` present |
| `gnome-boxes` | Not installed. apt offers 49.1-1 |
| ISO | `ubuntu-26.04.1-desktop-amd64.iso` is listed in `https://releases.ubuntu.com/26.04/SHA256SUMS` |

## Steps

### 1. Prepare the VM `[inline: manual, on the host]`

```bash
sudo apt install gnome-boxes
```

Download `https://releases.ubuntu.com/26.04/ubuntu-26.04.1-desktop-amd64.iso`, then compare it with `SHA256SUMS`:

```bash
sha256sum ubuntu-26.04.1-desktop-amd64.iso
```

Expected: `601e30fbf5d97759367c632e2c33630665039b7e2158fd068403da3ccf1bda1f`.

Claude creates the VM from the ISO with 4 CPUs, 6 GB RAM and a 60 GB disk, installs Ubuntu with autoinstall, logs in to
the desktop automatically, and takes a snapshot.

Done when: the snapshot exists, and it's a clean desktop with nothing else installed beyond `openssh-server`, which is
the control channel.

### 2. Run bootstrap `[inline: manual, in the VM]`

From a terminal on the VM's desktop, not SSH:

```bash
sudo apt install git
git clone https://github.com/makubexD/SyncSettings.git
cd SyncSettings
./bootstrap/linux.sh --dry-run
./bootstrap/linux.sh 2>&1 | tee ~/bootstrap.log
```

Answer the `sudo` prompt and the four values. Press Enter for `<HOME>` and for each `Overwrite` prompt. Bootstrap ends
with `./sync preview`.

Done when: bootstrap has finished. Keep `~/bootstrap.log` whatever the result.

### 3. Check the result `[inline: manual, in the VM]`

Log out and back in, then run the two read-only checks:

```bash
cd SyncSettings
./sync preview
./bootstrap/linux.sh --dry-run
```

| Check | Expected |
|---|---|
| Bootstrap exit and summary | Exit 0, no `ERROR` |
| `./sync preview` | No `DRIFT` line, nothing to send |
| `--dry-run` | No `WOULD` line |
| Rerun of `./bootstrap/linux.sh` | Nothing new installed |
| Snaps | `snap list` shows `code` and `postman` |
| VS Code | Opens with the restored settings and extensions |
| GNOME | Favorites and terminal settings are back, and the `clipboard-history` extension is on |
| Fonts | `fc-list` shows the Nerd Fonts |
| Links | `~/.local/bin` links point to `~/.claude/bin/*` |
| `claude` | Starts, and after sign-in `claude plugin list` shows the plugins |
| `gh auth login` | Works |

Not tested in the VM: the DeepSeek key and `/mk-check`, SSH and GPG keys, OmniRoute, RepoWn, the data disk and the GPU driver.

### 4. Bring the result back `[inline: judgment]`

Check `bootstrap.log` for personal values before it leaves the VM. Then send it to Claude Code with what failed, using
"execute step 4 of docs/plan-bootstrap-vm.md".

For each failure: find the cause, add a stub case to `tests/linux/bootstrap.sh` that reproduces it, then fix it on a
branch through a PR. Restore the snapshot and rerun from step 2 until step 3 passes.

### 5. Close the item `[inline: TODO edit]`

On a branch, remove the "Fresh VM run of bootstrap" section from `TODO.md` and add any finding that wasn't fixed, then
open a PR.

Done when: the PR is merged, and phase 7 has no open items.

## After this

Not part of this plan. Listed so the order survives a restart:

1. **Windows checks W0 to W6** in `TODO.md`, on the real Windows machine and in that order.
2. **Phase 8:** inventory on Windows, `winget.json`, `bootstrap/windows.ps1`. Needs W0 to W6 first.
3. **Phase 9:** cleanup, final README, Mermaid diagrams, badges, markdownlint and link check in CI, trim `CLAUDE.md`.
4. **Roll back Claude auto-approval,** in `TODO.md`, when development is done.

Small leftovers from PR #34: `docs/review-gate.md` has no `bootstrap-check` row in its table, the `DEEPSEEK_API_KEY` line
in `import.sh` still starts with "Then", and the merged remote branch `feat/linux-claude` still exists.
