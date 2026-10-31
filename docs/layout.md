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
│   └── git/
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

## Linked folders

A file with `detectLinkedPaths` keeps its folders next to it, in `<repoPath>.linked/`, so they land in the same tool
folder: `windows/shell/.bashrc.linked/MakuCustomAlias/`.
