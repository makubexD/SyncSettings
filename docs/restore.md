# Restore a machine

This page takes a new machine back to your setup. Bootstrap handles everything the repo can hold. The rest is a short manual
list, because this repo is public and secrets never go in it.

On Ubuntu, run `./bootstrap/linux.sh`. On Windows, the one-line installer restores your settings; see [Windows](#windows).
On a Mac, see [macOS](#macos): there is no bootstrap, so apps come from Homebrew.

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
curl -fsSL https://raw.githubusercontent.com/makubexD/SyncSettings/master/install.sh | bash
```

It installs `git` and `jq` if needed (it asks first), clones the repo to `~/SyncSettings`, and runs `mksync setup`. Answer
yes to `Also restore apps and packages from packages/linux (uses sudo)?`; that runs `./bootstrap/linux.sh`, described
below. You can also run it yourself from the clone.

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

A new Windows machine starts from one line in PowerShell, as your own user:

```powershell
irm https://raw.githubusercontent.com/makubexD/SyncSettings/master/install.ps1 | iex
```

It offers to install Git and the GitHub CLI with `winget` (it asks first), clones the repo to `%USERPROFILE%\SyncSettings`,
puts `mksync` on your user `PATH`, and runs `mksync setup`. Setup runs `doctor`, shows what the import would change, and
applies it after you say yes, asking for the values the configs need on the way (your name and email for git, for
example). It keeps a `.bak` of every file it replaces. Then open a new window and run `mksync`; `Machine : matches the repo` means
it worked.

There's no Windows package restore: apps aren't installed for you, only their settings. Install the apps first (VS Code,
Windows Terminal, Git Bash comes with Git), then run setup again, or `mksync pull`, so settings whose folder was missing
get created. Import skips a file whose folder doesn't exist yet.

The Windows checks in [`TODO.md`](../TODO.md) were written for the machine that already had the old layout. On a new
machine W0 (old layout) and W1 (the first migrating import) don't apply, because the one-liner's setup is that import.
W2 (git works), W3 (the round trip, now `mksync` showing nothing to do), W4 (apps), W5 (the PR flow, now `mksync push`)
and W6 (the global git ignore) still tell you it worked.

## macOS

There is no bootstrap on a Mac: the package lists in `packages/linux/` are Ubuntu packages. Install Homebrew and run the
[install line](../README.md#install), which installs `bash` and `jq`, clones the repo and runs `mksync setup`. Setup
imports the files whose platform includes `macos` (shell, git credentials, terminal tools, VS Code, `CLAUDE.md`); install
the apps behind them (`brew install tmux starship htop gh`, WezTerm, VS Code) yourself. Then restore the files from
[Before you lose the machine](#before-you-lose-the-machine) and sign in to `gh`.

What's left on Linux only: GNOME settings, the package drift report, and the rest of the Claude Code setup in `~/.claude`
(settings, hooks, scripts), which still assumes Linux paths. `mksync setup --bootstrap` and `bootstrap/linux.sh` don't
run on a Mac.

The scripts handle entries whose `platform` is `"macos"`, `"common"`, or a list that names `macos`, and an entry's
`localPaths.macos` replaces its `localPath` there (VS Code keeps its settings in
`~/Library/Application Support/Code/User/`).

### Troubleshooting on macOS

| You see | Do |
|---|---|
| `ERROR: SyncSettings needs bash 4 or newer (this is 3.2.57…)` | `brew install bash`. The scripts switch to Homebrew's bash by themselves once it's in `/opt/homebrew/bin` or `/usr/local/bin` |
| `ERROR: install Homebrew first: https://brew.sh` | Install Homebrew with the line on its site, open a new Terminal, and run the install line again |
| `MISSING  jq: install with brew install jq` | `brew install jq` |
| `brew` not found right after installing it | Homebrew isn't on `PATH` yet. Apple silicon Macs use `/opt/homebrew`, Intel Macs `/usr/local`; the synced `~/.zprofile` loads whichever exists, or run `eval "$(/opt/homebrew/bin/brew shellenv)"` (`/usr/local/bin/brew` on Intel) |
| `WARN  macOS 12.7 is older than 13` | Update macOS. Older releases may work, but Homebrew and the CI run only cover 13 and newer |
