# Packages and the drift report

`packages/linux/` says what this machine has installed and where it came from. You edit these lists by hand. `./sync export`
compares them with the machine and prints a `DRIFT` line for each difference, but it never changes a list and never installs
anything.

`./bootstrap/linux.sh` installs from these lists on a new machine; see [restore.md](restore.md). For the exact drift rules, see
[sync-contract.md](sync-contract.md#package-drift).

## The lists

| File | Holds | Line format |
|---|---|---|
| `apt.txt` | Packages from an apt source | `<package>` |
| `deb.txt` | `.deb` files that no apt source offers | `<package> <https url> <sha256>` |
| `apt-sources/*.sources`, `*.list` | Third-party apt sources | Copied from `/etc/apt/sources.list.d/`, byte for byte |
| `apt-sources/keyrings/*.gpg` | The public key each source names | Copied from the keyring folder, byte for byte |
| `snap.txt` | Snaps | `<name> [classic] [channel=<channel>]`, in that order |
| `npm.txt` | npm globals under nvm's newest Node | `<package>` or `@scope/name` |
| `pipx.txt` | pipx apps | `<package>` |
| `vscode-extensions.txt` | Default-profile extensions | `<publisher.name>`, lower case |
| `fonts.txt` | Nerd Fonts | `<asset> <tag> <sha256>` |
| `gnome-extensions.txt` | GNOME Shell extensions | `<uuid> <github url> <commit>` |
| `tools.txt` | Tools with no apt source: `bun`, `copilot`, `nvm`, `rtk` | `<name> <https url> <sha256>` |
| `drift-ignore.txt` | Installed names that aren't yours to restore | `<manager> <name>` |

Each `.txt` list has one entry per line, sorted with `LC_ALL=C`, with no duplicates. Blank lines and lines starting with `#`
are allowed. Versions float unless a line carries a pin, and a line carries a pin only when the download has no signed
repository behind it.

`apt.txt` and `deb.txt` are separate because a restore can run `apt install` on `apt.txt` and nothing else. A package in
`deb.txt` isn't in any source, so `apt install` would stop on it. It has to be downloaded and checked against its hash first.

The fields end up in root commands, so `scripts/ci/check-packages.sh` checks every line strictly. It also requires
`https` and a signing key for each apt source, and it rejects options that turn signature checks off. Run it after you edit a
list:

```bash
scripts/ci/check-packages.sh
```

`tools.txt` exists because of how these tools install. Their own installers edit the shell profile, need a terminal, or follow a
moving URL, so bootstrap downloads a pinned file instead, for the same reason `deb.txt` does. Drift doesn't compare these pins,
because the tools update themselves. Claude Code isn't listed: its installer checks its own download, and it updates right after.

## Reading the report

The report comes at the end of `./sync export` and `./sync preview`. Each line is `DRIFT <manager>/<name>` with a note, such as:

```text
  DRIFT      apt/cowsay  (installed, not in packages/linux/apt.txt)
```

| Note | Means | What to do |
|---|---|---|
| `installed, not in packages/linux/<file>` | You installed something the list doesn't have | [Add it](#add-a-package), [ignore it](#ignore-a-package) or uninstall it |
| `in packages/linux/<file>, not installed` | A listed package isn't on this machine | Install it, or [drop it](#drop-a-package) |
| `differs from packages/linux/apt-sources` | A source or key changed on this machine | Read what changed. For a key, see [Replace a rotated key](#replace-a-rotated-key). For a source, copy the new file if you trust the change |

A `SKIPPED` line with a list as its label means that part of the report didn't run, and the rest still did. `snap failed` is
normal in a container, and `nvm not installed` means there's no `~/.nvm/versions/node`.

For apt, "installed" and "yours" use different sources. A listed package counts as present if it's installed at all, so
`dconf-cli`, which apt marks as automatic, stays quiet. A package counts as extra only if it's marked manual, so dependencies
never show.

For npm, only the newest Node version under nvm is checked. If you keep several, globals on an older version don't show.

## Change a list

Lists aren't exported, so a change is a hand edit followed by a commit:

```bash
scripts/ci/check-packages.sh
git diff packages
./sync commit
```

> [!NOTE]
> `./sync preview` shows drift, but not your edits to `packages/`, and it doesn't leak-scan them. `git diff` shows them,
> and `./sync commit` scans and carries them.

### Add a package

Add a line to the list and keep it sorted. For a new apt source, also copy its file into `apt-sources/` and its key into
`apt-sources/keyrings/`. The source's `Signed-By` must point to `/usr/share/keyrings/` or `/etc/apt/keyrings/`.

For a package that came from a `.deb` file, use `deb.txt` if no apt source offers it, as in [Move a `.deb` pin](#move-a-deb-pin).

### Drop a package

Delete its line. If it stays installed, add it to `drift-ignore.txt` or the next report calls it extra.

### Ignore a package

Add `<manager> <name>` to `drift-ignore.txt`. The managers are `apt`, `snap`, `npm`, `pipx`, `vscode`, `font`, `extension` and
`apt-source`. A name can't be both listed and ignored for the same manager, and lint fails if it is.

Use this for what comes with the system or belongs to this hardware. A new Ubuntu release may print new lines once, and they
go here too. `nvidia-driver-580`, its kernel module and the HWE kernel are ignored on purpose, because restoring them by name
could break another machine.

## Move a pin

A pin is a line you choose to change. In each case, download into an empty temp folder and check the file before you write its
hash.

### Move a `.deb` pin

Update the package on this machine first, then check the download against it:

```bash
dir=$(mktemp -d)
gh release download <tag> -R <owner>/<repo> -p '<file>.deb' -D "$dir"
dpkg-deb -f "$dir"/*.deb Package Version
dpkg-query -W <package>
sha256sum "$dir"/*.deb
```

The two versions must match. Then put the release URL and the hash in `deb.txt`. The hash proves the file won't change later,
not that today's file is genuine, so download only from the project's own releases.

### Move a font pin

```bash
dir=$(mktemp -d)
gh release download <tag> -R ryanoasis/nerd-fonts -p '<asset>.tar.xz' -D "$dir"
mkdir "$dir/x"
tar -xJf "$dir/<asset>.tar.xz" -C "$dir/x"
diff -r "$dir/x" ~/.local/share/fonts/NerdFonts/<asset>
sha256sum "$dir/<asset>.tar.xz"
```

`diff` should report nothing but `.uuid`. Then update the tag and the hash in `fonts.txt`.

### Move an extension pin

The extension's code runs inside GNOME Shell, and `clipboard-history` reads your clipboard, so read the change before you move
the pin:

```bash
dir=$(mktemp -d)
git clone <github url> "$dir"
git -C "$dir" diff <old commit>..<new commit>
```

Then put the full 40-character commit in `gnome-extensions.txt`.

### Move a tool pin

Update the tool on this machine first, then check the download against it:

```bash
dir=$(mktemp -d)
gh release download <tag> -R <owner>/<repo> -p '<asset>' -D "$dir"
tar -xzf "$dir/<asset>" -C "$dir"
cmp "$dir/<tool>" ~/.local/bin/<tool>
sha256sum "$dir/<asset>"
```

`cmp` should print nothing. For `bun` the asset is a zip: use `unzip -jo "$dir/<asset>" -d "$dir"` and compare with `~/.bun/bin/bun`.
Then put the release URL and the hash in `tools.txt`.

`nvm` is a script, so there's no binary to compare. Download `install.sh` from the new tag, read what changed, and record its hash.
The `bootstrap-check` job downloads every pin on each PR, so a wrong hash fails there.

## Replace a rotated key

Vendors rotate keys, and some replace the local file on their own. Google's daily cron job rewrites Chrome's, for example.
When drift reports `apt-key/<file>`, compare the fingerprints before you copy anything:

```bash
gpg --show-keys --with-fingerprint packages/linux/apt-sources/keyrings/<file>
gpg --show-keys --with-fingerprint /usr/share/keyrings/<file>
```

Check the new fingerprint against the vendor's own page. Then copy the new key over the one in
`packages/linux/apt-sources/keyrings/`. Some keys live in `/etc/apt/keyrings/` instead.
