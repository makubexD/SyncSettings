# Phase 5: dconf

Roadmap: `docs/plan-restructure.md`. Goal of this phase: the GNOME settings someone chose are in the repo, a restore brings
them back, `./sync preview` stays clean while the desktop is in normal use, and nothing private reaches the public repo.

Out of scope: installing the `clipboard-history` extension and `dconf-cli` (phase 6), running import from bootstrap and
`docs/restore.md` (phase 7), Windows configs (phase 8).

## Findings that shaped this plan

All from read-only checks on this machine (Ubuntu 26.04, GNOME 50.1, dconf 0.49), or a private session bus with a throwaway
`HOME`. The real dconf database wasn't written.

| Finding | Result | Effect |
|---|---|---|
| A client with `HOME=B`, on a bus whose service started with `HOME=A` | The write landed in A's database, and B's stayed empty | **`dconf load` ignores the caller's `HOME`.** `HOME=$(mktemp -d) ./import.sh`, the repo's documented test, would write to the real desktop. Decision 2 |
| `dconf dump` without a session bus | Works, reads the file under `$XDG_CONFIG_HOME` | Export never needs a bus, and with a throwaway `HOME` it reads an empty database |
| `dconf load` without a session bus | Exit 1, `dbus-launch` not found (`dbus-x11` isn't installed) | One `ERROR` per entry from a plain text console; no special case |
| `dconf load` of a file with fewer keys | Keys the file doesn't name stay | Load merges, so a plain compare of two dumps would never settle. Decision 3 |
| `dconf load` of a file with one bad value | Exit 1, and none of the file's keys were written | No half-applied entry, so `ERROR` and move on |
| `dconf dump` twice, then load that dump and dump again | Byte-identical. Keys and sections sorted, every value on one line (`\n` is escaped) | Export can compare text directly |
| `[../escape]` in a loaded file | Stored as a literal `../` folder under the entry's path. `[/abs]` is rejected | A repo file can't write outside its `path` |
| `dconf dump /org/gnome` | `error: dconf dir must end with a slash` | `path` must end in `/`, checked up front |
| `dconf dump /nothing/` | Exit 0, no output | Empty dump means "no settings", not a failure |
| `leak-scan.sh` over the candidate dumps | One `email` hit: `clipboard-history@jayeshbarman.github.io` in `enabled-extensions` | An extension UUID has the shape of an address. Without step 6 this file can't be committed |
| Cached-value check and `grep` for the username over the candidates | No hits | No `sanitizeRules` needed today. Decision 5 |
| `/org/gnome/settings-daemon/plugins/color/` | `night-light-last-coordinates` holds this machine's latitude and longitude | Never synced. The leak scan can't see coordinates, so decision 1 stops them |
| `/org/gnome/portal/filechooser/code_code/` | `last-folder-path` holds a real home path | Never synced |
| `gsettings list-keys org.gnome.shell` | Has `command-history`, `looking-glass-history`, `last-selected-power-profile` | They're unset today but would enter a public repo unreviewed under a whole-tree dump. Decision 1 |
| Tiling Assistant source (`focusHint.js:25`, `extension.js:47`) | `focus-hint-color` is generated from the theme. `overridden-settings`, and the mutter keys it covers, are written by the extension | The roadmap's `tiling-assistant` item and `/org/gnome/mutter/` hold no choice of yours, so they're dropped |
| Dconf subtree for `clipboard-history` | None: every setting is at its default | The roadmap's item comes down to `enabled-extensions`. The code itself is 76 KB from GitHub with a compiled schema, so it goes to phase 6 |
| `~/gnome-workspace-keys-restore.sh` | Sets `<Super>Page_Up` **and** `<Control><Alt>Up`; the live keys have only `<Super>Page_Up` | Phase 4 said the dump "covers" this script. It doesn't: they differ. Decision 6 |
| `/org/gnome/desktop/notifications/`, `app-folders/` | Only generated `application-id` lists and Ubuntu's stock folders | Not synced |
| Engine: `check_paths`, `report_orphans`, `Assert-SafePaths` | All assume every entry has a `localPath` or is `file`/`dir` | Steps 2 and 3. A Linux-only entry stops the Windows engine unless PowerShell learns the type |
| `tests/linux/engine.sh` | Exports `XDG_CONFIG_HOME=/nonexistent` and inherits the real session bus | Real-config cases must not reach `dconf load`; the guard covers it, and step 1 gives dconf cases their own bus |
| The repo | Public | Decision 1 |

## What gets synced

Ten entries under `dotfiles/linux/gnome/dconf/`. All `"platform": "linux"`.

| `path` | File | `keys` | Holds today |
|---|---|---|---|
| `/org/gnome/desktop/interface/` | `interface.ini` | none | Accent, dark scheme, GTK and icon theme |
| `/org/gnome/desktop/input-sources/` | `input-sources.ini` | `sources`, `xkb-options`, `per-window` | `latam` layout |
| `/org/gnome/desktop/wm/keybindings/` | `wm-keybindings.ini` | none | Workspace shortcuts |
| `/org/gnome/desktop/privacy/` | `privacy.ini` | none | Problem reporting off |
| `/org/gnome/desktop/session/` | `session.ini` | none | Screen blank delay |
| `/org/gnome/settings-daemon/plugins/power/` | `power.ini` | none | Dimming, no sleep on AC |
| `/org/gnome/shell/` | `shell.ini` | `favorite-apps`, `enabled-extensions`, `disabled-extensions`, `keybindings/*` | Dock, extensions, `<Super>m` |
| `/org/gnome/Ptyxis/` | `ptyxis.ini` | Every preference except `window-size` (step 7), `Profiles/*` | Font, profile |
| `/org/gnome/nautilus/preferences/` | `nautilus.ini` | none | Default view |
| `/org/gtk/gtk4/settings/file-chooser/` | `file-chooser.ini` | `show-*`, `sort-directories-first` | Hidden files, folders first |

Left out on purpose:

| Path or key | Why |
|---|---|
| `settings-daemon/plugins/color/` | Holds coordinates. Night Light isn't configured, so nothing is lost |
| `portal/filechooser/`, `control-center/`, `nautilus/window-state/`, `app-picker-layout`, `window-size` | Window state and history |
| `apps/update-manager/`, `com/ubuntu/update-notifier/`, `net/nokyan/Resources/`, `evolution-data-server/`, `shell/world-clocks/`, `shell/extensions/ding/`, `welcome-dialog-last-shown-version` | Generated state, nothing set by hand |
| `shell/extensions/tiling-assistant/`, `mutter/`, `mutter/keybindings/` | Written by the extension when it starts |
| `desktop/notifications/`, `desktop/app-folders/`, `desktop/peripherals/keyboard/` | Generated lists, stock folders, and the live Num Lock state |
| `system/location/` | Decision 7 |
| `settings-daemon/plugins/media-keys/` | Empty here, so there's nothing to save. `docs/configuration.md` shows how to add it |

## The entry format

```json
{
  "repoPath": "dotfiles/linux/gnome/dconf/shell.ini",
  "path": "/org/gnome/shell/",
  "type": "dconf",
  "platform": "linux",
  "description": "Dock favorites, extensions, shell shortcuts",
  "keys": ["favorite-apps", "enabled-extensions", "disabled-extensions", "keybindings/*"]
}
```

| Field | Rule |
|---|---|
| `type` | `"dconf"`. `file` and `dir` keep their meaning |
| `path` | A dconf folder: starts and ends with `/`, at least one segment, letters, digits, `.`, `_`, `-`, no `..` segment. `/` alone is refused, so nobody dumps the whole database by accident |
| `platform` | Must be `linux` |
| `repoPath` | One `.ini` file, under `dotfiles/linux/`. Export owns it, so it's byte for byte what `dconf dump` prints, filtered by `keys` |
| `keys` | Optional, a non-empty list. A pattern is a shell glob matched against the key's name relative to `path`: `font-name`, or `Profiles/abc/label` in a subfolder. `*` also matches `/`. Without `keys`, the whole subtree goes |
| `localPath`, `sanitizeRules`, `detectLinkedPaths` | Not allowed (lint fails) |

**Export** dumps `path`, applies `keys`, and compares bytes with the repo file:

| Case | Status | Note |
|---|---|---|
| `dconf` isn't installed | `SKIPPED` | `dconf not installed` |
| Nothing left after `keys` | `SKIPPED` | `no settings under <path>`; a repo file stays as it is |
| Repo file missing | `ADDED` | |
| Same text | `UNCHANGED` | |
| Different text | `MODIFIED` | |
| `dconf dump` fails | `ERROR` | `dconf dump failed` |

**Import** loads the repo file into `path`:

| Case | Status | Note |
|---|---|---|
| Repo file missing | `SKIPPED` | `not found in repo` |
| `dconf` isn't installed | `SKIPPED` | `dconf not installed` |
| `HOME` isn't the login home | `SKIPPED` | `HOME is not the login home; dconf left alone` |
| Nothing set under `path` yet | `CREATED` | No prompt, no backup |
| Every repo key already has that value | `UNCHANGED` | Nothing is loaded |
| Different, overwrite accepted | `UPDATED` | `backup saved as <file>.bak` |
| Different, answered no | `SKIPPED` | `user skipped` |
| Dump, backup or load fails | `ERROR` | `dconf dump failed`, `cannot create backup`, `dconf load failed` |

The prompt is the usual one with the path as the name: `Overwrite /org/gnome/shell/? [Y/n]`.

## Decisions to confirm in review

1. **`keys` is an allowlist, not an exclude list.** With a public repo, a setting nobody named must stay out by default.
   An exclude list catches new settings automatically, but `command-history` would reach a commit the first time it's
   set, and the leak scan can't recognize coordinates or shell history. The cost: a new preference in a filtered entry isn't
   exported until its key is added. Entries without `keys` are narrow folders that hold only preferences.
2. **Import won't load dconf when `HOME` isn't the login home.** It compares `$HOME` with `getent passwd`. Tests get past
   the guard with a fake `getent` on `PATH` and a private bus, so the engine has no test-only variable, and a real bus
   never pairs with a fake home.
3. **Import merges; it never resets.** That matches "import never deletes". A key the repo doesn't name stays, and it
   doesn't count as a difference. So a key you reset to its default on one machine doesn't reset on another: it
   disappears from the repo file, and the other machine keeps its old value. With one Linux machine this only touches a
   restore, where nothing is set yet.
4. **The backup lives in `~/.local/state/sync-settings/dconf/<file>.bak`.** There's no local file to sit next to. It holds
   the raw dump of `path`, written before each `UPDATED`. Loading it back restores old values, but keys that had no
   value stay at the repo's value; `docs/sync-contract.md` says so.
5. **No `sanitizeRules` on dconf entries for now.** Nothing needs them, and a future home path stops at the leak scan.
6. **The live shortcuts win over `~/gnome-workspace-keys-restore.sh`.** The repo records `<Super>Page_Up` and friends
   without the `<Control><Alt>` arrows. The script stays in your home folder, unsynced. If you want the arrow shortcuts
   back, run it before step 7, and the export picks them up.
7. **`system/location/` stays out.** It's on here, but restoring it would turn location on without the question a fresh
   install asks. `report-technical-problems` is in, because that restore only keeps data on the machine.
8. **The extension's code goes to phase 6**, in a new `packages/linux/gnome-extensions.txt`, and `dconf-cli` joins
   `apt.txt`. Until then a restored `enabled-extensions` names an extension that isn't installed, and GNOME Shell ignores
   it. Copying it as a `dir` entry would put third-party code and a compiled schema in the repo.
9. **`ci.yml` installs `dconf-cli` and `dbus`, so this PR needs your `reviewed` label.** A fake `dconf` would only test my
   assumptions about it, and this phase's riskiest findings came from the real one. The dconf cases fail, rather than
   skip, when the tools are missing.

## Shared rules

- Branch `feat/dconf`, one commit per step, one draft PR opened at step 1 and marked ready at step 11. Commits carry the
  `Plan-Step` and `Route` trailers.
- From step 1 on, each step lands with `git push`, then `gh run watch` on the `ci` run. A red job counts as a rejection.
- Workers use `tests/fixtures/user-values.json` only. They never open, copy or print `.user-values.json`, never read the real
  home, and never run `dconf` outside `on_test_bus`. Steps that read the real database are `[inline]`.
- No case runs `dconf load` or `dconf write` on the real session bus. A reviewer greps each diff for those commands.
- `bash` code follows the repo's rules: byte-exact text through `read_text`/`write_text`, entries on another fd in any loop
  that prompts.
- An engine change updates `docs/sync-contract.md`; that happens once, in step 10, because the steps before it build one feature.

## What verifies each step

| Step | Local | CI | Real desktop |
|---|---|---|---|
| 1 Test bus | `engine.sh dconf` | `engine-linux` with the new packages | Hash unchanged |
| 2 Validation, bash and lint | `engine.sh`, shellcheck | `lint`, `engine-linux` | none |
| 3 Validation, PowerShell | parse only | `engine-windows` | none |
| 4 Export | `engine.sh dconf` | `engine-linux` | none |
| 5 Import | `engine.sh dconf` | `engine-linux` | Hash unchanged |
| 6 Leak scan | `engine.sh leak` | `leak-scan`, `engine-linux` | none |
| 7 Real entries | `./sync preview`, full diff | all | Read only |
| 8 Round trip, bash | `engine.sh real-config` | `engine-linux` | Hash unchanged |
| 9 Round trip, PowerShell | none | `engine-windows` | none |
| 10 Docs | read through | `lint` | none |
| 11 Verify | all | all | Hash unchanged |
| 12 This machine | manual | none | Manual |

"Hash unchanged" means `sha256sum ~/.config/dconf/user` matches before and after, run by the main session. Don't change a
desktop setting during that step. If the hash moved with no engine involved, GNOME wrote it; run the step again.

## Steps

### 1. A private session bus for tests `[worker:low]`

Files: `tests/linux/engine.sh`, `.github/workflows/ci.yml`.

In `ci.yml`, as the first step of `engine-linux` after checkout:

```yaml
      - name: Install dconf
        run: sudo apt-get update && sudo apt-get install -y dconf-cli dbus
```

In `engine.sh`, after `run_engine_input`:

```bash
# dconf writes go over the session bus, not through $HOME, so every dconf case
# runs on its own bus. The fake getent makes $t/home the login home for the engine.
setup_dconf_bus() {
    command -v dconf > /dev/null || fail 'dconf is not installed (dconf-cli)'
    command -v dbus-run-session > /dev/null || fail 'dbus-run-session is not installed (dbus)'
    mkdir -p "$t/bin" "$t/home"
    cat > "$t/bin/getent" <<EOF
#!/bin/sh
printf 'x:x:%s:%s::%s:/bin/bash\n' "$(id -u)" "$(id -g)" "$t/home"
EOF
    chmod +x "$t/bin/getent"
}

on_test_bus() {
    PATH="$t/bin:$PATH" HOME="$t/home" XDG_CONFIG_HOME="$t/home/.config" XDG_RUNTIME_DIR="$t" \
        dbus-run-session -- "$@"
}

# run_engine on the private bus, with stdin from the given file.
run_engine_bus() {
    local input=$1 script=$2
    shift 2
    rc=0
    (cd "$t/repo" && on_test_bus "./$script" "$@" < "$input") > "$out" 2>&1 || rc=$?
}

# Seed the private bus: load ini text from stdin under a dconf path.
dconf_seed() {
    on_test_bus dconf load "$1"
}
```

New case `dconf-test-bus`, in the case list and the `case` statement:

| Check | Expected |
|---|---|
| `printf '[/]\nkey=1\n' \| dconf_seed /test/app/`, then `on_test_bus dconf read /test/app/key` | `1` |
| `$t/home/.config/dconf/user` | Exists |
| `sha256sum` of `$HOME/.config/dconf/user`, taken before and after inside the case, if the file exists | Same |

Test: `tests/linux/engine.sh dconf` passes; `git status --short` shows only the two files; the hash is unchanged. The
full suite still passes on CI, where the case proves the packages installed.

### 2. Validate dconf entries, bash and lint `[worker]`

Files: `scripts/linux/sync.sh`, `scripts/ci/check-config.sh`, `tests/linux/engine.sh`.

Write the cases first.

`sync.sh`:

- `check_paths`: the first loop selects entries with `.type != "dconf"`. A second loop handles dconf entries: `repoPath`
  through `path_is_safe … repo` with `path_fail`, then this check:

  ```bash
  dconf_fail() {
      printf 'ERROR: sync-config.json: entry %s needs "platform": "linux" and a dconf path like /org/gnome/shell/.\n' "$1" >&2
      exit 1
  }
  ```

  Valid: `.platform == "linux"`, `path` matches `^(/[A-Za-z0-9._-]+)+/$`, and `path` doesn't contain `/../`.
- Line 89 and line 416: `(.type // "file") == "file"` becomes `.type != "dir"`, so a dconf entry owns its `repoPath`, and
  a symlink at it names the entry.

`check-config.sh`, in the `$bad` list. Keep the existing rules, and:

- The first rule asks for `localPath` only when `.type != "dconf"`.
- The `type` rule also accepts `"dconf"`.
- `select(.type == "dconf")` fails on: platform not `linux`; has `localPath`, `sanitizeRules` or `detectLinkedPaths`; `path`
  failing the regex above, or holding `/../`.
- `select(.type != "dconf")` fails on having `path` or `keys`.
- `select(has("keys"))` fails unless `keys` is a non-empty array of strings.

Use `add_entry` with `{"repoPath":"dotfiles/linux/dconf/app.ini","path":"/test/app/","type":"dconf","platform":"linux"}` as
the valid base. Engine cases use `assert_path_stop` when they expect a stop.

| Case | Change to the base entry | Expected |
|---|---|---|
| `dconf-config-valid` | none | `export.sh` and `import.sh --force` exit 0, no `unsafe path`, no `dconf path` line |
| `dconf-path-missing` | no `path` | Both stop with the `dconf_fail` line, exit 1, no file written |
| `dconf-path-relative` | `org/gnome/` | Same |
| `dconf-path-no-slash` | `/org/gnome` | Same |
| `dconf-path-root` | `/` | Same |
| `dconf-path-double-slash` | `/org//gnome/` | Same |
| `dconf-path-dotdot` | `/org/../etc/` | Same |
| `dconf-path-space` | `/org/gno me/` | Same |
| `dconf-platform-common` | `"platform": "common"` | Same |
| `dconf-platform-windows` | `"platform": "windows"` | Same |
| `dconf-repo-unsafe` | `"repoPath": "dotfiles/../app.ini"` | Stops with `has an unsafe path.` |
| `dconf-symlink-named` | a symlink at `repoPath` | The unsafe path line names `dotfiles/linux/dconf/app.ini` |
| `dconf-orphan-owned` | a file at `repoPath` | Export prints no `ORPHAN` line for it |
| `lint-dconf-ok` | none | `check-config.sh` exits 0 |
| `lint-dconf-path` | `/org/gnome` | Exit 1, names the entry |
| `lint-dconf-root` | `/` | Exit 1, names the entry |
| `lint-dconf-platform` | `"platform": "common"` (with a `dotfiles/common/` repoPath) | Exit 1, names the entry |
| `lint-dconf-localpath` | adds `"localPath": "~/x"` | Exit 1, names the entry |
| `lint-dconf-rules` | adds `"sanitizeRules": []` | Exit 1, names the entry |
| `lint-dconf-linked` | adds `"detectLinkedPaths": true` | Exit 1, names the entry |
| `lint-dconf-keys-empty` | `"keys": []` | Exit 1, names the entry |
| `lint-dconf-keys-type` | `"keys": "font-name"` | Exit 1, names the entry |
| `lint-keys-on-file` | a `file` entry with `keys` | Exit 1, names the entry |
| `lint-path-on-dir` | a `dir` entry with `path` | Exit 1, names the entry |
| `lint-type-unknown` | `"type": "gsettings"` | Exit 1, names the entry |

Test: `tests/linux/engine.sh` green; `scripts/ci/check-config.sh` prints OK on the real config; shellcheck clean. In the
review, break the `/../` check and see `dconf-path-dotdot` fail.

### 3. Validate dconf entries, PowerShell `[worker]`

Files: `scripts/windows/SyncHelpers.ps1`, `tests/windows/Engine.Tests.ps1`.

The Windows engine never runs these entries, but it checks every entry, so it has to know the type.

- `Assert-SafePaths`: `repoPath` is always checked. If the entry has `type -eq 'dconf'` (through `PSObject.Properties`, like
  the code around it), skip the `localPath` check and instead require `platform -ceq 'linux'`, `path -cmatch
  '^(/[A-Za-z0-9._-]+)+/$'` and `path -cnotlike '*/../*'`. Otherwise throw:

  ```text
  sync-config.json: entry {0} needs "platform": "linux" and a dconf path like /org/gnome/shell/.
  ```

- `Get-OwningRepoPath` and the orphan report already treat any non-`dir` entry as owning its `repoPath`. Leave them alone.

Use `Add-FixtureEntry` and `Assert-PathStop`, same base entry as step 2.

| Case | Change | Expected |
|---|---|---|
| `dconf-entry-ignored` | base entry, and a file at `repoPath` | `Export-Settings.ps1` and `Import-Settings.ps1 -Force` exit 0; the output doesn't mention `app.ini`, and has no `ORPHAN` for it |
| `dconf-path-missing` | no `path` | Both stop with the message, exit 1, no file written |
| `dconf-path-no-slash` | `/org/gnome` | Same |
| `dconf-path-root` | `/` | Same |
| `dconf-path-dotdot` | `/org/../etc/` | Same |
| `dconf-platform-common` | `"platform": "common"` | Same |
| `dconf-repo-unsafe` | `"repoPath": "dotfiles/../app.ini"` | Stops with `has an unsafe path.` |

Test: CI `engine-windows` green, and the seven cases show in the job's log. `pwsh` can only parse the files here.

### 4. Export `[worker:high]`

Files: `scripts/linux/sync.sh`, `export.sh`, `tests/linux/engine.sh`.

In `sync.sh`, a new section before `# -- Status output`:

```bash
# -- dconf ----------------------------------------------------------------------

# Keep the keys of a dump (stdin) that match an entry's "keys" patterns. A key's
# name is relative to the entry's path. The output keeps dconf's layout: a blank
# line between sections, and no section left without keys.
dconf_filter() {
    local -a patterns=()
    local line rel pattern section='' pending=0 first=1
    mapfile -d '' patterns < <(jq -j '.[] | ., "\u0000"' <<<"$1")
    while IFS= read -r line; do
        case $line in
            '') continue ;;
            '['*']') section=${line:1:-1}; pending=1; continue ;;
        esac
        rel=${line%%=*}
        [[ $section == / ]] || rel=$section/$rel
        for pattern in "${patterns[@]}"; do
            # shellcheck disable=SC2053  # pattern is a glob on purpose
            if [[ $rel == $pattern ]]; then
                if (( pending )); then
                    (( first )) || printf '\n'
                    printf '[%s]\n' "$section"
                    pending=0
                    first=0
                fi
                printf '%s\n' "$line"
                break
            fi
        done
    done
}
```

In `export.sh`, after `export_dir`, and dispatch on `dconf` in the main loop:

```bash
export_dconf() {
    local entry=$1
    local repo_path dconf_path repo_file repo_dir keys text repo_text
    repo_path=$(jq -r '.repoPath' <<<"$entry")
    dconf_path=$(jq -r '.path' <<<"$entry")
    keys=$(jq -c '.keys // []' <<<"$entry")
    repo_file=$REPO_ROOT/$repo_path

    if ! command -v dconf > /dev/null; then
        status SKIPPED "$repo_path" 'dconf not installed'
        SKIPPED=$((SKIPPED + 1))
        return 0
    fi

    if ! text=$(dconf dump "$dconf_path" 2>/dev/null && printf x); then
        status ERROR "$repo_path" 'dconf dump failed'
        return 0
    fi
    text=${text%x}
    if [[ $keys != '[]' ]]; then
        text=$(dconf_filter "$keys" <<<"$text"; printf x)
        text=${text%x}
    fi

    if [[ -z $text ]]; then
        status SKIPPED "$repo_path" "no settings under $dconf_path"
        SKIPPED=$((SKIPPED + 1))
        return 0
    fi

    # then, as in process_entry: mkdir -p the repo folder; a missing repo file is ADDED;
    # read_text + a byte compare gives UNCHANGED, or write_text and MODIFIED.
}
```

Each case below starts with `new_tmp`, `setup_repo`, `setup_home_fixture`, `setup_repo_fixture`, `setup_dconf_bus`, adds the base
entry from step 2, seeds what it says, and runs `run_engine_bus /dev/null export.sh`.

| Case | Seed and action | Expected |
|---|---|---|
| `dconf-export-adds` | `[/]`, `a=1` | `ADDED`; the repo file equals `dconf dump /test/app/` byte for byte |
| `dconf-export-unchanged` | Run export twice | Second run `UNCHANGED`, repo file hash unchanged |
| `dconf-export-modifies` | Export, `dconf write /test/app/a 2`, export | `MODIFIED`, the file has `a=2` |
| `dconf-export-keys` | Entry with `"keys":["keep","sub/*"]`; seed `keep=1`, `drop=2`, `[sub]` `x=3`, `[other]` `y=4` | File is exactly `[/]\nkeep=1\n\n[sub]\nx=3\n` |
| `dconf-export-keys-no-root` | `"keys":["sub/*"]`, same seed | File is exactly `[sub]\nx=3\n` |
| `dconf-export-keys-nested` | `"keys":["sub/*"]`, seed `[sub/deep]` `z=1` | File has `[sub/deep]` and `z=1`: `*` crosses `/` |
| `dconf-export-keys-glob` | `"keys":["show-*"]`, seed `show-hidden=true`, `shown=1` | File has `show-hidden`, not `shown` |
| `dconf-export-keep-all` | `"keys":["*"]`, three sections | File equals the raw dump byte for byte |
| `dconf-export-no-settings` | Seed nothing | `SKIPPED` with `no settings under /test/app/`, no repo file |
| `dconf-export-no-settings-keeps-repo` | Repo file exists, seed nothing | `SKIPPED`, repo file hash unchanged |
| `dconf-export-keys-empty-result` | Repo file exists, `"keys":["absent"]`, seed `a=1` | `SKIPPED`, repo file hash unchanged |
| `dconf-export-missing-tool` | `PATH` of symlinks without `dconf`, like `sync-missing-tool`, no bus | `SKIPPED` with `dconf not installed`, exit 0 |
| `dconf-export-fails` | A `dconf` stub in `$t/bin` that exits 1 | `ERROR` with `dconf dump failed`, exit 0, and the fixture's later entries still print a status |
| `dconf-preview-read-only` | Commit a repo file, change a key, run `export.sh --preview` | The diff shows the key, `tree_hash` of the repo and of `$t/home` unchanged |

Test: `tests/linux/engine.sh dconf` green; full suite green; shellcheck clean. Change `dconf_filter` so it keeps empty sections
and see `dconf-export-keys` fail.

### 5. Import `[worker:high]`

Files: `scripts/linux/sync.sh`, `import.sh`, `tests/linux/engine.sh`.

In the `sync.sh` dconf section:

```bash
# dconf writes go over the session bus to a service that keeps the login
# session's HOME, so a throwaway HOME would still change the real desktop.
dconf_home_ok() {
    [[ $HOME == "$(getent passwd "$(id -u)" | cut -d: -f6)" ]]
}

# One "[section] key=value" line per key, so two dumps compare key by key.
dconf_flat() {
    awk '/^\[.*\]$/ { s = $0; next } NF { print s " " $0 }'
}

# Keys in the repo file ($1) that the dump ($2) doesn't have with that value.
# Keys only the dump has don't count: dconf load leaves them alone.
dconf_unapplied() {
    LC_ALL=C comm -23 <(dconf_flat < "$1" | LC_ALL=C sort) <(dconf_flat <<<"$2" | LC_ALL=C sort)
}
```

In `import.sh`, after `import_dir`, and dispatch on `dconf` in the main loop. The loop already reads entries on fd 3, so the
prompt reads stdin:

```bash
import_dconf() {
    local entry=$1
    local repo_path dconf_path repo_file current answer backup_dir backup
    repo_path=$(jq -r '.repoPath' <<<"$entry")
    dconf_path=$(jq -r '.path' <<<"$entry")
    repo_file=$REPO_ROOT/$repo_path

    # In this order: repo file missing, dconf missing, dconf_home_ok fails. Each is a
    # SKIPPED line from the table in the plan, and SKIPPED=$((SKIPPED + 1)).

    if ! current=$(dconf dump "$dconf_path" 2>/dev/null); then
        status ERROR "$repo_path" 'dconf dump failed'
        return 0
    fi

    if [[ -n $current ]]; then
        if [[ -z $(dconf_unapplied "$repo_file" "$current") ]]; then
            status UNCHANGED "$repo_path"
            return 0
        fi
        # Same prompt as a file, with $dconf_path as the name. Answering no is SKIPPED 'user skipped'.
        backup_dir=$HOME/.local/state/sync-settings/dconf
        backup=$backup_dir/${repo_path##*/}.bak
        if ! mkdir -p "$backup_dir" || ! printf '%s\n' "$current" > "$backup"; then
            status ERROR "$repo_path" 'cannot create backup'
            return 0
        fi
    fi

    if ! dconf load "$dconf_path" < "$repo_file" 2>/dev/null; then
        status ERROR "$repo_path" 'dconf load failed'
        return 0
    fi
    # UPDATED with the backup note if $current was set, CREATED if not. APPLIED=$((APPLIED + 1)).
}
```

Each case seeds the bus, writes the repo file, and uses `run_engine_bus <file> import.sh` with an answer file, unless it says
otherwise.

| Case | Setup | Expected |
|---|---|---|
| `dconf-import-creates` | Empty database, repo `a=1` | `CREATED`, no `Overwrite` prompt, no backup, `dconf read` gives `1` |
| `dconf-import-unchanged` | Database equals the repo | `UNCHANGED`, and `$t/home/.config/dconf/user` hash unchanged |
| `dconf-import-local-extra` | Database has the repo's keys plus `extra=1` | `UNCHANGED`, `extra` still there |
| `dconf-import-update-yes` | Local `a=1`, repo `a=2`, answer `y` | Prompt names `/test/app/`; `UPDATED` with `backup saved as app.ini.bak`; `a` is `2`; the backup has `a=1` |
| `dconf-import-update-no` | Same, answer `n` | `SKIPPED` with `user skipped`, `a` stays `1`, no backup |
| `dconf-import-force` | Same, `--force` | No prompt, `UPDATED`, backup written |
| `dconf-import-eof` | Same, stdin `/dev/null`, no `--force` | `UPDATED`, as for files |
| `dconf-import-merge` | Local `a=1`, `extra=1`; repo `a=2`, `--force` | `a` is `2`, `extra` is `1` |
| `dconf-import-no-repo-file` | No repo file | `SKIPPED` with `not found in repo` |
| `dconf-import-wrong-home` | Delete `$t/bin/getent`, so the real one answers; repo `a=1` on the private bus | `SKIPPED` with `HOME is not the login home; dconf left alone`; `a` isn't set; no backup |
| `dconf-import-missing-tool` | `PATH` of symlinks without `dconf`, no bus, repo file present | `SKIPPED` with `dconf not installed`, exit 0 |
| `dconf-import-bad-file` | Repo `a=2`, `bad=notvalid value`; local `a=1`; `--force` | `ERROR` with `dconf load failed`, exit 0, `a` stays `1`, later fixture entries still print a status |
| `dconf-import-prompt-reads-stdin` | Two dconf entries that both differ, answers `n` then `y` | First `SKIPPED`, second `UPDATED`: the answers came from stdin, not the entry list |
| `dconf-roundtrip-values` | Seed `s='x=y'`, `m="it's\nline2"`, `l=['a', 'b']`, `e=@as []`, `u=uint32 3`, `t=(1, 'x')`; export; `mv "$t/home" "$t/old"` and `mkdir "$t/home"` for an empty database; import; dump | The dump equals the repo file byte for byte |
| `dconf-roundtrip-settles` | Export, import, export, import | Last export `UNCHANGED`, last import `UNCHANGED`, no backup |

Test: `tests/linux/engine.sh dconf` green; full suite green; shellcheck clean; the real hash unchanged. Remove the
`dconf_home_ok` call and see `dconf-import-wrong-home` fail on its private bus.

### 6. Extension UUIDs aren't addresses `[worker:low]`

Files: `scripts/ci/leak-scan.sh`, `tests/linux/engine.sh`.

In `scan_email`, right after `text=${rest#*:}`, exempt only the two extension lists in dconf files:

```bash
        file=${hit%%:*}
        # Extension UUIDs look like addresses; only these two keys hold them.
        if [[ $file == *dotfiles/linux/gnome/dconf/*.ini && $text =~ ^(enabled|disabled)-extensions= ]]; then
            continue
        fi
```

Declare `file` in the function's `local` line. The leading `*` also covers `after/dotfiles/…` in a preview.

Cases, each writing one file under `$t` and running the scan on it. Addresses built with `@` stay in `engine.sh`, which
the scan doesn't cover.

| Case | File | Line | Expected |
|---|---|---|---|
| `leak-extension-enabled` | `dotfiles/linux/gnome/dconf/shell.ini` | `enabled-extensions=['clip@someone.github.io']` | Exit 0 |
| `leak-extension-disabled` | same | `disabled-extensions=['ding@rastersoft.com']` | Exit 0 |
| `leak-email-other-key` | same | `label='person@gmail.com'` | Exit 1, `email` |
| `leak-email-other-file` | `dotfiles/linux/tool/shell.ini` | `enabled-extensions=['person@gmail.com']` | Exit 1, `email` |
| `leak-email-other-suffix` | `dotfiles/linux/gnome/dconf/shell.txt` | `enabled-extensions=['person@gmail.com']` | Exit 1, `email` |

Test: `tests/linux/engine.sh leak` green; `scripts/ci/leak-scan.sh` clean on the real repo; shellcheck clean.

### 7. The real entries `[inline: reads the real dconf]`

Files: `sync-config.json`, `dotfiles/linux/gnome/dconf/`.

Add the ten entries from [What gets synced](#what-gets-synced), with a `description` each. The Ptyxis `keys`, from `gsettings
list-keys org.gnome.Ptyxis`:

```json
["audible-bell", "cursor-blink-mode", "cursor-shape", "default-columns", "default-profile-uuid", "default-rows",
 "disable-padding", "enable-a11y", "enable-zoom-scroll-ctrl", "font-name", "ignore-osc-title", "inhibit-logout",
 "interface-style", "new-tab-position", "profile-uuids", "prompt-on-close", "restore-session", "restore-window-size",
 "scrollbar-policy", "tab-middle-click", "text-blink-mode", "toast-on-copy-clipboard", "use-system-font", "visual-bell",
 "visual-process-leader", "word-char-exceptions", "Profiles/*"]
```

Run `./sync preview`, then `./export.sh`, and read the whole diff. The repo is public.

Test:

1. `git status --short` lists only `sync-config.json` and ten `.ini` files.
2. `scripts/ci/leak-scan.sh` clean; `grep -rl "$HOME" dotfiles` prints nothing; `scripts/ci/check-config.sh` OK.
3. `grep -rEl 'coordinates|command-history|looking-glass|last-folder|^window-size|app-picker' dotfiles/linux/gnome/dconf`
   prints nothing.
4. `dconf dump /org/gnome/desktop/wm/keybindings/` equals `wm-keybindings.ini` byte for byte.
5. The cached-value check, without printing values, finds nothing in the ten files.
6. After the commit, resize a Ptyxis window, open a file dialog and change its width, open the app grid and drag an app.
   `./sync preview` still prints that nothing would change.

### 8. Round trip covers dconf, bash `[worker]`

Files: `tests/linux/engine.sh`.

Extend `real-config-roundtrip`. It runs without a private bus, so the guard must hold:

| Check | Expected |
|---|---|
| Import, each of the ten `repoPath`s | `SKIPPED` with `HOME is not the login home; dconf left alone` |
| Export, each of the ten | `SKIPPED` with `no settings under <path>` |
| `$t/home/.local/state/sync-settings` | Doesn't exist |

New case `real-config-dconf-restore`: as `real-config-roundtrip` for the repo and fake values, plus `setup_dconf_bus`, on the
private bus:

| Check | Expected |
|---|---|
| First `import.sh --force`, each of the ten | `CREATED` |
| `on_test_bus dconf read /org/gnome/desktop/wm/keybindings/switch-to-workspace-up` | The value in `wm-keybindings.ini` |
| Each `.ini`: every line that holds a key, checked with `grep -Fqx` against the dump of its `path` | All found |
| Second `import.sh` | All ten `UNCHANGED` |
| `export.sh` | All ten `UNCHANGED`, `Repo is up to date`, `diff -r` of `dotfiles` empty |

Test: `tests/linux/engine.sh real-config` green; the real hash unchanged; change an expected value locally and see it fail, then
put it back.

### 9. Round trip covers dconf, PowerShell `[worker]`

Files: `tests/windows/Engine.Tests.ps1`.

`path-real-config` already reads the real config, so step 7 covers parsing. In `real-config-roundtrip`:

- After import and after export, the output doesn't match `dconf`.
- No `ORPHAN` line: the existing check stays, and now also covers `dotfiles/linux/gnome/dconf/`.

Test: CI `engine-windows` green, and the case shows in the job's log.

### 10. Docs `[inline: user-facing copy]`

Files: `docs/sync-contract.md`, `docs/configuration.md`, `docs/layout.md`, `docs/daily-workflow.md`, `README.md`, `CLAUDE.md`,
`docs/plan-restructure.md`.

- `docs/sync-contract.md`:
  - Path safety: the dconf rule and its message.
  - Export and Import status tables: the dconf rows.
  - Backups: the state folder, and what loading a backup can't undo.
  - New section "dconf entries": merge semantics, the login-home guard and why, `keys`, no `sanitizeRules`.
  - Orphan report: a dconf entry owns its `repoPath`.
  - Known differences and Parity: dconf entries are bash only; PowerShell validates them and doesn't run them.
- `docs/configuration.md`: fields in the table, a `type: dconf` section with the example, how to choose `keys` (a warning
  that a filtered entry won't pick up a new key, and that `color/` holds coordinates), how to add a path such as
  `media-keys`, and how to read a key's real name with `dconf watch /`.
- `docs/layout.md`: the tree gains `gnome/dconf/`. New section "Which dconf settings are synced", from
  [What gets synced](#what-gets-synced).
- `docs/daily-workflow.md`: a theme change or a pinned app shows in preview as an `.ini` diff, and this is normal.
- `README.md`: the list of what's synced gains GNOME settings, and the requirements gain `dconf-cli`.
- `CLAUDE.md`:
  - Project purpose: GNOME settings.
  - Patterns: a `dconf` entry type.
  - The Testing bullet warns that a throwaway `HOME` doesn't isolate `dconf load`, that the guard covers import, and
    that dconf cases run on `on_test_bus`.
  - The "Claude auto-approval" section is untouched.
- `docs/plan-restructure.md`:
  - Inventory: the dconf row is done, and names what changed: `tiling-assistant` dropped, the extension's code moved.
  - Phase 6 gains `packages/linux/gnome-extensions.txt` (`clipboard-history` from its GitHub repo, schema compile included) and
    `dconf-cli` in `apt.txt`.
  - Phase 7 gains: import must run inside the graphical session, because `dconf load` needs the session bus; from a text
    console each dconf entry reports `ERROR`.

Test: read through; every link in the changed docs resolves; `grep -n dconf README.md CLAUDE.md` shows the new lines.

### 11. Verify and PR `[inline: final review]`

1. `tests/linux/engine.sh` green with the real config; shellcheck clean; `scripts/ci/check-config.sh` OK;
   `scripts/ci/leak-scan.sh` clean; `grep -rl "$HOME" dotfiles` prints nothing.
2. `git diff master...HEAD` holds no `dconf load` or `dconf write` outside `import.sh`, `on_test_bus` and `dconf_seed`.
3. Restore in a throwaway clone with a copy of `.user-values.json`: `HOME=$(mktemp -d) ./import.sh --force < /dev/null`
   reports every dconf entry `SKIPPED` with the login-home note, and the real hash is unchanged. Delete the clone.
4. `gh pr ready`. `leak-scan`, `lint`, `engine-linux`, `engine-windows` green.
5. `/agent-skills:review` of the phase diff.
6. **Stop here.** The PR touches `.github/workflows/`, so auto-approval doesn't apply: you add the `reviewed` label.

### 12. Check this machine `[inline: the real desktop]`

After the merge: `git switch master && git pull`.

1. `./sync preview` prints that nothing would change.
2. `./import.sh` from a terminal reports the ten entries `UNCHANGED`, and `~/.local/state/sync-settings` doesn't exist.
3. `gsettings set org.gnome.desktop.interface accent-color 'blue'`, then `./import.sh` and answer `n` to the
   `/org/gnome/desktop/interface/` prompt: `SKIPPED`, the accent stays blue.
4. `./import.sh` again and answer `y`: `UPDATED` with `backup saved as interface.ini.bak`, the accent is orange again, and the
   backup holds `accent-color='blue'`.
5. Delete `~/.local/state/sync-settings`.

## Not in this plan

- Installing the extension and `dconf-cli` (phase 6, added by step 10).
- Running import inside the graphical session during bootstrap (phase 7, added by step 10).
- `docs/restore.md` (phase 7).
- `sanitizeRules` on dconf entries (decision 5).
- Reporting local keys the repo doesn't have, as `EXTRA` does for files. A filtered entry would report every excluded key on
  each import, and the keys that matter already show in preview.
- Deleting `~/gnome-workspace-keys-restore.sh` (decision 6).

## Done when

- The ten entries are in `sync-config.json`, and the leak scan and `grep -rl "$HOME" dotfiles` are clean.
- `./sync preview` stays clean after normal desktop use.
- `HOME=$(mktemp -d) ./import.sh --force < /dev/null` leaves the real dconf database unchanged.
- `real-config-dconf-restore` restores all ten into an empty database on `engine-linux`, and a second import is
  `UNCHANGED`.
- `engine-windows` is green with the dconf entries in the real config.
- `dotfiles/linux/gnome/dconf/` holds no coordinates, shell history, paths or window sizes.
- The roadmap's phases 6 and 7 name what this phase left them.
