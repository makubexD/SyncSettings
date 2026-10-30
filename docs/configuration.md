# Configuration reference

`sync-config.json` lists every file and folder SyncSettings keeps in the repo. This page covers each field and how to
add an entry. For what the engines do with those fields, see [sync-contract.md](sync-contract.md).

## File layout

```json
{
  "version": 1,
  "defaultUser": null,
  "files": [
    {
      "repoPath": "dotfiles/common/editorconfig",
      "localPath": "~/.editorconfig",
      "platform": "common",
      "description": "Editor defaults"
    }
  ],
  "excludePatterns": ["*.pem", "*.key", "*.bak", ".env"]
}
```

| Field | Meaning |
|---|---|
| `files` | The entries to sync, processed in this order |
| `excludePatterns` | Files never copied in either direction ([details](#excludepatterns)) |
| `version`, `defaultUser` | Not read by the engines. Leave them as they are |

## Entry fields

| Field | Required | Meaning |
|---|---|---|
| `repoPath` | yes | Where the file lives in this repo, with forward slashes. No trailing slash, also for folders. Unique across entries |
| `localPath` | yes | Where it lives on the machine ([forms](#localpath)) |
| `platform` | yes | `common`, `windows` or `linux` ([details](#platform)) |
| `description` | no | A note for people. The engines don't read it |
| `sanitizeRules` | no | Placeholders that keep private values out of the repo ([details](#sanitizerules)) |
| `type` | no | `file` (default) or `dir` ([details](#type-dir)) |
| `detectLinkedPaths` | no | Windows only: also sync folders the file mentions ([details](#detectlinkedpaths)) |

## `platform`

`platform` picks the engine and decides where the entry may live. An entry with no `platform`, or any other value,
stops both engines with exit code 1 before they touch a file. CI lint also fails on it, and on the path rules below.

| `platform` | Runs on | `repoPath` must be | `localPath` |
|---|---|---|---|
| `common` | both | under `dotfiles/common/` | `~/` form only |
| `linux` | Linux | under `dotfiles/linux/` | `~/` form |
| `windows` | Windows | under `dotfiles/`, not in `linux/` or `common/` | either form |

## `localPath`

| Form | JSON example | Works on |
|---|---|---|
| `~/` with forward slashes | `"~/.config/git/ignore"` | both |
| `~\` with backslashes | `"~\\.gitconfig"` | Windows only |

`~` is `$HOME` on Linux and the profile folder on Windows, or the target user's profile with `-User`. Backslashes are
doubled in JSON. An absolute path, or a path with a `..` segment, stops every command before it touches a file.

## `sanitizeRules`

Each rule names a placeholder that stands in for a private value in the repo. Export replaces every occurrence of the
value in the file, and import puts it back, so pick values specific enough not to match unrelated text.

```json
{
  "repoPath": "dotfiles/.gitconfig",
  "localPath": "~\\.gitconfig",
  "platform": "windows",
  "description": "Git global configuration",
  "sanitizeRules": [
    { "placeholder": "<YOUR_NAME>", "prompt": "Full name for git commits" },
    {
      "placeholder": "<GH_CLI_PATH>",
      "prompt": "Path to GitHub CLI executable",
      "default": "C:\\Program Files\\GitHub CLI\\gh.exe",
      "escapeBackslashes": true
    }
  ]
}
```

```json
{
  "repoPath": "dotfiles/linux/claude/settings.json",
  "localPath": "~/.claude/settings.json",
  "platform": "linux",
  "description": "Claude Code user settings",
  "sanitizeRules": [
    { "placeholder": "<HOME>", "prompt": "Home directory", "defaultEnv": "HOME" }
  ]
}
```

| Rule field | Required | Meaning |
|---|---|---|
| `placeholder` | yes | The text stored in the repo, such as `<YOUR_NAME>` |
| `prompt` | yes | The question shown when the value is needed |
| `default` | no | The value offered at the prompt |
| `defaultEnv` | no | Name of an environment variable to offer instead, used when `default` is not set |
| `escapeBackslashes` | no | `true` if the file stores the value with doubled backslashes (`C:\\Tools`), as `.gitconfig` does |

- `defaultEnv` reads the variable on the machine running the sync. `HOME` is usually unset on Windows, so a `common`
  rule with `"defaultEnv": "HOME"` prompts there with no default.
- A placeholder used by several entries has one value.
- Values are cached in `.user-values.json`, which is gitignored, with placeholders as keys:

  ```json
  { "<YOUR_NAME>": "Jane Doe", "<HOME>": "/home/jane" }
  ```

- Without a terminal, a placeholder with no value stops the run. Add the value to `.user-values.json`.

To enter the values again, run `./export.sh --reset-values` or `./import.sh --reset-values`, or on Windows
`export.bat -ResetValues` or `import.bat -ResetValues`.

## `type: dir`

Syncs a whole folder, recursively.

```json
{
  "repoPath": "dotfiles/common/nvim",
  "localPath": "~/.config/nvim",
  "platform": "common",
  "type": "dir",
  "description": "Neovim configuration"
}
```

- Export makes the repo folder match the local one, so it deletes repo files that are gone locally. Git keeps the
  history.
- Import never deletes. It lists local files the repo doesn't have as `EXTRA` and keeps them.
- Symlinks are skipped, and `excludePatterns` apply to every file inside.
- `sanitizeRules` and `detectLinkedPaths` are not allowed on a `dir` entry. CI lint fails if either is set.

## `detectLinkedPaths`

```json
{
  "repoPath": "dotfiles/.bashrc",
  "localPath": "~\\.bashrc",
  "platform": "windows",
  "description": "Bash run commands",
  "detectLinkedPaths": true
}
```

The Windows engine scans the file for folder paths (`/c/Tools` or `C:\Tools`) and syncs each folder that exists.
System folders and anything under the user profile are ignored. Copies live in the repo under
`<repoPath>.linked/<folder name>/`, for example `dotfiles/.bashrc.linked/Tools/`. The bash engine ignores this field.

Import never deletes from a linked folder. It asks before overwriting a file and keeps a `.bak`, and a local file the
repo doesn't have is reported as `EXTRA` and kept.

## `excludePatterns`

Each pattern is a glob matched against the file name, or against the end of the path. A match is never copied in
either direction, and this applies to files inside `dir` entries and linked folders too.

Keep `*.bak` in the list. It stops the backups that import writes inside a synced folder from being exported.

## Adding an entry

1. Add the entry to `files` in `sync-config.json`.
2. Check that the file still parses:

   ```bash
   jq empty sync-config.json
   ```

3. Copy the file into the repo with `./export.sh` on Linux or `export.bat` on Windows. The new entry shows as `ADDED`.
   A new `common` entry only needs exporting on one machine.
4. On Linux, check that no home path reached the repo. This must print nothing:

   ```bash
   grep -rl "$HOME" dotfiles/linux
   ```

5. Commit with `./commit.sh` or `commit.bat`, which opens the pull request. See
   [daily-workflow.md](daily-workflow.md).
