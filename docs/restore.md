# Restore a machine

This page takes a new machine back to your setup. Bootstrap handles everything the repo can hold. The rest is a short manual
list, because this repo is public and secrets never go in it.

On Ubuntu, run `./bootstrap/linux.sh`. Windows comes in a later phase; see [Windows](#windows).

## Before you lose the machine

The repo holds your configs and the lists of what to install. It doesn't hold the files below, so each one needs its own
backup, such as a password manager:

| What | Where | Without it |
|---|---|---|
| DeepSeek key | `~/.config/claude-workers/env` | `mk-exec` can't run |
| OmniRoute settings | `~/.config/opencode/omniroute.env` | Nothing in the shell breaks; the line that loads it is guarded |
| RepoWn accounts | `~/.config/repown/accounts.json` | You add the accounts again |
| SSH keys | `~/.ssh` | You make new ones and register them |
| GPG keys | `~/.gnupg` | You can't sign or decrypt with the old keys |

Sign-ins aren't backed up either, but you only have to repeat them: `gh`, Claude Code and VS Code Settings Sync.

Your own projects, and anything else outside the synced files, are also not here.

## Restore Ubuntu

Install Ubuntu 26.04 and sign in to the desktop. Open a terminal on the desktop, not a text console or SSH, because the GNOME
settings need your desktop session. Then run:

```bash
sudo apt install git
git clone https://github.com/makubexD/SyncSettings.git
cd SyncSettings
./bootstrap/linux.sh
```

Run it as your own user, not with `sudo`. It installs packages, tools and configs, links the scripts, adds the Claude plugins, and
ends with `./sync preview`, so the last thing on screen is the state of the machine. Expect it to take a while.

### What it asks

- **Your `sudo` password.** It asks at the start. A long package install can outlast `sudo`'s timeout, so it may ask again.
- **Four values:** your name, your email, your GitHub username and your work plugin marketplace URL. `<HOME>` comes from the
  environment, so press Enter. The answers stay in `.user-values.json`, which git ignores.
- **`Overwrite <file>? [Y/n]`, once for each stock file** such as `.bashrc`. Enter means yes. Import saves the old file as
  `<file>.bak` first.

### What the lines mean

| Status | Means | What to do |
|---|---|---|
| `INSTALLED` | Bootstrap added it | Nothing |
| `UNCHANGED` | It was already there | Nothing |
| `SKIPPED` | Bootstrap left it alone, and the note says why | See below |
| `ERROR` | That item failed, and the steps after it still ran | Read the message above it, fix the cause, and rerun |
| `WOULD` | `--dry-run` only: it's missing, and a real run would install it | Rerun without `--dry-run` |

Import prints its own status for each file, such as `CREATED` and `UPDATED`. See [sync-contract.md](sync-contract.md#statuses).

Bootstrap exits 1 if any step failed, and the summary names each one. Rerunning is always safe: it skips what's there and retries
what isn't.

| `SKIPPED` note | Means | What to do |
|---|---|---|
| `no desktop session` | You ran it outside the desktop, so import and preview didn't run | Rerun from a terminal on the desktop |
| `snapd not running` | Normal in a container. On a desktop, snapd isn't working | Fix snapd and rerun |
| `code not installed` | The VS Code snap didn't install | Fix the snap step first |
| `differs from the repo` | An apt source or key on the machine isn't the repo's copy. Bootstrap keeps it, because a key may have rotated on purpose | Read [Replace a rotated key](packages.md#replace-a-rotated-key) |
| `exists; left alone` | A different file is at `~/.local/bin/<name>` | Remove it if you want the link, and rerun |
| `settings.json or claude not installed` | Import or the Claude step didn't finish | Fix that first, and rerun |

## Finish by hand

Bootstrap can't do these. Do each one you need:

1. **Log out and back in**, so the GNOME extension, the fonts and the `PATH` from `.profile` take effect.
2. **GitHub:** run `gh auth login`. `./sync commit` needs it.
3. **Claude Code:** run `claude` and sign in. `~/.claude.json` isn't synced.
4. **DeepSeek key,** for `mk-exec`:

   ```bash
   mkdir -p -m 700 ~/.config/claude-workers
   printf 'export DEEPSEEK_API_KEY=%s\n' '<key>' > ~/.config/claude-workers/env
   chmod 600 ~/.config/claude-workers/env
   ```

   Then run `/mk-check` in Claude Code. All checks should pass, and the live job should finish on DeepSeek.

5. **OmniRoute and RepoWn,** if you use them: put `omniroute.env` in `~/.config/opencode/` and `accounts.json` in
   `~/.config/repown/`, then `chmod 600` both.
6. **SSH keys,** if the machine needs them: put them in `~/.ssh` with `chmod 600`. Git reaches GitHub through `gh`, so you may not
   need any.
7. **GPG keys,** if you sign anything: `gpg --import <backup>`.
8. **VS Code:** turn on Settings Sync for your named profiles. Bootstrap restores only the default profile.
9. **The data disk:** the launchers and the file manager bookmark expect it at `/mnt/Data`. Add it to `/etc/fstab` by the new
   machine's UUID (`lsblk -f` shows it), with `ntfs-3g` as the file system type if it's NTFS:

   ```text
   UUID=<uuid>  /mnt/Data  ntfs-3g  defaults  0  0
   ```

10. **GPU driver:** run `sudo ubuntu-drivers install`. It isn't in the lists, because the driver belongs to the hardware.

## What isn't restored

- `/usr/local/bin/prime-run`, which is outside `~`.
- `~/sata-diagnosis/` and its `sata-status` link, which are specific to one disk.
- Named VS Code profiles, which stay with Settings Sync.
- Claude Code's plugin caches. They reinstall with the plugins, so there's nothing to do.

## Check that it worked

Both commands are read-only:

```bash
./sync preview
./bootstrap/linux.sh --dry-run
```

`./sync preview` should print no `DRIFT` line and nothing to send. `--dry-run` should print no `WOULD` line.

Tool pins aren't part of the report, and the tools update themselves, so a restored tool can be older than the one you had
until it updates.

## Windows

There's no Windows bootstrap yet. It comes in phase 8 of [the roadmap](plan-restructure.md). Until then, install Git, clone the
repo and run `import.bat`.
