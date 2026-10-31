# Phase 7: bootstrap and restore runbook

Roadmap: `docs/plan-restructure.md`. Goal of this phase: on a fresh Ubuntu 26.04 desktop, `sudo apt install git`, a clone
and `./bootstrap/linux.sh` bring back the packages, tools, configs, links and plugins. `docs/restore.md` covers what can't
be in a public repo. Running bootstrap again changes nothing that's already there.

Out of scope: Windows (`bootstrap/windows.ps1` is phase 8), the final README landing page (phase 9), and anything that
needs a secret. Secrets stay manual.

## Findings that shaped this plan

All from read-only checks on this machine, downloads into the scratchpad, a throwaway `CLAUDE_CONFIG_DIR`, and a clean
`ubuntu:26.04` container under podman. Nothing was installed on this machine.

| Finding | Result | Effect |
|---|---|---|
| Sources and keys from `packages/linux/apt-sources/` in a clean 26.04 container | `apt-get update` works with all four, using the paths in each source | The repo's copies are enough, and the keys don't need downloading |
| `apt-get install -s` on all of `apt.txt` there | Exit 0, 1464 packages, no errors | Every name resolves from a fresh machine's sources. CI can keep proving that. Step 10 |
| `apt-get install -s` on both `deb.txt` files | Exit 0, both hashes match | The pins still download, and their dependencies resolve |
| `ubuntu-desktop-minimal`, `ubuntu-standard` | Neither depends directly on `git`, `curl` or `jq`. `ca-certificates`, `fontconfig`, `unzip`, `wget` and `xz-utils` are direct dependencies | The runbook starts with `sudo apt install git`. Bootstrap can't use `jq` or `curl` until the apt step has run |
| Container image | Has no `git`, `curl`, `jq`, `sudo`, `gpg`, `unzip` or `xz` | The CI script installs what it needs. Bootstrap installs `ca-certificates` before it adds `https` sources |
| How the tools got here (`.bash_history`) | `curl … \| bash` from `bun.com`, `claude.ai`, `gh.io` and rtk's `master`. nvm from a tagged URL, `nvm install --lts` | Four of the five ran an unpinned script from a moving URL. Decision 1 |
| `gh.io/copilot-install` | Offers to append to `~/.profile`, and reads `/dev/tty` | Can't run unattended, and it edits a synced file. Use the tarball |
| `bun.sh/install` | Edits the shell profile and needs `unzip` | Same. Use the zip |
| rtk `install.sh` | Takes the latest release, and checks it against `checksums.txt` | Use the tarball, so a restore gets the proven version |
| nvm `install.sh` | With `PROFILE=/dev/null` it leaves the profile alone. The synced `.bashrc` already loads nvm | Run it with that value |
| `claude.ai/install.sh`, run in the container | Exit 0. `.bashrc` and `.profile` unchanged. Writes `~/.claude/{backups,downloads,sessions}` and `~/.claude.json`. It checks the binary against its own manifest | Safe to run before import, and it stays unpinned. Decision 2 |
| Release assets against this machine | `rtk`, `bun` and `copilot` unpack to files identical to the installed ones (`cmp`). rtk's hash matches `checksums.txt` | The pins in step 1 are proven, not assumed |
| `~/.bun/bin/bunx` | Link to `bun` | The zip has only `bun`, so the recipe makes the link |
| Extension rebuilt from the pin by the roadmap's recipe | `diff -r` with the installed folder is empty. `shell-version` includes `50` | The recipe is exact. Copy `src/modern/*.js` flat into the extension folder |
| `claude plugin install` before `marketplace add` | Fails: "not found in marketplace" | `extraKnownMarketplaces` alone isn't enough. Add first, as the roadmap says |
| `claude plugin marketplace add 'owner/repo#ref'` | Works, and keeps the ref in `known_marketplaces.json`. `sigil` is public, so no login is needed | This answers the roadmap's open question |
| `marketplace add` on a settings file with `autoUpdate: true` | Removes `extraKnownMarketplaces.context-mode.autoUpdate`. Nothing else changes | Reproduced. Decision 3 |
| Copying `settings.json` back after add and install | `claude plugin list` still shows both plugins enabled, and the file stays byte-identical | No second import is needed. Decision 3 |
| `claude plugin install` exit codes | Failure exits 1. Installing again exits 0 ("already installed"). `add` again exits 0. No login needed | Safe to rerun, and failures can be detected |
| `plugins/known_marketplaces.json`, `plugins/installed_plugins.json` | Keyed by marketplace and by `plugin@marketplace` | `--dry-run` can tell what's missing without running `claude` |
| `dotfiles/linux/claude/settings.json` | `sigil`'s repo is `<YOUR_GH_USERNAME>/sigil` | Plugins have to read the hydrated local file, so they run after import |
| `import.sh` | Prints a link hint that omits `metrics-archive`. Exits 0 even with `ERROR` lines | Bootstrap makes the links. Step 9 fixes the hint |
| `~/.local/bin` | Four links to `~/.claude/bin/*`, plus `sata-status`, which is hand-written | Bootstrap links `~/.claude/bin/*` only |
| `~/.bun/install/global`, `~/.cargo`, `~/go`, `~/.dotnet/tools`, flatpak | Empty or missing | No tool manager is missing from the lists |
| `.gitattributes` | `*.sh` is already LF | `bootstrap/linux.sh` needs no new rule |
| Branch protection | Required: `review-gate`, `leak-scan`, `lint`. `engine-*` aren't required | The new job won't block a merge unless you add it. Step 13 asks |
| `ci.yml` | `shellcheck` names its files, and `engine-linux` runs only `engine.sh` | Bootstrap needs workflow changes, so this PR waits for your label |

## What gets added

```text
bootstrap/linux.sh             the restore, run as your own user
scripts/ci/check-plugins.sh    lint: enabledPlugins names a declared marketplace
scripts/ci/bootstrap-check.sh  CI: real apt and pin checks in a clean container
tests/linux/bootstrap.sh       stub tests, separate from engine.sh
packages/linux/tools.txt       pins for nvm, bun, rtk, copilot
docs/restore.md                the runbook
```

`packages/linux/tools.txt`, in the same `<name> <https url> <sha256>` shape as `deb.txt`:

```text
bun https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64.zip bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c
copilot https://github.com/github/copilot-cli/releases/download/v1.0.105/copilot-linux-x64.tar.gz aba1f06f27bc0447656647f76e0a4cf58b4b2a341c75ff04a750982b6aeb6bd2
nvm https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh 48a0eee9a60e07422dce0eb5774754c83889570ca1ee2566c516acbe8af03a9e
rtk https://github.com/rtk-ai/rtk/releases/download/v1.1.0/rtk-x86_64-unknown-linux-musl.tar.gz 9454ad1b9489daa57ab0a9f4ebe2faaf4dc82b8a0f26c9e5135151abd7c9378d
```

## What bootstrap does

The steps run in this order. Each one checks what's there first, so a second run does nothing. A failed step prints `ERROR`
and the next one still runs, as import does per file. Bootstrap exits 1 if any step failed.

| # | Function | Already done when | Action |
|---|---|---|---|
| 1 | `step_apt_sources` | Source and key equal the repo's | Install `ca-certificates`, then copy each source and the key its `Signed-By` names. A different file on the machine is kept and reported `SKIPPED`, because Google's cron job may have rotated a key on purpose |
| 2 | `step_apt` | Every `apt.txt` name installed | `apt-get update`, then one `apt-get install -y` of the missing names |
| 3 | `step_debs` | Package installed | Download, check the hash, check `dpkg-deb -f Package` equals the name, `apt-get install -y ./file` |
| 4 | `step_snaps` | `snap list <name>` passes | `snap wait system seed.loaded`, then `snap install` with `--classic` and `--channel=` from the line. If `snap list` fails, `SKIPPED` |
| 5 | `step_fonts` | `~/.local/share/fonts/NerdFonts/<asset>/` exists | Download, check the hash, unpack there, `fc-cache -f` |
| 6 | `step_extensions` | `<uuid>/metadata.json` exists | `git fetch --depth 1` the commit, copy by the recipe, `glib-compile-schemas` |
| 7 | `step_node` | `~/.nvm/nvm.sh` and a Node exist | Run the pinned installer with `PROFILE=/dev/null`, then `nvm install --lts` and `nvm alias default 'lts/*'` |
| 8 | `step_npm` | Name in `npm_packages` for the newest Node | `npm install -g` the missing names through nvm |
| 9 | `step_pipx` | Name in `pipx list --short` | `pipx install <name>` |
| 10 | `step_tools` | `bun`, `rtk`, `copilot`, `claude` exist at their paths | Unpack the pinned file, or run Claude's installer. See below |
| 11 | `step_import` | Never skipped, because import compares by itself | `./import.sh`. With no session bus, `SKIPPED` |
| 12 | `step_links` | Link already points at the script | Link each `~/.claude/bin/*` into `~/.local/bin`. A file that isn't that link is kept and reported `SKIPPED` |
| 13 | `step_plugins` | Named in both plugin state files, so a rerun doesn't call `claude` | `marketplace add`, `plugin install`, put `settings.json` back |
| 14 | `step_vscode` | Id in `code --list-extensions` | `code --install-extension <id>` for each one missing. One failure doesn't stop the rest |
| 15 | `step_preview` | Never skipped | `./sync preview`, so the last thing on screen is the state of the machine |

Tool recipes in `step_tools`:

| Tool | Target | Recipe |
|---|---|---|
| `bun` | `~/.bun/bin/bun`, `bunx` | `unzip -jo` `bun-linux-x64/bun` into `~/.bun/bin`, `chmod 755`, `ln -sf "$HOME/.bun/bin/bun" ~/.bun/bin/bunx` |
| `rtk` | `~/.local/bin/rtk` | `tar -xzf … rtk`, `install -m 755` |
| `copilot` | `~/.local/bin/copilot` | `tar -xzf … copilot`, `install -m 755` |
| `claude` | `~/.local/bin/claude` | `curl` `https://claude.ai/install.sh` to a temp file, `bash <file> </dev/null` |

Output uses `status` from `scripts/linux/sync.sh`: `INSTALLED`, `UNCHANGED`, `SKIPPED`, `ERROR`, and `WOULD` under `--dry-run`.
The last lines give the counts and point at `docs/restore.md`.

Flags: `--dry-run` runs the guards and prints a `WOULD` line for each thing that's missing. It calls no `sudo`, makes no network
request, and changes nothing. Import and preview print nothing under it, so a finished machine prints no `WOULD` line.
`-h` or `--help` prints usage, and anything else exits 1 with usage.

Core of the script:

```bash
#!/usr/bin/env bash
# Restore this machine from the repo: packages, tools, configs, links, plugins.
# Run it as your own user. It asks for sudo once, and running it again is safe.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# jq isn't installed yet, so skip the config checks sync.sh runs when sourced.
SYNC_LIB_ONLY=1
source scripts/linux/sync.sh

PACKAGES_DIR=$REPO_ROOT/packages/linux
ROOT=${BOOTSTRAP_ROOT:-}
SUDO=(sudo)
DRY_RUN=0
FAILED=()
INSTALLED=0
UNCHANGED=0
BOOT_SKIPPED=0

# Data lines of a list, without comments and blanks.
list_lines() {
    [[ -f $1 ]] || return 0
    awk '!/^[[:space:]]*(#|$)/' "$1"
}

# Download $1 to $3 and stop unless its SHA-256 is $2.
fetch_verified() {
    local url=$1 sha=$2 dest=$3
    curl -fsSL --proto '=https' --tlsv1.2 -o "$dest" "$url" || return 1
    if ! printf '%s  %s\n' "$sha" "$dest" | sha256sum -c --quiet - >/dev/null 2>&1; then
        rm -f "$dest"
        return 1
    fi
}

# `if ! "$@"` turns errexit off inside the step, so every command in a step ends
# in `|| return 1` or is checked by hand.
run_step() {
    local name=$1
    shift
    printf '\n  -- %s\n' "$name"
    if ! "$@"; then
        status ERROR "$name" 'step failed'
        FAILED+=("$name")
    fi
}

# step_* functions go here.

main() {
    parse_args "$@"
    check_machine
    WORK=$(mktemp -d)
    trap 'rm -rf "$WORK"' EXIT
    run_step 'apt sources' step_apt_sources
    # ...one line per row of the table above...
    print_summary
    (( ${#FAILED[@]} == 0 ))
}

# scripts/ci/bootstrap-check.sh sources this file to reuse the steps without main.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
    main "$@"
fi
```

## Decisions to confirm in review

1. **A new `tools.txt` pins bun, rtk, copilot and nvm.** This reverses phase 6, which said a list adds nothing. Reading the
   installers changed that: two of them edit synced files, one needs a terminal, and three follow a moving URL, so nothing
   holds a restore to what's been checked. It's the same rule as `deb.txt`: no signed repository, so pin the download. The
   cost is that the pins lag behind the machine, and a restore can give you an older tool until it updates. Drift doesn't
   compare them, because a tool that updates itself would report on every export.
2. **Claude Code isn't pinned.** Its installer checks the binary against a manifest, its script has no stable hash to pin,
   and the tool updates itself right after. This is the one script bootstrap runs from a moving URL. It goes to a file
   first, not into a pipe, so a cut-off download can't run half a script.
3. **Plugins run after import, then put `settings.json` back.** The roadmap offered two orders. Before import can't work,
   because the repo copy has a placeholder in `sigil`'s repo. Importing a second time would prompt again for any file you
   answered no to. So `step_plugins` copies the file aside and restores it, which I tested: the plugins stay enabled. It
   also covers any other key a later Claude version might drop.
4. **Import isn't forced.** Bootstrap runs plain `./import.sh`, so it asks before overwriting and you can rerun it on a live
   machine without losing unexported edits. On a fresh machine that's one prompt for each stock file, such as `.bashrc`.
   Without a terminal, EOF counts as yes, as it already does, and a missing value stops import.
5. **Bootstrap won't run as root.** `$HOME` would be wrong, and every tool would land in `/root`. It calls `sudo` for the apt
   and snap commands only. Nothing from `curl` runs as root except a `.deb` that passed its hash.
6. **Existing sources and keys are kept.** Bootstrap fills gaps and never overwrites a source or a key that differs. A rotated
   key on a live machine is newer than the repo's copy, and `DRIFT` already reports it.
7. **`check-packages.sh` runs first and stops everything.** The list fields reach root commands, and that lint is what keeps
   them from reaching one as an option or a path. A bad list exits 2 before `sudo` is asked for.
8. **Stub tests live in a new `tests/linux/bootstrap.sh`.** `engine.sh` is 186 KB and takes over two minutes. PATH in the new
   suite holds only stubs and an allowlist of harmless tools, so a missing stub fails the case rather than reaching the real
   `sudo` or `apt-get`. This is the rule that matters most, because these are the first scripts here that install things.
9. **`BOOTSTRAP_ROOT` is a test-only prefix** for `/etc/apt`, `/usr/share/keyrings` and `/etc/os-release`, like `DRIFT_ROOT`.
   Unlike `DRIFT_ROOT`, it's used for writes. Unset is the real path, and with the prefix wrong the worst case is a failed
   copy, because a test has no root and the sudo stub just runs the command.
10. **CI proves the data, stubs prove the logic, and a container proves the whole.** `bootstrap-check` runs on every PR: real
    sources, `apt-get install -s`, and every pin downloaded and hashed, a few hundred MB. A full run with real packages takes too
    long for CI, so it's a one-time manual check in podman (step 12). Snap, VS Code and the desktop can't run there, so the
    last proof is your fresh VM, kept in `TODO.md`.
11. **`bootstrap/` has no entry in `./sync`.** The roadmap and README call it directly, and `./sync` needs `jq`, which a fresh
    machine doesn't have yet.
12. **The session check is `DBUS_SESSION_BUS_ADDRESS`.** Without it, `step_import` reports `SKIPPED`, `step_links` and
    `step_plugins` have nothing to work with, and the summary says to rerun bootstrap from a terminal on the desktop. That beats
    a screen of dconf `ERROR` lines, and a rerun is cheap.

## Shared rules

- Branch `feat/bootstrap`, one commit per step, one draft PR opened at step 1 and marked ready at step 13. Commits carry the
  `Plan-Step` and `Route` trailers.
- From step 1 on, each step lands with `git push`, then `gh run watch` on the `ci` run. A red job counts as a rejection.
- Workers run only `tests/linux/bootstrap.sh <filter>`, the listed `engine.sh <filter>`, and shellcheck. They never run the
  full `engine.sh`, and they finish with a short summary as soon as those pass.
- Workers never run `bootstrap/linux.sh` directly, not even with `--dry-run`, and never use the network, the real home, `sudo`,
  `/etc/apt` or the real package tools. They never open, copy or print `.user-values.json`.
- The review of each step greps the diff for `curl … | `, `sudo -S`, `--allow-unauthenticated`, `trusted=yes`, `--force-yes`,
  `ANTHROPIC_`, and `eval`. Each must be absent.
- Every download goes through `fetch_verified`, except `claude.ai/install.sh` and `git fetch` of the extension's commit.
- Every child command inside a list loop reads from `/dev/null`, and the loop reads on fd 3 (`read … <&3`, `done 3< <(…)`),
  so `apt-get`, `ssh` or an installer can't eat the rest of the list.
- `dotfiles/` doesn't change in this phase.

## What verifies each step

| Step | Local | CI | This machine |
|---|---|---|---|
| 1 Tool pins | `engine.sh lint-packages`, `check-packages.sh` | `engine-linux` | none |
| 2 Plugin lint | `engine.sh lint-plugins`, shellcheck | `lint` | none |
| 3 Skeleton and harness | `bootstrap.sh guard`, shellcheck | `lint`, `engine-linux` | none |
| 4 apt | `bootstrap.sh apt` | `engine-linux` | none |
| 5 Snaps, fonts, extension | `bootstrap.sh desktop` | `engine-linux` | none |
| 6 Node, npm, pipx | `bootstrap.sh node` | `engine-linux` | none |
| 7 Standalone tools | `bootstrap.sh tools` | `engine-linux` | none |
| 8 VS Code | `bootstrap.sh vscode` | `engine-linux` | none |
| 9 Import, links, plugins | `bootstrap.sh restore` | `engine-linux` | none |
| 10 CI check | `podman` run of the script | `bootstrap-check` | none |
| 11 Docs | Read through | `lint` | none |
| 12 Full container run | Exit 0, second run idle | none | Container only |
| 13 Verify and PR | All | All | `--dry-run` |
| 14 This machine | Manual | none | Manual |

## Steps

### 1. Tool pins `[worker:low]`

Files: `packages/linux/tools.txt` (new), `scripts/ci/check-packages.sh`, `tests/linux/engine.sh`.

- Create `tools.txt` with the four lines above, byte for byte.
- In `check-packages.sh`, add `tools.txt` to `KNOWN_LISTS`, change "The nine lists" and "the nine above" to ten, and validate
  each data line with
  `^(bun|copilot|nvm|rtk) https://(github\.com|raw\.githubusercontent\.com)/[A-Za-z0-9./_~+-]+ [0-9a-f]{64}$`. Lines are sorted
  and unique, as in the other lists.

Add engine cases, following the existing `lint-packages-*` cases:

| Case | Input | Expected |
|---|---|---|
| `lint-packages-tools-ok` | Two valid lines | Exit 0 |
| `lint-packages-tools-unknown` | `make https://github.com/a/b/c.zip <64 hex>` | Exit 1, line reported |
| `lint-packages-tools-http` | `rtk http://github.com/a/b/c.zip <64 hex>` | Exit 1 |
| `lint-packages-tools-host` | `rtk https://example.com/c.zip <64 hex>` | Exit 1 |
| `lint-packages-tools-short-hash` | 63 hex digits | Exit 1 |
| `lint-packages-tools-unsorted` | `rtk` before `bun` | Exit 1, `not sorted` |

Test: `tests/linux/engine.sh lint-packages && scripts/ci/check-packages.sh && scripts/ci/leak-scan.sh`, plus shellcheck.

### 2. Plugin lint `[worker]`

Files: `scripts/ci/check-plugins.sh` (new, executable), `tests/linux/engine.sh`, `.github/workflows/ci.yml`.

`scripts/ci/check-plugins.sh [settings-file]`, default `dotfiles/linux/claude/settings.json`, shaped like `check-config.sh`:
exit 2 with `ERROR: no such file: <file>` if it's missing, one problem per line, `<file>: invalid entries above` and exit 1,
or `<file>: OK` and exit 0. With `jq`:

- Each key of `enabledPlugins` has the form `<plugin>@<marketplace>`, and `<marketplace>` is a key of `extraKnownMarketplaces`.
- Each marketplace has `.source.source == "github"`, because bootstrap handles nothing else.
- `.source.repo` matches `^[A-Za-z0-9_.<>-]+/[A-Za-z0-9_.-]+$`. The `<>` allows `<YOUR_GH_USERNAME>`.
- `.source.ref`, if present, matches `^[A-Za-z0-9][A-Za-z0-9._/-]*$`.

In `ci.yml`, add a `Plugin sanity` step after `Config sanity`: `run: scripts/ci/check-plugins.sh`.

| Case | Input | Expected |
|---|---|---|
| `lint-plugins-ok` | One marketplace, one enabled plugin | Exit 0 |
| `lint-plugins-undeclared` | Plugin names `x@nowhere` | Exit 1, names it |
| `lint-plugins-no-at` | Key `x` | Exit 1 |
| `lint-plugins-url-source` | `source: "url"` | Exit 1 |
| `lint-plugins-bad-repo` | Repo `a/b;rm` | Exit 1 |
| `lint-plugins-bad-ref` | Ref `-x` | Exit 1 |
| `lint-plugins-placeholder` | Repo `<YOUR_GH_USERNAME>/sigil` | Exit 0 |
| `lint-plugins-missing` | No file | Exit 2 |
| `lint-real-plugins` | The real settings file | Exit 0 |

Test: `tests/linux/engine.sh lint-plugins`, `tests/linux/engine.sh lint-real-plugins`, shellcheck.

### 3. Skeleton and test harness `[worker:high]`

Files: `bootstrap/linux.sh` (new, executable), `tests/linux/bootstrap.sh` (new, executable), `.github/workflows/ci.yml`,
`scripts/linux/sync.sh`.

`scripts/linux/sync.sh` runs `check_platforms`, `check_paths` and a `jq` read of `excludePatterns` when sourced. Without `jq`,
as on a fresh machine, that prints five `jq: command not found` lines and the checks do nothing. Wrap those statements in
`if [[ -z ${SYNC_LIB_ONLY:-} ]]; then … fi`, so export, import and preview behave as before.

`bootstrap/linux.sh`: the core above, with `parse_args`, `check_machine`, `print_summary` and every `step_*` as a stub that
returns 0, so later steps fill one function each. Use the table's order in `main`.

`check_machine` stops with exit 2 and one `ERROR:` line, in this order. `--dry-run` runs all but the last:

| Check | Message |
|---|---|
| `id -u` is 0 | `run bootstrap as your own user, not root.` |
| `uname -m` isn't `x86_64` | `the pinned downloads are for x86_64.` |
| `apt-get` missing, or `ID` in `$ROOT/etc/os-release` isn't `ubuntu` | `bootstrap needs Ubuntu.` |
| `scripts/ci/check-packages.sh "$PACKAGES_DIR"` fails | `fix packages/linux first.` |
| `sudo -v` fails | `sudo is needed for apt and snap.` |

`VERSION_ID` other than `26.04` prints `WARNING: the lists were recorded on Ubuntu 26.04.` and goes on.

`print_summary` prints `<n> installed, <n> already there, <n> skipped.`, then each failed step, then
`Next: docs/restore.md`. Steps count through `boot_installed <label> [note]`, `boot_unchanged <label>` and
`boot_skipped <label> <note>`, which wrap `status`.

`tests/linux/bootstrap.sh [case-name-filter]`, in the shape of `engine.sh` (`fail`, `new_tmp`, a `case` dispatch, one line per
result):

- `setup_case`: copies `bootstrap/`, `scripts/` and `packages/linux/` from `tests/fixtures/` or from a small list the case writes
  into `$t/repo`. Replaces `import.sh` and `sync` there with stubs that log their arguments.
- `$t/bin` holds a stub for each of `sudo apt-get dpkg-query dpkg-deb snap curl code pipx git claude glib-compile-schemas fc-cache
  id uname`. Each one appends `<tool> <args>` to `$t/calls`, prints `$t/stub/<tool>.out` and exits with `$t/stub/<tool>.rc`,
  like `setup_drift_case`. `sudo` logs and runs the rest. `curl` copies `$t/net/<basename of url>` to its `-o` path, or exits 22.
- `$t/sysbin` holds links to `bash awk sed grep sort comm cmp cp mv rm mkdir mktemp chmod ln cat tar unzip sha256sum install env
  dirname basename tr cut head tail find jq xz gzip ls wc`, and nothing else. A worker may add a tool only if it can't install,
  download, or write outside `$t`.
- `run_bootstrap [args]`: `env -i HOME="$t/home" PATH="$t/bin:$t/sysbin" BOOTSTRAP_ROOT="$t/root"
  DBUS_SESSION_BUS_ADDRESS=unix:path=/dev/null bash "$t/repo/bootstrap/linux.sh" "$@" < /dev/null`.

In `ci.yml`: add `bootstrap/linux.sh` to the `shellcheck` line, and a step `Bootstrap tests (bash)` after the engine tests in
`engine-linux`: `run: tests/linux/bootstrap.sh`.

| Case | Setup | Expected |
|---|---|---|
| `guard-root` | `id -u` prints 0 | Exit 2, message, `$t/calls` has no `sudo` |
| `guard-arch` | `uname -m` prints `aarch64` | Exit 2 |
| `guard-not-ubuntu` | `ID=debian` | Exit 2 |
| `guard-bad-list` | `apt.txt` holds `-x` | Exit 2, no `sudo` call |
| `guard-sudo-refused` | `sudo.rc` is 1 | Exit 2, no other call |
| `guard-other-release` | `VERSION_ID=24.04` | Warning, exit 0 |
| `guard-unknown-option` | `--nope` | Exit 1, usage |
| `guard-help` | `--help` | Exit 0, usage, no calls |
| `guard-dry-run-no-sudo` | `--dry-run` | Exit 0, no `sudo` or `curl` in `$t/calls` |
| `guard-step-order` | Plain run | Step headers print in the table's order |
| `guard-step-failure-continues` | One stub step made to fail through a list the later steps fill | Next header still prints, exit 1, summary names the step |
| `guard-sourced-no-main` | `source` the file from a test script | No step runs, no `sudo` |
| `guard-no-jq` | `$t/sysbin/jq` removed, `--dry-run` | Output before the first step header has no `jq` |

`guard-step-failure-continues` can only be written once a step has real code, so add it in step 4.

Test: `tests/linux/bootstrap.sh guard`, `tests/linux/engine.sh missing-platform`, `tests/linux/engine.sh excluded`, shellcheck
on both new files and `scripts/linux/sync.sh`.

### 4. apt sources, apt, debs `[worker:high]`

Files: `bootstrap/linux.sh`, `tests/linux/bootstrap.sh`.

`step_apt_sources`: install `ca-certificates` through `apt-get install -y` if `dpkg-query` doesn't show it. For each
`*.sources` and `*.list` in `packages/linux/apt-sources/`, read every `Signed-By:` or `signed-by=` value with `sed` ignoring case,
and take the basename. Then for the source file, to `$ROOT/etc/apt/sources.list.d/`, and each key, to `$ROOT<value>`:

- Missing: `"${SUDO[@]}" install -D -m 0644 <from> <to>`, `boot_installed`, and set `APT_STALE=1`.
- Identical by `cmp`: `boot_unchanged`.
- Different: `boot_skipped <label> 'differs from the repo; see docs/packages.md'`.

`step_apt`: missing names are `package_names apt.txt` minus installed ones. Use the same `dpkg-query` call and `awk` as
`drift_apt`, in a small function `dpkg_installed` that `drift_apt` also calls. If none are missing and `APT_STALE` is unset, return.
Otherwise `apt-get update`, and `apt-get install -y -- <names>`. Under `--dry-run`, one `WOULD` line per name and no calls.

`step_debs`: for each `name url sha` in `deb.txt`, skip if installed, otherwise `fetch_verified` into `$WORK/$name.deb`. Stop that
line if `dpkg-deb -f <file> Package` isn't `$name`. `chmod 755 "$WORK"` and `chmod 644` the file so apt's sandbox user can read
it, then `apt-get install -y "$WORK/$name.deb"`.

| Case | Setup | Expected |
|---|---|---|
| `apt-sources-fresh` | One `.sources`, one `.list`, two keys | All four under `$t/root`, mode 0644, bytes equal, and keys in the folder each source names |
| `apt-sources-same` | Files already there | `UNCHANGED`, no `install` |
| `apt-sources-differs` | Different key on the machine | `SKIPPED`, file left as it was |
| `apt-sources-before-install` | Plain run | `install` of the source comes before `apt-get update`, and that before `apt-get install` |
| `apt-install-missing` | `dpkg-query` shows one of two | `apt-get install -y -- <other>` only |
| `apt-nothing-missing` | All installed | No `apt-get` call at all |
| `apt-install-fails` | `apt-get.rc` is 100 | `ERROR`, later headers print, exit 1 |
| `apt-dry-run` | `--dry-run`, one missing | `WOULD apt/<name>`, no `apt-get` |
| `deb-installs` | Good file in `$t/net` | `apt-get install -y` with a path ending `.deb` |
| `deb-bad-hash` | File with other bytes | `ERROR`, no `apt-get install`, file gone |
| `deb-wrong-package` | `dpkg-deb` prints another name | `ERROR`, no `apt-get install` |
| `deb-already-installed` | Installed | No `curl` call |
| `deb-loop-keeps-going` | First line fails, second is good | Second still installs |

Add `guard-step-failure-continues` here. Rerun `tests/linux/engine.sh drift-apt` for the `dpkg_installed` change.

Test: `tests/linux/bootstrap.sh apt`, `tests/linux/bootstrap.sh deb`, `tests/linux/bootstrap.sh guard`,
`tests/linux/engine.sh drift-apt`, shellcheck.

### 5. Snaps, fonts, GNOME extension `[worker]`

Files: `bootstrap/linux.sh`, `tests/linux/bootstrap.sh`.

`step_snaps`: if `snap list` fails, `boot_skipped packages/linux/snap.txt 'snapd not running'` and return 0. Otherwise
`sudo snap wait system seed.loaded`, then for each line, skip if `snap list <name>` passes, or else
`sudo snap install <name> [--classic] [--channel=<channel>]`.

`step_fonts`: for each `asset tag sha`, skip if the folder exists. `fetch_verified` from
`https://github.com/ryanoasis/nerd-fonts/releases/download/<tag>/<asset>.tar.xz`, unpack into `$WORK/<asset>`, move to
`$HOME/.local/share/fonts/NerdFonts/<asset>`, and after the loop run `fc-cache -f` once if anything was added. The move comes last,
so a failed unpack leaves no folder that a rerun would mistake for an install.

`step_extensions`: for each `uuid url commit`, skip if `$HOME/.local/share/gnome-shell/extensions/<uuid>/metadata.json` exists. In a
new folder under `$WORK`: `git init -q`, `git fetch -q --depth 1 <url> <commit>`, `git -c advice.detachedHead=false checkout -q
FETCH_HEAD`. Stop that line unless `git rev-parse HEAD` equals `<commit>`. Build in `$WORK` first: copy `metadata.json`,
`stylesheet.css` and `schemas/`, and copy `src/modern/*.js` flat next to them. Run `glib-compile-schemas <out>/schemas`, then move
the result into place. Never run the extension's `install.sh`. If `glib-compile-schemas` is missing, `SKIPPED`.

| Case | Setup | Expected |
|---|---|---|
| `desktop-snap-args` | `code classic`, `postman channel=v11/stable` | `snap install code --classic`, `snap install postman --channel=v11/stable` |
| `desktop-snap-present` | `snap list code` passes | No install for it |
| `desktop-snap-down` | `snap.rc` is 1 | `SKIPPED`, exit 0 |
| `desktop-font-installs` | Good `.tar.xz` | Files under `NerdFonts/<asset>/`, one `fc-cache -f` |
| `desktop-font-bad-hash` | Other bytes | `ERROR`, no folder, no `fc-cache` |
| `desktop-font-bad-archive` | Right hash, not a tarball | `ERROR`, no folder |
| `desktop-font-present` | Folder exists | No `curl` |
| `desktop-ext-installs` | `git` stub fills a tree with `src/modern/extension.js`, `src/legacy/old.js`, `install.sh`, `metadata.json`, `stylesheet.css`, `schemas/x.xml` | Folder has `extension.js`, `metadata.json`, `stylesheet.css`, `schemas/x.xml`. It has no `old.js`, `install.sh` or `src/` |
| `desktop-ext-wrong-commit` | `rev-parse` prints another hash | `ERROR`, no folder |
| `desktop-ext-no-install-sh` | `install.sh` writes a marker when run | Marker absent |
| `desktop-ext-present` | `metadata.json` exists | No `git` |
| `desktop-dry-run` | `--dry-run`, all missing | `WOULD` lines, no `snap install`, `curl` or `git` |

Test: `tests/linux/bootstrap.sh desktop`, shellcheck.

### 6. Node, npm, pipx `[worker]`

Files: `bootstrap/linux.sh`, `tests/linux/bootstrap.sh`.

`step_node`: if `$HOME/.nvm/nvm.sh` is missing, read the `nvm` line of `tools.txt`, `fetch_verified` it to `$WORK/nvm-install.sh`,
and run `PROFILE=/dev/null NVM_DIR="$HOME/.nvm" bash "$WORK/nvm-install.sh" </dev/null`. Then, if `$HOME/.nvm/versions/node` has no
version folder, run a child shell, because nvm breaks under `set -eu`:

```bash
bash -c 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" && nvm install --lts && nvm alias default "lts/*"' </dev/null
```

`step_npm`: find the newest `$HOME/.nvm/versions/node/*` by `sort -V`, as `drift_npm` does. Missing names are `package_names npm.txt`
minus `npm_packages <dir>/lib/node_modules`. If any are missing, `PATH="$dir/bin:$PATH" npm install -g -- <names> </dev/null`, with
the names as arguments. Don't source `nvm.sh` here: it activates the default alias, which can differ from the newest Node that
this guard and `drift_npm` read, so a package would install into one Node, be checked against the other, and reinstall on every run.

`step_pipx`: if `pipx` isn't on PATH, `SKIPPED`. Missing names are `package_names pipx.txt` minus the first field of `pipx list
--short`. `pipx install <name>` for each one.

The real `nvm.sh` isn't in the tests: the fixture is a small shell file that defines an `nvm` function which logs to `$t/calls`, and
a stub `npm`. Add `nvm` and `npm` to the stubs.

| Case | Setup | Expected |
|---|---|---|
| `node-installs-nvm` | No `.nvm`, script in `$t/net` | Script ran with `PROFILE=/dev/null` |
| `node-bad-hash` | Other bytes | `ERROR`, script never ran |
| `node-profile-untouched` | Script appends to `$PROFILE` | `$t/home/.bashrc` unchanged |
| `node-installs-lts` | `.nvm` exists, no version | `nvm install --lts`, `nvm alias default lts/*` |
| `node-present` | Version folder exists | No `nvm` call, no `curl` |
| `node-npm-missing` | One of two in `lib/node_modules` | `npm install -g -- <other>` |
| `node-npm-newest` | `v20.0.0` empty, `v22.1.0` has one of two | `npm install -g -- <other>`, with `v22.1.0/bin` first on `PATH` |
| `node-npm-scoped` | `@scope/name` listed, folder present | Not installed again |
| `node-npm-present` | All present | No `npm` call |
| `node-pipx-installs` | `pipx list --short` empty | `pipx install poetry` |
| `node-pipx-present` | Prints `poetry 2.0.0` | No install |
| `node-pipx-missing-tool` | No `pipx` stub | `SKIPPED`, exit 0 |
| `node-dry-run` | `--dry-run`, all missing | `WOULD` lines, no `curl`, installer, `npm` or `pipx install` |

Test: `tests/linux/bootstrap.sh node`, shellcheck.

### 7. Standalone tools `[worker]`

Files: `bootstrap/linux.sh`, `tests/linux/bootstrap.sh`.

`step_tools`: for each line of `tools.txt` except `nvm`, skip if the target exists, otherwise `fetch_verified` and follow the recipe
table. Each recipe unpacks in `$WORK` and moves the binary into place last. A `case` on the name holds the recipes, and an unknown
name is an `ERROR` line. Then Claude: if `$HOME/.local/bin/claude` is missing, `curl` the installer to `$WORK/claude-install.sh`
and `bash "$WORK/claude-install.sh" </dev/null`. Never pipe it. An installer can exit 0 without leaving a working binary, so after
it runs, `$HOME/.local/bin/claude` must be executable, or the step is `ERROR tool/claude 'installer left no claude'` and exit 1. It's
`-x`, the same check `step_plugins` uses, because otherwise that step would skip with a note that hides the cause.

| Case | Setup | Expected |
|---|---|---|
| `tools-bun` | Zip with `bun-linux-x64/bun` | `~/.bun/bin/bun` mode 755, `bunx` link points at it |
| `tools-rtk` | Tarball with `rtk`, `LICENSE` | `~/.local/bin/rtk` mode 755, no `LICENSE` in `~/.local/bin` |
| `tools-copilot` | Tarball with `copilot` | `~/.local/bin/copilot` mode 755 |
| `tools-bad-hash` | Other bytes for `rtk` | `ERROR`, no `rtk`, the next tool still installs |
| `tools-bad-archive` | Right hash, not a tarball | `ERROR`, no file at the target |
| `tools-present` | All targets exist | No `curl` |
| `tools-claude-file-first` | Installer in `$t/net` | Ran from a file under `$WORK`, with stdin from `/dev/null` |
| `tools-claude-fails` | Script exits 1 | `ERROR`, exit 1 |
| `tools-claude-no-binary` | Script exits 0 and writes no `claude` | `ERROR tool/claude`, note `installer left no claude`, no `INSTALLED tool/claude`, exit 1 |
| `tools-nvm-skipped` | `tools.txt` with `nvm` | No `nvm` recipe here |

Test: `tests/linux/bootstrap.sh tools`, shellcheck.

### 8. VS Code extensions `[worker:low]`

Files: `bootstrap/linux.sh`, `tests/linux/bootstrap.sh`.

`step_vscode`: use `code` from PATH, or else `/snap/bin/code` (through `$ROOT` in tests). If neither exists, `SKIPPED`, since the
snap may have been skipped. Missing ids are `package_names vscode-extensions.txt` minus lower-cased `code --list-extensions`. For each,
`code --install-extension <id> </dev/null`. Print `ERROR` for one that fails and go on, then return 1 at the end if any failed.

| Case | Setup | Expected |
|---|---|---|
| `vscode-installs-missing` | Two listed, one present | One `--install-extension` |
| `vscode-case-insensitive` | Prints `Foo.Bar`, list has `foo.bar` | No install |
| `vscode-one-fails` | First fails | Second still installs, exit 1 |
| `vscode-no-code` | No `code` | `SKIPPED`, exit 0 |
| `vscode-snap-path` | Only `$ROOT/snap/bin/code` | That one is used |

Test: `tests/linux/bootstrap.sh vscode`, shellcheck.

### 9. Import, links, plugins, preview `[worker:high]`

Files: `bootstrap/linux.sh`, `tests/linux/bootstrap.sh`, `import.sh`.

`step_import`: if `DBUS_SESSION_BUS_ADDRESS` is empty, `boot_skipped import 'no desktop session; rerun from a terminal on the
desktop'`, set `NO_SESSION=1` and return 0. Otherwise `./import.sh || return 1`. Stdin stays the terminal so prompts work.

`step_links`: for each executable `$HOME/.claude/bin/*`, with `$HOME/.local/bin/<name>` as the target:

- Missing: `ln -s`, `boot_installed`.
- A link with the right target: `boot_unchanged`.
- Anything else: `boot_skipped <name> 'exists; left alone'`.

`step_plugins`: as below. If `settings.json` or `claude` is missing, `SKIPPED`. Under `--dry-run`, print `WOULD` for each name
`missing_marketplaces` or `missing_plugins` returns, or `WOULD plugins` if `jq` isn't installed yet.

```bash
# Marketplaces in settings.json that known_marketplaces.json lacks, as NUL-separated add arguments.
missing_marketplaces() {
    local known=$HOME/.claude/plugins/known_marketplaces.json
    [[ -f $known ]] || known=/dev/null
    jq -j --slurpfile k <(cat "$known") '(($k[0] // {}) | keys) as $have
        | (.extraKnownMarketplaces // {}) | to_entries[] | select(.key as $n | $have | index($n) | not)
        | .value.source | .repo + (if .ref then "#" + .ref else "" end), "\u0000"' "$1"
}

# Enabled plugins that installed_plugins.json lacks, NUL-separated.
missing_plugins() {
    local installed=$HOME/.claude/plugins/installed_plugins.json
    [[ -f $installed ]] || installed=/dev/null
    jq -j --slurpfile i <(cat "$installed") '(($i[0].plugins // {}) | keys) as $have
        | (.enabledPlugins // {}) | to_entries[] | select(.value == true) | .key
        | select(. as $n | $have | index($n) | not) | (., "\u0000")' "$1"
}

step_plugins() {
    local settings=$HOME/.claude/settings.json keep=$WORK/settings.json
    local claude=$HOME/.local/bin/claude spec plugin rc=0
    cp -p "$settings" "$keep" || return 1
    while IFS= read -r -d '' spec <&3; do
        "$claude" plugin marketplace add "$spec" </dev/null || { status ERROR "plugin/$spec" 'add failed'; rc=1; }
    done 3< <(missing_marketplaces "$keep")
    while IFS= read -r -d '' plugin <&3; do
        "$claude" plugin install "$plugin" </dev/null || { status ERROR "plugin/$plugin" 'install failed'; rc=1; }
    done 3< <(missing_plugins "$keep")
    cp -p "$keep" "$settings" || return 1
    return "$rc"
}
```

The two queries read `$keep`, not `settings.json`, because `add` rewrites that file. A state file that's absent means everything is
missing.

`plugin install` runs with `PATH="$HOME/.bun/bin:$PATH"`. The shell that started bootstrap hasn't loaded the restored `.bashrc`, and
without bun on `PATH`, Claude installs a plugin that needs bun with no `node_modules`, reports success, and records it, so a rerun
never repairs it. The step 12 container run found this.

`step_preview`: with `NO_SESSION` set, return 0. Otherwise `./sync preview </dev/null || return 1`.

`print_summary`: with `NO_SESSION` set, the last line is
`Rerun ./bootstrap/linux.sh from a terminal on the desktop to finish.`

`import.sh`: change the hint to `ln -sf ~/.claude/bin/* ~/.local/bin/`, so it stops missing `metrics-archive`.

| Case | Setup | Expected |
|---|---|---|
| `restore-import-runs` | Session set | Import stub called with no arguments |
| `restore-import-fails` | Stub exits 1 | `ERROR`, exit 1 |
| `restore-no-session` | Variable empty | No import, no preview, `SKIPPED`, final line says rerun, exit 0 |
| `restore-order` | Plain run | Import, then links, then `plugin marketplace add`, then `plugin install`, then `sync preview` |
| `restore-link-new` | Script in `~/.claude/bin` | Link created |
| `restore-link-same` | Right link there | `UNCHANGED` |
| `restore-link-real-file` | Regular file at the target | `SKIPPED`, file untouched |
| `restore-link-other-target` | Link elsewhere | `SKIPPED`, link untouched |
| `restore-plugins-ref` | `{repo: a/b, ref: c}` | `plugin marketplace add a/b#c` |
| `restore-plugins-no-ref` | `{repo: a/b}` | `plugin marketplace add a/b` |
| `restore-plugins-disabled` | `x@m: false` | No `plugin install x@m` |
| `restore-plugins-settings-back` | `claude` stub rewrites `settings.json` without `autoUpdate` | Byte-identical to before the step |
| `restore-plugins-settings-back-on-failure` | `claude` stub rewrites it, then exits 1 | Byte-identical, exit 1 |
| `restore-plugins-no-settings` | No file | `SKIPPED`, no `claude` call |
| `restore-plugins-present` | State files name everything | No `claude` call, `settings.json` untouched |
| `restore-plugins-partial` | One of two plugins in the state file | One `plugin install` |
| `restore-plugins-no-state` | No state files | Every marketplace and plugin installed |
| `restore-plugins-dry-run` | State files name everything | No `WOULD` line, no `claude` call |
| `restore-plugins-bun-on-path` | `claude` stub saves its `PATH` on `plugin install` | That `PATH` holds `~/.bun/bin` |
| `restore-idempotent` | Whole fixture, run twice | The second run's `$t/calls` holds no `install`, `curl`, `ln` or `git fetch` line |

Test: `tests/linux/bootstrap.sh restore`, `tests/linux/engine.sh import`, shellcheck.

### 10. CI check in a clean container `[worker]`

Files: `scripts/ci/bootstrap-check.sh` (new, executable), `.github/workflows/ci.yml`.

`scripts/ci/bootstrap-check.sh`, run as root in the container. It sets `-euo pipefail`, then:

1. `apt-get update`, then install `ca-certificates curl git jq xz-utils unzip libglib2.0-bin`.
2. `source bootstrap/linux.sh`, which doesn't run `main`. Set `SUDO=()`, `WORK=$(mktemp -d)`.
3. `step_apt_sources`, then `apt-get update`, where a bad key or source fails with `E:`. Fail on any line starting `E:` or `W:`.
4. `apt-get install -s` on all of `apt.txt`.
5. For each `deb.txt` line: `fetch_verified`, check the `Package` field, `apt-get install -s "$file"`.
6. For each `fonts.txt` and `tools.txt` line: `fetch_verified`.
7. `step_extensions` with `HOME` set to a temp folder, then assert `metadata.json`, `extension.js` and
   `schemas/gschemas.compiled` exist.
8. `useradd -m ci`, then `runuser -u ci -- ./bootstrap/linux.sh --dry-run` exits 0.

Print a `PASS <check>` line for each. The first failure exits 1.

`ci.yml`, a new job:

```yaml
  bootstrap-check:
    runs-on: ubuntu-latest
    container: ubuntu:26.04
    steps:
      - uses: actions/checkout@v4
      - name: Check the lists on a clean Ubuntu
        run: scripts/ci/bootstrap-check.sh
```

`ci.yml`'s shellcheck line already covers `scripts/ci/*.sh`.

The worker doesn't run this script, because it needs the network and root. The review runs it in the main session:

```bash
git archive HEAD | podman run --rm -i docker.io/library/ubuntu:26.04 \
  bash -c 'mkdir /r && cd /r && tar -x && scripts/ci/bootstrap-check.sh'
```

Test: shellcheck, then the podman run above, then the `bootstrap-check` job on the PR.

### 11. Docs `[inline: user-facing copy]`

Files: `docs/restore.md` (new), `docs/packages.md`, `docs/layout.md`, `README.md`, `CLAUDE.md`, `TODO.md`, `docs/plan-restructure.md`.

`docs/restore.md`, with Ubuntu first and a stub section for Windows that points at phase 8:

1. Before you lose the machine: what the repo doesn't hold, so you know what needs its own backup.
2. Restore: install Ubuntu, sign in to the desktop, then in a terminal on the desktop:

   ```bash
   sudo apt install git
   git clone https://github.com/makubexD/SyncSettings.git
   cd SyncSettings
   ./bootstrap/linux.sh
   ```

3. What it asks: the `sudo` password, four values (name, email, GitHub username, work marketplace URL, with `<HOME>` taken from
   the environment), and an overwrite prompt for each stock file.
4. What each status means, and what to do with `SKIPPED` and `ERROR`. Rerun is always safe.
5. Manual checklist, each with its command:
   - Log out and back in, so the extension, the fonts and `.profile`'s `PATH` take effect.
   - `gh auth login`, needed by `./sync commit`.
   - `claude`, to sign in. `~/.claude.json` isn't synced.
   - DeepSeek key in `~/.config/claude-workers/env`, `chmod 600`, then `/mk-check`.
   - `omniroute.env` and `repown/accounts.json`, if you use them.
   - SSH keys, if the machine needs them. This one has none today.
   - `~/.gnupg`, if you sign anything.
   - VS Code: Settings Sync sign-in, for named profiles.
   - `/mnt/Data` in `/etc/fstab`, used by the launchers and the bookmark. Name the file system (`ntfs-3g`), not this disk's UUID.
   - GPU: `ubuntu-drivers install`, not a package name, because the driver belongs to the hardware.
6. What isn't restored: `/usr/local/bin/prime-run`, `~/sata-diagnosis/` and its `sata-status` link, named VS Code profiles,
   Claude Code's plugin caches, which reinstall.
7. Check it worked: `./sync preview` prints no `DRIFT`, and `./bootstrap/linux.sh --dry-run` prints no `WOULD`.

`docs/packages.md`: remove "Installing from the lists is a later phase". Add `tools.txt` to the table, with why it exists. Add
**Move a tool pin**, with `gh release download`, `cmp` against the installed binary, and `sha256sum`. Add that bootstrap installs
from these lists, and link `docs/restore.md`.

`docs/layout.md`: add `bootstrap/`.

`README.md`: replace steps 1 to 4 of "New Linux machine" with the four commands and a link to `docs/restore.md`. Keep the DeepSeek
and `/mk-check` steps as links into that page. Add `docs/restore.md` to the docs list. The landing page rewrite stays in phase 9.

`CLAUDE.md`: add `./bootstrap/linux.sh` to the entry points with one line, add the test command and the stub rule under Key Patterns,
and add `packages/linux/tools.txt` to the architecture note.

`TODO.md`: add "Fresh VM run of `./bootstrap/linux.sh`, ending in a clean `./sync preview` and the `docs/restore.md` checklist."

`docs/plan-restructure.md`: mark inventory rows as `Done in phase 7`, note the `tools.txt` reversal in the row for standalone
installers, and add bootstrap to the target layout's `packages/linux` line.

Test: read each page through, check the links by hand, and run every command in `docs/restore.md` that's safe here.

### 12. Full run in a container `[inline: the only full run before a VM, and reading the result is judgment]`

No files change. This uses tracked files only, so `.user-values.json` can't get in, and the values below are fake. It takes
a while, because it installs everything for real, so run it in the background.

Prepare `$SCRATCH/e2e.sh`:

```bash
apt-get update -qq && apt-get install -y -qq sudo git dbus tar >/dev/null
useradd -m tester && echo 'tester ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/tester
mkdir /r && tar -x -C /r < /repo.tar
# preview diffs against HEAD, and a tarball has no .git. No origin, so check_upstream returns at once.
git -C /r init -q && git -C /r add -A && git -C /r -c user.name=t -c user.email=t@example.com commit -qm base
chown -R tester /r
cat > /r/.user-values.json <<'J'
{"<HOME>":"/home/tester","<YOUR_NAME>":"Test User","<YOUR_EMAIL>":"test@example.com",
 "<YOUR_GH_USERNAME>":"makubexD","<YOUR_WORK_MARKETPLACE>":"https://example.com/m"}
J
chown tester /r/.user-values.json
cd /r
runuser -u tester -- env HOME=/home/tester dbus-run-session -- ./bootstrap/linux.sh </dev/null; echo "first=$?"
runuser -u tester -- env HOME=/home/tester ./bootstrap/linux.sh --dry-run </dev/null; echo "dry=$?"
runuser -u tester -- env HOME=/home/tester dbus-run-session -- ./bootstrap/linux.sh </dev/null; echo "second=$?"
```

Run: `git archive HEAD -o "$SCRATCH/repo.tar"`, then
`podman run --rm -i -v "$SCRATCH/repo.tar":/repo.tar:ro,z docker.io/library/ubuntu:26.04 bash -s < "$SCRATCH/e2e.sh"`.
Save the log in the scratchpad.

Expected:

| Check | Result |
|---|---|
| First run | Exit 0, or `ERROR` only on what a container can't do |
| Snaps | `SKIPPED`, and `step_vscode` `SKIPPED` |
| `dry-run` output | No `WOULD` line, `SKIPPED` for snaps and VS Code |
| Second run | Everything `UNCHANGED`. No `INSTALLED` line |
| Preview | `SKIPPED` for the snaps and VS Code, no changed file. `DRIFT` only for packages the base image marks manual, and `sudo` and `dbus` from `e2e.sh` |
| `.bashrc` | Equal to the hydrated repo file, so no installer edited it |
| `~/.claude/settings.json` | Equal to the hydrated repo file, `autoUpdate` still there |
| `claude plugin list` | Both plugins enabled, and no `Note:` about missing packages |
| `rtk --version`, `bun --version`, `copilot --version`, `node --version` | All run |

A failure here goes back to the step that owns it, as a rejection, with a new stub case that reproduces it.

### 13. Verify and PR `[inline: final review]`

1. `tests/linux/engine.sh`, `tests/linux/bootstrap.sh`, and shellcheck on every shell file. All clean.
2. `./bootstrap/linux.sh --dry-run` on this machine: guards pass, no `WOULD` line, and `git status --short` shows nothing.
3. `./sync preview`: no `DRIFT`, nothing would be sent.
4. `gh pr ready`. `leak-scan`, `lint`, `engine-linux`, `engine-windows`, `bootstrap-check` green.
5. `/agent-skills:review` of the phase diff, with `security-auditor` on `bootstrap/linux.sh`, because it's the first code here
   that runs downloads and root commands.
6. Stop for your label: the PR touches `.github/workflows/`, so auto-approval doesn't apply.
7. Ask whether to add `bootstrap-check` to the required checks. That's a `gh api` call on repo settings, so it needs your yes.

### 14. Check this machine `[inline: the real machine]`

After the merge: `git switch master && git pull`. You run these, because they use `sudo` on the real system.

1. `! ./bootstrap/linux.sh`, from a terminal on the desktop. Expect `UNCHANGED` everywhere, `apt-get` not called, import
   `UNCHANGED`, no change to `settings.json`, and exit 0.
2. Rename `~/.local/bin/rtk` for a moment, and rerun. `INSTALLED`, and `cmp` with the saved copy passes. Put yours back.
3. Uninstall one VS Code extension you don't need. A rerun brings it back.

Then the fresh VM run stays in `TODO.md`, for when it's convenient.

## Not in this plan

- `bootstrap/windows.ps1`, `winget.json` and the Windows half of `docs/restore.md` (phase 8).
- `docs/getting-started.md`, `docs/security.md`, `docs/troubleshooting.md`, `docs/adding-a-file.md` and the final README (phase 9).
- Removing `sampleGrok.md` and `docs/plan-linux.md` (phase 9).
- Drift for `tools.txt`, because the tools update themselves.
- Pinning `claude`, apt, snap, npm, pipx or VS Code versions.
- Installing a GPU driver, or anything for this hardware.
- Restoring secrets, or fetching them from a password manager.
- `prime-run` and `sata-status`. They're hand-written, and `localPath` only reaches `~`.
- Other architectures or Ubuntu releases: the guard stops the first, and warns on the second.
- A real desktop run in CI. It needs a VM.

## Done when

- `./bootstrap/linux.sh` restores a clean `ubuntu:26.04` container, and a second run installs nothing.
- `bootstrap-check` proves on every PR that each apt name resolves and each pin still downloads and matches.
- A test reaching a real `sudo`, `apt-get` or `curl` can't happen, because PATH in `tests/linux/bootstrap.sh` doesn't hold them.
- No synced file is edited by an installer or by `claude plugin`, shown by a clean preview after the run.
- `docs/restore.md` lists every item in the roadmap's "Never in repo" row and phase 7 notes.
- The run on this machine changes nothing, and the fresh VM run is in `TODO.md`.
