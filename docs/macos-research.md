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
