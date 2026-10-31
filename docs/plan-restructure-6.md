# Phase 6: packages and drift report

Roadmap: `docs/plan-restructure.md`. Goal of this phase: the repo says what this machine has installed and where it came
from, in lists phase 7 can install from without guessing, and `./export.sh` tells you when the machine and the lists
disagree. Export never rewrites a list.

Out of scope: installing anything, including the extension, `dconf-cli`, the `.deb` files and the fonts (phase 7),
`docs/restore.md` (phase 7), `packages/windows/` and `winget.json` (phase 8).

## Findings that shaped this plan

All from read-only checks on this machine (Ubuntu 26.04.1, GNOME 50), plus downloads into the scratchpad. Nothing was
installed, and the extension's scripts were read, not run.

| Finding | Result | Effect |
|---|---|---|
| `apt-mark showmanual` | 84 packages, and only 39 were asked for by name in `/var/log/apt/history.log`. The installer marked the rest manual: `grub-*`, `dash`, `grep`, `libpinyin15`, language packs | Diffing against it directly would print 40-odd lines on every export, and nobody reads that. Decision 2 |
| `/var/log/installer/initial-status.gz` | Missing on this install | No automatic baseline, so the noise has to be written down |
| `dconf-cli`, `dbus` | Installed, marked **auto** | The roadmap's `dconf-cli` line would always report "not installed" if "missing" were checked against `showmanual`. Decision 1 |
| `powershell`, `rustdesk` | Installed from local `.deb` files, and no apt source offers them | In `apt.txt` they would stop a restore at `apt install`. They need their own list. Decision 3 |
| Release URLs for those two and Nerd Fonts | All return 200 | Each can be pinned to a URL |
| `google-chrome-stable` | Installed from a `.deb`, but `dl.google.com` offers it too | Belongs in `apt.txt`, with its source |
| Third-party apt sources | Four: Brave, Chrome, GitHub CLI, WezTerm, in two formats (`.sources`, `.list`) and two keyring folders | Copied as they are, so `apt-sources/` has to keep both formats |
| `dpkg -S` on the keyrings | Only Brave's has a package, and Chrome's is rewritten by a daily cron job | Keys can change under us. Drift compares them. Decision 4 |
| Two `npm` on the machine | `/usr/bin/npm` (apt, Node 22) and nvm's (Node 24). nvm is only on `PATH` in some shells | `npm ls -g` can silently list the wrong tree. Decision 5 |
| `npm ls -g` under nvm | `corepack`, `npm`, `omniroute`, `opencode-ai`, `repown` | The first two ship with Node, so they're ignored |
| `snap list` | 19 snaps. `Notes` marks the bases, and `seed.yaml` names what Ubuntu installed. Only `code` (classic) and `postman` (`v11/stable`) are yours | `snap.txt` needs a confinement and a channel, not just names |
| `code --list-extensions` | 73 ids, lower case, default profile only, 0.6 s | Matches the roadmap. Named profiles stay with Settings Sync |
| Extension upstream | `git ls-remote` shows one branch, no tags, two commits | Pin by commit. Decision 6 |
| `extensions.gnome.org` | 404 for this UUID | GitHub is the only source |
| Installed extension against commit `16ab951` | Every file equals its `src/modern/` or root copy. `gschemas.compiled` is built on install | That commit is the pin, proven rather than assumed |
| Extension's `install.sh` | Runs `rm -rf` on the destination, edits `toggle-message-tray`, enables the extension | Phase 7 shouldn't run it: dconf already restores `toggle-message-tray=['<Super>m']` and `enabled-extensions`. Decision 6 |
| `glib-compile-schemas`, `gnome-extensions` | Come with `libglib2.0-0t64` and `gnome-shell` | No extra apt line needed for the extension |
| `leak-scan.sh` on the extension's UUID | It has the shape of an address, and the phase 5 exemption covers only dconf `.ini` files | Without step 2, `gnome-extensions.txt` can't be committed |
| Nerd Fonts | One family, `JetBrainsMono`, 101 files, version string `Nerd Fonts 3.5.1` | One line, pinned to `v3.5.1` |
| `/etc/fstab` | `/mnt/Data` mounts as `ntfs-3g` | `ntfs-3g` goes in `apt.txt`, even though the installer marked it |
| `run_preview` | Copies `dotfiles`, the config, `export.sh` and `scripts` only | Preview would find no `packages/` and report no drift until step 4 copies it |
| `.gitattributes` | Covers `dotfiles/common` and `dotfiles/linux` only | A Windows clone would give `packages/` CRLF. Keyrings are binary, so a blanket `text` rule would corrupt them. Step 3 |
| `.gitignore` | Has `*.key`, `*.token*`, `token` | Keyrings keep their `.gpg` names, and step 3 checks none are ignored |
| `commit.sh`, `Commit-Settings.ps1` | Stage `packages/` when it exists, and scan it. No test on either side covers that, because the folder never existed | Step 6 |
| `ci.yml` shellcheck line | Names `scripts/linux/sync.sh` and `scripts/ci/*.sh` | Drift code in `sync.sh` and lint in `scripts/ci/` are covered with no workflow change. Decision 8 |
| Timing | `apt-mark` 0.28 s, `snap list` 0.14 s, `pipx` 0.21 s, `code` 0.58 s | About 1.2 s added to an export. Acceptable |

## What gets listed

`packages/linux/`. All files are plain text except the keyrings.

| File | Line format | Entries today |
|---|---|---|
| `apt.txt` | `<package>` | 41 |
| `deb.txt` | `<package> <https url> <sha256>` | `powershell`, `rustdesk` |
| `apt-sources/*.sources`, `*.list` | Copied from `/etc/apt/sources.list.d/`, byte for byte | 4 |
| `apt-sources/keyrings/*.gpg` | Copied from the keyring folders, byte for byte | 4 |
| `snap.txt` | `<name> [classic] [channel=<channel>]` | `code classic`, `postman channel=v11/stable` |
| `npm.txt` | `<package>` | `omniroute`, `opencode-ai`, `repown` |
| `pipx.txt` | `<package>` | `poetry` |
| `vscode-extensions.txt` | `<publisher.name>`, lower case | 73 |
| `fonts.txt` | `<nerd-fonts asset> <tag> <sha256>` | `JetBrainsMono v3.5.1 <sha256>` |
| `gnome-extensions.txt` | `<uuid> <github url> <commit>` | `clipboard-history@jayeshbarman.github.io https://github.com/jayeshbarman/clipboard-history 16ab9516f0ab4c98bf825a6bf2961547f6669b3a` |
| `drift-ignore.txt` | `<manager> <name>` | 42 `apt`, 11 `snap`, 2 `npm`, 4 `apt-source` |

Every list: one entry per line, `#` starts a comment line, blank lines are allowed, data lines sorted with `LC_ALL=C` and
unique. Versions float unless a line carries a pin. A pin exists only where a download has no signed repository behind it.

`apt.txt`, the 39 from the history plus `dconf-cli` and `ntfs-3g`:

```text
brave-browser btop build-essential ca-certificates curl dconf-cli dotnet-sdk-10.0 fd-find fzf gh git
gnome-shell-extension-manager gnome-tweaks gnupg google-chrome-stable htop jq lm-sensors mesa-utils nodejs npm ntfs-3g
pipx podman python3 python3-pip python3-venv ripgrep shellcheck shfmt smartmontools snapd starship tmux tree unzip
wezterm wget xclip zip zoxide
```

`drift-ignore.txt`:

| Manager | Names |
|---|---|
| `apt` | `dash diffutils efibootmgr findutils grep grub-efi-amd64 grub-efi-amd64-signed gzip hostname ibus-table-cangjie-big ibus-table-cangjie3 ibus-table-cangjie5 init language-pack-en language-pack-en-base language-pack-gnome-en language-pack-gnome-en-base libchewing3 libchewing3-data libm17n-0 libmarisa1 libopencc-data libopencc1.1 libotf1 libpinyin-data libpinyin15 linux-generic-hwe-24.04 linux-modules-nvidia-580-generic-hwe-26.04 linux-tools-common m17n-db ncurses-base ncurses-bin nvidia-driver-580 shim-signed sysstat ubuntu-desktop-minimal ubuntu-minimal ubuntu-restricted-addons ubuntu-standard ubuntu-wallpapers wbritish wpasupplicant` |
| `snap` | `canonical-livepatch desktop-security-center firefox firmware-updater gnome-46-2404 gtk-common-themes hwctl mesa-2404 prompting-client snap-store snapd-desktop-integration` |
| `npm` | `corepack npm` |
| `apt-source` | `ubuntu-esm-apps.sources ubuntu-esm-infra.sources ubuntu.sources ubuntu.sources.curtin.orig` |

## The drift report

`report_drift` runs in `export.sh` right after `report_orphans`, and so also in preview. It's a report, like the orphan
list: it never writes a file, changes a count or changes the exit code. With no `packages/linux/` folder it prints nothing,
which is also what Windows and the existing fixtures see.

| Manager | "Present" (is a listed name installed?) | "Chosen" (is an installed name listed?) |
|---|---|---|
| `apt` | `dpkg-query`, status `installed`, for `apt.txt` and `deb.txt` | `apt-mark showmanual`, against both lists |
| `snap` | `snap list`, without rows whose `Notes` has `base` or `snapd` | Same |
| `npm` | Folders in the newest `$HOME/.nvm/versions/node/*/lib/node_modules` by `sort -V`, with `@scope/name` as one package | Same |
| `pipx` | `pipx list --short`, first field | Same |
| `vscode` | `code --list-extensions` | Same |
| `font` | Folders in `$HOME/.local/share/fonts/NerdFonts/` | Same |
| `extension` | Folders in `$HOME/.local/share/gnome-shell/extensions/` | Same |
| `apt-source` | Files in `<root>/etc/apt/sources.list.d/`, compared by content | Same |
| `apt-key` | `<root>/usr/share/keyrings/<name>`, or else `<root>/etc/apt/keyrings/<name>`, compared by content | None: system keyrings hold plenty of stock keys, so only listed keys are checked |

Output, one line per difference, through `status`. Labels are `<manager>/<name>`:

| Case | Status | Note |
|---|---|---|
| Listed, not present | `DRIFT` | `in packages/linux/<file>, not installed` |
| Chosen, not listed or ignored | `DRIFT` | `installed, not in packages/linux/<file>` |
| Source or key differs | `DRIFT` | `differs from packages/linux/apt-sources` |
| Tool missing | `SKIPPED` | Label is the list, `<tool> not installed` |
| Tool fails | `SKIPPED` | Label is the list, `<tool> failed` |
| nvm folder missing | `SKIPPED` | Label `packages/linux/npm.txt`, `nvm not installed` |

These `SKIPPED` lines don't add to `SKIPPED`, so the "file(s) skipped" note keeps counting files only. A failing tool never
stops the rest of the report. `snap list` fails in containers, and that's normal.

Core of the code, in a new `sync.sh` section before `# -- Status output`:

```bash
# -- Package drift ---------------------------------------------------------------

# Names in a list: the first field of each line, without comments and blanks.
package_names() {
    [[ -f $1 ]] || return 0
    awk '!/^[[:space:]]*(#|$)/ { print $1 }' "$1" | LC_ALL=C sort -u
}

# Names drift-ignore.txt gives for one manager.
drift_ignored() {
    [[ -f $PACKAGES_DIR/drift-ignore.txt ]] || return 0
    awk -v m="$1" '$1 == m { print $2 }' "$PACKAGES_DIR/drift-ignore.txt" | LC_ALL=C sort -u
}

# Listed names ($3, sorted) that aren't present ($4).
drift_missing() {
    local manager=$1 list=$2 listed=$3 present=$4 name
    while IFS= read -r name; do
        [[ -z $name ]] || status DRIFT "$manager/$name" "in packages/linux/$list, not installed"
    done < <(LC_ALL=C comm -23 <(printf '%s\n' "$listed") <(printf '%s\n' "$present" | LC_ALL=C sort -u))
}

# Chosen names ($4) that are neither listed ($3) nor ignored.
drift_extra() {
    local manager=$1 list=$2 listed=$3 chosen=$4 name
    while IFS= read -r name; do
        [[ -z $name ]] || status DRIFT "$manager/$name" "installed, not in packages/linux/$list"
    done < <(LC_ALL=C comm -13 <(printf '%s\n%s\n' "$listed" "$(drift_ignored "$manager")" | LC_ALL=C sort -u) \
                               <(printf '%s\n' "$chosen" | LC_ALL=C sort -u))
}
```

`report_drift` sets `PACKAGES_DIR=$REPO_ROOT/packages/linux` and `root=${DRIFT_ROOT:-}`, then calls one small function per
manager. Each runs its tool as `if ! out=$(tool 2>/dev/null); then … SKIPPED; return 0; fi`, so `set -e` can't stop the
export. `apt-mark` names lose any `:arch` suffix. For `apt`, the extra check uses `apt.txt` and `deb.txt` together, and the
note names `apt.txt`.

## Decisions to confirm in review

1. **"Missing" and "extra" use different sources for apt.** A listed package counts as present if it's installed at all, so
   `dconf-cli`, marked auto, stays quiet. A package counts as extra only if it's marked manual, so dependencies never show.
2. **A hand-written `drift-ignore.txt` instead of an automatic baseline.** The installer's record is gone, and the seed list
   covers snaps only. The cost is that a fresh Ubuntu release will print new lines once, and you move them to the ignore
   file. `nvidia-driver-580`, its kernel module, and the HWE kernel are in the ignore list on purpose: they belong to this
   hardware, so restoring them by name could break another machine. `docs/restore.md` will send you to `ubuntu-drivers`.
3. **`deb.txt` pins a URL and a SHA-256.** These files get installed as root with no signed repository behind them. The hash
   comes from today's download, so it proves the file won't change later, not that today's file is genuine. Step 3 checks
   the `.deb`'s version against the installed one. The cost is that a PowerShell or RustDesk update needs a new line by hand.
   PowerShell stays a `.deb` because that's how it got here. I didn't check whether Microsoft's repository serves 26.04.
4. **Public keys are committed, and drift compares them.** Downloading a key from the same host as the packages at restore
   time proves nothing, so the repo is the trust anchor, and they're public anyway. If Google rotates its key, the daily
   cron job updates the local file and drift says so. Copy the new key after checking its fingerprint.
5. **npm globals are read from nvm's folder, not from `npm`.** Which `npm` runs depends on the shell, and the wrong one
   lists a different tree with no error. Reading the newest version's folder doesn't depend on `PATH`. With several Node
   versions, only the newest is checked. There's one today.
6. **The extension is pinned to a commit, and phase 7 doesn't run its `install.sh`.** It's a personal repo with two commits,
   and its code runs inside GNOME Shell and reads your clipboard, so an update should be a line you chose to change. Phase 7
   does the three things that matter: copy `metadata.json`, `stylesheet.css`, `schemas/` and the `src/modern/*.js` files, then
   run `glib-compile-schemas`. Copying it into the repo stays rejected, as in phase 5.
7. **`drift-ignore.txt` wins only for "extra".** Listing a name there and in a package list is a lint error, so a name can't
   be both wanted and ignored.
8. **No workflow change.** `check-packages.sh` runs through an engine case, `lint-real-packages`, the way
   `lint-real-config` works, so `engine-linux` enforces it. `ci.yml` stays untouched, and auto-approval applies to this PR if
   its conditions hold. A separate `lint` step would read better in the Actions log, but it isn't worth a gated PR on its own.
9. **`DRIFT_ROOT` is a test-only variable.** Phase 5 refused one for dconf because a mistake there writes to the real
   desktop. This one only moves where two read-only comparisons look, and tests can't fake `/etc/apt` any other way.
10. **The lists record what's here, and your review decides what stays.** `nodejs` and `npm` from apt stay in `apt.txt`,
    since removing them is a change to the machine, not to a list. `omniroute` and `opencode-ai` are listed because they're
    installed, even though OpenCode is unused. Delete a line and add it to `drift-ignore.txt`, or uninstall it, if you don't want it restored.
11. **Bash only for now.** PowerShell gets no drift report until phase 8 has a `winget.json` to compare. It's a known
    difference in the contract.

## Shared rules

- Branch `feat/packages`, one commit per step, one draft PR opened at step 1 and marked ready at step 8. Commits carry the
  `Plan-Step` and `Route` trailers.
- From step 1 on, each step lands with `git push`, then `gh run watch` on the `ci` run. A red job counts as a rejection.
- Workers use `tests/fixtures/` only. They never open, copy or print `.user-values.json`, and they never read the real
  home, `/etc/apt` or the real package tools. Steps that read this machine are `[inline]`.
- Every drift case runs on stubs. A case that reaches the real `apt-mark`, `snap` or `code` is a bug, because the result
  would depend on the machine. The review greps each diff for cases that call `run_engine` on a `packages/` fixture without
  the stubs.
- Nothing in this phase installs, removes or marks a package. The review greps the diff for `apt install`, `apt-get`,
  `apt-mark manual`, `snap install`, `npm i`, `pipx install`, `code --install-extension`.
- An engine change updates `docs/sync-contract.md`. That happens once, in step 7, as in phase 5.

## What verifies each step

| Step | Local | CI | This machine |
|---|---|---|---|
| 1 Lint | `engine.sh lint-packages`, shellcheck | `engine-linux`, `lint` | none |
| 2 Leak scan | `engine.sh leak` | `leak-scan`, `engine-linux` | none |
| 3 Real lists | `check-packages.sh`, `leak-scan.sh`, full diff | all | Read only |
| 4 Drift, command managers | `engine.sh drift`, shellcheck | `engine-linux` | none |
| 5 Drift, files and folders | `engine.sh drift`, shellcheck | `engine-linux` | `./sync preview` prints no `DRIFT` |
| 6 Commit carries `packages/` | `engine.sh commit` | `engine-linux`, `engine-windows` | none |
| 7 Docs | read through | `lint` | none |
| 8 Verify | all | all | Read only |
| 9 This machine | manual | none | Manual |

## Steps

### 1. Lint for package lists `[worker]`

Files: `scripts/ci/check-packages.sh` (new, executable), `tests/linux/engine.sh`.

`scripts/ci/check-packages.sh [packages-dir]`, default `packages/linux`. It follows `check-config.sh`: `set -euo pipefail`,
exit 2 with `ERROR: no such directory: <dir>` if the folder is missing, one `<file>:<line>: <reason>` per problem, a
last line `<dir>: invalid entries above` and exit 1, or `<dir>: OK` and exit 0. It reads files as text and never runs them.

Comment lines (`^[[:space:]]*#`) and blank lines are skipped. Each data line must match in full:

| File | Pattern |
|---|---|
| `apt.txt` | `^[a-z0-9][a-z0-9+.-]*$` |
| `deb.txt` | `^[a-z0-9][a-z0-9+.-]* https://[A-Za-z0-9./_~+-]+\.deb [0-9a-f]{64}$` |
| `snap.txt` | `^[a-z0-9-]+( classic)?( channel=[a-z0-9./-]+)?$` |
| `npm.txt` | `^(@[a-z0-9._-]+/)?[a-z0-9._-]+$` |
| `pipx.txt` | `^[A-Za-z0-9._-]+$` |
| `vscode-extensions.txt` | `^[a-z0-9-]+\.[a-z0-9-]+$` |
| `fonts.txt` | `^[A-Za-z0-9]+ v[0-9]+\.[0-9]+\.[0-9]+ [0-9a-f]{64}$` |
| `gnome-extensions.txt` | `^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+ https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+ [0-9a-f]{40}$` |
| `drift-ignore.txt` | `^(apt\|snap\|npm\|pipx\|vscode\|font\|extension\|apt-source) [A-Za-z0-9@][A-Za-z0-9@/+._-]*$` |

The patterns are strict because phase 7 hands these fields to root commands, and a public repo takes PRs.

More rules:

- Data lines are sorted (`LC_ALL=C`) and unique, on the whole line, in each file. Reason: `not sorted` or `duplicate`.
- A file directly in the folder that isn't one of the nine above fails, with reason `unknown list`.
- A name in both `apt.txt` and `deb.txt` fails. So does a name in a list and under that list's manager in `drift-ignore.txt`.
- `apt-sources/`: only `*.sources`, `*.list` and `keyrings/*.gpg`.
  - Every `URIs:` value and `deb` line URL starts with `https://`.
  - Every source has `Signed-By:` or `signed-by=`, under `/usr/share/keyrings/` or `/etc/apt/keyrings/`, and that basename
    exists in `keyrings/`.
  - Every key in `keyrings/` is named by a source.

Write the cases first. `lint_packages_run` builds a valid folder under `$t`, one line per list, one source and its key, applies
the change, and runs the script. Valid data uses invented names, no real address, and a 64-hex and 40-hex string.

| Case | Change | Expected |
|---|---|---|
| `lint-packages-ok` | none | Exit 0, `<dir>: OK` |
| `lint-packages-empty-dir` | Empty folder | Exit 0 |
| `lint-packages-no-dir` | Folder missing | Exit 2 |
| `lint-packages-comments` | Comment and blank lines between data lines, out of order with them | Exit 0 |
| `lint-packages-apt-shell` | `apt.txt` line `foo;rm` | Exit 1, names `apt.txt:<line>` |
| `lint-packages-apt-upper` | `Foo` | Exit 1, same |
| `lint-packages-apt-two-fields` | `foo bar` | Exit 1, same |
| `lint-packages-unsorted` | `b` before `a` | Exit 1, `not sorted` |
| `lint-packages-duplicate` | `a` twice | Exit 1, `duplicate` |
| `lint-packages-deb-http` | `http://` URL | Exit 1, names `deb.txt` |
| `lint-packages-deb-no-hash` | No hash | Exit 1, same |
| `lint-packages-deb-short-hash` | 63 hex characters | Exit 1, same |
| `lint-packages-deb-subshell` | URL holding `$(x)` | Exit 1, same |
| `lint-packages-snap-options` | `a classic channel=v1/stable` | Exit 0 |
| `lint-packages-snap-order` | `a channel=v1/stable classic` | Exit 1, names `snap.txt` |
| `lint-packages-npm-scoped` | `@scope/name` | Exit 0 |
| `lint-packages-vscode-upper` | `Pub.Name` | Exit 1, names `vscode-extensions.txt` |
| `lint-packages-font-no-tag` | `Name abc` | Exit 1, names `fonts.txt` |
| `lint-packages-extension-other-host` | `https://example.com/a/b` | Exit 1, names `gnome-extensions.txt` |
| `lint-packages-extension-branch` | `main` for the commit | Exit 1, same |
| `lint-packages-ignore-manager` | `brew x` | Exit 1, names `drift-ignore.txt` |
| `lint-packages-unknown-file` | `extra.txt` | Exit 1, `unknown list` |
| `lint-packages-apt-and-deb` | Same name in both | Exit 1, names the package |
| `lint-packages-listed-and-ignored` | `apt foo` ignored, `foo` in `apt.txt` | Exit 1, names the package |
| `lint-packages-same-name-other-manager` | `snap foo` ignored, `foo` in `apt.txt` | Exit 0 |
| `lint-packages-source-http` | `URIs: http://…` | Exit 1, names the source |
| `lint-packages-list-http` | `.list` line with `http://` | Exit 1, names the source |
| `lint-packages-source-unsigned` | No `Signed-By` | Exit 1, names the source |
| `lint-packages-source-key-missing` | `Signed-By` names an absent file | Exit 1, names the source |
| `lint-packages-source-key-elsewhere` | `Signed-By: /tmp/k.gpg` | Exit 1, names the source |
| `lint-packages-key-unused` | A key no source names | Exit 1, names the key |
| `lint-packages-source-other-file` | `apt-sources/notes.md` | Exit 1, `unknown list` |

Test: `tests/linux/engine.sh lint-packages` green; shellcheck clean. In the review, drop `[0-9a-f]{64}` to `[0-9a-f]+` and see
`lint-packages-deb-short-hash` fail.

### 2. The extension list isn't an address `[worker:low]`

Files: `scripts/ci/leak-scan.sh`, `tests/linux/engine.sh`.

In `scan_email`, next to the dconf exemption. It covers only a full, well-formed line of that one file, so an address
anywhere else on the line still fails:

```bash
        # A UUID has the shape of an address; a whole line of this list is safe.
        if [[ $file == *packages/linux/gnome-extensions.txt \
            && $text =~ ^[^[:space:]@]+@[^[:space:]@]+\ https://github\.com/[^[:space:]@]+\ [0-9a-f]{40}$ ]]; then
            continue
        fi
```

Cases, each writing one file under `$t` and running the scan on it. Use the placeholder hash and `someone`, not real values.

| Case | File | Line | Expected |
|---|---|---|---|
| `leak-gnome-list-ok` | `packages/linux/gnome-extensions.txt` | `clip@someone.github.io https://github.com/someone/clip <40 hex>` | Exit 0 |
| `leak-gnome-list-comment` | same | `# ask person@gmail.com` | Exit 1, `email` |
| `leak-gnome-list-extra-field` | same | The valid line plus ` person@gmail.com` | Exit 1, `email` |
| `leak-gnome-list-url-address` | same | `clip@someone.github.io https://person@gmail.com/x <40 hex>` | Exit 1, `email` |
| `leak-gnome-list-short-commit` | same | The valid line with a 7-character commit | Exit 1, `email` |
| `leak-gnome-other-file` | `packages/linux/npm.txt` | The valid line | Exit 1, `email` |

Test: `tests/linux/engine.sh leak` green; shellcheck clean.

### 3. The real lists `[inline: reads this machine, and choosing what's kept is judgment]`

Files: `packages/linux/*`, `packages/linux/apt-sources/**`, `.gitattributes`, `tests/linux/engine.sh`.

1. `.gitattributes`, keeping this order so the second line wins for keys:

   ```text
   packages/** text eol=lf
   packages/**/*.gpg binary
   ```

2. Write the lists from [What gets listed](#what-gets-listed). `vscode-extensions.txt` comes from `code --list-extensions`, read
   through once.
3. Copy the four sources and four keys, unchanged:

   | Source | Key |
   |---|---|
   | `brave-browser-release.sources` | `/usr/share/keyrings/brave-browser-archive-keyring.gpg` |
   | `github-cli.list` | `/etc/apt/keyrings/githubcli-archive-keyring.gpg` |
   | `google-chrome.sources` | `/usr/share/keyrings/google-chrome.gpg` |
   | `wezterm.list` | `/usr/share/keyrings/wezterm-fury.gpg` |

4. Pins, with `gh release download` into the scratchpad:

   | Line | Check before writing the hash |
   |---|---|
   | `powershell`, tag `v7.6.6`, `powershell_7.6.6-1.deb_amd64.deb` | `dpkg-deb -f <file> Version` equals `dpkg-query -W powershell` |
   | `rustdesk`, tag `1.5.0`, `rustdesk-1.5.0-x86_64.deb` | Same for `rustdesk` |
   | `JetBrainsMono`, tag `v3.5.1`, `JetBrainsMono.tar.xz` | Unpack it. `diff -r` against `~/.local/share/fonts/NerdFonts/JetBrainsMono` shows no differences, apart from `.uuid` |

   If a check fails, stop and bring it back: the pin wouldn't reproduce this machine.
5. New case `lint-real-packages` in `engine.sh`: `scripts/ci/check-packages.sh` from `$REPO` exits 0 and prints
   `packages/linux: OK`.

Test:

1. `scripts/ci/check-packages.sh` OK; `tests/linux/engine.sh lint-real-packages` green.
2. `scripts/ci/leak-scan.sh` clean; `grep -rl "$HOME" packages` prints nothing. Without printing them, the cached-value check
   finds no `.user-values.json` value in `packages/`.
3. `git status --short packages | wc -l` counts every file, and `git status --ignored --short packages` shows no `!!` line.
4. `git check-attr text eol -- packages/linux/apt.txt` gives `set` and `lf`. For a `.gpg` file, `text` is `unset`.
5. `comm` of `apt-mark showmanual` against `apt.txt`, `deb.txt` and the ignore list is empty both ways, and every line of
   `apt.txt` and `deb.txt` is `installed`.
6. Read the whole diff. The repo is public.

### 4. Drift for command managers `[worker:high]`

Files: `scripts/linux/sync.sh`, `export.sh`, `tests/linux/engine.sh`.

Add the section from [The drift report](#the-drift-report) with `report_drift` covering `apt`, `snap`, `npm`, `pipx` and `vscode`.
Call it in `export.sh` after `report_orphans`. In `run_preview`, copy `packages` into `$PREVIEW_TMP/after/` when it exists.

`setup_drift_case` in `engine.sh`: `new_tmp`, `setup_repo`, `setup_home_fixture`, `setup_repo_fixture`, then creates
`$t/repo/packages/linux/`, `$t/root` and stubs in `$t/bin`. Each stub prints `$t/stub/<tool>.out` and exits with
`$t/stub/<tool>.rc` (default 0):

```bash
for tool in apt-mark dpkg-query snap pipx code; do
    cat > "$t/bin/$tool" <<EOF
#!/bin/sh
cat "$t/stub/$tool.out" 2>/dev/null
exit "\$(cat "$t/stub/$tool.rc" 2>/dev/null || echo 0)"
EOF
    chmod +x "$t/bin/$tool"
done
```

`run_drift` is `PATH="$t/bin:$PATH" DRIFT_ROOT="$t/root" run_engine "$t/home" export.sh`. `dpkg-query` output in fixtures is
`installed <name>` lines, so the stub stands in for the engine's format string. `$t/home` has
`.nvm/versions/node/v1.0.0/lib/node_modules/` with no packages by default.

| Case | Setup | Expected |
|---|---|---|
| `drift-no-packages` | No `packages/` folder | No `DRIFT` line, no line naming `packages/`, exit 0 |
| `drift-none` | Lists equal the stubs | No `DRIFT` line |
| `drift-empty-list` | `apt.txt` holds only a comment; stubs print nothing | No `DRIFT` line, no blank label |
| `drift-apt-extra` | `showmanual` has `foo`, not listed | `DRIFT apt/foo (installed, not in packages/linux/apt.txt)` |
| `drift-apt-missing` | `apt.txt` has `foo`, not in `dpkg-query` | `DRIFT apt/foo (in packages/linux/apt.txt, not installed)` |
| `drift-apt-auto-listed` | `apt.txt` has `foo`, in `dpkg-query`, not in `showmanual` | No `DRIFT` line |
| `drift-apt-not-installed-state` | `dpkg-query` has `config-files foo` | `foo` counts as not installed |
| `drift-apt-ignored` | `showmanual` has `foo`, `apt foo` ignored | No `DRIFT` line |
| `drift-apt-ignore-other-manager` | `showmanual` has `foo`, `snap foo` ignored | `DRIFT apt/foo` |
| `drift-apt-arch-suffix` | `showmanual` has `foo:i386`, `apt.txt` has `foo` | No `DRIFT` line |
| `drift-deb-listed` | `deb.txt` has `foo <url> <hash>`, installed and manual | No `DRIFT` line |
| `drift-deb-missing` | Same, not in `dpkg-query` | `DRIFT apt/foo (in packages/linux/deb.txt, not installed)` |
| `drift-snap-notes` | Rows with `Notes` of `base`, `snapd`, `-` and `classic` | Only the last two count |
| `drift-snap-options` | `snap.txt` has `foo classic channel=v1/stable`, `snap list` has `foo` | No `DRIFT` line |
| `drift-snap-extra` | `snap list` has `foo`, not listed | `DRIFT snap/foo` |
| `drift-snap-missing` | `snap.txt` has `foo`, not installed | `DRIFT snap/foo` |
| `drift-npm-extra` | `node_modules/foo`, not listed | `DRIFT npm/foo` |
| `drift-npm-scoped` | `node_modules/@a/b`, `npm.txt` has `@a/b` | No `DRIFT` line |
| `drift-npm-newest` | `v9.0.0` and `v10.0.0` folders holding different packages | Only `v10.0.0` counts: `sort -V`, not text order |
| `drift-npm-hidden` | `node_modules/.bin` | No `DRIFT` line |
| `drift-npm-no-call` | An `npm` stub that writes `$t/called` | `$t/called` doesn't exist |
| `drift-npm-no-nvm` | No `.nvm` in `$t/home` | `SKIPPED packages/linux/npm.txt (nvm not installed)`, other managers still report |
| `drift-pipx` | `pipx list --short` stub prints `foo 1.2.3`, `pipx.txt` has `foo` | No `DRIFT` line |
| `drift-vscode` | Stub has `a.b`, `vscode-extensions.txt` has `c.d` | `DRIFT vscode/a.b` and `DRIFT vscode/c.d` |
| `drift-tool-missing` | `PATH` of symlinks without `snap`, like `sync-missing-tool` | `SKIPPED packages/linux/snap.txt (snap not installed)`, exit 0 |
| `drift-tool-fails` | `snap.rc` is 1 | `SKIPPED packages/linux/snap.txt (snap failed)`, exit 0, `pipx` still reports |
| `drift-counts-unchanged` | Three `DRIFT` lines and one `SKIPPED` from a tool, repo otherwise current | `Repo is up to date`, no `file(s) skipped` note, exit 0 |
| `drift-writes-nothing` | Any drift | `tree_hash` of `packages/` unchanged |
| `drift-preview` | A drift, `export.sh --preview` | `DRIFT` line shown, `Nothing would be sent`, `tree_hash` of the repo unchanged |
| `drift-import-silent` | A drift, `import.sh --force` | No `DRIFT` line |

Test: `tests/linux/engine.sh drift` green; full suite green; shellcheck clean. Point `drift_missing` at `showmanual` for apt and see
`drift-apt-auto-listed` fail. Replace `sort -V` with `sort` and see `drift-npm-newest` fail.

### 5. Drift for fonts, extensions and apt sources `[worker]`

Files: `scripts/linux/sync.sh`, `tests/linux/engine.sh`.

Add `font`, `extension`, `apt-source` and `apt-key` to `report_drift`, from the table. They read folders, so a missing folder
means nothing is present, not `SKIPPED`. The `apt-source` check compares with `cmp -s`, and a source in the repo and not on the
machine is "not installed". `<root>` is `${DRIFT_ROOT:-}`. A listed source or key that can't be read counts as not installed.

| Case | Setup | Expected |
|---|---|---|
| `drift-font-ok` | `fonts.txt` line, folder `NerdFonts/Name` | No `DRIFT` line |
| `drift-font-missing` | No folder | `DRIFT font/Name (in packages/linux/fonts.txt, not installed)` |
| `drift-font-extra` | Folder `Other` | `DRIFT font/Other (installed, not in packages/linux/fonts.txt)` |
| `drift-font-loose-file` | `.uuid` file in `NerdFonts/` | No `DRIFT` line |
| `drift-extension-ok` | Line and folder for one UUID | No `DRIFT` line |
| `drift-extension-missing` | Line, no folder | `DRIFT extension/<uuid>` |
| `drift-extension-extra` | Folder, no line | `DRIFT extension/<uuid>` |
| `drift-no-folders` | Empty lists, no `fonts/` or `extensions/` folder in the home | No `DRIFT`, no `SKIPPED` line |
| `drift-source-ok` | Same file in repo and `$t/root/etc/apt/sources.list.d/` | No `DRIFT` line |
| `drift-source-differs` | One byte differs | `DRIFT apt-source/<file> (differs from packages/linux/apt-sources)` |
| `drift-source-missing` | Only in the repo | `DRIFT apt-source/<file> (in packages/linux/apt-sources, not installed)` |
| `drift-source-extra` | Only on the machine | `DRIFT apt-source/<file> (installed, not in packages/linux/apt-sources)` |
| `drift-source-ignored` | Only on the machine, `apt-source <file>` ignored | No `DRIFT` line |
| `drift-key-usr-share` | Key equal under `usr/share/keyrings` | No `DRIFT` line |
| `drift-key-etc-apt` | Key equal under `etc/apt/keyrings` | No `DRIFT` line |
| `drift-key-differs` | One byte differs | `DRIFT apt-key/<file> (differs from packages/linux/apt-sources)` |
| `drift-key-missing` | In neither folder | `DRIFT apt-key/<file> (in packages/linux/apt-sources, not installed)` |
| `drift-key-stock-ignored` | Another key on the machine only | No `DRIFT` line |

Test: `tests/linux/engine.sh drift` green; full suite green; shellcheck clean. Then, in the main session, `./sync preview` on this
machine prints no `DRIFT` line, and `git status --short` shows no change. If Chrome's key moved since step 3, that's a true
report: copy it and amend step 3's files in a new commit.

### 6. Commit carries `packages/` `[worker]`

Files: `tests/linux/engine.sh`, `tests/windows/Engine.Tests.ps1`.

No engine change. Both scripts already do this, and these cases prove it. Add the same two cases on both sides, built on `commit-happy`
and `commit-leak-blocked`:

| Case | Setup | Expected |
|---|---|---|
| `commit-packages` | A changed `packages/linux/apt.txt`, nothing else | Exit 0, the branch's commit holds that file, `master` didn't move |
| `commit-packages-leak-blocked` | A home path in `packages/linux/apt.txt` | Stops before committing, and prints `packages/linux/apt.txt` and the rule, not the text |

Test: `tests/linux/engine.sh commit` green; CI `engine-windows` green, and both cases show in the job's log.

### 7. Docs `[inline: user-facing copy]`

Files: `docs/packages.md` (new), `docs/sync-contract.md`, `docs/layout.md`, `docs/daily-workflow.md`, `README.md`, `CLAUDE.md`,
`docs/plan-restructure.md`.

- `docs/packages.md`:
  - One table of the lists and their line formats, and why `apt.txt` and `deb.txt` are separate.
  - Reading the report: each `DRIFT` note and what to do about it.
  - How to add a package, drop one, or ignore one.
  - How to move a pin: a new `.deb`, font release or extension commit, with the checks from step 3, including reading the
    extension's diff.
  - How to replace a rotated key.
  - That preview shows drift but not your hand edits to `packages/`; `git diff` does, and `./sync commit` carries them.
- `docs/sync-contract.md`:
  - Flow: export ends with the drift report.
  - Statuses: `DRIFT` in the Both table, and the `SKIPPED` lines that don't count.
  - New section "Package drift": sources per manager, the two-source rule for apt, `drift-ignore.txt`, never changes a count
    or the exit code, `DRIFT_ROOT`.
  - Known differences and Parity: bash only until phase 8.
- `docs/layout.md`: the tree gains `packages/`. A note that lists aren't `dotfiles/`, so no entry owns them and `ORPHAN` doesn't apply.
- `docs/daily-workflow.md`: a `DRIFT` line after installing something is normal, and what to do next.
- `README.md`: the repo map gains `packages/`, and "Read next" links `docs/packages.md`. Step 1 of the restore section says the
  lists are in `packages/linux/` until bootstrap exists.
- `CLAUDE.md`: Key Patterns gain a drift bullet, Testing gains "drift cases run on stubs", Architecture names `packages/linux/`.
  The "Claude auto-approval" section is untouched.
- `docs/plan-restructure.md`:
  - Inventory: the Nerd Fonts, VS Code extensions and apt rows are done, and the `.deb` split is named.
  - Target layout: `deb.txt`, `gnome-extensions.txt`, `drift-ignore.txt`, `apt-sources/keyrings/`.
  - Phase 7 gains:
    - Install sources and keys before apt, using the paths in each source.
    - Verify the SHA-256 before installing a `.deb` or unpacking a font.
    - Install the extension by copying `src/modern/`, without its `install.sh`.
    - `ubuntu-drivers` for the GPU, as a `docs/restore.md` step.
    - `copilot`, with the other standalone installers.

Test: read through; every link in the changed docs resolves; `scripts/ci/check-packages.sh` still OK.

### 8. Verify and PR `[inline: final review]`

1. `tests/linux/engine.sh` green; shellcheck with the `ci.yml` command clean; `scripts/ci/check-config.sh` and
   `scripts/ci/check-packages.sh` OK; `scripts/ci/leak-scan.sh` clean; `grep -rl "$HOME" dotfiles packages` prints nothing.
2. The two greps from [Shared rules](#shared-rules) are clean, and `git diff master...HEAD --stat` touches none of
   `.github/workflows/`, `docs/review-gate.md`, `.claude/settings.json` or the auto-approval section.
3. `./sync preview` on this machine: no `DRIFT`, and it prints that nothing would be sent.
4. In a throwaway clone, `HOME=$(mktemp -d) ./export.sh < /dev/null`: exit 0, with `npm`, `font` and `extension` differences
   reported from the empty home and nothing else broken. Delete the clone.
5. `gh pr ready`. `leak-scan`, `lint`, `engine-linux`, `engine-windows` green.
6. `/agent-skills:review` of the phase diff, with the leak-scan exemption and the `deb.txt` pins called out.
7. If the conditions in `CLAUDE.md` hold, add `reviewed` and merge. Otherwise stop for your label.

### 9. Check this machine `[inline: the real machine]`

After the merge: `git switch master && git pull`.

1. `./sync preview` prints no `DRIFT` line.
2. `sudo apt install cowsay`, then `./sync preview`: `DRIFT apt/cowsay (installed, not in packages/linux/apt.txt)`, and
   `git status --short` shows nothing. You run the `sudo` commands.
3. `sudo apt remove cowsay`, then `sudo apt autoremove`, then `./sync preview`: no `DRIFT` line.
4. Rename `~/.local/share/fonts/NerdFonts/JetBrainsMono` for a moment: `DRIFT font/JetBrainsMono`. Rename it back.

## Not in this plan

- Installing anything (phase 7).
- `~/.claude` plugins, a phase 7 item.
- Standalone installers: nvm, bun, rtk, claude and copilot. Each has its own recipe, so a list adds nothing, and bootstrap
  carries them. Drift doesn't check them.
- `packages/windows/` and a Windows drift report (phase 8).
- A `./sync drift` command. Preview already answers the question.
- Pinning apt, snap, npm or VS Code versions: they come from signed sources, and a restore should get current versions.
- VS Code named profiles (Settings Sync).
- `/usr/local/bin/prime-run` and `~/sata-diagnosis/`, with the `sata-status` link. They're hand-written, not packages. If you want
  them on a restored machine, they need `sync-config.json` entries, which `prime-run` can't get as things stand: `localPath`
  only reaches `~`.

## Done when

- `packages/linux/` holds every list, `check-packages.sh` and the leak scan are clean, and `engine-linux` enforces both.
- `./sync preview` prints no `DRIFT` on this machine, and a package installed by hand shows up on the next one.
- Every `deb.txt` and `fonts.txt` pin was checked against what's installed.
- `gnome-extensions.txt` pins the commit whose files match the installed extension.
- `commit-packages` passes on both engines.
- No step installed, removed or marked a package.
- The roadmap's phase 7 names what this phase left it.
