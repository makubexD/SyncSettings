# Configuration reference

`sync-config.json` lists every file and folder SyncSettings keeps in the repo, grouped in modules. This page covers each
field and how to add an entry. For what `mksync` does with those fields, see [sync-contract.md](sync-contract.md). For
where a new file belongs, see [layout.md](layout.md).

## File layout

```json
{
  "schemaVersion": 2,
  "excludePatterns": ["*.pem", "*.key", "*.bak", ".env"],
  "modules": {
    "editor": { "description": "Editor defaults" }
  },
  "entries": [
    {
      "file": "editorconfig/.editorconfig",
      "module": "editor",
      "merge": "whole",
      "localPath": "~/.editorconfig",
      "description": "Editor defaults"
    }
  ]
}
```

| Field             | Meaning                                                                                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`   | `2`. A `sync-config.json` with none is an old v1 config: every command stops with `ERROR: sync-config.json: needs schemaVersion 2; this is an old config.`, exit 2. A newer number stops with exit 2 and asks for a newer `mksync` |
| `modules`         | The modules, by name: `description`, and an optional `os` list that every entry of the module gets                                                                                                                                 |
| `entries`         | The entries to sync, processed in this order                                                                                                                                                                                       |
| `excludePatterns` | Files never copied in either direction ([details](#excludepatterns))                                                                                                                                                               |

`mksync` reads `sync-config.v2.json` instead when a clone still has one (a clone from before v1.0.0); see
[the contract](sync-contract.md#config).

## Entry fields

| Field               | Required                       | Meaning                                                                                                                                                                               |
| ------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`              | yes                            | The path under the layer folders (`dotfiles/common/`, `dotfiles/<os>/`, a profile or machine layer), with forward slashes. No trailing slash, also for folders. Unique across entries |
| `module`            | yes                            | The module it belongs to; a profile turns modules on and off                                                                                                                          |
| `merge`             | yes                            | How its layers combine: `whole`, `json`, `import`, `dir` or `dconf` ([details](#merge-types))                                                                                         |
| `localPath`         | yes, except on a `dconf` entry | Where it lives on the machine ([forms](#localpath))                                                                                                                                   |
| `localPaths`        | no                             | Another `localPath` per system, for the same file in another folder ([details](#localpaths))                                                                                          |
| `os`                | no                             | The systems that get it, such as `["linux", "macos"]`; else the module's `os`; else every system ([details](#os))                                                                     |
| `description`       | no                             | A note for people. `mksync` doesn't read it                                                                                                                                           |
| `sanitize`          | no                             | Placeholders that keep private values out of the repo ([details](#sanitize))                                                                                                          |
| `dconfPath`, `keys` | `dconf` entries                | The dconf folder to sync, and which keys to keep ([details](#merge-dconf))                                                                                                            |
| `localOnlyKeys`     | no                             | `json` entries: top-level keys kept from the local file                                                                                                                               |
| `importName`        | `import` entries               | The side file each layer is written to, e.g. `CLAUDE.{layer}.md`                                                                                                                      |
| `linked`            | no                             | `true` on a file that names folders to offer as `dir` entries ([details](#linked))                                                                                                    |
| `elevate`           | no                             | Reserved; only `false` is accepted                                                                                                                                                    |

## `os`

`os` decides which systems get the entry and where its file is written when it is new.

| Effective `os`                         | Runs on                  | New file goes to   | `localPath`                    |
| -------------------------------------- | ------------------------ | ------------------ | ------------------------------ |
| none                                   | Windows, Linux and macOS | `dotfiles/common/` | `~/` form only                 |
| one system, e.g. `["linux"]`           | that system              | `dotfiles/<os>/`   | `~/` form, or an absolute path |
| two systems, e.g. `["linux", "macos"]` | each system listed       | `dotfiles/common/` | `~/` form only                 |

A file in `dotfiles/<os>/` overrides the `dotfiles/common/` one on that system. Use a two-system list for a file two
systems share and the third doesn't have: tmux's config is the same on Linux and macOS. A `dconf` entry runs on Linux
only.

## `localPath`

| Form                      | JSON example             | Works on                   |
| ------------------------- | ------------------------ | -------------------------- |
| `~/` with forward slashes | `"~/.config/git/ignore"` | every system               |
| an absolute path          | `"C:/MakuCustomAlias"`   | the one system in its `os` |

`~` is `$HOME` on Linux and macOS and the profile folder on Windows, where `/` becomes `\` after `~` is expanded. A
`\` anywhere in `localPath` or `localPaths` stops every command with `entry <file> has a backslash in localPath.`, exit
1: write Windows paths with `/` too.

## `localPaths`

For a shared file that lives in another folder on one system. VS Code reads the same `settings.json` from
`~/.config/Code/User` on Linux and `~/Library/Application Support/Code/User` on macOS:

```json
{
  "file": "vscode/settings.json",
  "module": "vscode",
  "merge": "json",
  "localPath": "~/.config/Code/User/settings.json",
  "localPaths": {
    "macos": "~/Library/Application Support/Code/User/settings.json"
  },
  "os": ["linux", "macos"]
}
```

The keys are `linux`, `macos` and `windows`; on a system named here, its value replaces `localPath`. Each value follows
the `localPath` rules. Any other key stops every command with exit code 1.

## `sanitize`

Each rule names a placeholder that stands in for a private value in the repo. Export replaces every occurrence of the
value in the file, and import puts it back, so pick values specific enough not to match unrelated text.

```json
{
  "file": "git/.gitconfig.local",
  "module": "git",
  "merge": "whole",
  "localPath": "~/.gitconfig.local",
  "os": ["windows"],
  "sanitize": [
    {
      "placeholder": "<YOUR_GH_USERNAME>",
      "prompt": "GitHub username",
      "suggest": "gh-login"
    },
    {
      "placeholder": "<GH_CLI_PATH>",
      "prompt": "Path to GitHub CLI executable",
      "default": "C:\\Program Files\\GitHub CLI\\gh.exe",
      "suggest": ["gh-path"],
      "escapeBackslashes": true
    }
  ]
}
```

| Rule field          | Required | Meaning                                                                                                                                    |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `placeholder`       | yes      | The text stored in the repo, such as `<YOUR_NAME>`                                                                                         |
| `prompt`            | yes      | The question shown when the value is needed; `mksync` asks only when nothing else (saved, inferred, `default`, `defaultEnv`) gives a value |
| `default`           | no       | The value offered at the prompt                                                                                                            |
| `defaultEnv`        | no       | Name of an environment variable to offer instead, used when `default` is not set                                                           |
| `escapeBackslashes` | no       | `true` if the file stores the value with doubled backslashes (`C:\\Tools`), as `.gitconfig` does                                           |
| `suggest`           | no       | A source, or a list of sources tried in order, whose answer is shown as the prompt's suggested answer (below)                              |

- `defaultEnv` reads the variable on the machine running the sync. `"defaultEnv": "HOME"` is the home folder on every
  system: `$HOME` on Linux and macOS, `%USERPROFILE%` on Windows with forward slashes (`C:/Users/you`), where `HOME`
  is usually unset. Export also replaces its backslash forms (`C:\Users\you`).
- A placeholder used by several entries has one value, so give two meanings two placeholders. `<YOUR_GH_USERNAME>` is
  the account git signs in with (`[credential] username` in Windows' `.gitconfig.local`); `<YOUR_GH_OWNER>` is the
  owner of your own repos, as `~/.claude/settings.json` names them. On a work machine the two differ.
- `suggest` is one source (`"gh-login"`) or a list of distinct ones (`["gh-hosts-login", "origin-owner"]`). The
  sources run only when push or pull is about to ask, in list order, and the first that answers is the suggestion.
  Each runs without a shell, for at most 5 seconds:

  | Source           | Answer                                                                                             |
  | ---------------- | -------------------------------------------------------------------------------------------------- |
  | `gh-login`       | `gh api user --jq .login` (network)                                                                |
  | `gh-hosts-login` | `gh config get -h github.com user`, the login `gh` saved; no network                               |
  | `origin-owner`   | the owner in the clone's `origin` (`git remote get-url origin`) when it is on `github.com`         |
  | `git-user-name`  | `git config --global user.name`                                                                    |
  | `git-user-email` | `git config --global user.email`                                                                   |
  | `passwd-name`    | your full name up to its first comma (`getent passwd` on Linux, `id -F` on macOS); none on Windows |
  | `gh-path`        | the path of `gh` on `PATH`, found as `mksync doctor` finds it                                      |

  Enter takes the suggestion, shown as `GitHub username (~/.gitconfig.local) [you]:`; end of input never takes it. A
  source that fails, prints nothing, or prints more than one line or a control character doesn't answer, and the next
  one runs. `--yes` (push and pull), `preview` and `diff` never use one, with one exception: a rule with a `default`
  and `gh-path` in its `suggest` takes the found `gh` path in place of the default, without asking, and saves it with
  the machine's values so export sanitizes it; without `gh` on `PATH` the default is used. An empty list, a repeated
  source or any other value stops every command with
  `ERROR: sync-config.json: entry <file> has an invalid suggest.`, exit 1, as an invalid `defaultEnv` does.

- With a machine record, values are saved in the record or the profile ([below](#profiles-and-machines)). Without one,
  they are cached in `.user-values.json`, which is gitignored, with placeholders as keys.
- `mksync push` and `mksync pull` ask for a value nothing fills and save the answer. The question names the files
  that need it (`GitHub username (~/.gitconfig.local):`). An answer that holds a
  placeholder (`<HOME>`) is refused. `preview` and `check` mark a file that needs a missing value `SKIPPED` and carry
  on. With `--yes`, with no input, or in `diff`, a placeholder with no value stops the run with
  `missing value for <PLACEHOLDER>: run mksync push or pull in a terminal to enter it`.
- Export compares the sanitized text, so a change to a value alone (a new email) is not a change. A new line is.
- `sanitize` isn't allowed on a `dir` or `dconf` entry.

## Merge types

Each entry has a `merge` that says how its layers combine ([contract](sync-contract.md#layers)):

| `merge`  | Layers combine as                                                                                                          | Extra fields        |
| -------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `whole`  | the latest layer that holds the file wins, byte for byte                                                                   |                     |
| `json`   | objects merge key by key, a later layer winning; arrays collect items not there yet; export sends each change to its layer | `localOnlyKeys`     |
| `import` | the base text, then one `@import` line per later layer, each layer written beside the local file                           | `importName`        |
| `dir`    | a whole folder, recursively ([details](#merge-dir))                                                                        |                     |
| `dconf`  | one folder of GNOME settings in one `.ini` file ([details](#merge-dconf))                                                  | `dconfPath`, `keys` |

### `merge: dir`

```json
{
  "file": "nvim",
  "module": "editor",
  "merge": "dir",
  "localPath": "~/.config/nvim",
  "description": "Neovim configuration"
}
```

- Export makes the repo folder match the local one, so it deletes repo files that are gone locally. Git keeps the
  history.
- Import never deletes. It lists local files the repo doesn't have as `EXTRA` and keeps them.
- Symlinks are skipped, and `excludePatterns` apply to every file inside.
- `sanitize`, `dconfPath` and `keys` are not allowed on a `dir` entry.
- A `dir` entry can't contain another entry, not even another `dir`.
- A local folder with nothing to sync keeps the repo files: the entry is `SKIPPED` and nothing is deleted.

### `merge: dconf`

Syncs one folder of GNOME settings with one `.ini` file. Linux only. It needs `dconf-cli`.

```json
{
  "file": "gnome/dconf/shell.ini",
  "module": "gnome",
  "merge": "dconf",
  "dconfPath": "/org/gnome/shell/",
  "description": "Dock favorites, extensions, shell shortcuts",
  "keys": [
    "favorite-apps",
    "enabled-extensions",
    "disabled-extensions",
    "keybindings/*"
  ]
}
```

| Field                   | Rule                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `dconfPath`             | Starts and ends with `/`, with letters, digits, `.`, `_` or `-` in its segments and no `..` segment. `/` alone is refused |
| `file`                  | One `.ini` file. Export owns it, so don't edit it by hand                                                                 |
| `localPath`, `sanitize` | Not allowed                                                                                                               |

Import merges the file into the folder: it asks before changing anything, saves a backup, and leaves keys the file
doesn't name. It has to run in a terminal on the desktop, because `dconf load` needs the session bus.
[sync-contract.md](sync-contract.md#dconf-entries-merge-dconf) has the full rules.

#### Choosing `keys`

`keys` is a list of globs matched against a key's name relative to `dconfPath`: `font-name`, or `Profiles/abc/label` in
a subfolder. `*` also matches `/`, so `keybindings/*` covers everything below `keybindings`. Without `keys`, the whole
folder goes.

Leave `keys` out only for a narrow folder that holds nothing but preferences.

> [!WARNING]
> The repo is public, and the leak scan can't recognize coordinates or shell history. Don't sync a folder without
> reading its dump first: `/org/gnome/settings-daemon/plugins/color/` holds your latitude and longitude, and
> `/org/gnome/shell/` can hold `command-history`.

> [!NOTE]
> A filtered entry won't pick up a new key. Add it to `keys`, then push.

#### Adding a dconf folder

To find a key's real name, run `dconf watch /`, change the setting in its app, and read the path it prints. Read the
folder before you add it:

```bash
dconf dump /org/gnome/settings-daemon/plugins/media-keys/
```

Add an entry for it, such as `gnome/dconf/media-keys.ini` with that `dconfPath`, then follow
[Adding an entry](#adding-an-entry). [layout.md](layout.md#which-dconf-settings-are-synced) lists what's synced and
what's left out on purpose.

## `linked`

```json
{
  "file": "shell/.bashrc",
  "module": "shell",
  "merge": "whole",
  "localPath": "~/.bashrc",
  "os": ["windows"],
  "linked": true
}
```

`mksync setup` reads the file for folder paths (`/c/Tools` or `C:\Tools`). Each folder that exists and no entry syncs
yet is offered once as a `dir` entry of its own, such as `shell/MakuCustomAlias` with local folder
`C:/MakuCustomAlias`. System folders and anything under the user profile are ignored
([contract](sync-contract.md#linked-folders)).

## `excludePatterns`

Each pattern is a glob matched against the file name, or against the end of the path. A match is never copied in
either direction, and this applies to files inside `dir` entries too.

Keep `*.bak` in the list. It stops the backups that import writes inside a synced folder from being exported.

## Adding an entry

1. Add the entry to `entries` in `sync-config.json`, with its `file` where [layout.md](layout.md) says, then check the
   config:

   ```bash
   bun run tools/check-config.ts
   ```

2. Send the file with `mksync push`, which copies it into the repo (the new entry shows as `ADDED`) and opens the pull
   request. An entry for several systems only needs pushing from one machine. See
   [daily-workflow.md](daily-workflow.md).
3. On Linux, check that no home path reached the repo. This must print nothing:

   ```bash
   grep -rl "$HOME" dotfiles/
   ```

## Profiles and machines

The machine record chooses the extra layers, as the system chooses the OS layer. `mksync setup` writes it once per
machine; with no record there are no extra layers and every module is on.

| File                              | Holds                                                                                         | Layer it brings               | Layer label                 |
| --------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------- |
| `<state>/machine.json`            | the record: name, profile, OS, Claude mode, push or pull only, module changes, machine values | `<state>/machines/<name>/`    | `machines/<name>/<file>`    |
| `<state>/profiles/<profile>.json` | the profile: modules, values, destinations, retired                                           | `<state>/profiles/<profile>/` | `profiles/<profile>/<file>` |

`<state>` is the state folder ([layout.md](layout.md#profiles-and-machines-in-the-state-folder)). A name is lowercase
letters, digits and `-`, and it can't name another layer: neither name may be `linux`, `macos`, `windows`, `common` or
`base`, and the machine can't share its profile's name (their side files, such as `CLAUDE.<name>.md`, would overwrite
each other). A record or profile that doesn't parse stops the run with exit 2 before any file is touched, naming the
field ([contract, "Machines"](sync-contract.md#machines)).

**The record.** Every field is required; `setup` writes it, so it's rarely edited by hand:

| Field                | Type                                  | Meaning                                                                                       |
| -------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `name`               | name                                  | this machine, and its layer folder                                                            |
| `profile`            | name                                  | the profile it runs                                                                           |
| `os`                 | `linux`, `macos` or `windows`         | the system it was set up on                                                                   |
| `hostname`, `domain` | string; string or `null`              | what the scan read, used to suggest this record on a reinstall                                |
| `claude`             | `none`, `claude` or `claude-deepseek` | turns off `claude` and `claude-worker`, `claude-worker` only, or neither                      |
| `pullOnly`           | boolean                               | pull without ever pushing                                                                     |
| `modules`            | `{ "add": [...], "remove": [...] }`   | modules turned on or off for this machine only                                                |
| `values`             | object                                | this machine's values: `<HOME>`, `<GH_CLI_PATH>`, and any placeholder answered "this machine" |
| `replaced`           | list of `{hostname, domain, date}`    | earlier installs this record took over, oldest first                                          |
| `retired`            | boolean                               | set by `machine retire`; a retired record can't push                                          |

**The profile** is JSON with four optional fields:

| Field          | Type                  | Meaning                                                                                                                                                                             |
| -------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modules`      | array of module names | the modules this profile runs; an entry of any other module gets no status line                                                                                                     |
| `values`       | object                | the profile's values: name, email, GitHub user and org, work marketplace, and any placeholder answered "this profile"; a record's value wins over the profile's                     |
| `destinations` | object                | where a new setting goes: key path (`proxy`, `permissions.allow[]`) to layer slot, `os`, `profile` or `machine`; any other value stops the run (`destination <key> is not a layer`) |
| `retired`      | boolean               | set by `profile retire`: not listed by `setup`, and refused if named                                                                                                                |

**Worked example.** A work machine gets the `parity` module and one extra key in a JSON file:

```json
// sync-config.json (entry)
{ "file": "parity/settings.json", "module": "parity", "merge": "json",
  "localPath": "~/.config/parity/settings.json" }

// dotfiles/common/parity/settings.json         (base)
{ "editor": "vim", "theme": "dark" }

// <state>/machine.json                          (record, written by setup)
{ "name": "wk1-laptop", "profile": "work-1", "os": "linux", "hostname": "wk1-laptop",
  "domain": null, "claude": "claude", "pullOnly": false,
  "modules": { "add": [], "remove": [] }, "values": {}, "replaced": [], "retired": false }

// <state>/profiles/work-1.json                    (profile)
{ "modules": ["parity"], "values": {}, "destinations": {}, "retired": false }

// <state>/profiles/work-1/parity/settings.json   (profile layer)
{ "theme": "light", "proxy": "http://proxy.example.com" }
```

With the record in place, `mksync pull` writes `~/.config/parity/settings.json` as
`{ "editor": "vim", "theme": "light", "proxy": "http://proxy.example.com" }` (laid out over several lines) and labels
the line with the latest layer, `profiles/work-1/parity/settings.json`. Changing `theme` locally and running
`mksync push` writes the new value back to the profile layer in the state folder, since that
layer set it; `dotfiles/` doesn't change. Each time export rewrites or removes a file in the state folder, the old file
goes into the run's dated backups folder first.

**A new setting.** Adding `"font": "mono"` locally is a key no layer has yet, so export needs to know where it goes.
Without an answer it stops that file with `ERROR`, note `new setting font: needs a destination`. With one in the
profile, `{ "modules": ["parity"], "destinations": { "font": "profile" } }`, export writes it to the profile layer, and
creates that layer's file (`ADDED`) when the profile had none for this entry. `"os"` would send it to
`dotfiles/<os>/parity/settings.json` instead, and `"machine"` to the machine layer (`machines/wk1-laptop/parity/settings.json`). Removing a key locally removes it from every layer that sets it.

A file the repo holds in one layer only, such as `claude/settings.json` in `dotfiles/common/`, asks too on a machine
with a record: `mksync push` suggests the profile (`all machines` for `personal`), and `mksync preview` and
`mksync diff` plan the suggestion. Only a machine with no record puts the key in that one layer without asking.

**Values with a record.** A placeholder's value comes from the record's `values`, then the profile's;
`.user-values.json` is neither read nor written, even when it is still there. A value found during an `import` or
`export` (inferred from the local file, a rule's `default` or its `defaultEnv`) is saved before any file is written,
on the side the table in [the contract](sync-contract.md#values-on-a-machine) gives it: with the entry above sanitized
by a `<HOME>` rule (`defaultEnv: HOME`, the home folder), the first import adds `"<HOME>": "/home/user"` to `machine.json`; a
`<YOUR_NAME>` default would go into `profiles/work-1.json`, and any placeholder the table doesn't name goes on the
profile too. The profile is written first, then the record, both readable by you only. A run that finds nothing new
writes neither, and a preview saves nothing. With no value at all, the run stops before any file with
`missing value for <YOUR_NAME>: run mksync push or pull in a terminal to enter it`, exit 1: run either in a terminal,
and it asks for the value and saves it on the side above.
