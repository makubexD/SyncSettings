# Repository layout

Every synced file lives under `dotfiles/<platform>/<tool>/`. This page says where a new file goes and why the
exceptions exist. For the fields of an entry, see [configuration.md](configuration.md).

```text
dotfiles/
├── common/    Same file on both systems
│   ├── claude/
│   └── git/
├── linux/     Linux only
│   ├── claude/
│   ├── claude-worker/
│   ├── gh/
│   ├── git/
│   ├── gnome/
│   ├── htop/
│   ├── rtk/
│   ├── shell/
│   ├── starship/
│   ├── tmux/
│   ├── vscode/
│   └── wezterm/
└── windows/   Windows only
    ├── git/
    ├── shell/
    └── windows-terminal/
```

## Where a file goes

| The file | Where | Example |
|---|---|---|
| Is the same on both systems | `dotfiles/common/<tool>/`, `"platform": "common"` | `claude/RTK.md` |
| Exists on one system, or differs throughout | `dotfiles/<linux or windows>/<tool>/` | `windows/shell/.bashrc` |
| Is mostly shared, with a few lines per system, and its tool has an include | Split it: the shared part in `common`, one local part per system | `git/.gitconfig` |
| Is a folder where every file should be synced and none holds a private value | One `"type": "dir"` entry | `linux/claude/hooks` |
| Is a folder with private values, or with files to leave out | One file entry per file | `linux/claude/bin/` |

CI lint enforces the platform folder: a `repoPath` outside `dotfiles/<platform>/` fails. A `common` entry must also use
the `~/` form of `localPath`, because the other form only works on Windows.

## Naming

- Name the folder after the tool, in lowercase with dashes: `windows-terminal`, `claude-worker`.
- Keep the file's real name, leading dot included: `.gitconfig`, `settings.json`.
- Below the tool folder, mirror the local folders: `~/.claude/bin/mk-exec` is `linux/claude/bin/mk-exec`.
- A launcher stays with its tool, wherever it lives locally: `~/.local/bin/wezterm-xwayland` is
  `linux/wezterm/wezterm-xwayland`. That's why `wezterm.lua` has a file entry, not a `dir` entry for the folder.

## Line endings

`.gitattributes` forces LF on everything under `dotfiles/common/` and `dotfiles/linux/`, so a Windows checkout with
`core.autocrlf=true` doesn't add CR bytes to them. `dotfiles/windows/` has no rule yet.

## Why `.gitconfig` has a local part

Identity, core settings, diff and merge tools, aliases and `init.defaultBranch` are the same everywhere. Credentials are
not: Windows uses `manager` and `gh.exe`, Linux uses `/usr/bin/gh`. So there are three entries:

| Entry | Local path | Holds |
|---|---|---|
| `common/git/.gitconfig` | `~/.gitconfig` | Everything shared, ending in `[include] path = ~/.gitconfig.local` |
| `windows/git/.gitconfig.local` | `~\.gitconfig.local` | Windows credentials |
| `linux/git/.gitconfig.local` | `~/.gitconfig.local` | Linux credentials |

To check the merged result, include the local file: `git config --global --includes --get-all
credential.https://github.com.helper`. Without `--includes`, the command reads only `~/.gitconfig` and finds nothing.

## One `dir` entry per skill

`~/.claude/skills` is not a `dir` entry, because Claude Code keeps `synced/` there, 4.6 MB it manages itself. Each skill
has its own entry instead, so **a new skill needs a new entry** or it isn't synced.

`~/.claude/bin` is not a `dir` entry either. `bin/tests/` holds home paths, and a `dir` entry can't have `sanitizeRules`,
so each script has a file entry and `bin/tests/` stays out of the repo.

An entry can't sit inside a `dir` entry, not even another `dir`. Export makes a `dir` entry's repo folder match its local
folder, so it would delete the inner entry's files from the repo unless they also exist in that local folder. CI lint
fails on it.

## Why plugin state isn't synced

`linux/claude/settings.json` declares what Claude Code should have: `extraKnownMarketplaces` and `enabledPlugins`.
`~/.claude/plugins/installed_plugins.json` and `known_marketplaces.json` record what it installed: versions, commit SHAs,
timestamps and paths into a cache of about 200 MB that the repo doesn't hold.

Claude Code rewrites those two files on its own, so they would show up as changes nobody made. Restoring them without
the cache doesn't work either: every plugin fails to load. To get plugins back, add each marketplace with
`claude plugin marketplace add` and install each plugin with `claude plugin install`. You get the latest versions, not
the ones last exported.

## VS Code and Settings Sync

The repo holds the default profile only: `settings.json` and `snippets/`. Named profiles stay with VS Code's Settings
Sync, so a full restore needs a Settings Sync sign-in.

Import can overwrite `settings.json`, and Settings Sync then spreads that to your other machine. Before you accept that
file at the import prompt, check that the repo copy is the one you want everywhere.

The local `settings.json` uses CRLF and the repo copy uses LF. The file is left that way on purpose, because Settings
Sync could carry a conversion to the other machine or bring CRLF back. Its `sanitizeRules` make the comparison ignore
line endings, so CRLF doesn't count as a change. Those rules cover the home path and a work marketplace URL. A new
machine prompts for the URL, which has no default.

## Linked folders

A file with `detectLinkedPaths` keeps its folders next to it, in `<repoPath>.linked/`, so they land in the same tool
folder: `windows/shell/.bashrc.linked/MakuCustomAlias/`.
