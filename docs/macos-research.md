# macOS research

Phase 3 of [the easy-install roadmap](plan-easy-install.md), step plan [plan-easy-install-3.md](plan-easy-install-3.md).
The question: how does SyncSettings run on macOS? This page holds the evidence, the options and, once made, the decision.
Every claim about the code cites `file:line` as of 2026-11-08; every claim about macOS cites the probe run (step 3).

## Inventory

The bash side is the Linux engine (`export.sh`, `import.sh`, `commit.sh`, `scripts/linux/sync.sh`), the front door (`sync`,
`scripts/linux/front.sh`), the installer (`install.sh`) and `bootstrap/linux.sh`. macOS ships bash 3.2 (the last GPLv2
release) and BSD userland tools.

### Bash 4 features

| Where | What | Bash 3.2 equivalent |
|---|---|---|
| `scripts/linux/sync.sh:11` | `declare -A USER_VALUES=()`, the placeholder-to-value map; read with `${!USER_VALUES[@]}` at `scripts/linux/sync.sh:207` and `commit.sh:128` | No associative arrays. Two parallel indexed arrays, or one `NAME<TAB>value` list with lookup by loop. The map holds a handful of entries, so a loop costs nothing |
| `commit.sh:128`, `commit.sh:190`, `commit.sh:229`, `scripts/linux/sync.sh:255`, `scripts/linux/sync.sh:256` | `mapfile -t` | `while IFS= read -r line; do arr+=("$line"); done` |
| `scripts/linux/sync.sh:423` | `mapfile -d ''` (needs bash 4.4) | `while IFS= read -r -d '' p; do arr+=("$p"); done` |
| `set -u` in `sync:3`, `export.sh:3`, `import.sh:3`, `commit.sh:3`, `scripts/linux/sync.sh:5` | Before bash 4.4, `"${arr[@]}"` on an empty array is an "unbound variable" error under `set -u`. Four loops already guard with `"${arr[@]:-}"` (`scripts/linux/sync.sh:303`, `:768`, `:772`, `:779`); the other expansions don't | Guard every empty-able expansion with `${arr[@]+"${arr[@]}"}`. The probe's `system` leg counts how many fire |
| `scripts/linux/front.sh:350` | `mksync doctor` reports `MISSING` below bash 4 | Stays as the gate under option A or C |

Not used (checked): `${var,,}` and `${var^^}`, `declare -g`, negative array indexes, `printf '%(…)T'`, `;;&`, `|&`,
`globstar`, `lastpipe`, `coproc`, `wait -n`. `printf -v` (`scripts/linux/sync.sh:895`) and `read -d ''` work in 3.2.

### GNU-only tools and flags

| Where | What | BSD / macOS equivalent |
|---|---|---|
| `export.sh:102`, `import.sh:236` | `chmod --reference=<file>`, copying the mode onto a file written from text | `chmod "$(stat -f %Lp "$ref")"` on BSD, `stat -c %a` on GNU, so it needs a small helper that tries both |
| `sync:7`, `install.sh:123`, `install.sh:159`, `install.sh:164`, `scripts/linux/front.sh:387`, `scripts/linux/front.sh:389` | `readlink -f`, the canonical path of the script or link | macOS 12.3 and newer ship `readlink -f` and `realpath`; older ones don't. A `cd -P` + `pwd -P` loop works everywhere |
| `scripts/linux/sync.sh:589`, `bootstrap/linux.sh:384` | `find … -printf '%f\n'`, listing nvm's Node folder names | `for d in "$dir"/*/; do basename "$d"; done` |
| `scripts/linux/sync.sh:589`, `bootstrap/linux.sh:385` | `sort -V`, picking the newest Node version | macOS's `sort` has `-V` in recent releases; the probe confirms. Else a `sort -t. -k1,1n -k2,2n -k3,3n` on the version without the `v` |
| `scripts/linux/front.sh:66` | `timeout 15 git fetch`, the status fetch | Not in macOS. `gtimeout` from Homebrew coreutils, or a background job with `kill` after 15 seconds |
| `scripts/linux/sync.sh:450` | `getent passwd`, the login-home guard for dconf | No `getent`; `dscl . -read /Users/$USER NFSHomeDirectory`. Only reached by dconf entries, which are Linux-only (below) |
| `bootstrap/linux.sh:32` | `sha256sum -c` | `shasum -a 256 -c`. Bootstrap only |
| `bootstrap/linux.sh:372` | `mv -T` | Not in BSD `mv`. Bootstrap only |

Portable as used (checked): `cp -p` (12 places), `cmp -s`, `mktemp` and `mktemp -d` without templates, `sed -n` with basic
expressions (`scripts/linux/front.sh:103`, `bootstrap/linux.sh:70`, `bootstrap/linux.sh:120`), `date +%Y%m%d-%H%M`
(`commit.sh:269`), `awk` (POSIX programs only, `scripts/linux/sync.sh:462`-`:576`), `find -mindepth`, `-maxdepth`, `-empty`
and `-delete` (`export.sh:215`), `install -m`, `ln -sfn` (`install.sh:170`). `jq` isn't in macOS at all; Homebrew has it,
and every option needs it.

### Gates that stop macOS today

- `install.sh:42`-`:46`: `Darwin` stops with `ERROR: macOS isn't supported yet.`
- `sync:22`: only routes Windows shells; on macOS it would run the bash engine and fail at the first bash-4 line.
- `scripts/linux/sync.sh:119`: `platform_entries` takes `linux` and `common` entries, so on macOS it would apply Linux
  paths such as `~/.config/Code/User/settings.json` (40 `linux` entries, 4 `common`).

### Linux by design

These have no macOS meaning, so on macOS they are skipped, not ported:

- dconf entries and the dconf test bus (`scripts/linux/sync.sh`, `export.sh:224`, `import.sh`); GNOME, `mimeapps.list`,
  GTK bookmarks and `.desktop` files.
- Package drift against `apt-mark`, `snap` and `code --list-extensions` (`scripts/linux/sync.sh:534`-`:589`), and
  `packages/linux/`.
- `bootstrap/linux.sh` as a whole (apt, snap, GNOME extensions, `sudo`).
- `install.sh:88`-`:106` (`sudo apt-get`) and the `dnf` and `pacman` hints in `scripts/linux/front.sh:35`-`:39`.

What macOS would want instead, as notes for the decision only: `defaults export <domain>` / `defaults import` for app
settings (the dconf counterpart, with the same allowlist need because the repo is public), a Homebrew `Brewfile` with
`brew bundle check` for packages and drift, and `~/Library/Application Support/Code/User/` for VS Code.

### What the shared tools would need

The tools synced today that a Mac would also use: git (`common`), the shell (`.bashrc`, `.profile`, though macOS defaults
to zsh), tmux, starship, wezterm, htop, gh, VS Code (another folder), and Claude Code (`~/.claude`, same paths). The
`linux` entries for these would become `common`, or get `macos` twins with other `localPath`s.

## Probe results

Run: <https://github.com/makubexD/SyncSettings/actions/runs/42545872997> (2026-11-08, `macos-latest` = macOS 26.7.2 on
arm64), logs in its `probe-system` and `probe-gnu` artifacts.

### What macOS 26 has

From the `system` leg's tool check, which corrects the inventory above:

| Tool | macOS 26 |
|---|---|
| `bash` | 3.2.57 |
| `readlink -f`, `realpath` | present, work |
| `sort -V` | works (`v1.9` before `v1.10`) |
| `sha256sum` | present (`/sbin/sha256sum`) |
| `cmp` | present |
| `timeout` | missing |
| `getent` | missing |
| `find -printf` | `unknown primary or operator` |
| `chmod --reference` | `illegal option` |
| `jq` | not in macOS; Homebrew's was used |

So on current macOS, the GNU gap is four things: `timeout`, `getent` (dconf only), `find -printf` and
`chmod --reference`.

### `gnu` leg: Homebrew bash 5.3 and GNU tools

Engine: 305 passed, 48 failed. Bootstrap: 101 passed, 1 failed. `mksync doctor`: no `MISSING` line. `mksync` status: ran
the import check and reported `38 file(s) differ from the repo` against the runner's home, which is the right answer for
a machine that never imported.

| Case | First error | Class |
|---|---|---|
| 36 `dconf-*` cases, plus `import-check-dconf`, `real-config-dconf-restore` among them | `dconf is not installed (dconf-cli)` | Linux-only by design |
| `real-config-roundtrip` | `missing guarded SKIPPED line for dotfiles/linux/gnome/dconf/interface.ini` | Linux-only by design (dconf) |
| `install-fresh`, `install-update`, `install-not-a-clone`, `install-link-conflict`, `install-missing-jq-yes`, `install-missing-jq-no-answer`, `install-missing-jq-eof`, `install-runs-setup` | `install.sh exited 1` (its `Darwin` gate, `install.sh:46`) | Gate, expected |
| `prompt-empty-stops`, `defaultenv-valid`, `upstream-behind-pull` | wrong exit code | Test harness only: `script -qec` is util-linux syntax; BSD `script` takes `script -q /dev/null cmd` |
| bootstrap `tools-claude-file-first` | `stdin was not /dev/null` | Test harness only: the stub reads `/proc/self/fd/0` |

Engine: 37 + 8 + 3 = 48. Bootstrap: 1. No failure is in the engine itself: with Homebrew bash and GNU tools on `PATH`,
every export, import, commit, preview, check and drift case that isn't dconf passes on macOS.

### `system` leg: macOS's own bash 3.2 and BSD tools

| What | Result | Class |
|---|---|---|
| `tests/linux/engine.sh` | `line 5308: syntax error near unexpected token ';;'`; no case ran | Bash 3.2: its parser fails on a `case` inside `$( … )` without `(pattern)`, used by the runner loop only |
| `tests/linux/bootstrap.sh` | `line 1814`, the same error; no case ran | Bash 3.2, same |
| `mksync doctor` | `MISSING bash 4 or newer (this is 3.2.57(1)-release)` | The gate at `scripts/linux/front.sh:350` works |
| `mksync` status | `Machine : not checked`, so `./import.sh --check` failed | Bash 3.2 (`declare -A` at `scripts/linux/sync.sh:11` is the first bash-4 line it reaches) |

The engine scripts don't use `$(case …)` (checked), so the parse error is the test harness's. But because no case ran,
this leg measures nothing about option B's cost beyond the inventory: the real list of bash 3.2 failures would only show
after the harness is fixed. The inventory's estimate stands: one associative array, six `mapfile`s, the unguarded empty
arrays under `set -u`, plus the four BSD gaps.

### Found on the way

- `mksync` status says `Next: nothing to do.` when the machine check couldn't run (`scripts/linux/front.sh:119`-`:122`):
  a failed check falls through to the last branch. Linux and Windows (`scripts/windows/Front.ps1`, `Show-Status`) do the
  same today. It should say to run the check by hand to see why.
- The OS label read `linux (unknown)` on macOS: the status reads `/etc/os-release`, which macOS doesn't have.

## Options

Every option needs Homebrew for `jq` alone, which macOS doesn't ship. So "Homebrew is required" is already true; the
options differ only in what else comes from it and how much code changes.

| | A. Homebrew bash + GNU tools | B. Portable code | C. Hybrid (recommended) |
|---|---|---|---|
| Brew installs | `bash coreutils findutils jq` | `jq` | `bash jq` |
| Engine code change | None measured: the `gnu` leg passed every non-dconf case | One associative array, six `mapfile`s, every unguarded empty array under `set -u`, plus the BSD gaps; the true count is unknown until the harness runs on 3.2 | `chmod --reference` (2 places) and `timeout` (1 place) get portable helpers; `find -printf` and `getent` sit on Linux-only paths (npm drift, dconf) and stay |
| Test harness | `script -qec` and `/proc/self/fd/0` (4 cases) | Same 4, plus the `$(case …)` parse error in both runners | Same 4 |
| Runtime wiring | `gnubin` folders first on `PATH`, or the scripts call `g`-prefixed tools | None | `#!/usr/bin/env bash` already picks Homebrew's bash when `brew shellenv` is in the profile; `sync` re-execs under `$(brew --prefix)/bin/bash` when `BASH_VERSINFO` is below 4, so a bare `/bin/bash sync` still works |
| Ongoing cost | A user's `PATH` decides which `sed`/`find` runs; GNU-only flags keep creeping in unseen | Every future change must stay bash 3.2 + BSD; a macOS CI job is needed to hold it | A macOS CI job (Homebrew bash, no `gnubin`) catches new GNU-only flags |

**Recommendation: C.** macOS 26 already has `readlink -f`, `realpath`, `sort -V` and `sha256sum`, so the GNU gap on the
engine's path is two spots. Homebrew bash keeps the bash 4 code as it is and costs one formula next to `jq`, which every
option needs. A pulls in GNU tools to cover two flags and makes behaviour depend on `PATH` order; B rewrites the
engine's core data structures for no user-visible gain and taxes every later change. `mksync doctor` keeps its bash 4
gate (`scripts/linux/front.sh:350`); on macOS its hint becomes `brew install bash`.

## Config contract (proposed)

- **Platform value `macos`.** `platform_entries` (`scripts/linux/sync.sh:119`) picks by OS: Linux takes `linux` +
  `common`, macOS takes `macos` + `common`. `check_platforms` and PowerShell's `Assert-ValidPlatform` accept `macos`;
  Windows skips it like `linux`.
- **`common` entries apply on macOS as they are.** All four use `~/` paths that are the same on a Mac:
  `~/.gitconfig`, `~/.config/git/ignore`, `~/.claude/RTK.md`, `~/.claude/docs/token-routing-map.html`.
- **Files under `dotfiles/macos/<tool>/`** only when the content differs from Linux. Where the file is the same and
  only the platform differs, the entry moves to `common` (same `repoPath` under `dotfiles/common/`) rather than getting a
  twin, so one edit reaches both machines.
- **Tools already synced, by where they'd live on a Mac:**

| Tool | Linux entries | macOS `localPath` | Proposal |
|---|---|---|---|
| git | `~/.gitconfig` (common), `~/.gitconfig.local` | same | `.gitconfig.local` stays per-OS (it holds OS paths) |
| Claude Code | 11 `~/.claude/…` entries, 2 `~/.claude-worker` | same paths | Move to `common` the ones that are OS-neutral (`CLAUDE.md`, skills, docs); `settings.json`, `hooks`, `statusline.sh` and `bin/` call Linux paths and tools, so they stay `linux` until a Mac copy is written. `mk-exec` and the worker setup are Linux-only for now |
| shell | `~/.bashrc`, `~/.profile` | macOS defaults to zsh: `~/.zshrc`, `~/.zprofile` | `dotfiles/macos/shell/` with zsh files, not the bash ones |
| VS Code | `~/.config/Code/User/{settings,keybindings}.json` | `~/Library/Application Support/Code/User/` | `common` content, two `localPath`s: needs a per-OS path, below |
| tmux, starship, wezterm, htop, gh | `~/.config/…`, `~/.tmux.conf` | same paths | `common` |
| rtk | `~/.config/rtk` | likely `~/Library/Application Support/rtk` (Rust `dirs` default); check on the Mac | per-OS path |
| GNOME, dconf | 14 + dconf entries | n/a | stay `linux` |

- **Per-OS `localPath`.** VS Code (and maybe rtk) has the same content in another folder. Either a `macos` twin entry
  pointing at the same `repoPath` (no schema change, but two entries to keep in step and export would see both), or an
  optional `localPaths: { "macos": "…" }` override on a `common` entry. The override is the cleaner contract; it's a
  schema change on both engines.
- **`mksync setup` and `doctor` on macOS.** `doctor`: bash ≥ 4 (hint `brew install bash`), `git`, `jq`, `cmp`
  (hints `brew install …`), `brew` itself (MISSING with the install URL), `gh`. No `dconf` check. `setup`: no
  `--bootstrap` (`bootstrap/linux.sh` is apt); the OS label comes from `sw_vers` instead of `/etc/os-release`. The
  installer's `Darwin` gate (`install.sh:42`) becomes a check that `brew` exists, then offers `brew install bash jq`.
- **Later, not this phase:** `defaults export` allowlists (the dconf counterpart), a `Brewfile` with `brew bundle check`
  as the package list and drift report.

## Decision

2026-11-08, by the user:

- **Option C.** Homebrew `bash` and `jq` are required; the bash 4 code stays; `chmod --reference` and `timeout` get
  portable helpers; a macOS CI job (Homebrew bash, no `gnubin`) keeps GNU-only flags out.
- **No Mac in use yet.** The macOS work is proven by CI on `macos-latest`, not on a real machine. Anything that can only
  be checked on a Mac (rtk's config folder, zsh startup order on a real login) is marked as such, not guessed.
- **First tools, all four groups:** git and Claude Code's OS-neutral files (`common`), VS Code (per-OS `localPath`),
  tmux, starship, wezterm, htop and gh (`common`), and zsh under `dotfiles/macos/shell/`.
