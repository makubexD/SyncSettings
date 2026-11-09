# Easy install, phase 4: macOS

Roadmap: `docs/plan-easy-install.md`. Research and decision: `docs/macos-research.md`. Goal: the bash engine, `mksync` and
`install.sh` run on macOS with Homebrew `bash` and `jq` (option C), with a `macos` CI job that proves it. No Mac is in use
yet, so `macos-latest` in CI is the proof; a real run on a Mac goes to `TODO.md`.

## Shared rules

- Branch `feat/easy-install-macos` from `master` (after the research branch merges), one commit per step, one PR at the
  end.
- The engine stays bash 4. macOS's `/bin/bash` 3.2 only has to reach the re-exec guard (step 6) and print its error;
  nothing past it needs to run on 3.2.
- No GNU-only tool or flag on a path macOS runs: no `chmod --reference`, `timeout`, `find -printf`, `getent`, `mv -T`,
  `sed -i`, `stat -c`. Linux-only paths (dconf, package drift, `bootstrap/linux.sh`) may keep them.
- The OS comes from one function, `sync_os` (step 3): `SYNC_OS` when set, else `uname -s` (`Linux` → `linux`, `Darwin`
  → `macos`). Tests set `SYNC_OS=macos` on Linux to cover macOS behaviour; the `engine-macos` job (step 10) runs the
  same cases for real.
- Each step's test is its own filter of `tests/linux/engine.sh <filter>` (bash) or the parse check plus the
  `engine-windows` job (PowerShell, as in phase 2). The full suite runs once, in the finish.
- A behaviour change updates `docs/sync-contract.md` in the same commit when step 1 didn't already cover it.
- The PR touches `.github/workflows/` (step 10).

## Steps

### 1. Contract `[inline: contract design]`

Files: `docs/sync-contract.md`, `docs/configuration.md`, `docs/layout.md`.

- **`platform`** takes `"common"`, `"windows"`, `"linux"`, `"macos"`, or a non-empty array of the last three without
  repeats (`["linux", "macos"]`). `"common"` keeps meaning all three. Anything else, an empty array, or a repeat stops
  both engines before a file is touched, with the same error naming the four values.
- **`localPaths`** (optional): an object keyed by `linux`, `macos` or `windows`, each value a `~/` (or `~\` on Windows)
  path that replaces `localPath` on that OS. Same safety check as `localPath`. Any other key is an error.
- **Minimum macOS**: 13 (Ventura). `readlink -f` (`sync:7`, `install.sh`, `front.sh`) arrived in 12.3, and Homebrew
  supports the three newest releases. `mksync doctor` prints `WARN macOS <v> is older than 13` below it.
- **OS detection**: `sync_os` as in the shared rules. Any other `uname -s` →
  `ERROR: SyncSettings runs on Linux, macOS and Windows; this is <uname>.` exit 1.
- **Layout**: `dotfiles/common/<tool>/` holds any file used by more than one OS, and the entry's `platform` says which;
  `dotfiles/macos/<tool>/` is macOS only.
- **macOS skips**: dconf entries (the `linux` platform already keeps them off macOS), package drift (`report_drift` prints
  nothing on macOS), and `--bootstrap`.
- **Front door on macOS**: doctor checks bash ≥ 4 (hint `brew install bash`), `git`, `jq`, `cmp`, `brew` (MISSING with
  `https://brew.sh`), `gh`; the OS label comes from `sw_vers -productVersion` (`macos 26.7.2`). `setup` doesn't offer the
  bootstrap. `install.sh` on macOS: step 8.
- Known differences: add the macOS rows.

### 2. Platform cases `[worker]`

Files: `tests/linux/engine.sh`.

Each case runs on the existing fixture with a config edited by `jq` in the case:

| Case | Setup | Expected |
|---|---|---|
| `platform-macos-value` | one entry `"platform": "macos"`, `SYNC_OS=macos` | export copies it; with `SYNC_OS=linux` it's not mentioned |
| `platform-array` | `["linux", "macos"]` | copied under both `SYNC_OS` values |
| `platform-array-empty` | `[]` | exit 1, the new error, no file written |
| `platform-array-repeat` | `["linux", "linux"]` | exit 1, the new error |
| `platform-array-windows-only` | `["windows"]` | skipped on both `SYNC_OS` values, exit 0 |
| `platform-bad-sync-os` | `SYNC_OS=bsd` | exit 1, `this is bsd` in stderr |
| `localpaths-macos` | `localPaths.macos` set to another `~/` path | `SYNC_OS=macos` import writes there; `SYNC_OS=linux` writes `localPath` |
| `localpaths-unsafe` | `localPaths.macos` = `~/../x` | exit 1 before any write |
| `localpaths-bad-key` | key `bsd` | exit 1, `unknown localPaths key bsd` |
| `localpaths-spaces` | `~/Library/Application Support/Code/User/settings.json` | import and `--check` handle the space |

Test: `tests/linux/engine.sh platform` and `tests/linux/engine.sh localpaths`; every case except
`platform-array-windows-only`'s Linux run fails for the right reason (unknown platform, `SYNC_OS` ignored, or
`localPaths` ignored) until step 3.

### 3. Platform selection in the bash engine `[worker]`

Files: `scripts/linux/sync.sh`.

- New `sync_os`: prints `${SYNC_OS:-}` when set and one of `linux`/`macos`, else maps `uname -s` (`Linux` → `linux`,
  `Darwin` → `macos`); anything else prints the step 1 error to stderr and exits 1. `SYNC_OS` set to another value is the
  same error with its value. Called once at load into `SYNC_OS_NAME` (not under `SYNC_LIB_ONLY`'s skip: tests need it).
- `check_platforms` accepts the step 1 values and arrays; its error text becomes
  `entry %s needs "platform": "common", "windows", "linux", "macos" or a list of the last three.`
- `check_paths` also checks every `localPaths` value with `path_is_safe … local` and rejects keys other than
  `linux`/`macos`/`windows` (`ERROR: sync-config.json: entry %s has an unknown localPaths key %s.`).
- `platform_entries` selects `common`, the OS's own value, and arrays containing it, and rewrites
  `.localPath = (.localPaths[$os] // .localPath)` in the same `jq`, so `export.sh`, `import.sh` and `sync.sh:248`
  keep reading `.localPath` unchanged.
- The dconf placeholder query in `scripts/linux/front.sh` (`front_doctor`, `select(.platform == "linux" or …)`) uses the
  same selection; move it to a `platform_select` jq snippet in `sync.sh` that both use.

Test: `tests/linux/engine.sh platform` and `tests/linux/engine.sh localpaths` (step 2's cases) all pass.

### 4. Platform selection in PowerShell `[worker]`

Files: `scripts/windows/SyncHelpers.ps1`, `tests/windows/Engine.Tests.ps1`.

`Assert-ValidPlatform` accepts the step 1 values and arrays (same error text as step 3). `Test-WindowsEntry` is true for
`windows`, `common`, or an array containing `windows`. `localPaths` is validated as in step 3 and `localPaths.windows`
replaces `localPath` where the scripts resolve it. Pester cases: `macos` entry skipped, `["linux","macos"]` skipped,
`["windows","macos"]` used, empty array and unknown `localPaths` key throw, `localPaths.windows` used.

Test: the phase 2 parse check on the two files, then the `engine-windows` job on the pushed branch.

### 5. Portable helpers `[worker]`

Files: `scripts/linux/sync.sh`, `export.sh`, `import.sh`, `scripts/linux/front.sh`.

- `copy_mode <ref> <target>`: `chmod "$(stat -c %a "$ref" 2>/dev/null || stat -f %Lp "$ref")" "$target"`. Replaces
  `chmod --reference` at `export.sh:102` and `import.sh:236`.
- `run_with_timeout <seconds> <cmd…>`: uses `timeout` when on `PATH`, else runs the command in the background and kills
  it after the limit, returning 124 like `timeout`. Replaces `timeout 15` at `scripts/linux/front.sh:66`.
- `report_drift` returns at once when `SYNC_OS_NAME` is `macos` (it reads `apt-mark`, `snap` and `find -printf`).

Test: `tests/linux/engine.sh mode` (existing mode cases), `tests/linux/engine.sh status` and a new case
`status-fetch-timeout-no-timeout-bin`: `PATH` without `timeout`, a stub `git` that sleeps 30 on `fetch`, limit set by
`SYNC_FETCH_TIMEOUT=1` → status prints `offline, not checked` within 5 seconds.

### 6. Bash 4 guard `[worker]`

Files: `sync`, `export.sh`, `import.sh`, `commit.sh`.

Right after the shebang, before `set -u` and any bash 4 line, in bash 3.2 syntax:

```bash
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
    for b in /opt/homebrew/bin/bash /usr/local/bin/bash; do
        [ -x "$b" ] && [ -z "${SYNC_REEXEC:-}" ] && SYNC_REEXEC=1 exec "$b" "$0" "$@"
    done
    echo "ERROR: SyncSettings needs bash 4 or newer (this is ${BASH_VERSION:-unknown}). On macOS: brew install bash" >&2
    exit 1
fi
```

Test: `tests/linux/engine.sh guard` with new cases run under a fake old bash is not possible on Linux, so: a case
`guard-reexec` that runs each script with `BASH_VERSINFO` unchanged (no re-exec, normal result), and
`bash --posix -n` plus `shellcheck -s bash` on the four files. The `engine-macos` job's `system-bash` check (step 10)
runs `/bin/bash ./sync doctor` for real.

### 7. Front door on macOS `[worker]`

Files: `scripts/linux/front.sh`.

- OS label: `macos <sw_vers -productVersion>` when `SYNC_OS_NAME` is `macos`; `/etc/os-release` otherwise.
- `front_install_hint` on macOS: `brew install <pkg>` (`cmp` → nothing to install, it ships with macOS); bash's hint
  `brew install bash`.
- `front_doctor` on macOS adds `brew` (MISSING: `brew: install from https://brew.sh`). Below macOS 13 it prints
  `WARN macOS <v> is older than 13`.
- `front_setup` on macOS doesn't ask about the bootstrap; `--bootstrap` →
  `ERROR: --bootstrap is Ubuntu only.` exit 1.
- The status's `Next: nothing to do.` after a failed machine check becomes
  `Next: the machine check failed; run ./import.sh --check to see why.` (`docs/macos-research.md`, "Found on the way").
  The same text in `scripts/windows/Front.ps1` with `Import-Settings.ps1 -Check`.

Test: `tests/linux/engine.sh front` with new cases under `SYNC_OS=macos` and stubs for `sw_vers` and `brew`:
`front-macos-label` (`macos 26.7.2`), `front-macos-doctor-no-brew` (MISSING line, exit 1), `front-macos-hints`
(`brew install jq` with `jq` hidden), `front-macos-setup-no-bootstrap` (no bootstrap question),
`front-macos-bootstrap-flag` (exit 1), `front-check-failed-next` (Linux, broken config → new `Next:` line).

### 8. `install.sh` on macOS `[worker]`

Files: `install.sh`, `tests/linux/engine.sh`.

The `Darwin` gate (`install.sh:42`) becomes: no `brew` → `ERROR: install Homebrew first: https://brew.sh` exit 1. Missing
`jq`, or no bash ≥ 4 at `/opt/homebrew/bin/bash` or `/usr/local/bin/bash` → `Install with Homebrew: brew install bash jq
[Y/n]` (end of input is yes, as the apt prompt). No `sudo`. The link goes to `~/.local/bin/mksync` as on Linux, with the
same not-on-`PATH` hint; `setup` runs under the Homebrew bash.

Test: `tests/linux/engine.sh install` with `SYNC_OS=macos` (the installer honours it like `sync_os`) and a `brew` stub
that logs its arguments: `install-macos-no-brew` (exit 1, error), `install-macos-fresh` (stub logs `install bash jq`,
link made, setup ran), `install-macos-deps-no` (answer `n` → exit 1, nothing installed), `install-macos-has-deps` (stub
not called).

### 9. Portable test harness `[worker]`

Files: `tests/linux/engine.sh`, `tests/linux/bootstrap.sh`.

- `script -qec "<cmd>" /dev/null` (util-linux) → a `run_in_pty` helper that uses `script -q /dev/null <cmd>` when
  `script --version` fails (BSD).
- The `tools-claude-file-first` stub reads `/proc/self/fd/0`: use `[ -t 0 ]` and a read with `-t 0` instead.
- Cases that need dconf or apt (`dconf-*`, `real-config-roundtrip`'s dconf lines, drift cases) print `SKIP <case>
  (linux only)` when the OS is macOS; the harness computes it the same way as `sync_os` (`SYNC_OS`, else `uname -s`),
  because `SYNC_OS_NAME` lives in `sync.sh`, which the harness doesn't source; the summary counts skips separately and they don't fail the run.

Test: `tests/linux/engine.sh prompt-empty-stops`, `defaultenv-valid`, `upstream-behind-pull` and
`tests/linux/bootstrap.sh tools-claude-file-first` pass on Linux; `SYNC_OS=macos tests/linux/engine.sh dconf` prints only
`SKIP` lines and exits 0.

### 10. `engine-macos` CI job `[worker]`

Files: `.github/workflows/ci.yml`, `.github/workflows/macos-probe.yml` (deleted).

Job `engine-macos` on `macos-latest`: `brew install bash jq` (no coreutils, no `gnubin`), then
`/opt/homebrew/bin/bash tests/linux/engine.sh`, then a `system-bash` step: `/bin/bash ./sync doctor` must print the
`MISSING bash 4` line or re-exec (exit code and output checked), and `/bin/bash ./export.sh` must re-exec, not fail on
`declare -A`. Not `continue-on-error`. Add it to the required checks note in `docs/review-gate.md` only if the user
says so at review. Delete the probe workflow.

Test: `actionlint .github/workflows/ci.yml` (or the YAML parse from phase 3), then the job on the pushed branch.

### 11. Shared entries `[worker]`

Files: `sync-config.json`, `dotfiles/` (moves).

`git mv` and set `"platform": ["linux", "macos"]`:

- `dotfiles/linux/{tmux,starship,htop,gh}/…` → `dotfiles/common/<tool>/…`
- `dotfiles/linux/wezterm/wezterm.lua` → `dotfiles/common/wezterm/wezterm.lua` (the `xwayland` files stay `linux`)
- `dotfiles/linux/vscode/{settings.json,snippets}` → `dotfiles/common/vscode/…`, with `localPaths.macos`
  `~/Library/Application Support/Code/User/settings.json` and `…/snippets`
- `dotfiles/linux/claude/CLAUDE.md` and `sampleGrok.md` → `dotfiles/common/claude/`

The rest of `claude/` (settings, hooks, statusline, `bin/`, skills that call `mk-exec`) and `claude-worker/`, `rtk`
(its macOS folder is unchecked), `shell`, `git/.gitconfig.local` and GNOME stay `linux`.

Test: `tests/linux/engine.sh real-config`; then on this machine `./import.sh --check` reports the same count as before
the step (no new differences), and `./sync preview` shows only the renames.

### 12. macOS-only files `[inline: user-facing config, written from the Linux files by judgment]`

Files: `dotfiles/macos/shell/.zshrc`, `dotfiles/macos/shell/.zprofile`, `dotfiles/macos/git/.gitconfig.local`,
`sync-config.json`.

- `.zprofile`: `eval "$(/opt/homebrew/bin/brew shellenv)"` (falling back to `/usr/local`), `~/.local/bin` on `PATH`.
- `.zshrc`: the parts of `dotfiles/linux/shell/.bashrc` that mean something on a Mac (history size, `ll`/`la`/`l`,
  nvm, bun, starship init for zsh), without GNU `--color=auto` and `notify-send`.
- `.gitconfig.local`: the `gh auth git-credential` helper with `!gh`, no `/usr/bin` path.
- Three `"platform": "macos"` entries.

Test: `zsh -n` on both files if `zsh` is installed, `git config -f dotfiles/macos/git/.gitconfig.local -l`, and
`SYNC_OS=macos HOME=$(mktemp -d) ./import.sh --check < /dev/null` lists the three files.

### 13. Docs `[inline: user-facing docs]`

Files: `README.md`, `docs/daily-workflow.md`, `docs/restore.md`, `CLAUDE.md`, `docs/sync-contract.md`, `TODO.md`.

macOS install (Homebrew first, then the one line), what `mksync doctor` shows on a Mac with sample output, what is
skipped on macOS and why, troubleshooting (`bash 3.2` error, no Homebrew, `jq` missing, Intel vs Apple silicon
prefixes), and `CLAUDE.md`'s Project Purpose and platform rules. `TODO.md`: the real run on a Mac, and checking rtk's
macOS config folder. `grep -rn "macOS isn't supported\|until phase" README.md docs CLAUDE.md` prints nothing stale.

Test: the grep above, and every relative link in the changed docs resolves (`grep -o '](\([^)#]*\)' … | xargs ls`).
