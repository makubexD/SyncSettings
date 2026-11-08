# Easy install, phase 1: Linux

Roadmap: `docs/plan-easy-install.md`. Goal: `curl … | bash` installs or updates the tool on a Linux machine, and `mksync`
shows where the machine stands and runs the next step. The Windows engine doesn't change in this phase.

## Shared rules

- Branch `feat/easy-install-linux`, one commit per step, one PR at the end.
- The bash rules in `CLAUDE.md` apply: `read_text`/`write_text`, NUL-separated jq, prompts on another fd inside loops.
- Every `[Y/n]` prompt reads stdin like `import.sh` does: an empty answer or EOF means yes. Every `[y/N]` prompt means no
  on an empty answer or EOF.
- New cases go in `tests/linux/engine.sh` and are registered in its `case` dispatch next to the existing `sync-*` cases.
  A case never reaches the real `sudo`, `apt-get`, `gh`, network or dconf bus: stubs, a bare origin from
  `make_git_repo`, and `on_test_bus`.
- Each step's test command is `tests/linux/engine.sh <filter>` plus `shellcheck -x` on the changed scripts. The full
  suite runs once at the end.
- The PR touches `.github/workflows/ci.yml` (step 7), so it waits for the user's `reviewed` label.

## Steps

### 1. Contract `[inline: contract design]`

Files: `docs/sync-contract.md`.

Add two sections. "Import check" has the rules of step 2. "Front door" has the commands, outputs and exit codes of steps
3 to 6, and `install.sh`'s environment variables.

### 2. `import.sh --check` `[worker]`

Files: `import.sh`, `tests/linux/engine.sh`.

A dry run of import: it reports what import would change and writes nothing.

- New flag `--check`; usage becomes `import.sh [--force] [--reset-values] [--check]`. With `--reset-values` →
  `ERROR: --check cannot be combined with --reset-values.` exit 1. `--force` is accepted and ignored.
- Header line `  SyncSettings -- IMPORT CHECK (linux)` instead of `IMPORT`. `check_upstream` is skipped.
- Values: `load_values`, then `infer_values` as today. No `request_values` and no `save_values`. A placeholder with no
  value takes the rule's `default`, then its `defaultEnv` value, in memory only.
- Global `CHECK=0|1`. With `CHECK=1` nothing is written: no `mkdir`, `cp`, `write_text`, `chmod`, backup, or
  `dconf load`, and no prompt. A missing local folder is not an error; the file in it is a `CREATE`.
- Status lines: a file import would create → `status CREATE <label>`; one it would overwrite → `status UPDATE <label>`.
  Both add 1 to a new `CHANGED` counter. `UNCHANGED`, `SKIPPED` and `EXTRA` lines stay as they are.
- A sanitized entry with a placeholder still missing a value → `status SKIPPED <label> 'needs values: run mksync setup'`
  and `CHANGED+1`.
- dconf: the same checks as today up to the `dconf dump` (read-only). An empty dump → `CREATE`. A non-empty
  `dconf_unapplied` → `UPDATE`.
- Summary: `CHANGED == 0` → `  This machine matches the repo.` exit 0. Otherwise
  `  %d file(s) would change. Run mksync pull to apply.` exit 3. The `DEEPSEEK_API_KEY` line is printed only without
  `--check`.

Cases (`tree_hash` of `$t/home` and `$t/repo` is the same before and after in every one):

- `import-check-writes-nothing`: local `plain.txt` holds `old`, and one fixture file is missing locally → rc 3, `UPDATE`
  for `dotfiles/linux/plain.txt`, `CREATE` for the missing one, no `.bak` file under `$t/home`, and
  `.user-values.json` byte-identical.
- `import-check-matches`: `import.sh --force` first, then `--check` → rc 0, `This machine matches the repo.`, no
  `CREATE` or `UPDATE` line.
- `import-check-sanitized`: after a real import, `named.conf` is `UNCHANGED`. Edit it locally → `UPDATE`, rc 3.
- `import-check-needs-values`: no `.user-values.json`, and a rule with no default → the `needs values` line, rc 3, no
  `Enter values` text, and no `.user-values.json` created.
- `import-check-dir`: a dir entry with one local file changed and one local extra file → `UPDATE` and `EXTRA`, rc 3.
- `import-check-dconf`: on `on_test_bus`, a seeded value differs from the repo file → `UPDATE`, rc 3, and
  `dconf dump` of the path is the same before and after.
- `import-check-reset-rejected`: `--check --reset-values` → rc 1 with the message.
- `import-check-no-prompt`: `run_engine_input` with `n` and a changed file → no `Overwrite ` in the output.

Test: `tests/linux/engine.sh import-check && shellcheck -x import.sh`.

### 3. `mksync` status, doctor and help `[worker]`

Files: `sync`, `scripts/linux/front.sh` (new), `tests/linux/engine.sh`.

`sync`:

- `cd "$(dirname "$(readlink -f "$0")")"`, so a symlink on `PATH` works from any folder.
- The Windows hand-over stays first.
- `help`/`-h` print:
  ```
  usage: mksync [command] [options]
    (none)   show where this machine stands and what to run next
    doctor   check the tools and the setup
    setup    first run on this machine
    pull     get the latest repo and apply it here
    push     send this machine's changes as a PR
    preview | export | commit | import   the single steps
    Detected: linux
  ```
- `doctor` sources `scripts/linux/front.sh` and runs `front_doctor` before any `require_tool`, so it works with tools
  missing. No arguments → `front_status`. `status` is the same as no arguments. `setup`, `pull`, `push` are added to the
  known commands and print `Not implemented yet.` with exit 1 until steps 4 and 5. `gh` is required for `commit` and
  `push`.

`scripts/linux/front.sh` (sourced, no top-level work, and no jq at source time). `REPO_ROOT` is the folder `sync` is in.
`SYNC_OS_RELEASE` (default `/etc/os-release`) is read for `PRETTY_NAME` and `ID`, with `unknown` if it's missing.

`front_status` prints exactly (labels padded as shown):

```

  SyncSettings  linux (<PRETTY_NAME>)
  Repo      : <REPO_ROOT>
  Origin    : <origin>
  Unsent    : <unsent>
  Machine   : <machine>

  Next: <next>
```

- `<origin>`: not a git work tree → `not a git clone`; no `origin` remote → `no origin remote`; not on `master` →
  `on branch <b>, not master`; `timeout 15 git fetch -q origin master` fails → `offline, not checked`; behind by n > 0
  → `<n> update(s) waiting`; else `up to date`. `GIT_TERMINAL_PROMPT=0` on every git call.
- `<unsent>`: the line count of `git status --porcelain -- dotfiles packages sync-config.json` → `none`, or
  `<k> changed file(s) not sent yet`. Not a git clone → `not checked`.
- `<machine>`: `./import.sh --check < /dev/null`, its output kept in a temp file that's removed afterward. rc 0 →
  `matches the repo`; rc 3 → `<n> file(s) differ from the repo`, with n from the summary line; anything else →
  `not checked: run ./import.sh --check to see why`.
- `<next>`, the first that holds: not a git clone or no origin → `run mksync doctor.`; updates waiting → `mksync pull`;
  unsent > 0 → `mksync push`; machine differs → `mksync pull to take the repo's version, or mksync push to send this
  machine's.`; else `nothing to do.`
- Exit 0 always.

`front_doctor` prints one line per check as `printf '  %-8s %s\n' <OK|WARN|MISSING> <text>`:

- bash: `BASH_VERSINFO[0] >= 4` → `OK bash <version>`, else `MISSING bash 4 or newer (this is <version>)`.
- `git`, `jq`, `cmp`: `OK <tool>`, or `MISSING <tool>: install with <hint>`. The package is the tool's name, except
  `diffutils` for `cmp`. The hint is the first of `sudo apt-get install <pkg>`, `sudo dnf install <pkg>`,
  `sudo pacman -S <pkg>` whose manager is on `PATH`, else `your package manager`.
- gh: not on `PATH` (honor `$GH` like `commit.sh`) → `WARN gh: needed for push; see https://cli.github.com`;
  `gh auth status` fails → `WARN gh: not signed in; run gh auth login`; else `OK gh (signed in)`.
- clone: origin remote present → `OK repo clone with origin`, else `WARN repo has no origin remote`.
- link: `readlink -f "$(command -v mksync)"` equals `$REPO_ROOT/sync` → `OK mksync on PATH`, else
  `WARN mksync not on PATH; run: ln -s "<REPO_ROOT>/sync" ~/.local/bin/mksync`.
- values, only when jq is there: placeholders of `linux`/`common` entries with no value in `.user-values.json`, no
  `default` and no `defaultEnv` → `WARN <n> value(s) not set; mksync setup asks for them`, else `OK values`.
- No `MISSING` → `  Ready.` exit 0. Otherwise `  Fix the MISSING items, then run mksync doctor again.` exit 1.

Tests: `add_sync` also copies `scripts/linux/front.sh`. `case_sync_usage` now runs `sync help` and expects the new usage
line `usage: mksync [command] [options]` and `Detected: linux`. Doctor cases build a stub `PATH` like
`case_sync_missing_tool`. A gh stub answers `auth status` with exit 0 or 1.

- `sync-doctor-ready`: real git, jq, cmp, gh stub signed in, `mksync` symlink in the stub folder → rc 0, `Ready.`.
- `sync-doctor-missing-jq`: no jq, an `apt-get` stub on `PATH` → rc 1,
  `MISSING  jq: install with sudo apt-get install jq`.
- `sync-doctor-gh-signed-out` → `WARN     gh: not signed in; run gh auth login`, rc 0.
- `sync-doctor-no-link` → a `WARN` line with `ln -s`, rc 0.
- `sync-status-clean`: `setup_repo`, fixtures, `make_git_repo`, then `import.sh --force` into the home →
  `Origin    : up to date`, `Unsent    : none`, `Machine   : matches the repo`, `Next: nothing to do.`, rc 0.
- `sync-status-behind`: a second clone pushes one commit to origin → `Origin    : 1 update(s) waiting`,
  `Next: mksync pull`.
- `sync-status-unsent`: a changed file under `$t/repo/dotfiles/` → `Unsent    : 1 changed file(s) not sent yet`,
  `Next: mksync push`.
- `sync-status-differs`: a changed local file → `Machine   : 1 file(s) differ from the repo`.
- `sync-status-not-git`: no `make_git_repo` → `Origin    : not a git clone`, `Next: run mksync doctor.`, rc 0.
- `sync-status-writes-nothing`: `tree_hash` of home and repo is the same before and after `sync-status-differs`'s setup.
- `sync-status-os-name`: `SYNC_OS_RELEASE` pointing at a file with `PRETTY_NAME="Test OS 1"` →
  `SyncSettings  linux (Test OS 1)`.
- `sync-symlink`: `ln -s "$t/repo/sync" "$t/bin/mksync"`, run `$t/bin/mksync help` from `$t` → rc 0 with the usage line.

Test: `tests/linux/engine.sh sync- && shellcheck -x sync scripts/linux/front.sh`.

### 4. `mksync pull` and `mksync push` `[worker]`

Files: `sync`, `scripts/linux/front.sh`, `tests/linux/engine.sh`.

Both need a git clone on `master` with an origin, else
`ERROR: <pull|push> needs the repo clone on master with an origin remote.` exit 1.

`front_pull [--yes] [--no-fetch]`:

1. `git status --porcelain -- dotfiles packages sync-config.json` not empty →
   `ERROR: the repo has changes not sent yet; run mksync push first, or git restore them.` exit 1.
2. Without `--no-fetch`: fetch fails → `ERROR: could not reach origin.` exit 1. Behind by n > 0: `git pull --ff-only -q`,
   failure → `ERROR: pull failed; resolve it and rerun.` exit 1; then `  Pulled <n> commit(s).` and
   `exec "$REPO_ROOT/sync" pull --no-fetch` with `--yes` if given, so the new code runs.
3. `./import.sh --check < /dev/null` with its output shown. rc 0 → exit 0 (its summary already says it matches). rc 1 →
   exit 1. rc 3 → unless `--yes`, ask `  Apply these changes? [Y/n] `; no → `  Nothing applied.` exit 0; yes →
   `exec ./import.sh --force`, which keeps the `.bak` backups and asks for missing values.

`front_push [--yes] [-m <message>]`:

1. `./export.sh`, stdin kept so it can ask for values. A failure exits with its code.
2. Nothing in `git status --porcelain -- dotfiles packages sync-config.json` →
   `  Nothing to send: the repo matches this machine.` exit 0.
3. Print `git status --short -- dotfiles packages sync-config.json`. Unless `--yes`, ask
   `  Open a PR with these changes? [Y/n] `; no →
   `  Kept in the repo. Run mksync push again, or git restore dotfiles to drop them.` exit 0.
4. `exec ./commit.sh`, with `-m <message>` if given. `GH` is passed through.

`sync` routes `pull` and `push` with their options. An unknown option → `Unknown option: <x>` exit 1.

Cases (reuse `setup_commit_repo`, `make_gh_stub`, `run_commit`'s pattern, running `./sync` in `$t/clone`):

- `sync-pull-applies`: a second clone pushes a change to `dotfiles/linux/plain.txt`; the home has the old version;
  `sync pull --yes` → rc 0, clone HEAD equals origin's, the home file has the new text, `plain.txt.bak` exists, and the
  output has `Pulled 1 commit(s).`
- `sync-pull-matches` → `This machine matches the repo.`, rc 0.
- `sync-pull-declined`: a changed local file, input `n` → `Nothing applied.`, the local file unchanged.
- `sync-pull-dirty`: a changed file under `dotfiles/` in the clone → rc 1 with the error, HEAD unchanged.
- `sync-pull-not-master`: on another branch → rc 1 with the error.
- `sync-push-nothing` → `Nothing to send`, rc 0, the gh log empty.
- `sync-push-opens-pr`: a changed local `plain.txt`, `--yes` → rc 0, the gh log has `pr create`, origin has a
  `sync/linux-` branch.
- `sync-push-declined`: input `n` → rc 0, `Kept in the repo`, gh log empty, the change still in the working tree.

Test: `tests/linux/engine.sh sync-p && shellcheck -x sync scripts/linux/front.sh`.

### 5. `mksync setup` `[worker]`

Files: `sync`, `scripts/linux/front.sh`, `tests/linux/engine.sh`.

`front_setup [--yes] [--bootstrap]`:

1. `front_doctor`; exit 1 → exit 1.
2. `./import.sh --check < /dev/null`, output shown. rc 1 → exit 1.
3. `ID` is `ubuntu` and `bootstrap/linux.sh` is executable: with `--bootstrap` run it; otherwise ask
   `  Also restore apps and packages from packages/linux (uses sudo)? [y/N] `. Yes →
   `exec ./bootstrap/linux.sh`, which runs import itself. `--yes` doesn't answer this question.
4. The check's rc was 3: unless `--yes`, ask `  Apply these changes? [Y/n] `; yes → `./import.sh --force`, a failure
   exits with its code; no → `  Nothing applied.`
5. `  Setup done. Run mksync any time to see where this machine stands.` exit 0.

Cases:

- `sync-setup-applies`: `SYNC_OS_RELEASE` with `ID=debian`, a fixture file missing locally, `--yes` → the file is created,
  `Setup done.`, no bootstrap question.
- `sync-setup-offers-bootstrap`: `ID=ubuntu`, a stub `bootstrap/linux.sh` that prints `BOOTSTRAP RAN`, input `y` → the
  output has `BOOTSTRAP RAN`. Empty input → it doesn't.
- `sync-setup-doctor-fails`: a stub `PATH` without jq → rc 1, no `IMPORT CHECK` header.

Test: `tests/linux/engine.sh sync-setup && shellcheck -x sync scripts/linux/front.sh`.

### 6. `install.sh` `[worker]`

Files: `install.sh` (new, executable), `tests/linux/engine.sh`.

The whole script is functions, and its last line is `main "$@"`, so a partial download runs nothing.

Settings, from the environment: `SYNCSETTINGS_REPO_URL` (default `https://github.com/makubexD/SyncSettings.git`),
`SYNCSETTINGS_DIR` (default `$HOME/SyncSettings`), `SYNCSETTINGS_REF` (default `master`), `SYNCSETTINGS_BIN` (default
`$HOME/.local/bin`), and `SYNCSETTINGS_TTY`, the file answers are read from. Default: stdin when it's a terminal, else
`/dev/tty` when it's readable, else `/dev/null`. Flags: `--yes`, `--no-setup`. Unknown → usage, exit 1.

1. `uname -s`: `Linux` continues. `Darwin` → `ERROR: macOS isn't supported yet.` exit 1. `MINGW*|MSYS*|CYGWIN*` →
   `ERROR: on Windows, run the PowerShell installer from the README.` exit 1. Anything else →
   `ERROR: unsupported system: <name>.` exit 1.
2. Tools `git`, `jq`, `cmp` (package `diffutils`). Missing ones with `apt-get` on `PATH`: unless `--yes`, ask
   `  Install <pkgs> with sudo apt-get? [Y/n] ` from the answers file. Yes → `sudo apt-get update -q` then
   `sudo apt-get install -y <pkgs>`; a failure exits 1. Recheck afterward; still missing → error, exit 1. No `apt-get`,
   or the answer is no → `ERROR: install <pkgs> with your package manager, then run this again.` exit 1.
3. The folder: a git clone with an origin → `git -C <dir> pull --ff-only -q` (failure → error, exit 1) and
   `  Updated <dir>`. It exists and is neither a clone nor empty →
   `ERROR: <dir> exists and isn't a SyncSettings clone; set SYNCSETTINGS_DIR.` exit 1. Otherwise
   `git clone -q --branch <ref> <url> <dir>` and `  Cloned into <dir>`. Then `<dir>/sync` and `<dir>/sync-config.json`
   must exist, else `ERROR: <dir> doesn't look like SyncSettings.` exit 1.
4. The link: `mkdir -p <bin>`. `<bin>/mksync` exists and isn't a symlink resolving to `<dir>/sync` →
   `ERROR: <bin>/mksync already exists; remove it and run this again.` exit 1. Else `ln -sfn <dir>/sync <bin>/mksync`.
   `<bin>` not in `PATH` → `  Add this line to ~/.bashrc, then open a new terminal: export PATH="<bin>:$PATH"`.
5. Unless `--no-setup`: `<dir>/sync setup`, with `--yes` if given and stdin from the answers file. A failure exits with its
   code.
6. `  Installed. Run mksync any time.` exit 0.

Cases. The origin is a bare repo built from `setup_repo`, the fixtures, `sync`, `scripts/linux/front.sh` and
`install.sh`, via `make_git_repo`, with `SYNCSETTINGS_REPO_URL=$t/origin.git`, `HOME=$t/home` and
`SYNCSETTINGS_TTY=/dev/null` unless noted. `sudo` and `apt-get` stubs log their arguments; the `apt-get install` stub
links the real `jq` into the stub folder.

- `install-fresh`: `--no-setup` → rc 0, the clone at `$t/home/SyncSettings`, `$t/home/.local/bin/mksync` resolving to
  its `sync`, and the `PATH` hint.
- `install-update`: a second run after a new origin commit → `Updated`, clone HEAD equals origin's, rc 0.
- `install-not-a-clone`: the folder holds a file → rc 1 with the error, the file untouched.
- `install-link-conflict`: `<bin>/mksync` is a regular file → rc 1 with the error, the file untouched.
- `install-missing-jq-yes`: no jq, `--yes --no-setup` → the stub log has `apt-get install -y jq`, rc 0.
- `install-missing-jq-no-answer`: no jq, no `--yes` → rc 1 with `install jq with your package manager`, the stub not
  called.
- `install-macos`: a `uname` stub printing `Darwin` → rc 1, `macOS isn't supported yet`.
- `install-runs-setup`: `--yes`, `SYNC_OS_RELEASE` with `ID=debian` → a fixture file is created in `$t/home`, and the
  output has `Setup done.` and `Installed.`
- `install-partial`: all but the last line of `install.sh`, run with bash → rc 0, no clone folder, no link.

Test: `tests/linux/engine.sh install- && shellcheck -x install.sh`.

### 7. Lint the new scripts `[inline: tiny edit, CI file]`

Files: `.github/workflows/ci.yml`.

Add `sync install.sh scripts/linux/front.sh` to the ShellCheck line. This is why the PR needs the user's label.

Test: `shellcheck -x bootstrap/linux.sh export.sh import.sh commit.sh sync install.sh scripts/linux/sync.sh
scripts/linux/front.sh scripts/ci/*.sh tests/linux/*.sh`.

### 8. Docs `[inline: user-facing copy]`

Files: `README.md`, `docs/daily-workflow.md`, `docs/restore.md`, `CLAUDE.md`.

README opens with Install, using
`curl -fsSL https://raw.githubusercontent.com/makubexD/SyncSettings/master/install.sh | bash`, and then the commands
table from the roadmap. The daily workflow becomes `mksync`, then `mksync push` or `mksync pull`. The restore doc starts
from the one-liner. In `CLAUDE.md`, add `install.sh` and `scripts/linux/front.sh` to the entry points and architecture.

### 9. Real run on this machine `[inline: verification on the real machine]`

After pushing the branch, with a throwaway `HOME`:

```bash
H=$(mktemp -d)
curl -fsSL https://raw.githubusercontent.com/makubexD/SyncSettings/feat/easy-install-linux/install.sh \
  | HOME=$H SYNCSETTINGS_REF=feat/easy-install-linux bash -s -- --no-setup
HOME=$H "$H/.local/bin/mksync" doctor
```

| Check | Expected |
|---|---|
| Install | `Cloned into $H/SyncSettings`, the `PATH` hint, `Installed.` |
| Second run of the same line | `Updated`, rc 0 |
| `doctor` in `$H` | No `MISSING` line |

Then, in the real repo, read-only: `./sync` and `./sync doctor`. Expect `Origin    : up to date`, no `MISSING`, and
`dconf list /test/` empty. Then `rm -rf "$H"`.
