# Design: one engine with modules, profiles and layers

Phase 3 of `docs/plan-single-engine.md`. This file turns the decisions of 2026-11-10 into rules, worked examples and
file shapes. No TypeScript is written before the user approves it. Anything not decided here is in "Open".

## Statusline and hooks on Windows

Today the Claude settings are synced on Linux only (`dotfiles/linux/claude/`). `settings.json` points the statusline at
`<HOME>/.claude/statusline.sh` and every hook at a bash script under `<HOME>/.claude/hooks/`. The statusline reads its
input with one `jq` call and runs `git` for the branch and changes. The repo's history has no Windows `settings.json`
for Claude, so the Windows side comes from the documentation only.

What Claude Code's documentation says:

- **Statusline shell.** "On Windows, Claude Code runs status line commands through Git Bash when Git Bash is installed,
  or through PowerShell when Git Bash is absent."
  ([statusline, Windows configuration](https://code.claude.com/docs/en/statusline#windows-configuration))
- **Hook shell.** A hook's `command` goes to "`sh -c` on macOS and Linux, Git Bash on Windows, or PowerShell when Git
  Bash isn't installed". A hook can pin it with `"shell": "bash"` or `"shell": "powershell"`. With `args` set, the
  hook runs a program directly, with no shell, and on Windows the program must be a real `.exe`.
  ([hooks](https://code.claude.com/docs/en/hooks))
- **Home paths.** In the statusline command, "the `~` shorthand also works and expands to your Windows home
  directory". Backslashes are eaten by Git Bash, so paths use forward slashes (`C:/Users/…`). `$HOME` isn't mentioned
  for Windows: Git Bash sets it, PowerShell has `$HOME` as its own variable, so it works in both, but untested.
  Hooks get `${CLAUDE_PROJECT_DIR}` from Claude Code on every OS.
- **Which tools exist.** Without Git for Windows, Claude Code has no Bash at all and uses its PowerShell tool
  ([setup](https://code.claude.com/docs/en/setup)). So a machine without Git Bash can't run `statusline.sh` or any of
  the bash hooks, and the documentation doesn't promise `jq` anywhere.

Example: on Windows work #1 with Git for Windows but no `jq`, a shared `statusline.sh` starts under Git Bash, the `jq`
call fails, and the bar shows the fallback text or nothing. On work #2 without Git for Windows, PowerShell gets
`~/.claude/statusline.sh` and can't run it at all.

The two options:

|                     | One shared `statusline.sh`                  | `mksync statusline`                                                               |
| ------------------- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| Needs on Windows    | Git Bash and `jq`                           | the `mksync` program, already installed by the restore                            |
| Runs under          | Git Bash only                               | Git Bash or PowerShell: the command is a program name, the same in both           |
| Code                | one bash file, as today                     | one TypeScript command, tested by the shared cases                                |
| Start-up on Windows | Git Bash, then `jq` and `git`; not measured | about 57 ms (Bun, `docs/archive/single-engine-research.md` section 3), plus `git` |
| Change by hand      | edit the file, see it on the next refresh   | edit the source and rebuild, or wait for a release                                |

Decision: the statusline becomes `mksync statusline`, on every OS. The work machines may have neither Git Bash nor
`jq`, and the subcommand needs only the program the restore already installs, under whichever shell Claude Code picks.
It is written once, in the same language as the engine, and the shared cases test its output. The cost is hand
tweaks: they go through the source. A machine that wants its own bar keeps a machine-layer `statusLine` override in
`settings.json`, as any other setting.

Example: on personal Linux, `settings.json` says `"command": "mksync statusline"`; the Linux bar looks the same as
today's `statusline.sh`. On Windows work #1 to #3 the same line works under Git Bash or PowerShell, with no `jq`.

Hooks stay scripts. The Linux hooks (`metrics-capture.sh` and others, under `dotfiles/linux/claude/hooks/`) are synced
files like any other, not engine code, so they don't move into `mksync`. On Windows a bash hook needs Git Bash, or a
`"shell": "powershell"` twin. Which hooks the work machines need goes in "Open".

## Catalog

Every entry in `sync-config.json` today, and where it lands. The columns:

- **Module:** the group a profile lists to get the entry (`git`, `shell`, `claude`…). A machine whose record says
  "Claude: none" skips `claude`; only "Claude plus DeepSeek" gets `claude-worker`.
- **Layer:** where the file's content lives. Base is every machine (an entry may still be limited with `os`, as in
  "Config v2"); OS is one OS; profile is one profile;
  machine is one machine record. Values (`<YOUR_EMAIL>`, `<HOME>`) are in "Values" in the last column, not a layer
  of their own: an account belongs to the profile, a path to the machine.
- **Receives:** which machines end up with the file today, when their profile lists the module.
- **Merge:** how the layers combine. "Whole file" means one layer owns the file (values still hydrate). "JSON" merges
  keys, later layers win. "`@import`" keeps one file per layer and the base file imports the others. "dconf" loads
  only the listed keys. "Dir" syncs a folder entry by entry.

| Entry                                                   | Module             | Layer                                                                                  | Receives                         | Merge      | Values                                                                   |
| ------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------- | -------------------------------- | ---------- | ------------------------------------------------------------------------ |
| `dotfiles/common/git/.gitconfig`                        | `git`              | base                                                                                   | all                              | whole file | `<YOUR_NAME>`, `<YOUR_EMAIL>`: profile                                   |
| `dotfiles/common/git/ignore`                            | `git`              | base                                                                                   | all                              | whole file |                                                                          |
| `dotfiles/windows/git/.gitconfig.local`                 | `git`              | OS (Windows)                                                                           | Windows                          | whole file | `<YOUR_GH_USERNAME>`, `<YOUR_GH_ORG>`: profile; `<GH_CLI_PATH>`: machine |
| `dotfiles/linux/git/.gitconfig.local`                   | `git`              | OS (Linux)                                                                             | Linux                            | whole file |                                                                          |
| `dotfiles/macos/git/.gitconfig.local`                   | `git`              | OS (macOS)                                                                             | macOS                            | whole file |                                                                          |
| `dotfiles/macos/shell/.zshrc`                           | `shell`            | OS (macOS)                                                                             | macOS                            | whole file |                                                                          |
| `dotfiles/macos/shell/.zprofile`                        | `shell`            | OS (macOS)                                                                             | macOS                            | whole file |                                                                          |
| `dotfiles/windows/shell/.bashrc`                        | `shell`            | OS (Windows)                                                                           | Windows                          | whole file | linked folders: profile ("Linked folders")                               |
| `dotfiles/windows/shell/.bash_profile`                  | `shell`            | OS (Windows)                                                                           | Windows                          | whole file |                                                                          |
| `dotfiles/linux/shell/.bashrc`                          | `shell`            | OS (Linux)                                                                             | Linux                            | whole file |                                                                          |
| `dotfiles/linux/shell/.profile`                         | `shell`            | OS (Linux)                                                                             | Linux                            | whole file |                                                                          |
| `dotfiles/common/tmux/.tmux.conf`                       | `tmux`             | base, `os`: Linux, macOS                                                               | Linux, macOS                     | whole file |                                                                          |
| `dotfiles/common/starship/starship.toml`                | `starship`         | base, `os`: Linux, macOS                                                               | Linux, macOS                     | whole file |                                                                          |
| `dotfiles/common/wezterm/wezterm.lua`                   | `wezterm`          | base, `os`: Linux, macOS                                                               | Linux, macOS                     | whole file |                                                                          |
| `dotfiles/common/htop/htoprc`                           | `htop`             | base, `os`: Linux, macOS                                                               | Linux, macOS                     | whole file |                                                                          |
| `dotfiles/common/gh/config.yml`                         | `gh`               | base, `os`: Linux, macOS                                                               | Linux, macOS                     | whole file |                                                                          |
| `dotfiles/linux/rtk`                                    | `rtk`              | OS (Linux)                                                                             | Linux                            | dir        |                                                                          |
| `dotfiles/linux/gnome/mimeapps.list`                    | `gnome`            | OS (Linux)                                                                             | Linux                            | whole file |                                                                          |
| `dotfiles/linux/gnome/bookmarks`                        | `gnome`            | OS (Linux)                                                                             | Linux                            | whole file | `<HOME>`: machine                                                        |
| `dotfiles/linux/gnome/applications/disco-datos.desktop` | `gnome`            | machine (see Open)                                                                     | personal Linux                   | whole file |                                                                          |
| `dotfiles/linux/gnome/applications/mis-discos.desktop`  | `gnome`            | machine (see Open)                                                                     | personal Linux                   | whole file |                                                                          |
| `dotfiles/linux/wezterm/wezterm-xwayland`               | `wezterm`          | OS (Linux)                                                                             | Linux                            | whole file |                                                                          |
| `dotfiles/linux/wezterm/wezterm-xwayland.desktop`       | `wezterm`          | OS (Linux)                                                                             | Linux                            | whole file | `<HOME>`: machine                                                        |
| `dotfiles/common/vscode/settings.json`                  | `vscode`           | base                                                                                   | Linux, macOS (Windows: see Open) | JSON       | `<HOME>`: machine; `<YOUR_WORK_MARKETPLACE>`: profile                    |
| `dotfiles/common/vscode/snippets`                       | `vscode`           | base                                                                                   | Linux, macOS (Windows: see Open) | dir        |                                                                          |
| `dotfiles/windows/windows-terminal/settings.json`       | `windows-terminal` | OS (Windows)                                                                           | Windows                          | whole file |                                                                          |
| `dotfiles/common/claude/CLAUDE.md`                      | `claude`           | base, profile adds one                                                                 | Linux, macOS; Windows in phase 7 | `@import`  |                                                                          |
| `dotfiles/common/claude/RTK.md`                         | `claude`           | base                                                                                   | all with Claude                  | whole file |                                                                          |
| `dotfiles/linux/claude/settings.json`                   | `claude`           | OS (Linux) today; a base part moves to `dotfiles/common/` when Windows joins (phase 7) | Linux                            | JSON       | `<HOME>`: machine; `<YOUR_GH_USERNAME>`: profile                         |
| `dotfiles/linux/claude/statusline.sh`                   | `claude`           | none: replaced by `mksync statusline`                                                  | Linux until cut-over             | whole file |                                                                          |
| `dotfiles/common/claude/sampleGrok.md`                  | `claude`           | none (see Open)                                                                        | Linux, macOS                     | whole file |                                                                          |
| `dotfiles/linux/claude/hooks`                           | `claude`           | OS (Linux)                                                                             | Linux                            | dir        |                                                                          |
| `dotfiles/linux/claude/skills/mk-delegate`              | `claude-worker`    | OS (Linux)                                                                             | Linux with DeepSeek              | dir        |                                                                          |
| `dotfiles/linux/claude/skills/mk-check`                 | `claude-worker`    | OS (Linux)                                                                             | Linux with DeepSeek              | dir        |                                                                          |
| `dotfiles/common/claude/docs/token-routing-map.html`    | `claude`           | base                                                                                   | all with Claude                  | whole file |                                                                          |
| `dotfiles/linux/claude/bin/mk-exec`                     | `claude-worker`    | OS (Linux)                                                                             | Linux with DeepSeek              | whole file |                                                                          |
| `dotfiles/linux/claude/bin/workflow-report`             | `claude-worker`    | OS (Linux)                                                                             | Linux with DeepSeek              | whole file |                                                                          |
| `dotfiles/linux/claude/bin/metrics-archive`             | `claude`           | OS (Linux)                                                                             | Linux                            | whole file |                                                                          |
| `dotfiles/linux/claude-worker/CLAUDE.md`                | `claude-worker`    | OS (Linux)                                                                             | Linux with DeepSeek              | whole file |                                                                          |
| `dotfiles/linux/claude-worker/settings.json`            | `claude-worker`    | OS (Linux)                                                                             | Linux with DeepSeek              | JSON       |                                                                          |
| `dotfiles/linux/claude/bin/worker-mode`                 | `claude-worker`    | OS (Linux)                                                                             | Linux with DeepSeek              | whole file |                                                                          |
| `dotfiles/linux/gnome/dconf/interface.ini`              | `gnome`            | OS (Linux)                                                                             | Linux                            | dconf      |                                                                          |
| `dotfiles/linux/gnome/dconf/input-sources.ini`          | `gnome`            | OS (Linux)                                                                             | Linux                            | dconf      |                                                                          |
| `dotfiles/linux/gnome/dconf/wm-keybindings.ini`         | `gnome`            | OS (Linux)                                                                             | Linux                            | dconf      |                                                                          |
| `dotfiles/linux/gnome/dconf/privacy.ini`                | `gnome`            | OS (Linux)                                                                             | Linux                            | dconf      |                                                                          |
| `dotfiles/linux/gnome/dconf/session.ini`                | `gnome`            | OS (Linux)                                                                             | Linux                            | dconf      |                                                                          |
| `dotfiles/linux/gnome/dconf/power.ini`                  | `gnome`            | OS (Linux)                                                                             | Linux                            | dconf      |                                                                          |
| `dotfiles/linux/gnome/dconf/shell.ini`                  | `gnome`            | OS (Linux)                                                                             | Linux                            | dconf      |                                                                          |
| `dotfiles/linux/gnome/dconf/ptyxis.ini`                 | `gnome`            | OS (Linux)                                                                             | Linux                            | dconf      |                                                                          |
| `dotfiles/linux/gnome/dconf/nautilus.ini`               | `gnome`            | OS (Linux)                                                                             | Linux                            | dconf      |                                                                          |
| `dotfiles/linux/gnome/dconf/file-chooser.ini`           | `gnome`            | OS (Linux)                                                                             | Linux                            | dconf      |                                                                          |
| Windows Claude settings (expected)                      | `claude`           | OS (Windows) overlay on the base                                                       | Windows; confirm in phase 7      | JSON       | `<HOME>`: machine                                                        |
| Windows statusline (expected)                           | `claude`           | none: `mksync statusline`                                                              | Windows; confirm in phase 7      | (no file)  |                                                                          |
| Windows `CLAUDE.md` (expected)                          | `claude`           | base, work profile adds one                                                            | Windows; confirm in phase 7      | `@import`  |                                                                          |

Example, a base file with a value per profile: `dotfiles/common/vscode/settings.json` lists three Copilot plugin
marketplaces, the last one `<YOUR_WORK_MARKETPLACE>`. The file is base: the same on every machine with the `vscode`
module. The value is per profile: work #1's profile holds `https://marketplace.example.com/work-1`, work #2's holds its
own. Pull on work #1 writes the file with work #1's address; push turns it back into `<YOUR_WORK_MARKETPLACE>`, so
nothing from job #1 reaches job #2. The `personal` profile has no work marketplace, which is the open question below.

## Layers

A file is built from up to four layers, in this order: **base**, **OS**, **profile**, **machine**. When two layers set
the same thing, the later one wins: the machine beats the profile, the profile beats the OS, the OS beats the base.
"The same thing" depends on the merge type from the catalog:

| Merge      | What two layers can both set                     | Who wins                                                                                                              |
| ---------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| whole file | the whole file                                   | the latest layer that has the file; the others aren't read                                                            |
| JSON       | one key path (`editor.fontSize`); one array item | the latest layer with that key. Objects merge key by key; arrays collect the items of every layer ("Merge and split") |
| `@import`  | nothing: each layer has its own file             | no conflict. The base file imports the others, base first, so Claude reads the machine's lines last                   |
| dconf      | one listed key                                   | the latest layer with that key                                                                                        |
| dir        | one file inside the folder                       | the latest layer with that file; files from all layers are kept                                                       |

A layer that has nothing for an entry is skipped. Most entries have one layer today (the catalog's "Layer" column);
the extra layers are there for the day a profile or a machine needs to differ.

Example: VS Code on Windows work #1. The base `settings.json` sets `"editor.fontSize": 14`. The `work-1` profile adds
`"http.proxy": "http://proxy.example.com:8080"`. The laptop's machine record sets `"editor.fontSize": 16` for its small
screen. Pull writes a file with `"editor.fontSize": 16` and the proxy; personal Linux still gets 14 and no proxy.

Example: `.gitconfig.local` is whole file at the OS layer. Linux gets `dotfiles/linux/git/.gitconfig.local`, Windows
its own. If work #2 one day needs a different one, a profile-layer `.gitconfig.local` replaces the Windows one there,
whole; nothing is merged line by line.

## Modules and profiles

A **module** is a named group of entries: `git`, `shell`, `vscode`, `claude`… (the catalog's "Module" column). A module
may be limited to some OSes: `gnome` is Linux only, `windows-terminal` Windows only. A limited module stays off on
another OS even when the profile lists it, and `mksync status` says so (`gnome: off, linux only`). Profiles are not
tied to an OS, so this is how one profile serves a Linux and a Windows machine.

The machine record adds one switch on top: its Claude mode. "None" turns off `claude` and `claude-worker`; "Claude
only" turns off `claude-worker`.

A **profile** is the list of modules one kind of machine gets, plus what's personal to that job. There is `personal`
and one per job (`work-1`, `work-2`, `work-3`). There's no parent profile: what every job shares is a `work-base`
module, and each work profile lists it.

Example: the module lists.

| Profile    | Modules                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `personal` | `git`, `shell`, `tmux`, `starship`, `wezterm`, `htop`, `gh`, `rtk`, `gnome`, `vscode`, `claude`, `claude-worker` |
| `work-1`   | `work-base`, `git`, `shell`, `vscode`, `windows-terminal`, `claude`                                              |

On work #1 (Windows) `personal`'s `gnome` would be off anyway; on a second personal machine running macOS, `gnome`
and `windows-terminal` are off and the rest apply.

What goes in `work-base` comes from the Windows inventory (phase 7). Until then it is an empty module.

**Modules choose files, layers choose keys** (decided 2026-11-18, cut-over decision 12). A tool only some profiles
should have is a module that only those profiles list; a value or key that differs per profile goes in that profile's
layer. Example: the plan workflow (`/next`, `plan-next`, `pr-ready`, the context gate, metrics) and the DeepSeek worker
(`mk-exec`, `mk-delegate`, `mk-check`, `worker-mode`) are module `claude-worker`, which only `personal` lists, so a
work profile never gets them on any OS. `claude` keeps what any Claude machine wants. One module holds both, since
`/next` sends its steps to the worker; split it only when a profile needs one without the other. Its entries stay
`os: ["linux"]` until a personal Windows or macOS machine exists ("Open", "Workflow on a personal Windows or macOS
machine").

**The profile file** holds four things:

```json
{
  "modules": [
    "work-base",
    "git",
    "shell",
    "vscode",
    "windows-terminal",
    "claude"
  ],
  "values": {
    "<YOUR_EMAIL>": "jane@example.com",
    "<YOUR_GH_ORG>": "example-org",
    "<YOUR_WORK_MARKETPLACE>": "https://marketplace.example.com/work-1"
  },
  "destinations": {
    "claude settings.json: permissions.allow": "profile"
  },
  "retired": false
}
```

- `modules`: as above.
- `values`: the profile's own values (next section).
- `destinations`: the answers to "where does this new setting go?" from push, so every machine with this profile
  knows them. Only arrays, folders and linked-folder answers are kept here ("New settings").
- `retired`: `true` once the job ends. The profile stays as the last backup, and the first run no longer suggests it.

Until the repo is private, profile files live in the machine's local state, never in the repo. The first push after
the switch commits them.

Example: job #2 ends. Its profile gets `"retired": true` on the next push from work #2. A new work laptop's first run
lists `personal`, `work-1` and `work-3`, not `work-2`.

## Values

A value fills a `<PLACEHOLDER>` on pull and turns back into it on push, as today. What changes is where it's kept:

| Value                     | Kept on | Why                            |
| ------------------------- | ------- | ------------------------------ |
| `<YOUR_NAME>`             | profile | the name on the job's accounts |
| `<YOUR_EMAIL>`            | profile | an account                     |
| `<YOUR_GH_USERNAME>`      | profile | an account                     |
| `<YOUR_GH_ORG>`           | profile | an account                     |
| `<YOUR_WORK_MARKETPLACE>` | profile | the job's service              |
| `<HOME>`                  | machine | a path                         |
| `<GH_CLI_PATH>`           | machine | a path                         |

The rule for a new placeholder: an account, a name or an address of the job's service goes on the profile; a path or
anything about this one computer goes on the machine. If a placeholder ends up in both, the machine wins, as in
"Layers".

**Moving `.user-values.json`.** On a machine's first run of the new engine, each key of `.user-values.json` goes to the
profile or to the machine by the table above. A placeholder that isn't in the table is asked about once,
`<OTHER>: kept on 1) this profile 2) this machine [1]`, and `--yes` or end of input keeps it on the profile. The old
file is left as it is, so the old engine still works until cut-over, and is deleted then. With a record the program reads
values only from the machine, then the profile; a value asked for during a pull or setup is saved by the same rule.
The program asks only for a value that nothing else fills: no record or profile value, no inferred value, no rule
`default` and no `defaultEnv`.

Example: personal Linux has `{"<YOUR_EMAIL>": "jane@example.com", "<HOME>": "/home/jane"}`. After the first run, the
`personal` profile holds the email and the machine record holds `/home/jane`. On work #1, the same move puts the work
email on `work-1` and `C:\Users\jane` on that laptop's record.

**Values in JSON files.** A value hydrated into an entry whose merge type is JSON is written as a JSON string: `\`
becomes `\\`, `"` becomes `\"`, and control characters become `\uXXXX`. Push reads the file as JSON, so it finds the
value in the parsed string and needs no doubled form. This replaces `escapeBackslashes` for JSON entries. Non-JSON
files that need doubled backslashes (`.gitconfig.local` with `<GH_CLI_PATH>`) keep `escapeBackslashes`.

Example: on work #1, `<HOME>` is `C:\Users\jane`. A Claude `settings.json` line `"command": "<HOME>/.claude/hooks/x.sh"`
is written as `"command": "C:\\Users\\jane/.claude/hooks/x.sh"`, valid JSON. Without escaping it would be
`"C:\Users\jane/…"`, which is invalid JSON (`\U` and `\j` aren't escapes). A name with quotes, `Jane "JJ" Doe`, becomes
`"Jane \"JJ\" Doe"`.

## Merge and split

Pull **merges** an entry's layers into the local file. Push **splits** a changed local file back into its layers. The
two must be exact opposites: pull right after push writes the same bytes, and push right after pull finds nothing.

### Merging a JSON file

1. **Objects** merge key by key, in layer order (base, OS, profile, machine). A key set by one layer only is copied. A
   key set by two: if both values are objects, they merge the same way; otherwise the later layer's value wins.
2. **Arrays** merge by item. The result is the base's items in the base's order, then each later layer's items that
   aren't there yet, in that layer's order. Two items are the same when they are equal as JSON (same keys and values,
   key order ignored). This covers `permissions.allow`, each `hooks.<event>[]`, and VS Code lists such as
   `chat.plugins.marketplaces`: a layer adds items and never needs to repeat the base's.
3. **Key order:** the base's keys in the base's order, then keys that only later layers have, in the order those layers
   list them. The order of a layer's file is the order it's written in the repo.
4. **Layout:** two-space indent, one key per line, `": "` after a key, empty objects and arrays as `{}` and `[]`, and a
   trailing newline, which is how the synced JSON files are written today. Non-ASCII characters are written as
   themselves, not `\u` escapes.
5. **Line endings:** CRLF on Windows, LF elsewhere. The repo's layer files are always LF.

Values are hydrated into each layer before the merge, JSON-escaped ("Values"), so a placeholder never decides whether
two array items are equal.

Example: the base Claude `settings.json` has `"permissions": {"allow": ["Bash(git:*)"], "defaultMode": "auto"}`. The
OS layer for Windows has `"permissions": {"allow": ["PowerShell(Get-ChildItem:*)"]}`. Work #1 gets `allow` with both
items, git first, and `defaultMode` from the base.

### Splitting a changed file

Push reads the local file as it is and compares it, parsed, with what pull would write now (values hydrated). Whitespace, key
order and line endings aren't changes; a different value, a new or missing key, or a new or missing array item is.
Each change goes to one layer:

- a changed or removed key goes to the layer it came from (the latest layer that sets it);
- a new key or a new array item is a new setting: the preview asks where it goes ("New settings"), unless the profile's
  `destinations` already says;
- a removed array item is removed from the layer that added it.

The preview shows each change under the machines that receive it ("Push and pull"), so a change to a base key is
listed under "all machines" and can be moved to a narrower layer there, where it becomes an override.

Values are sanitized before a change is stored: the layer gets `<HOME>`, never `C:\Users\jane`.

### Case 1: A key changed that lives in the base

Personal Linux changes `"editor.fontSize"` from 14 to 15 in VS Code. The key comes from the base, so push stores 15 in
the base `settings.json`. The preview lists it under "all machines": work #1 to #3 get 15 on their next pull. To keep it
on this machine only, the user moves it to "this machine" in the preview; the base keeps 14 and the machine record
gets an override of 15.

### Case 2: A key changed that a module's layer sets

Work #1 changes `"http.proxy"`, which the `work-1` profile layer sets. Push stores the new address in that layer. The
preview lists it under "this profile"; personal Linux never sees it, because it never had the key.

### Case 3: A new array item

Work #1 adds a third marketplace to `"chat.plugins.marketplaces"`. The item is new, so it's a new setting: the preview
asks where it goes and suggests "this profile" (a work machine). The answer `profile` stores the item in the `work-1`
layer. The base's two items stay where they are.

### Case 4: A removed array item

Work #1 removes `"github/awesome-copilot#marketplace"`, which the base adds. Push removes it from the base, and the
preview lists the removal under "all machines". Removing it on one machine only would need a way for a later layer to
take an item out; there isn't one yet (see "Removing a key in a later layer" in "Open"), so the preview says the
removal can only go to all machines, or be skipped.

### Case 5: Claude Code rewrites `settings.json` itself

Claude Code writes its own `settings.json` when a permission is granted ("always allow") or a setting is changed with
a slash command. A grant adds an item to `permissions.allow`: a new array item, case 3, so the preview asks and, on a
work machine, suggests "this profile". Changing the model with `/model` writes `"model"`: if a layer already sets it,
case 1 or 2; if not, a new top-level key, case 6. Claude Code may also rewrite the file with its own key order or
spacing; push ignores both, since it compares parsed JSON.

Example: on work #1 the user answers "always allow" for `Bash(work-tool-1 status)`. Push shows one new setting,
suggests "this profile", and stores it in the `work-1` layer. Personal Linux never gets the work tool's permission.

### Case 6: A new top-level key

Personal Linux sets `"chat.agent.enabled": true` in VS Code, a key no layer has. Push asks where it goes and suggests
"all machines" (a personal machine). The key goes to that layer. Nothing goes to `destinations`: from now on the key
has a layer, so a later change to it is case 1 or 2, never a new setting again.

### Case 7: An edit to `CLAUDE.md` inside the base text

The local `~/.claude/CLAUDE.md` is the base text followed by the engine's import block (case 8). An edit above the
block belongs to the base text: push compares that part with the base file, line by line after folding CRLF to LF,
and stores the new text in the base. The preview lists it under "all machines". Text meant for one profile goes in
that profile's file instead, which the user edits directly (`~/.claude/CLAUDE.work-1.md`).

### Case 8: An edit to an `@import` line in `CLAUDE.md`

The import block is the last lines of the local `CLAUDE.md`, after a marker line the engine writes:

```markdown
<!-- mksync: layers below are written by mksync pull -->

@CLAUDE.windows.md
@CLAUDE.work-1.md
```

It has one line per layer file that exists, in layer order. The engine owns the block: push doesn't store it anywhere,
and pull writes it again. If the user edits or deletes a line in the block, push shows `CLAUDE.md: import block is
written by mksync, edit not pushed` and pull puts the block back (after the `.bak`). An `@import` the user writes
above the marker, such as today's `@RTK.md`, is base text, case 7.

### Case 9: A file saved with CRLF on Windows

An editor on work #1 saves `settings.json` or `CLAUDE.md` with CRLF. JSON is compared parsed, and text is compared with
CRLF folded to LF, so line endings alone are not a change and push finds nothing. A real edit in a CRLF file is
stored with LF. Pull writes CRLF on Windows, so the next push finds nothing either.

### Local edits that aren't in any layer

Pull keeps today's rule: if a file changed on this machine since the last sync point (`OUT` or `BOTH` in `mksync
diff`), pull stops and says to push first, or `--force` overwrites after writing `<file>.bak`. The layers don't change
this: a local edit is either pushed, and then it's in a layer, or overwritten with a backup.

One addition for JSON files: an entry may list keys that are this machine's state, not settings (Claude Code keeps
some in `settings.json`). Those keys are never pushed, and pull keeps their local values instead of removing them.
Which keys go on that list is in "Open".

## Machine records

Each machine has one record. It says who the machine is and holds what belongs to it alone:

```json
{
  "name": "wk1-laptop",
  "profile": "work-1",
  "os": "windows",
  "hostname": "wk1-laptop",
  "domain": "corp.example.com",
  "claude": "claude",
  "pullOnly": false,
  "modules": { "add": [], "remove": ["windows-terminal"] },
  "values": {
    "<HOME>": "C:\\Users\\jane",
    "<GH_CLI_PATH>": "C:\\Tools\\gh\\bin\\gh.exe"
  },
  "replaced": [],
  "retired": false
}
```

- `name`: the record's name, chosen on the first run (the hostname by default). It never changes, so a replacement
  machine keeps it.
- `profile`: one profile name.
- `os`: `linux`, `windows` or `macos`, from the scan.
- `hostname`, `domain`: what the scan saw when the record was made or last taken over. `domain` is the Windows domain,
  `null` elsewhere.
- `claude`: `none`, `claude` or `claude-deepseek`, the second question's answer.
- `pullOnly`: `true` when the third answer was "pull only". Push then refuses (`this machine is pull-only`, exit 1).
- `modules`: modules switched on or off for this machine only, on top of the profile's list. `add` takes only modules
  this OS can run.
- `values`: the machine's values ("Values"), such as paths.
- `replaced`: one line per takeover, `{"hostname": …, "date": …}`, oldest first.
- `retired`: `true` once the machine is gone.

The machine layer's files (overrides from "Layers") sit next to the record.

**Where it's kept.** Until the repo is private, in the machine's local state: `~/.local/state/sync-settings/` on Linux
and macOS, `%LOCALAPPDATA%\sync-settings\` on Windows, as `machine.json`, with the profile it uses under `profiles/`.
After the switch, in the repo as `machines/<name>.json`, and the local state keeps only a pointer,
`{"name": "<name>", "home": "repo"}`, written by the first private push; reading a record never needs the network, only
the guard does.

A machine with no record (every machine before its first `mksync setup`) runs as in phase 5 with no profile: no profile
or machine layer, every module on, values from `.user-values.json`. The record replaced phase 5's `SYNC_PROFILE` and
`SYNC_MACHINE` stand-ins in phase 6.

Example: personal Linux's record is `{"name": "personal-linux", "profile": "personal", "os": "linux", "claude":
"claude-deepseek", "pullOnly": false, …}` with `<HOME>` = `/home/jane` in its values.

## First run

`mksync setup` on a machine with no record. It scans, shows what it found, asks four questions, writes the record,
then runs the first pull. The exact output on a new work #1 laptop:

```text
$ mksync setup
Scanning this machine...
  OS         windows
  Hostname   wk1-laptop
  Domain     corp.example.com
  Git email  jane@work1.example.com
  Tools      git, gh, code, claude (not found: jq, wezterm)
  Files      9 of 14 Windows entries already exist here

Profiles in this repo:
  1) personal
  2) work-1      machine wk1-laptop
  3) work-3      machine wk3-desktop
  This looks like wk1-laptop (same hostname): choosing 2 replaces it.

1/4 What is this machine for? [2]
2/4 Claude here? 1) none  2) Claude only  3) Claude plus DeepSeek [2]
3/4 Push with a preview, or pull only? 1) push with a preview  2) pull only [1]
4/4 Files that are already here? 1) back up and replace  2) keep mine, push them first  3) stop [1]

Machine wk1-laptop: profile work-1, Claude only, push with a preview.
Same as: mksync setup --profile work-1 --replace wk1-laptop --claude claude --mode push --existing backup
```

The suggested answers, in brackets:

1. **The profile.** The profile of the one non-retired record whose hostname is exactly this one, with "replaces
   `<machine>`". With no exact match, or two or more (a reinstalled machine's hostname coming back), there is no
   suggestion and no scoring: the user picks a number or types a new profile name. Retired profiles aren't listed.
2. **Claude.** "Claude only" when the scan found `claude`, else "none". DeepSeek is never suggested; it's chosen.
3. **Push or pull only.** "Push with a preview".
4. **Existing files.** "Back up and replace": each file is backed up as `<file>.bak` before the pull writes it, as
   today. "Keep mine" runs a push (with its preview) before the pull; "stop" ends without writing anything but the
   record. Until the program can commit (phase 8), "keep mine" runs `export` then `import` and prints `Pushed into the
repo folder; commit it with mksync push.`

**Before the repo is private** the repo holds no profiles or records, so the first run lists only `personal` and the
profiles kept in this machine's local state (none, on a new machine), and makes no "replaces" suggestion. The user
types a profile name, and the new profile starts with an empty module list filled from the scan's suggestions. Each
machine then has its own copy of its profile: values and `destinations` aren't shared between two machines of one job
until the switch. The example above is the first run after the switch.

A question takes its flag; without one, it's asked, and an empty answer or end of input takes the suggestion in
brackets. `--yes` takes every suggestion without asking. A question with no suggestion (the profile, unless a record has
this hostname) that gets end of input, or `--yes` and no flag, stops with `ERROR: missing --profile` (exit 2) before
anything is written. `--name` with `--replace` stops with `ERROR: --name and --replace can't be used together.` (exit
1).

**Tests** replace the scan with `SYNC_HOSTNAME`, `SYNC_DOMAIN` (empty means none) and `SYNC_TOOLS` (a comma list of the
tools found), as `SYNC_OS` replaces the OS, so a shared case prints the same scan on every runner.

**`mksync machine show`** prints the record:

```text
$ mksync machine show
machine   wk1-laptop
profile   work-1
os        windows
claude    Claude only
mode      push with a preview
modules   work-base, git, shell, vscode, claude (windows-terminal off on this machine)
```

When the hostname or domain no longer matches the record, it adds a warning on stderr and still exits 0:

```text
warning: the record says hostname wk1-laptop, this machine is wk1-new.
If this is a new machine, run: mksync setup --replace wk1-laptop
```

Pull and its check print the same warning and go on; push stops on it (exit 1), so two machines never push from one
record. Push also stops for a retired or pull-only record. The push preview only warns.

## Replace and retire

**Replace.** A new machine takes over an old one's record (`--replace <name>`, or the first run's suggestion). It
keeps the name, profile, Claude mode, pull-only and module overrides. Each machine value is asked again, with the old
value as the suggestion, because paths can differ on a new disk. `hostname` and `domain` take the new machine's, and
the old pair goes to `replaced`. The old machine, if it's still on, now gets the hostname warning and can't push.

Example: work #1's laptop dies; the new one is `wk1-new`. Its first run finds no hostname match, so there's no
suggestion; the user types `--replace wk1-laptop`. The record stays `wk1-laptop`, with `hostname: wk1-new` and one line
in `replaced`.

**Retire.** A machine record gets `retired: true` when the machine is gone for good; a profile gets it when the job
ends. Nothing is deleted: the repo keeps both as the last backup. A retired profile isn't offered on a first run; a
retired machine isn't offered for `--replace` and can't push. Retiring a profile doesn't retire its machines: each is
retired or moved to another profile on its own, and a profile still used by a record that isn't retired can't be
retired (`profile work-1 is used by machine wk1-laptop`, exit 1). Both ask `[y/N]` first; `--yes` answers.

**While public** a new machine has no local records, so `--replace wk1-laptop` there stops with `no machine wk1-laptop
here; records are shared once the repo is private.` (exit 1). Replace proper needs the repo store, which tests reach
with `MKSYNC_VISIBILITY=private` fixtures. A rerun of `setup` on a machine that has a record stops too, pointing to
`--replace`.

Example: on personal Linux, `mksync profile retire personal` is refused while `personal-linux` uses it; `mksync machine
retire personal-linux --yes` first, then the profile can be retired.

## Public-repo guard

Until the repo is private, profiles, machine records and values never reach it. The guard enforces that on every push.

- **Reading the visibility.** For an `origin` on `github.com`, push asks GitHub: `gh repo view --json visibility` when
  `gh` is signed in, otherwise the public API (`GET /repos/<owner>/<repo>`, which answers only for public repos). Any
  failure, such as no network, counts as public: the guard fails closed. For any other `origin` (a local path, as the
  fixtures use) it reads `MKSYNC_VISIBILITY` (`public` or `private`) and defaults to public.
- **What it refuses.** While public, push never stages `profiles/`, `machines/` or a values file. If one is already
  staged or committed on the branch, push stops before pushing:

  ```text
  refused: the repo is public, so machines/wk1-laptop.json can't be pushed.
  It is kept on this machine and goes in with the first push after the repo is private.
  ```

  and exits 1. In a normal push, the held files show in the preview as `held until the repo is private: 2 files`, and
  the push goes on with the rest (exit 0).

- **The first push after going private.** The guard now reads private. The preview gets a group "first backup:
  profiles and machines", with each local profile and record, values included. Push commits them under `profiles/`
  and `machines/` in the same PR as any other change. From then on the repo is their home and local state keeps only
  the record's name.
- **Tests.** Fixtures push to a local bare repo, so they set `MKSYNC_VISIBILITY` to test both sides. The variable is
  ignored for a `github.com` origin, so it can't switch the guard off on the real repo.

**Built in phase 6:** reading the visibility (from the push URL, with SSH host aliases resolved by `ssh -G`), the held
line in `export --preview`, and the refusal in `export` when the clone already tracks `profiles/` or `machines/` in any
letter case. The "first backup" group waits for phase 7; merging two machines' copies of one profile exists as a core
function (`mergeProfileCopies`) that phase 7 wires into the first private push.

Example: today, personal Linux pushes a VS Code change. The preview shows the change and `held until the repo is
private: profiles/personal.json, machines/personal-linux.json`; the PR has the VS Code change only.

## Push and pull

**Push** always shows a preview before anything leaves the machine. Changes are grouped by who receives them, widest
first, and numbered so one can be moved to another group. The exact output on work #1:

```text
$ mksync push
Changes on wk1-laptop (profile work-1):

All machines
  1  M  vscode  settings.json      editor.fontSize: 14 -> 15
Windows machines
  2  M  git     .gitconfig.local   1 line changed
Profile work-1
  3  +  claude  settings.json      permissions.allow: Bash(work-tool-1 status)
This machine only
     (none)

New settings
  4  +  vscode  settings.json      chat.agent.enabled: true
     Where does it go? 1) all machines  2) Windows machines  3) profile work-1  4) this machine [3]

Held until the repo is private: machines/wk1-laptop.json, profiles/work-1.json

Move a change? Type its number, or press Enter to go on:
Open a PR with these changes? [Y/n]
```

- A line is `<number> <M|+|-> <module> <file> <what>`: a changed key with old and new value, an added or removed item,
  or a line count for text files. Values are shown sanitized (`<YOUR_EMAIL>`), never raw.
- Moving a change asks for its new group with the same four choices. Moving a base key to a narrower group stores an
  override there and leaves the base as it was (case 1).
- **`--yes`** skips the questions, not the preview or the rules: the preview prints, each new setting takes its stored
  destination or the suggestion, nothing is moved, and the PR opens. The profile-value rule and the public-repo guard
  still stop it.
- The PR, branch and exit codes are today's (`sync/<os>-…`, never `master`; 0, or 1 on an error).
- **Pull-only** machines have no push: `mksync push` prints `this machine is pull-only (see mksync machine show)` and exits 1,
  and `mksync status` never suggests it.

**Pull** stays today's command: the guard against unpushed local edits, `Apply these changes? [Y/n]`, `.bak` before
each write, the sync point. Its list of changes uses the same groups, so the user sees that a change arrives from "all
machines" or from "profile work-1".

## New settings

A new key, a new array item or a new file in a `dir` entry has no layer yet, so push asks where it goes.

- **The suggestion:** "this profile" on any work profile, "all machines" on `personal`. A work machine's new settings
  stay with the job unless the user widens them; the personal machine shares by default.
- **Where the answer is stored:** the setting goes into the chosen layer. A new key needs nothing more: it now has a
  layer. A new array item or a new file in a folder is different, because the next one is new again, so the answer
  also goes into the profile's `destinations`, keyed by module, file and path (`claude settings.json:
permissions.allow`, `vscode snippets/`). The next item there goes to the same place without asking; it still shows
  in the preview.
- Every machine with that profile reads the same `destinations`, so work #1's answer holds on any later work #1
  machine.
- Whole-file entries have no new settings: a new line belongs to the layer that owns the file.

Example: on personal Linux, Claude grants `Bash(npm test:*)`. The first time, push asks about `permissions.allow` and
suggests "all machines"; the user picks "this machine". Every later grant on personal Linux goes there without the
question, listed under "This machine only".

## Profile values

A profile's values must not leave the profile. Push checks every change bound for a layer wider than the profile
(all machines, an OS): if its text holds one of this profile's `values` literally, ignoring case, push refuses it:

```text
refused: change 1 (vscode settings.json) holds a value of profile work-1 (<YOUR_EMAIL>) and would reach all machines.
Move it to "profile work-1", or put <YOUR_EMAIL> in the file instead.
```

and exits 1 without opening a PR. The message names the placeholder, never the value.

This is a literal match only. It doesn't catch a value written another way (`jane` from `jane@work1.example.com`, a
hostname inside a URL, a value encoded or split), another profile's values, or names never stored as a value. Those are
the leak scan's job (`scripts/ci/leak-scan.sh`, and the CI check), which looks for names, emails, hostnames and home
paths in the whole repo. Neither is a guarantee, so the design doesn't present one as such.

Example: on work #1 the user pastes the work email into the base VS Code `settings.json` as a Git author setting. The
change is bound for all machines and holds `<YOUR_EMAIL>`'s value of `work-1`, so push refuses it. Moving it to
"profile work-1" lets it through.

## Decided in phase 7

The plan's decisions (`docs/archive/plan-single-engine-7.md`), as rules. Exact lines are in the contract's program sections
("Push preview", "New settings", "Profile values", "Statusline", "Public-repo guard", "Retire", "Import check").

- **The push side until phase 8 is `mksync export`.** `export --preview` prints the grouped block, `export` prints it,
  asks, checks the profile values, then writes. The front door's `mksync push` and the PR come in phase 8, with
  "Move a change?". Example: on work #1, `dist/mksync export --preview` shows `Profile work-1` with the new
  `permissions.allow[]` item; nothing is written.
- **A block only when something changes.** A run with nothing to send prints what it printed before phase 7, so the
  older cases keep their output.
- **One group per layer written.** A changed key the base sets is under "All machines", even on a work machine,
  because that's where the change lands. Example: on work #1, `editor.fontSize` 14 → 15 in the base `settings.json` is
  line 1 under "All machines": pushing it changes personal Linux too, which is why it's shown first.
- **The suggestion is by profile name.** `personal` suggests "all machines", any other profile "profile <p>". A stored
  destination for an array path answers before any suggestion. Example: personal Linux answers `4` once for a new
  `permissions.allow[]` item; the profile's `destinations` now holds
  `"claude settings.json: permissions.allow[]": "machine"` (module, file and key path, so the same path in another
  file is asked on its own), and later grants go to the machine layer with no question. A path's new items are listed
  together and asked once.
- **"All machines" is a stored answer too.** `destinations` accepts `base`, so personal's default sticks.
- **No record, no question.** The question needs a profile to store the answer, so a machine before `setup` keeps
  the `needs a destination` error.
- **The profile-value rule searches the written text.** It runs after sanitize, so a value the entry's own rule turns
  into its placeholder never trips it; a value the entry has no rule for does. Example: the work email pasted into the
  base VS Code `settings.json` (no `<YOUR_EMAIL>` rule there) is refused; the same email in `.gitconfig`, whose rule
  turns it into `<YOUR_EMAIL>`, goes through.
- **The statusline is one program, colors always on.** `mksync statusline` prints what `statusline.sh` prints, ANSI
  included, under Git Bash or PowerShell; Load and Memory are Linux and macOS only. Its hand tweaks go through the
  source ("Statusline and hooks on Windows").
- **The Claude layout waited for cut-over.** The v1/v2 check refused a v2 entry that covers an OS its v1 twin doesn't,
  and v1 was frozen, so the split `settings.json` (a base for every OS, a Linux overlay with `hooks` and the keys that
  hold `<HOME>` or a `.sh` path, a Windows overlay) and the Windows rows in the catalog were written by
  `tools/claude-layout.ts` and run at the cut-over (phase 9). Decided in the cut-over plan's review (2026-11-18): the
  Linux overlay also takes the personal-only keys `enabledPlugins`, `extraKnownMarketplaces`, `permissions`,
  `autoMode` and `skipDangerousModePermissionPrompt`, since a `personal` profile layer can't be committed while the
  repo is public and the only Linux machine is personal; phase 10 moves them to `profiles/personal/`. The base keeps
  the shared keys (`model`, `effortLevel`, `modelSettings`, `statusLine`, `theme`, `tui`, the notification flags,
  `cleanupPeriodDays`, `autoUpdatesChannel`), so a work machine's own plugins, marketplaces and permissions stay its
  own. `<HOME>` stays a placeholder: `hooks` is Linux-only and `statusLine` becomes `mksync statusline`, which holds
  no path.
- **The first backup merges, then points.** The first private export copies the record, the profile and their layer
  folders into the repo, merging with a profile copy already there; only after every write succeeds does
  `machine.json` become the pointer, so a failed backup leaves the machine as it was. Example: work #1's laptop backs
  up `profiles/work-1.json`; later the desktop's first backup finds it, adds its own module, and asks about the one
  value that differs.
- **The Windows survey runs once, early.** One prompt on work machine #1 (`docs/archive/windows-survey.md`) answers "Confirm
  on Windows" with names and shapes only.

## Decided in phase 8

The plan's decisions (`docs/archive/plan-single-engine-8.md`), as rules. Exact lines are in the contract ("The program",
"Diff", "Checks before pushing", "dconf entries", "Package drift", "Front door", "Move a change", "Linked folders").

- **Old verbs and new commands side by side.** The program keeps `export` and `import`, gains `export --diff`,
  `import --reset-values` and `commit`, and takes the front door's `status`, `doctor`, `pull`, `push`, `diff`,
  `check` and `preview` as its own. Example: the shared case `commit-opens-pr` runs `mksync export` then
  `mksync commit` against the program, and `export.sh` then `commit.sh` against bash.
- **Diff without a temp folder.** `base` and `theirs` come from git objects; `mine` is `base` with the export's writes
  applied in memory. Example: on personal Linux, `.bashrc` edited since the last sync reads `OUT` without any copy of
  the clone being made.
- **Commit is the program's,** with one new check: the guard reads the unpushed commits too. Example: a profile file
  committed by hand and then `git rm --cached` is still refused while the repo is public, since pushing the branch
  would publish the first commit (settles "Left by the phase 6 audits", the first item).
- **The leak scan stays bash.** The program runs `scripts/ci/leak-scan.sh`. Example: a work machine without Git Bash
  can't push until it has one; the survey says whether that happens.
- **dconf through stubs.** The shared cases stub `dconf` and `getent`, so the dconf rules run against bash and the
  program without a session bus. Example: `dconf-keys-filter` dumps a fixture `.ini` and expects the filtered repo
  file.
- **Drift stays in export and preview,** as the contract says; `docs/archive/design-test-moves.md`'s "moves into `mksync
doctor`" is replaced by one `WARN drift` line in doctor. Example: on personal Linux, `mksync doctor` says
  `WARN drift: 3 package(s) differ; run mksync preview`, and the preview lists them.
- **Pull doesn't re-run itself.** The program reads the config again after the fast-forward. Example: a pull that
  brings a new entry applies it in the same run.
- **Move a change.** A key moved narrower is an override; moved wider, it leaves the old layer. This machine's merged
  files never change by a move. Example: on work #1, `editor.fontSize` 14 → 15 in the base moved to "profile work-1"
  leaves the base at 14 for personal Linux and writes 15 into the profile's layer.
- **Linked folders become `dir` entries** in a profile's or record's `entries`, asked once by `setup`. Example: on
  work #1, `.bashrc` sources `~/work-tool-1-scripts`; setup suggests "this profile", and the folder syncs as
  `profiles/work-1/linked/work-tool-1-scripts/`.
- **The port has its own plan.** The old cases without a shared twin (`docs/archive/design-test-moves.md`) are ported by
  `docs/archive/plan-single-engine-8-port.md`, except the dconf and drift groups, which phase 8 ports with their rules.

## Decided in phase 8, the port

The port plan's decisions (`docs/archive/plan-single-engine-8-port.md`), as rules. Its inventory, `docs/archive/port-inventory.tsv`,
gives every old case of `docs/archive/design-test-moves.md` a verdict.

- **Ported cases check the text the old case checked.** A shared case may add `expect/lines.txt`: lines that must
  appear in each command's output, in order, other lines allowed between them; `! <text>` must not appear; `# <n>`
  starts command `n`'s lines. Status lines read `WORD label note` with single spaces on every engine. Example:
  `only-no-file-import` expects `WARNING: --only matched no file.`, a line the status-line check drops.
- **What the runner can't set up stays a unit or adapter test:** a write failure, a symlink in `home/`, an
  unreachable origin, a failing `gh`, a real dconf bus, the package managers. The runner doesn't grow for them.
  Example: `error-continues` (a read-only repo file) is an `export.test.ts` case with a failing write action.
- **Gaps are fixed contract first.** Where the program breaks a rule the contract already states, the port writes
  the case, then the fix: a symlink under `dotfiles/`, `--only` with a `dir` entry's folder, LF for shared files
  exported on Windows, the preview's `--stat` and diff, the macOS doctor's `brew` line, and the Windows ACL on local
  state. Example: on work #1, a shared `.editorconfig` saved with CRLF is pushed with LF.
- **A local file that became a symlink in a `dir` entry** loses its repo copy (`REMOVED … no longer in source`), as
  bash does: a symlink isn't a file of the folder. Example: replacing `~/.config/fixture/dir/c.txt` with a link to
  another file removes `dotfiles/common/dir/c.txt` on the next export.
- **Push behind origin stops before the export,** as the bash front door does:
  `ERROR: origin has updates; run mksync pull first.`, exit 1. The PowerShell front door doesn't check, a Known
  difference until cut-over. Example: personal Linux pushes while work #1's PR was merged; nothing is exported until
  `mksync pull`.
- **Config lint rules move to v2 only where the rule has a v2 meaning.** The fourteen `lint-*` rules of
  `scripts/ci/check-config.sh` were decided one by one (port step 36). None is dropped: each v1 field it checks has a
  v2 field (`type` → `merge`, `path` → `dconfPath`, `sanitizeRules` → `sanitize`, `detectLinkedPaths` →
  `scanLinks`), so each keeps its meaning. Four new refusals carry twelve of them ("Config v2 error lines" in
  "Open"):
  - `can not use <field> with merge <merge>`: `sanitize` or `scanLinks` on a `dir` entry, which copies files as they
    are (`lint-dir-with-rules`); `localPath`, `sanitize` or `scanLinks` on a `dconf` entry, which loads the database
    and has no file to hydrate or scan (`lint-dconf-localpath`, `lint-dconf-rules`, `lint-dconf-linked`);
    `dconfPath` or `keys` on any other merge (`lint-keys-on-file`, `lint-path-on-dir`). The fields are checked in
    that order and the first one present is named.
  - `is inside dir entry <dir>`: an entry whose `file` starts with a `dir` entry's `file` plus `/`, whatever its
    merge (`lint-file-in-dir`, `lint-typed-file-in-dir`, `lint-dir-in-dir`). Layer roots are shared, so the two
    entries would own the same layer files. A sibling such as `d-old/x.txt` next to `d` is not inside it
    (`lint-sibling-prefix`, a case that must not be refused).
  - `has a trailing / in file`: v1 trimmed `dotfiles/linux/d/` before the inside-a-dir check
    (`lint-dir-trailing-slash`); v2 refuses the slash instead, since `file` must match the parity check's layer
    path exactly.
  - `needs keys as a non-empty list of strings`: `keys` on a `dconf` entry that is empty or not a list of strings
    (`lint-dconf-keys-empty`, `lint-dconf-keys-type`).
  - `lint-type-unknown` is already `has an unknown merge <m>`.

  Example: a config with `{"file": "vscode/snippets", "merge": "dir", "sanitize": [...]}` stops with
  `ERROR: sync-config.v2.json: entry vscode/snippets can not use sanitize with merge dir.`, exit 1.

- **Setup and bootstrap cases wait for phase 9,** with the bootstrap question, `--bootstrap` and doctor before
  setup: `sync-setup-offers-bootstrap`, `sync-setup-doctor-fails`, `front-macos-setup-no-bootstrap`,
  `front-macos-bootstrap-flag`.

## Decided in phase 9

Confirmed in the review of [plan-single-engine-9.md](archive/plan-single-engine-9.md) (2026-11-17), which holds each one's
full text and the steps that build it.

1. **Node runs the source, not a build.** `erasableSyntaxOnly` in `tsconfig.json`, every `Bun.*` call behind one process
   adapter on `node:child_process`, and `node src/main.ts` (Node 22.18 or newer, which strips types without a flag)
   runs the program from the clone with no build and no `npm install`; Bun runs `bun src/main.ts`. No
   `dist/mksync.mjs`. The oldest Bun to accept is checked on work #1 (Bun 1.3.14) in the cut-over plan.
2. **Launchers.** `mksync` and `mksync.cmd` at the repo root pick Bun or Node (`MKSYNC_RUNTIME=bun|node`; unset, Bun
   first) and stop with `ERROR: mksync needs Bun or Node 22.18 or newer to run from the clone.`, exit 2, when neither
   fits.
3. **Installers download the program; the clone stays.** SHA256 against `SHA256SUMS` (the attestation check was
   dropped in phase 10, see "Release and update"); `~/.local/bin/mksync`, or `%LOCALAPPDATA%\mksync\mksync.exe` on the user `Path`.
   `--runtime bun|node` (`SYNCSETTINGS_RUNTIME` on Windows, since `iex` passes no parameters) links the clone's
   launcher instead.
4. **Releases.** A tag `v<x.y.z>` equal to `package.json`'s `version` releases the four programs, `SHA256SUMS` (and,
   up to `v1.0.2`, a provenance attestation). First `v0.9.0`, tagged by the user; `v1.0.0` after the old engines are deleted.
5. **`mksync update`** replaces the program only with a newer release, checked as the installers check; on Windows
   through `mksync.old.exe`, deleted on the next start. Run from the clone it refuses (`git pull` updates it). No
   `--check`.
6. **A newer `schemaVersion`** stops with `ERROR: sync-config.v2.json: this config needs a newer mksync: run mksync
update.`, exit 2, before anything else; also after a pull that fast-forwards to one.
7. **Usage errors exit 2** in the program: unknown option, clashing flags, a repeated flag, an unknown verb in a
   group. The old engines keep 1 until they are deleted.
8. **Typed answers** are trimmed of spaces, tabs and `\r` at both ends; only spaces is empty.
9. **The overwrite prompt** is asked per file as import reaches it, one line read at a time.
10. **Links and atomic writes.** State and repo writes go through a temp file and a rename (0600 for state); a state
    or repo path that is a symlink is refused with `ERROR: <path> is a symlink.`, exit 1. Home writes keep following
    links; a link inside a `dir` entry's folder is `SKIPPED <path> (symlink)`. 0600 means values, records, profiles
    and `machine.json`; the sync point and dconf backups keep their mode, as the shared cases pin it (step 14).
11. **Config paths checked on read.** An empty, absolute, `..` or `\` entry `file` is
    `ERROR: sync-config.v2.json: entry <file> has an unsafe path.`; an `import` entry without `{layer}` in
    `importName` is `ERROR: sync-config.v2.json: entry <file> needs {layer} in importName.`; both exit 1.
12. **Front door.** `export`, `import` and `commit` still run but leave the usage line; `update` joins it; `shadow`
    stays hidden and goes with the old engines.
13. **No ESLint.** `tsc --noEmit` with `strict` and `erasableSyntaxOnly` is the lint.

## Linked folders

Some shell files point at folders of their own, such as a `scripts` folder that `.bashrc` sources. Today the
PowerShell engine copies them under `<repoPath>.linked/` (`detectLinkedPaths`).

- **The scan.** The first run, and `mksync status` afterwards, read the files of entries marked for linked folders and
  list each folder they point to that exists and isn't synced yet. Each one is asked about once:

  ```text
  .bashrc uses ~/work-tool-1-scripts (12 files, 40 KB). Sync it as a folder? 1) this profile  2) this machine  3) no [1]
  ```

  The suggestion is "this profile" for a folder under the home with fewer than 1000 files and under 10 MB, and "no"
  otherwise. A yes becomes a `dir` entry in that layer; a no is remembered in the profile's `destinations` and not
  asked again.

- **Cut-over.** Each tree under `dotfiles/windows/shell/.bashrc.linked/<folder>/` became a `dir` entry with the same
  local folder, moved with `git mv` so its history follows (cut-over decision 4). `detectLinkedPaths` and the
  `.linked/` layout were then removed.

## Config v2

`mksync` reads `sync-config.json` (`sync-config.v2.json` in a clone from before v1.0.0). Its full shape is in `docs/config-v2.example.json`, which has one entry of
each merge type.

**Top level**

- `schemaVersion`: `2`. The engine refuses any other number (`unsupported config schemaVersion 3`, exit 2).
- `excludePatterns`: as in v1.
- `modules`: name → `{description, os}`. `os` lists where the module can run; without it, every OS.
- `entries`: one per synced thing.

**An entry**

- `file`: the path inside a layer root, the same on every layer (`vscode/settings.json`).
- `module`: one name from `modules`.
- `merge`: `whole`, `json`, `import`, `dconf` or `dir` ("Catalog").
- `localPath`: where it goes, written with `~/` and `/` on every OS; the Windows adapter turns it into
  `%USERPROFILE%\…`. `localPaths` overrides it per OS.
- `os`: limits the entry to some OSes, inside its module's.
- `sanitize`: the placeholders this file may hold, each with `prompt`, and optionally `default`, `defaultEnv`,
  `escapeBackslashes`. The values themselves are on the profile and the machine. `escapeBackslashes` is refused on a
  `json` entry, which escapes by itself ("Values").
- `json` only: `localOnlyKeys`, the machine-state keys from "Merge and split".
- `import` only: `importName`, the local name of each layer's file, with `{layer}` replaced by the OS, profile or
  machine name (`CLAUDE.work-1.md`).
- `dconf` only: `dconfPath` and `keys`.
- `scanLinks`: the first run and `mksync status` look for linked folders in this file ("Linked folders").
- `elevate`: reserved for the elevation wrapper ("Open"). Only `false` is accepted until it's designed.
- `description`: as in v1.

**Layer sources.** An entry has no list of sources: each layer has a root folder, and the engine looks for `file`
under each one, in layer order. A layer without the file is skipped. An entry applies on a machine when its module is
on and at least one layer has the file.

| Layer   | Root                                           |
| ------- | ---------------------------------------------- |
| base    | `dotfiles/common/`                             |
| OS      | `dotfiles/<os>/` (`linux`, `windows`, `macos`) |
| profile | `profiles/<name>/`                             |
| machine | `machines/<name>/`                             |

Example: `git/.gitconfig.local` is one v2 entry. Linux reads `dotfiles/linux/git/.gitconfig.local`, Windows
`dotfiles/windows/git/.gitconfig.local`; the three v1 entries for it become one. A `json` entry such as Claude's
`settings.json` reads every root that has `claude/settings.json` and merges them; `CLAUDE.md` (`import`) does the same
but writes each layer's file next to the base one instead of merging.

**A file no layer holds yet.** Export can meet an entry whose file is in no layer root: a new entry, before its first
export. It writes the file to the base root when the entry has no `os` or more than one, else to that OS's root. An
entry with no `os` of its own takes its module's: a `gnome` entry writes to `dotfiles/linux/`.
Example: `git/.gitconfig.local` with `os: ["linux"]` and no file yet is written to
`dotfiles/linux/git/.gitconfig.local`; `tmux/.tmux.conf` with `os: ["linux", "macos"]` goes to
`dotfiles/common/tmux/.tmux.conf`. Once a layer holds the file, export writes where it is. Profile and machine layers
never receive a new file this way: the push preview asks ("New settings").

**Which file the program reads.** `sync-config.v2.json` when the repo has one, else `sync-config.json`, converted in
memory by the same converter that made the v2 file. The shared cases only carry v1, so they run the converter every
time.

**Profiles and machines.** `profiles/<name>.json` ("Modules and profiles") and `machines/<name>.json` ("Machine
records") sit next to their layer roots. Until the repo is private they live in local state, as "Public-repo guard"
says, with the same names.

**Choosing them before machine records (phase 5).** Phase 5 builds layers before phase 6 builds machine records, so
two variables stand in for the record: `SYNC_PROFILE` and `SYNC_MACHINE`, read like `SYNC_OS`. Unset, the program has
no profile or machine layer and every module is on, as in phase 4. Set, it reads the profile from
`<state>/profiles/<name>.json`, the profile layer from `<state>/profiles/<name>/` and the machine layer from
`<state>/machines/<name>/`; it never reads `profiles/` or `machines/` from the repo while it's public. Phase 6
removed both variables: the record ("Machine records") names the profile and the machine.
Example: `SYNC_PROFILE=work-1 mksync import` on a test machine with `<state>/profiles/work-1.json` listing `vscode`
and `<state>/profiles/work-1/vscode/settings.json` holding `{"http.proxy": "http://proxy.example.com:8080"}` imports
VS Code's settings with the proxy merged in, and skips every entry of a module `work-1` doesn't list.

### v2 while the old engines read v1 (until cut-over)

Decision: `sync-config.v2.json` was a separate, hand-edited file from phase 4 on, made once by a converter from v1,
and a CI check kept the two in step until cut-over. v2 is the file that survived, so it was the one people edited and
read as written. Generating it from v1 would have needed a third file for what v1 can't say (modules, merge types) and
made v2 a build output until cut-over. The old engines were frozen to bug fixes from phase 4, so new entries were rare
and the check was cheap.

- **The converter** ran once in phase 4 and applied the table below. Its output was reviewed and committed.
- **The check** ran in CI and in the local test command. For every v1 entry there had to be a v2 entry with the same
  layer file, the same local path on each OS, the same placeholders and the same dconf keys, and the reverse for every
  v2 entry that had a v1 counterpart.
- **At cut-over** the v1 `sync-config.json` and the check were deleted, and `sync-config.v2.json` was renamed
  `sync-config.json` (still `schemaVersion: 2`).
- **The file read (cut-over plan, decisions 7 and 8).** From `v0.9.0`, `loadConfig` reads `sync-config.v2.json` when
  present, else `sync-config.json`, picking the parser by the file's own `schemaVersion`; so a `v0.9.0` program reads
  the renamed file. Then v1 was dropped: the shared cases move from `config` to the `configV2` that `convertV1` makes,
  `v1.ts`, `convert.ts` and the converter go, and a `sync-config.json` with no `schemaVersion` stops with exit 2.
  `sync-config.v2.json` is still read first, so a machine that updates the program before it pulls loads its old
  clone.

### v1 to v2, field by field

| v1 field            | v2                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`           | `schemaVersion: 2`                                                                                                                                                                   |
| `defaultUser`       | dropped: no engine read it, and `-User` went at cut-over                                                                                                                             |
| `excludePatterns`   | `excludePatterns`, unchanged                                                                                                                                                         |
| `files`             | `entries`                                                                                                                                                                            |
| `repoPath`          | split into a layer root and `file`: `dotfiles/linux/git/.gitconfig.local` is the Linux OS layer of `git/.gitconfig.local`. v1 entries that differ only by OS folder become one entry |
| `localPath`         | `localPath`, with `~\` turned into `~/` and `\` into `/`                                                                                                                             |
| `localPaths`        | `localPaths`, same rewrite                                                                                                                                                           |
| `platform`          | which layer root holds the file, plus `os` when the entry is narrower than its module. `common` with no list: no `os`. A list such as `["linux", "macos"]`: `os` with that list      |
| `description`       | `description`, unchanged                                                                                                                                                             |
| `type`              | `merge`: `dir` → `dir`, `dconf` → `dconf`, absent → `whole`, then `json` or `import` set by hand on the entries the catalog marks so                                                 |
| `sanitizeRules`     | `sanitize`, same fields; values move to the profile and machine ("Values")                                                                                                           |
| `detectLinkedPaths` | `linked: true`; the `.linked/` trees became `dir` entries ("Linked folders")                                                                                                         |
| `keys`              | `keys`, unchanged (dconf only)                                                                                                                                                       |
| `path`              | `dconfPath` (dconf only), renamed because `file` now names the repo side                                                                                                             |

## Runtime

The research probe (`docs/archive/single-engine-research.md` section 3) built the same `main.ts` with Bun 1.4.4 and Deno 2.9.8
on four runners. Node SEA wasn't probed.

|                                                                  | Bun                               | Deno          | Node SEA                                             |
| ---------------------------------------------------------------- | --------------------------------- | ------------- | ---------------------------------------------------- |
| Built unchanged on Linux x64 and arm64, macOS arm64, Windows x64 | yes                               | yes           | not tried                                            |
| Start-up per run, Linux x64 / macOS / Windows (ms)               | 16 / 53 / 58                      | 54 / 54 / 103 | not measured                                         |
| Size raw, Windows x64 (MB)                                       | 115                               | 80            | not measured                                         |
| Size compressed, Windows x64 (MB): gzip -6 / zstd -19 / xz -9    | 55 / 44 / 41                      | not measured  | not measured                                         |
| Cross-builds every target from one Linux job                     | yes, sizes match native builds    | yes           | no: needs each target's `node` binary and `postject` |
| Cross-built macOS program carries a code signature               | yes (`LC_CODE_SIGNATURE` present) | not checked   | not tried                                            |

The compressed sizes and the signature were measured on 2026-11-10 on this Linux machine, from Bun 1.4.4
cross-builds of the same probe (Linux x64 52 / 41 / 38 MB and macOS arm64 41 / 31 / 26 MB, same order). The signature
was found by reading the Mach-O load commands; whether macOS accepts it wasn't tried on a Mac, which the
`macos-checks` CI job can do in phase 4.

Decision: Bun. It starts fastest where it matters (Linux and Windows), builds every target from one Linux job, and
ran the probe unchanged everywhere. Deno's smaller program doesn't outweigh twice the start-up on Windows, where the
statusline runs on every refresh ("Statusline and hooks on Windows"). Node SEA would need a build per target and has no
numbers; it isn't worth a second probe while Bun meets every need. The project's `ts-npm` and `ts-add-package` skills
assume npm, so they're adapted to `bun add` and `bun.lock` in phase 4.

**What the program needs on a machine:** nothing. No Bun, no Node: the installer downloads one file.

**Gatekeeper and SmartScreen.** Both warn only on a file marked as downloaded from the internet (quarantine flag on
macOS, Mark of the Web on Windows). Browsers set the mark; `curl` and PowerShell's `irm`/`Invoke-WebRequest` don't, so
the installers' downloads should run without a prompt. This is the documented behavior, not tried on a real machine.
Apple Silicon also refuses unsigned code outright, so the macOS program needs at least an ad-hoc signature (above).
No paid signing (Apple notarization, a Windows certificate) while the installers download from a script.

**Two ways to run.** The program is the first: nothing to install. The second runs from the clone on a runtime the
user picks, Bun or Node, for a machine that blocks the unsigned program (AppLocker, Defender policy) or a user who
prefers it ("Open", "Run from the clone on Bun or Node"). Same code, same tests, only slower to start: the runtime
compiles the TypeScript on every start, where the program carries it compiled already.

## Code layout

```text
src/
  core/        pure: no file, process or network access
    config/    read and validate config v2, profiles, machine records
    layers/    which modules, entries and layer files apply to this machine
    merge/     one strategy per merge type: whole.ts, json.ts, import.ts, dconf.ts, dir.ts
    values/    sanitize, hydrate, JSON escaping, inference
    plan/      pull and push plans: a list of actions from a snapshot of files
    preview/   grouping by receiver and the exact text of the preview
    guard/     public-repo guard and profile-value rule
  adapters/    run the actions: linux.ts, windows.ts, macos.ts, plus git.ts, gh.ts, dconf.ts
  cli/         command parsing and help (the cli skill's rules load here)
  wizard/      the first run (the wizard skill's rules load here)
  main.ts      wires cli, adapters and core
```

- **The core is pure.** It gets a snapshot (config, layer files, local files, values, OS, line ending) and returns
  actions (`write`, `backup`, `chmod`, `dconfLoad`, `git`…) and the text to print. The core never imports an adapter.
  This is what lets the unit tests simulate Windows on Linux.
- **One merge strategy per type**, each with `merge(layers) → file` and `split(file, layers) → changes per layer`. The
  nine cases of "Merge and split" are their first tests.
- **Adapters** do the I/O for one OS: paths (`~/` to `%USERPROFILE%\`), line endings, file modes, backups, dconf, the
  state folder. They hold no rules.
- The `ts-architecture-reviewer` agent checks these boundaries in phase 4.

**As built in phase 4.** The tree above is the target; phase 4 differs where its scope is smaller:

- `core/plan/` holds `export.ts`, `import.ts`, `check.ts` and `preview.ts` (the preview is phase 4's flat list, not
  the grouping by receiver); `core/compare.ts` and `core/status.ts` sit at the core root; `core/shadow.ts` compares
  the program with the old engine.
- No `core/merge/` yet: phase 4 has `whole`, `dir` and `dconf` entries only, handled inside the plans. Phase 5 adds
  `json` and `import`, so the strategies come first there ("Open").
- `adapters/fs.ts` runs every action and switches on the OS through `adapters/paths.ts`, rather than one file per OS;
  `adapters/git.ts` reads `HEAD`; `adapters/engine.ts` runs the old engine for shadow.
- The review's boundary check: `! grep -rnE "node:(fs|child_process|os)|Bun\.|process\.(env|cwd|platform)" src/core
src/cli --include=*.ts --exclude=*.test.ts`. Core tests read fixtures with `node:fs`; that's allowed.

**As built in phase 5.** Layers in the core, still one adapter file:

- `core/merge/` holds `types.ts` (`MergeStrategy`: `merge(layers, {eol})` and `split(local, layers, context)`),
  `whole.ts`, `json.ts` (`mergeJson`, `splitJson`), `import.ts` (`mergeImport`, `splitImport`) and `strategy.ts`.
  `strategyFor` returns only `whole`: `json` needs the local file for `localOnlyKeys` and returns new settings from a
  split, and `import` returns side files, so the plans call those functions directly ("Open").
- `core/json/value.ts` is the project's own JSON parser and writer (decision 4): it keeps key order and the text of
  each number, and writes the byte-exact layout.
- `core/paths.ts` is the one home-path expansion (`~/`, and `~\` on Windows only); `core/plan/pick.ts` is the file
  picking that export and import share (`--only`, exclude globs, error plans); `core/config/profile.ts` parses a
  profile; `core/layers/select.ts` picks entries and their layer files for an OS, profile and machine.
- `core/plan/import.ts` and `export.ts` hydrate every layer before a merge or split and sanitize each changed layer
  after it. `check.ts` reuses the import plan.
- `adapters/snapshot.ts` builds the snapshot (config, values, `SYNC_PROFILE` and `SYNC_MACHINE`, git state), so
  `main.ts` only wires. `adapters/fs.ts` reads the profile and machine layers from the state folder into the
  snapshot under `profiles/<name>/` and `machines/<name>/`, reads an `import` entry's side files, and writes those
  layer paths back under the state folder.
- After the finish review (steps 19 to 31): `SelectedEntry` carries `slots`, every layer the run has for an entry
  whether its file exists or not, beside `layers` (those whose file exists); export splits over the slots so a
  destination can create a layer file; `splitJson` sends a new setting with no usable destination to the one slot
  whose file exists, and looks array items up as `<path>[]`. `pick.ts` has `isJsonEntry`, the one rule for JSON escaping. Import compares a `json` entry
  parsed (`jsonEqual`). `loadLayers` refuses a layer name that names another layer, and `profile.ts` a destination
  that isn't a slot. `adapters/fs.ts` resolves a repo or state path under the top folder it names (`dotfiles/`,
  `profiles/<name>/`, `machines/<name>/`), keeps a dated copy inside its run folder, and copies a state file into the run's dated folder before replacing it; the preview
  leaves `profiles/` and `machines/` out. The parser skips a leading BOM and stops at 512 levels; `splitImport` takes
  the last marker followed only by `@` lines.

**As built in phase 6.** Machines and profiles as data, the first run, and the guard:

- `core/machine/` holds one file per concern: `record.ts` (the `MachineRecord` type, `parseRecord`, `recordText` with
  the byte-exact key order), `scope.ts` (`machineScope`: which modules are on, and `machineValues`: record values
  before profile values), `check.ts` (`checkRecord`: the record checks push, preview and pull run first),
  `values.ts` (`placeValue` and `moveUserValues`: the "Kept on" table and the one-time copy of `.user-values.json`),
  `replace.ts` (`replaceRecord`: hostname, domain and the `replaced` history), `retire.ts` (the retire questions and
  results), `show.ts` (`machine show`'s six lines) and `copies.ts` (`mergeProfileCopies`, not wired until phase 7).
- `core/guard.ts` is the public-repo guard: given the visibility, the tracked paths and the local records, it returns
  `held` and `refused`, matching `profiles/` and `machines/` case-insensitively. It imports no adapter.
- `adapters/store.ts` reads and writes local state: `machine.json` and `profiles/<name>.json` under the state folder
  (`readStore`, `writeRecord`, `writeProfile`) and, once private, the repo's `machines/` and `profiles/`
  (`readRepoStore`). `adapters/scan.ts` reads the machine for `setup` (OS, hostname, domain, git email, tools, existing
  files; `SYNC_HOSTNAME`, `SYNC_DOMAIN` and `SYNC_TOOLS` override it). `adapters/visibility.ts` reads the push URL's
  visibility through `gh`, the GitHub API, `ssh -G` for SSH aliases and `MKSYNC_VISIBILITY`, behind injectable
  `run` and `fetch` so its tests never reach the network.
- `wizard/setup.ts` is the flow (`runSetup`): scan block, profile list, four questions, refusals and summary, against
  an `io` with `write` and `readLine`. It writes nothing and returns the record, the profile, the fourth answer and
  `replaced`. `main.ts` then asks the value questions, writes the profile and then the record, and runs the import or
  export. `cli/parse.ts` parses `setup`, `machine show`, `machine retire` and `profile retire`.
- Values with a record: `adapters/snapshot.ts` reads them as `machineValues` (record over profile) and leaves
  `.user-values.json` unread. `resolveValues` and `hydrate` take the record's profile and machine names as a
  `ValueOwner`, so a missing value's error names both and carries its `placeholder` as data; `planImport` and
  `planExport` copy it to `RunPlan.missing`, which `core/plan/check.ts` reads to flag the entry and plan again.
  `core/plan/machine-values.ts` (`valuesPrepare`) picks the `prepare` action: `writeValues` with no record, else one
  `writeMachineValues` carrying the record and profile with this run's new values merged in (split by `placeValue`;
  an unnamed placeholder goes on the profile), or nothing when no value is new. `adapters/fs.ts` writes the profile,
  then the record, through `writeProfile` and `writeRecord`. A failed save still isn't reported (phase 4 entry).
- Store reads: `readText` in `adapters/store.ts` treats only `ENOENT` as missing; any other error on `machine.json` or
  a profile is `can't be read`, exit 2, except under `setup --replace`, which goes on as if this machine had no
  record. `main.ts` stops a public export when `git ls-files` fails, and `adapters/visibility.ts` aborts `gh` after
  the API's 5-second limit.

**As built in phase 7.** The push side's preview and questions, the first backup, and the statusline:

- `core/plan/changes.ts` turns a plan's writes into change lines (key paths for `json`, line counts for whole files,
  side files by their `importName`); `core/plan/groups.ts` numbers and groups them by layer and prints the block;
  `core/plan/newsettings.ts` lists the new settings and their choices. `main.ts` asks them (`askSettings`) and the
  first backup's questions (`askFirstBackup`) through one `setupTerminal()` per export, block first, then writes.
- `core/plan/profilevalues.ts` (`profileValueHits`) searches each base or OS write in the forms `formsFor`
  (`core/values/sanitize.ts`) gives, plus a `json` text's decoded escapes; a failed entry selection throws, since
  the export plan stops on it first.
- `core/merge/strategy.ts` (`strategyFor`) gives one `MergeStrategy` per merge type (`whole.ts`, `json.ts`,
  `import.ts`); the export and import plans merge and split through it, except the import plan's side files, which
  `mergeImport` still returns. `dir` and `dconf` have no strategy yet (added in phase 8).
- `core/machine/backup.ts` plans the first backup from the local and repo sides (`planFirstBackup`,
  `firstBackupWrites`); `main.ts` reads both sides again after the export's writes, so the backup carries what that
  export added. `adapters/store.ts` (`writeFirstBackup`) refuses a symlinked path, undoes its own writes on a failure,
  then writes the pointer. With a pointer, `readStore` reads only this machine's repo record; `profile retire` asks for
  every record with `usedBy`.
- `core/guard.ts` names `profiles/` and `machines/` once (`STATE_FOLDER_ROOTS`), for the preview, the adapter and the
  backup. `adapters/visibility.ts` judges every push URL of `origin`.
- `core/statusline/format.ts` builds the line from facts that `adapters/statusline.ts` reads (payload, git, `/proc`,
  the context-window file, the `SYNC_*` overrides).

**As built in phase 8.** The front door's commands in the program, one flow per command:

- `src/app/<command>.ts` wires core and adapters for one command: `export.ts` (the export flow moved out of `main.ts`,
  with the questions, the guard and the up-to-date check), `commit.ts`, `diff.ts`, `status.ts`, `doctor.ts`,
  `pull.ts` and `push.ts` (with "Move a change?"). `main.ts` parses and dispatches; it still holds `import`, `setup`,
  `machine`, `profile`, `statusline` and `shadow`.
- New core, all pure: `core/plan/diff.ts` labels each changed file `IN`, `OUT` or `BOTH` from three trees and builds
  the diff text; `core/plan/commit.ts` names the branch and writes the message and PR body, and finds paths outside the
  sync and cached values; `core/plan/move.ts` moves a `json` change or a whole file between layers;
  `core/plan/uptodate.ts` decides the up-to-date check's action; `core/front/status.ts` and `core/front/doctor.ts`
  turn facts into the status and doctor lines; `core/drift.ts` compares package lists with what's installed;
  `core/machine/linked.ts` finds linked folders and words their question and status line.
- `core/merge/strategy.ts` now has a strategy for every merge type: `dconf` (`core/merge/dconf.ts`, keys filtered and
  rendered as `dconf dump` does) and `dir` join `whole`, `json` and `import`.
- New adapters, one per outside tool: `adapters/gh.ts` (`gh pr create`), `adapters/dconf.ts` (`dconf dump`, `dconf
load` and the login home from `getent passwd`), `adapters/packages.ts` (`dpkg-query`, `apt-mark`, `snap`, `pipx`,
  `code` and the GNOME extension list), `adapters/leakscan.ts` (`bash scripts/ci/leak-scan.sh`) and
  `adapters/osname.ts` (the status's OS name). Git calls stay in `adapters/git.ts`, which gains fetch, fast-forward,
  ahead and behind counts, `ls-tree` and `cat-file --batch` reads, and the commit and push calls.
- `tools/claude-layout.ts` (dev-only) splits Claude's `settings.json` into layers for the cut-over (step 28); phase 9
  runs it with `--cutover`.
- After the phase 8 review (`docs/archive/plan-single-engine-8-fixes.md`): `main.ts` only resolves the repo, OS, home and
  config and dispatches with a `switch` over the command kind. `app/setup.ts`, `app/retire.ts` and `app/shadow.ts`
  hold those flows (`executeSetup` takes `execute` as a parameter, so `app/` never imports `main.ts`), and
  `app/import.ts` holds `runImport`. `app/export.ts` holds `runExport` and the run steps both share, in order:
  `startRun` (up-to-date and record checks), `buildRun` (snapshot and `RunContext`) and `endRun` (the record lines on
  stderr), plus the one `failure` helper. `RunContext` carries the snapshot's `env`, which the dconf load uses; the
  login home is read with `getent passwd <uid>`. `core/plan/move.ts` takes each change's key path from the export
  plan and refuses a move that changes the merge. `tools/claude-layout.ts` refuses a split repo and, without
  `--cutover`, prints `would write <path>` lines; its tests use `tools/fixtures/claude-layout/`.

## Release and update

- **From phase 4:** CI builds the four programs on every pull request and every push to `master`, from one Linux job
  (`program-build`, `bun build --compile` per target), and keeps them as one workflow artifact `mksync-<sha>` for 14
  days. Shared cases run against the Linux program in that job, and against the cross-built macOS and Windows programs
  on their own runners (`program-macos`, `program-windows`).
- **Releases (from cut-over, v0.9.0):** a tag `v<x.y.z>` makes a GitHub release with the four programs, `SHA256SUMS`, and, up to
  `v1.0.2`, a build provenance attestation (`gh attestation`). The installers download the program for the machine and check its SHA256 against
  `SHA256SUMS`. From `v1.0.2` that is the only check (see "The attestation rule" below).
- **`mksync update`** downloads the latest release the same way, checks it, and replaces itself. On Windows a running
  program can't be overwritten, so it renames itself to `mksync.old.exe` first and deletes that on the next run.
- **`schemaVersion` check:** a program meeting a config with a higher `schemaVersion` stops with `this config needs a
newer mksync: run mksync update` (exit 2), before reading anything else. A pull that fast-forwards to such a config
  says the same.
- **Private repo (decided 2026-11-20, built in `archive/plan-single-engine-9-private-prep.md`, `v1.0.1`).** The install line
  is "install `gh`, `gh auth login`, then `gh api -H 'Accept: application/vnd.github.raw'
repos/makubexD/SyncSettings/contents/install.sh | bash`" (`install.ps1 | Out-String | iex` on Windows), which works
  on a public and a private repo alike; no public releases-only repo. With `gh` signed in and no
  `SYNCSETTINGS_RELEASE_URL` / `MKSYNC_RELEASE_URL`, the installers and `mksync update` take the tag from
  `gh release view` and the asset and `SHA256SUMS` from `gh release download`; without it they keep the plain HTTPS
  download, which works while the repo is public. The installers' clone (and a pull from a `github.com` origin) runs
  with `-c credential.https://github.com.helper=` and `-c credential.https://github.com.helper=!gh auth
git-credential` for that one command, so nothing is written to the synced `~/.gitconfig`; after the first pull,
  Linux and macOS get the helper from `.gitconfig.local`, and Windows uses Git Credential Manager.

As built in phase 9:

- **Release files.** `scripts/ci/release-files.sh <tag> <folder>` refuses a tag that isn't `v` plus `package.json`'s
  `version`, cross-compiles `mksync-linux-x64`, `mksync-linux-arm64`, `mksync-darwin-arm64` and
  `mksync-windows-x64.exe`, and writes `SHA256SUMS` (sorted by name, `sha256sum -c` format). The `release` workflow runs
  it on a pushed `v*` tag and publishes the release with the annotated tag's message as its notes. Releases are not
  attested from `v1.0.3` on (phase 10, part B): the workflow no longer runs `actions/attest-build-provenance` and asks
  for no `id-token` or `attestations` permission. Every action is pinned by commit SHA.
- **Where the files come from.** The installers read `SYNCSETTINGS_RELEASE_URL`, the program `MKSYNC_RELEASE_URL`;
  both default to `https://github.com/makubexD/SyncSettings/releases`. The latest tag is where `<base>/latest`
  redirects; a `file://` base holds it in a `latest` file instead, which is how the tests serve a folder release.
  Files are `<base>/download/<tag>/<name>`.
- **The attestation rule (replaced in phase 10).** Up to `v1.0.1` the installers and `mksync update` ran
  `gh attestation verify <file> --repo makubexD/SyncSettings` when `gh auth status` succeeded. From `v1.0.2` they don't
  (`plan-single-engine-10.md`, decision 1): GitHub Free makes no attestation on a private repo, so the check would
  refuse every release. The `SHA256SUMS` check stays, and both files come from the same release through a signed-in
  `gh` (or HTTPS while the repo is public). The release workflow attested `v1.0.2` too, so a `v1.0.1` program could
  still update to it; from `v1.0.3` releases carry no attestation.
- **Install paths.** `~/.local/bin/mksync` on Linux and macOS (`SYNCSETTINGS_BIN`); `%LOCALAPPDATA%\mksync\mksync.exe`
  on Windows, added to the user `Path`. The earlier Windows launcher, `%LOCALAPPDATA%\SyncSettings\bin\mksync.cmd`,
  is removed when it is ours. Intel Macs have no program; `--runtime` is their way in.
- **Update.** `mksync update` downloads the new program next to itself as `<program>.new`, checks it, then renames it
  over (contract "Update").

Decision: releases are built in CI from one Linux job and checked by SHA256 at install and update. The checksum stops a
broken download. A private repo that only the owner's token can read is the trust boundary the attestation used to
prove: whoever could change `SHA256SUMS` next to the program could already change the program.

## Tests

**One local command,** `tests/all.sh`, runs every layer that Linux can run, in order, and stops at the first failure:

1. **Lint, unit tests and the config check:** `bun run lint`, `bun test src` (the core with fake snapshots, including
   Windows ones: backslash paths, CRLF), `bun run tools/check-config.ts`.
2. **Build and shared cases:** `bun run build`, then `tests/parity/run.sh` against `dist/mksync` (`parity-program`)
   and through the clone's launcher on Node (`parity-node`, skipped with a line when Node 22.18 isn't on `PATH`).
3. **Windows cases** in the local VM: the Windows program (`windows-exe`), then the shared cases (`run.ps1`) against
   it (`windows-program`). Skipped with a line saying so when the VM isn't running.

Outside `tests/all.sh`: the stub suites `tests/linux/bootstrap.sh`, `tests/linux/install.sh`,
`tests/linux/launcher.sh` and `tests/linux/release-files.sh`, and `tests/windows-vm/install-check.ps1` in the VM.
macOS runs in CI only. Since the cut-over (phase 9) there is no old engine to run the cases against: the bash and
PowerShell suites and the `parity-bash` and `windows-powershell` layers were deleted (tag `two-engines-final`). The
paragraphs below up to "Real-machine results" record how the layers were built and proved.

**The Windows VM, phase 4.** A Windows 11 VM in a container (podman, with KVM), with Windows PowerShell 5.1 as
shipped. The repo is mounted into it. Phase 4 sets it up once, takes a snapshot, and proves it by running the old
PowerShell engine's suite (Pester and `run.ps1`) green there, as CI does. Every run starts from the snapshot. Size,
image licence and start-up time are recorded then.

Decision: the local Windows VM works and is the Windows layer of `tests/all.sh`. Proved 2026-11-11 with
`tests/windows-vm/vm.sh` (how it works: `tests/windows-vm/README.md`):

|                                             |                                                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runner                                      | `dockurr/windows` 6.06, pinned by digest in `vm.sh`; podman 5.7 rootless with `/dev/kvm`                                                                                       |
| Image                                       | Windows 11 Enterprise Evaluation, build 26100, downloaded from Microsoft by the runner; ISO SHA256 `bc3f24086ebadc94489066b5ad78089e2cf5c3491e90e790bb81a2b199c10e38` (7.7 GB) |
| Licence                                     | evaluation, 90 days from the install: this one ends 2027-02-09. Then delete the disk and the snapshot and install again                                                        |
| In the guest                                | Windows PowerShell 5.1.26100, PortableGit 2.47.1 (with `bash.exe`, which the leak scan needs), Pester 6.2.0                                                                    |
| Size                                        | 4 GB RAM, 4 cores; a 40 GB sparse disk using 23 GB, and a snapshot of the same size                                                                                            |
| First install                               | about 60 minutes, 45 of them the ISO download                                                                                                                                  |
| Start from the snapshot                     | 6 minutes; shutdown 1.5 minutes                                                                                                                                                |
| One job (copy the repo, run a command)      | 6 to 10 seconds                                                                                                                                                                |
| Shared cases (`run.ps1`), PowerShell engine | 36 passed, 0 failed, 3.5 minutes                                                                                                                                               |
| Pester suite, PowerShell engine             | 242 passed, 0 failed, 31 minutes                                                                                                                                               |

Three things the VM needed, all in `tests/windows-vm/oem/`: the SMB client's folder cache turned off (the host
writes job files behind the SMB server's back, and a new job went unseen for 7 minutes); the Hidden attribute cleared
on the copied repo (the share shows dot-files as hidden, and Windows won't rewrite a hidden file); and Defender
exclusions for the work folders. The Pester suite is too slow for every run, so `tests/all.sh` runs the shared cases
in the VM and leaves Pester to CI.

`tests/all.sh` as built (phase 4) prints one line per layer: `lint`, `unit`, `config`, `build`, `parity-program`,
`parity-bash`, then, with the VM up, `windows-exe` (the `bun-windows-x64` build), `windows-program` and
`windows-powershell`; else `Windows: VM not running, skipped`. It ends with `all: ok`. The VM's copy of the repo keeps
`dist/` so the Windows program reaches the guest. First green run with the VM, 2026-11-12: 34 shared cases for the
program on both OSes (3 skipped until phase 8: `commit` and `diff`), 37 for bash, 36 for PowerShell
(`import-eof-no-force` is skipped there).

At the end of phase 8 (2026-11-16, Linux) there are 219 shared cases, 76 of them new in phase 8: the program passes
all 219; bash passes 115 and skips 104 (`v2 only` and the program-only commands). The runners gained these fields:
`syncPoint` (writes the repo's `HEAD` as the sync point), `origin/` (a commit that puts `origin/master` one ahead),
`unsent/` (files left uncommitted in the clone), and `stubs` as a list of `gh`, `dconf` and `getent`
(`tests/parity/README.md`, "The stubs"). The `dconf` stub answers `dump` from the case's `.ini` files and logs each
`load` to `dconf.log`, compared with `expect/dconf.log`; the `getent` stub makes the case's temp home the login home.
The runner touches the copied `home/` files, so a home file and its repo twin never share an mtime that git's stat
cache would take for "unchanged".

Phase 9 (2026-11-17) adds three layers. `parity-node` runs the shared cases through the clone's launcher on Node
(`MKSYNC_RUNTIME=node`, `--engine ./mksync`), after `parity-program`, and is skipped with a line when Node 22.18 isn't
on `PATH` (nvm keeps it off non-login shells). Two stub suites outside `tests/all.sh`: `tests/linux/launcher.sh` (the
launcher's runtime choice and errors, with `bun` and `node` as stubs) and `tests/linux/release-files.sh` (the release
script, with `bun` as a stub); `install.sh`'s cases in `tests/linux/engine.sh` and
`install.ps1`'s in Pester (`tests/windows/Engine.Tests.ps1`) install from a folder release
(`SYNCSETTINGS_RELEASE_URL=file://…`), and `tests/windows-vm/install-check.ps1` runs `install.ps1` in the VM. The runners gained the `bootstrap` stub (the
repo's own `bootstrap/linux.sh`, logging each run to `bootstrap.log`) and the `bootstrap` option for `setup`. There are 307 shared cases at the end of phase 9; on Linux, bash passes 184 and skips 123.

**Shadow mode** on the real machines, before cut-over (deleted with the old engines). `mksync shadow` ran the new program's pull and push plans
without writing anything and compared them with the old engine's check and preview: the same files, the same
placeholders, the same status words. Differences went to a log in local state.

`mksync shadow` (hidden, phase 4) printed `shadow: same` and exited 0, or printed one line per difference, appended
them with a timestamp to `shadow.log` in the state folder and exited 3. The old engine's export ran in a throwaway copy
of the clone, so the command wrote nothing in the repo or home.

Shadow on personal Linux, 2026-11-12: 21 differences, all explained, placeholders the same in every exported file.

- 10 dconf files, in the check and the preview: program `SKIPPED (not supported yet)`, engine `UNCHANGED`. Phase 8
  built dconf in the program.
- 11 package and extension `DRIFT` lines in the old engine's preview (apt, npm, pipx, a GNOME extension, an apt
  source); the program prints none. Phase 8 built package drift in the program. Shadow runs again in phase 9.

**Shared cases for layers (phase 5).** The shared cases carried only v1 until phase 5. Layers need config v2, so a
case could give `configV2` instead of `config` (since cut-over step 24 every case holds `configV2` only), plus `env` (from phase 6: `SYNC_HOSTNAME`, `SYNC_DOMAIN`, `SYNC_TOOLS`
and `MKSYNC_VISIBILITY`; phase 5's `SYNC_PROFILE` and `SYNC_MACHINE` were removed) and a `state/` tree
copied into the state folder, with `expect/state/` compared like `expect/home/`. The old engines couldn't read v2:
their runs printed `SKIP <case>: v2 only`. Example: `json-merge-layers` gives a base and a Linux `parity/settings.json`; the
program writes the merged file on Linux, macOS and Windows (CRLF there), and bash skips it.

**Old cases without a shared twin.** `tests/linux/engine.sh` had 484 cases and the Pester suite 240; 20 and 19 of them
had a shared twin. The rest, one row per group, are in `docs/archive/design-test-moves.md`. In short:

| Goes to                                                                                                    | bash | Pester |
| ---------------------------------------------------------------------------------------------------------- | ---- | ------ |
| shared case (one case often covers a bash and a Pester case with the same name)                            | 217  | 152    |
| core unit test                                                                                             | 112  | 33     |
| adapter test                                                                                               | 10   | 16     |
| stays bash (CI scripts `leak-scan.sh`, `check-packages.sh`, `check-plugins.sh`; the installers)            | 108  | 0      |
| dropped at cut-over (`sync` wrapper, `sync.cmd`, `-User`, Git Bash lookup, linked folders, bash internals) | 17   | 20     |

Every old case stayed in its suite until the cut-over deleted both suites.

**The real-Windows checklist** (phase 9, or any time the user is at a work machine) starts with:

1. The research probe and then `mksync`, installed with `irm … | iex`, run without a SmartScreen or policy block.
2. Which shell Claude Code uses there, and `mksync statusline` showing the bar.
3. `~` and `$HOME` in a hook and statusline command.
4. Whether Git Bash and `jq` are installed.
5. The run-from-clone fallback, if step 1 was blocked.
6. Local state readable by the user only (the `Save-UserValues` ACL rule, now in the Windows adapter).
7. (Before cut-over) `mksync shadow` in the clone: `shadow: same`, or each difference explained and recorded here,
   redacted.
8. The installer on a work machine: `irm … | iex` puts `mksync.exe` in `%LOCALAPPDATA%\mksync`, on the user `Path`,
   with no SmartScreen, Defender or policy block; else the IT answer, recorded redacted.
9. `mksync update`: `mksync <version> is up to date.` on the latest release, and after an older program is put back,
   `mksync updated: <old> -> <new>.`, with no `mksync.old.exe` left after the next start.
10. The fallback with `SYNCSETTINGS_RUNTIME=node` on work #1's Node 26.13: install, `mksync`, `mksync pull`.
11. The clone's launcher with `MKSYNC_RUNTIME=bun` on work #1's Bun 1.3.14 (the repo pins 1.4.4): it runs, or the
    oldest Bun to accept is written into the launcher.

### Real-machine results

**Personal Linux, 2026-11-18, release v0.9.0.** The README install line with `--no-setup` (and `SYNCSETTINGS_DIR` set
to the existing clone) put the release program in `~/.local/bin`: `mksync --version` prints `mksync 0.9.0`,
`mksync status` and `mksync doctor` exit 0, and `mksync update` prints `mksync 0.9.0 is up to date.` (the contract's
"Not newer" line). Nothing was pulled or pushed. `mksync shadow` exits 3 with 28 lines, all explained:

- 25 package and extension `DRIFT` lines in the old engine's export (17 apt, 2 npm, 2 pipx, 1 GNOME extension, 3 apt
  sources); the program prints none there. This is the open item "Drift in export and preview": the program reports
  drift only in `mksync doctor`, whose `WARN drift: 25 package(s) differ` matches.
- 3 lines for the Claude worker's `settings.json` (import `UPDATE`, export `MODIFIED`, and `only in engine`): the repo
  and local files hold the same JSON and differ only in layout. The program compares `json` entries parsed
  (`UNCHANGED`, as the contract says); the old engine compares bytes.

**Work #1 (Windows), 2026-11-18, run from the clone.** `tools/windows-cutover-check.ps1` in PowerShell 7.6.9 (full
language mode), on a clone made for the run: git 2.50.1, Node 26.13.0, Bun 1.3.14, jq 1.6, `gh` signed in, Windows 11
Enterprise. Every section ran:

- Install: the Node route removed the old `%LOCALAPPDATA%\SyncSettings\bin\mksync.cmd`, wrote
  `%LOCALAPPDATA%\mksync\mksync.cmd` (no `mksync.exe`) and put that folder on the user `Path`; `mksync --version` prints
  `mksync 0.9.0`. Nothing was blocked.
- Home: `~` and `$HOME` are `C:\Users\USER` in PowerShell, and `/c/Users/USER` (`C:/Users/USER`) in Git Bash.
- Git Bash: `mksync` is `command not found` (127), `mksync.cmd` works. Fixed by cut-over step 9 ("Open").
- `mksync statusline` on the sample payload: one line with the bar, exit 0. `MKSYNC_RUNTIME=bun` runs the launcher on
  Bun 1.3.14.
- `mksync status` and `doctor` exit 0 (doctor: no machine record and 4 values not set, as on any machine before
  setup); `check` exits 3 with 2 files to change; `update` prints the `git pull` error with exit 2, as the contract
  says for a clone install. No `.user-values.json` yet.
- `mksync shadow` exits 3 with 2 lines, both explained: `token-routing-map.html` is `CREATE` in the program and
  `SKIPPED` in the PowerShell engine because `~/.claude/docs` doesn't exist (the contract's known difference "Import,
  target folder missing"); the `.bashrc.linked/…/vs.bat` linked path is in the old engine only, which cut-over step 11
  replaces with a `dir` entry.

## Open

### Design

- **Setup's bootstrap edges (phase 9 step 24; settled in `archive/plan-single-engine-9-private-prep.md`, steps 1 and 3).**
  The contract now says the question comes after the record and profile are written and is skipped on `stop`, as
  built. `--bootstrap` on Windows stops like macOS, `ERROR: --bootstrap is Ubuntu only.`, exit 1, before the doctor
  (shared case `setup-windows-bootstrap-flag`), rather than the unknown-option exit 2 guessed here.
- **Pull-only status (decided in phase 8 step 20, to confirm).** The contract only said status "never suggests
  `mksync push`" on a pull-only machine. The program skips the unsent rule there, and a differing machine's next line
  is `mksync pull`, or `mksync pull --force to take the repo's version (each keeps a .bak).` when the diff finds an
  `OUT` or `BOTH` file. Unsent files on a pull-only machine still block `mksync pull`; whether status should say so
  is open.
- **A profile without a value.** `personal` has no `<YOUR_WORK_MARKETPLACE>`. Today import stops rather than write a
  placeholder. Options: the profile marks the value "none" and the engine drops that array item; or the item moves out
  of the base into each work profile's JSON layer, which "Merge and split" adds by item. The second needs no new rule
  and is the likely answer; it changes the worked example in "Catalog", so it waits for the user. It needs the work
  profiles' layers in the repo, so it waits for phase 10 (cut-over plan, decision 3).
- **Linux-only or personal-only.** There is one Linux machine and it is personal, so every Linux row could be an OS
  layer or the `personal` profile. The table says OS for tools (they'd suit any Linux machine) and machine for the two
  disk launchers (`disco-datos.desktop`, `mis-discos.desktop`), which name this machine's disks.
- **Tools that could reach Windows.** `tmux`, `starship`, `wezterm`, `htop`, `gh`, `rtk` and VS Code are Linux and macOS
  today. Whether each also belongs on Windows (`gh` and VS Code likely do) is a profile choice for the work machines.
- **Removing a key in a later layer.** JSON merge can add and replace keys, not remove one the base sets. Options: a
  `null` in the later layer removes the key, or removal isn't supported. Claude and VS Code treat some `null` values as
  meaningful, so `null` may need an explicit marker instead.
- **`~` instead of `<HOME>` in Claude settings.** Claude Code expands `~` in commands on every OS (see "Statusline and
  hooks on Windows"), so `settings.json` could drop `<HOME>` and its escaping. The `$HOME` check under "Confirm on
  Windows" came back yes on work #1: `~` and `$HOME` both resolve under Git Bash and PowerShell 5.1. So nothing on
  Windows blocks the switch; the layout tool's phase 9 run is where `<HOME>` in `hooks` and `statusLine` becomes `~`,
  if the user agrees then.
- **Owner of a setting (asked by the user 2026-11-16).** Sync and back up only what the user creates or changes; leave
  what a tool installs (a plugin's hook, a linked skill, a marketplace's cache) to that tool. The engine has no way yet
  to tell who made a hook, a skill or a key. Signals the scan could read, none decided: a link's target (a skill that
  links into `plugins/` or another tool's folder is that tool's); a name that starts with an installed plugin's or
  marketplace's name (`installed_plugins.json`, `known_marketplaces.json`); a file next to that tool's own logs; a
  file the repo already holds (the user's). `mksync setup` and `status` would then show the owner beside each new item
  and ask only about those with no owner found. Asked on work #1 first, from its survey's tree.
- **Names in the survey.** Names that are generic or public (`audit-agent-instructions`, `find-skills`, the
  official plugins) stay as they are, as the user prefers original names to numbers. Names that point at the employer
  stay `work-tool-<n>` while the repo is public (CLAUDE.md rule 1); they can become role names (what each one does)
  if the user lists the roles, and real names once the repo is private (phase 10).
- **An existing import line.** Work #1's `CLAUDE.md` already imports `@WORK-TOOL-3.md`. Under the `import` rule
  (contract, "Layers") that line is base text, so a push would carry it to every machine. At its restore it moves into
  the work profile's side file, `CLAUDE.work-1.md`.
- **`<YOUR_NAME>` per profile.** It's likely the same on every profile. Keeping it per profile costs one prompt per job;
  a shared value would need a fifth place (the user), which the decisions don't have.
- **Lines that name the deleted engine (found in phase 9 step 17).** The program still prints `run ./import.sh --check
to see why` (`mksync status`, `src/core/front/status.ts`), `run  ./import.sh  first` (`src/core/plan/run.ts`) and
  `ERROR: run commit.sh from master` (`src/app/commit.ts`). Those files are gone. Settled in
  `archive/plan-single-engine-9-private-prep.md` (steps 1 and 2): `mksync check`, `mksync setup` (a new machine needs setup,
  not a bare import) and `mksync commit`; the export line has the shared case `export-local-missing`.
- **Machine-state keys.** Which keys of Claude's `settings.json` (and VS Code's) are this machine's state, never pushed
  and kept on pull. Found by diffing the file before and after a few sessions, on Linux first.
- **Editing one hook.** Array items are compared whole, so changing one command inside a `hooks.<event>[]` item is a
  removed item (from its layer) plus a new item (asked about). Correct, but two lines in the preview for one edit. A
  key per item (the `matcher`) would make it one change; worth it only if hook edits turn out frequent.
- **JSON with comments (JSONC).** VS Code's `settings.json` may hold comments and trailing commas; Claude's may not.
  Phase 5 refuses both (`not valid JSON`), since no synced file has them today. If one needs them, the parser keeps
  comments attached to the next key, or the entry stays `whole`.
- **Phase 7 command names (settled by the `cli` review, step 2).** `mksync statusline` stays a top-level command with
  no options, and `mksync export --yes` means what `setup --yes` means. The new-setting question is
  `Where does it go? 1) all machines  2) <Os> machines  3) profile <p>  4) this machine [<s>]`; the first-backup
  question shows the repo's and this machine's value before `Keep which? 1) the repo's  2) this machine's [1]`.
- **The statusline's colors.** `mksync statusline` writes ANSI colors though its stdout is a pipe, and ignores
  `NO_COLOR`, as `statusline.sh` does, because Claude Code renders them. The `cli` skill's color rule (color only on a
  terminal, `NO_COLOR` turns it off) doesn't fit a program whose only reader is Claude Code's bar. Kept as a known
  exception; honoring `NO_COLOR` would be a one-line change if a machine sets it globally and wants a plain bar.
- **Elevation wrapper.** `-User` (import into another Windows account, elevated) was dropped at cut-over. If a real need
  shows up (a file only an admin may write), a small wrapper runs `mksync pull` through `RunAs` on Windows or `sudo`
  elsewhere, for the one entry. Designed and built only then.
- **Work configs in a personal repo.** Whether each employer's policy allows its machines' configs (redacted or not) in
  the user's own repo, private or public. The user's call, per job; a job that says no gets a profile with
  `pullOnly` machines and no work layer.
- **Pull's own preview.** Pull lists changes by group but asks only once (phase 7: `import --check` prints the
  groups). Whether pull should also let the user skip a group (take "all machines", skip "profile work-1") stays open:
  nothing has asked for it yet.
- **Not measured for the runtime.** Node SEA (size, start-up, cross-builds) and Deno's compressed size. They'd only
  matter if Bun hits a blocker. Settled in phase 4: programs cross-built on Linux run on their targets; the macOS
  arm64 and Windows x64 builds passed the shared cases on CI's runners (PR #74, 2026-11-12).
- **The Windows VM.** Settled in phase 4: it runs here and is the Windows layer of `tests/all.sh` ("Tests"). Its
  evaluation licence ends 2027-02-09.
- **Installing from a private repo.** Decided 2026-11-20 and built for `v1.0.1`: installs go through a signed-in
  `gh`; see "Release and update".
- **Failures the contract doesn't name (phase 4, program).** A failed save of `.user-values.json` and a failed
  sync-point write are not reported; the summary still prints `Sync point :` after the second. Bash ignores both too.
  Either the contract gives them a status (`WARNING`?) and both engines follow, or it says they're ignored. The
  sync-point half: the contract's "Sync point" now has the `WARNING`, and port step 20 tests it on import.
- **Program-only errors (phase 4).** `ERROR: no sync-config.json or sync-config.v2.json in this folder or its
parents.` and `ERROR: cannot read <file>.` have no contract text: the entry points always run from the repo.
  Settled in phase 8's docs step: both are in the contract's "The program".
- **Boundaries review, phase 4.** Phase 5 closed the home-path copies (`core/paths.ts`), the shared picking
  (`core/plan/pick.ts`), the merge strategies (`core/merge/`) and the snapshot reading (`adapters/snapshot.ts`,
  `parseValuesFile`, `pickOs`). Left:
  - `strategyFor` covers only `whole`; the plans still switch on the merge type and call `mergeJson`, `splitJson`,
    `mergeImport` and `splitImport` directly. Widening `MergeStrategy` (the local file in the merge context, new
    settings and side files in the results) would let every type go through it.
  - `import.ts`, `export.ts`, `check.ts` and `adapters/fs.ts` each build the profile and machine scope for
    `selectEntries`: four copies of the same three lines.
  - Shadow's process runner (`adapters/engine.ts`, `node:child_process`) duplicates the git adapter's (`Bun.spawn`).
- **Layers, phase 5.** Left for later phases:
  - An `import` entry whose base layer has no file but a later one does: export passes the present layers only, so
    the first present layer is taken as the base. Pull reports `no layer holds the file`, so it can't arise from a
    pull; a shared case should pin what export does.
- **Security review, phase 4 (before cut-over).** Fixed: sanitize and hydrate rescanning their own output. Left, each
  needing a shared case first where it shows in files or statuses:
  - The resolved dated-backup path isn't checked against the state folder (the rest of this item, unsafe entry paths
    and links, was settled in phase 9, decisions 10 and 11).
  - Only an entry's own rules sanitize it, and `sanitize` on a dir or dconf entry is accepted and ignored. A guard
    that stops an export holding any known value, in every form, would catch both; bash behaves the same today.
  - JSON escapes (`é`, `\/`) aren't matched on export; a value inferred from a JSON file is escaped twice on
    import; value lookups use plain objects (`constructor`).
  - A new hydrated file and new parent folders are created with the umask before the chmod, and the backups tree is
    0755; pruning removes any folder under `backups/`, not only run folders; `leak-scan` doesn't scan
    `sync-config.v2.json`.
- **Finish review, phase 4.** Fixed in steps 32 to 39: `--only` inference, `SYNC_OS` per host, an unset home,
  non-string values, failure reasons, the preview's deletions and config, file-entry symlinks, v2 validation and the
  full config check, `export --force`. Left:
  - The shared-case harness can't express a write failure, a symlink in `home/` or an uncommitted repo change, so
    those rules have unit tests only. A `setup` field (commands run before the first one) would cover the last two.
  - Files inside a `dir` entry: bash orders them with `sort -z`, which follows the locale (`a.txt B.txt _c` under
    `en_US.UTF-8`); the program sorts by code unit. Decide `LC_ALL=C` in bash, with a shared case, and write the
    order into the contract.
  - `isExcluded` compiles its patterns per file.
  - `core/plan/import.ts` still skips a file entry whose snapshot entry is a symlink; the adapter no longer produces
    one, so the branch is dead until the snapshot types drop the case.
  - Mutants no test kills: inference keeping the last match, sanitize's doubled-form order (a value ending in `\`),
    the placeholder tie-break order, `EXTRA` ignoring excludes, `\r` kept in inference, `paths.ts` `~\` on Linux and
    its trailing-separator branch, `elevate !== false`.
  - `ci.yml` pins `setup-bun` by SHA but `upload-artifact` and `download-artifact` by tag. `release.yml` (phase 9)
    pins every action by SHA.
- **Finish review, phase 5.** Fixed in steps 19 to 31. Left:
  - A removed key leaves every layer that sets it (contract, "Layers"), so a machine can't drop a key the base sets
    without dropping it for every machine. A later layer that masks a key (a tombstone value) would allow it; it needs
    a written form in JSON and a rule for arrays.
  - Value inference on an entry with more than one layer lines the local file up with the latest layer only, so a
    value that only an earlier layer's text holds isn't inferred.
  - A line other than `@…` or a blank one added under the import block by hand turns the block into base text
    (contract, "Layers"), so the next push stores the marker and its `@` lines in the base. A note on that status line
    would catch it.
- **Machines, phase 6.** Chosen in the build where the contract is silent; confirm or change in the contract:
  - A module limited to several systems is off as `<m> off, linux or macos only` (`core/machine/scope.ts`).
  - A record whose `name` equals its `profile` is refused as `name can't be <value>` (`core/machine/record.ts`).
  - A repo-home record that doesn't parse uses the state folder's `machine record (machine.json …)` line.
  - Setup: a bad answer to questions 2 to 4 prints `Pick 1 to <n>.` and asks again; an answer of digits only is
    never a new profile's name (the contract now fixes a choice as digits only); the profile list pads a name with machines to 12 characters and
    shows several as `machines a, b`; a takeover on the same hostname and domain adds no `replaced` entry;
    `--profile` with `--replace` takes the record's profile.
  - Setup "keep mine": a failed export stops before the import, with the export's exit code, so local files that
    weren't pushed are never overwritten.
  - Replace asks each machine value as `<KEY> [<old value>] ` in the record's key order; no shared case has a value
    yet.
  - Retire: a missing name is `ERROR: machine retire needs a name.` (`profile retire …`), exit 1.
- **Left by the phase 6 audits.** Each is a behavior the contract doesn't fix yet:
  - The guard checks tracked paths, not unpushed history: a state file committed and then `git rm --cached` still
    goes out with the next push. Phase 8 owns the push: settled by its step 9, which reads `origin/master..HEAD`.
  - A piped `setup --replace` prints the old machine values as suggestions on stdout.
  - A `__proto__` placeholder in `.user-values.json` is dropped without a message.
  - Profile names read from file names, and retire names, aren't checked against the layer-name rule.
  - An unknown verb in a group (`mksync machine list`) exits 1 as an unknown option; an unknown command prints the
    usage line, exit 2.
  - No `--help` at any level and no `--name=value` form (a migration, per the `cli` skill).
  - `--profile`, `--claude` and `--mode` given with `--replace` are ignored without a message.
  - The `wizard` skill's rules (prompts on stderr, a terminal required, `--no-input`) differ from the contract,
    which reads answers piped on stdin and prints the questions on stdout. The contract stands; adopting the skill's
    rules would be a migration.
  - An SSH alias that resolves to `ssh.github.com` (GitHub's SSH over port 443) is public, since only `github.com`
    is asked. It fails closed; asking it as `github.com` would need a line in the contract first.
  - The guard's stop when `git ls-files` fails in a clone has no shared case: the runner can't break a clone's index
    (the `setup` field from phase 4 would). A folder with no `.git` lists nothing, which the 18 export cases run
    outside a clone rely on.
  - `ENOTDIR` counts as a missing record, like `ENOENT`: a file where the state folder should be reads as "no record
    yet", and `setup` then fails at the write instead of before the questions.
  - A repeated setup flag has no shared case: the parity runner takes options as a JSON object. `src/cli/parse.test.ts`
    pins `ERROR: <flag> is repeated.`, and the usage line is pinned to the contract the same way.
- **Left by phase 7 steps 13 and 14.**
  - A new setting answered (or suggested) into the base or an OS layer is listed under `New settings`, not in that
    layer's group. If its value holds a profile value, the refusal still stops the run, but its `change <n>` names
    the first change line of that file, or `0` when the file has none, not the setting's own number. No shared case
    covers it; the fix is to number hits on new settings with the setting's line.
- **Left by the phase 7 audits.** Each is a behavior the contract doesn't fix yet, or a known gap:
  - Profile values: the machine's values and other profiles' values aren't searched (M3).
  - Repo files written with default modes, and the pointer write in `machine.json` isn't atomic (L3).
  - A layer file that is a symlink or binary isn't checked by the merge (L4).
  - `machine retire` and `profile retire` write the repo copy even while the repo is public (L5).
  - The statusline's git calls honour `core.fsmonitor` and have no timeout (L6, CLI-7); the context-window folder
    is created under `~/.claude/state/` with default modes (L7).
  - A refusal that is known before the questions (profile value, guard) is still printed after them (CLI-4).
  - `mksync statusline` typed by hand waits for stdin (CLI-5).
  - The export's status lines print before a failed first-backup write's `ERROR` line.
  - Export answers are read as `setup` reads them, so a piped answer has no echo (WIZ-4); no `--keep` or `--to`
    flags answer the questions without a terminal (WIZ-5); `--yes` keeping the repo's value prints no note (WIZ-6);
    the destination question's words (`Where does it go?`, the choice names) aren't reviewed with a user (WIZ-7 to
    WIZ-9).
  - The Windows survey and the Claude layout tool (`tools/claude-layout.ts`) moved to phase 8; phase 9 then runs the
    tool with `--cutover`, points `statusLine` at `mksync statusline` and retires `statusline.sh`.
- **Left by phase 7 steps 26 to 31.**
  - With a pointer, a run reads only its own repo record (step 31) but still every repo profile, as a local store
    reads every local profile, so another profile's broken file still stops import and export. `Store.profiles` feeds
    the setup and retire lists; reading only the run's profile needs a separate read for those.
  - The first backup's undo (step 30) leaves the folders it created, and a failed undo is silent: the write's error
    is the line the contract gives.
  - An export layer file the first backup also copies prints one status line, from the export (step 26).
- **Left by the phase 7 finish review (steps 33 to 42).**
  - `setup` followed by its export in one run loses piped answers: the export's questions read from a new reader
    (`main.ts` around the setup-then-export call).
  - A file whose write fails still has its answered destinations stored in the profile.
  - `main.ts` holds the export flow and the git calls; they belong in their own module and `adapters/git.ts`.
  - `LayerFile.bytes` means raw bytes in some readers and hydrated bytes in others; the name should say which.
  - The profile-value rule matches on a change line's `what`, which is escaped and cut at 60 characters, so a value
    past the cut or holding an escaped character isn't found.
  - Change paths join keys with `.`, so a flat key holding a dot (`"a.b"`) and nested keys (`a` → `b`) print alike.
  - Statusline cases missing: Windows, a Python virtual env, `Unknown option` from an older Claude Code.
  - Destinations stored before step 36 use the bare key path (`"delta[]"`); they no longer match, so the item is asked
    once more. No migration rewrites them.
  - The import check sanitizes the local side with the values inferred from it; when inference finds nothing, that
    side prints its real value (terminal only, never written).
  - A git that can't run, or a folder that isn't a repo, now reads the visibility as unknown, so `MKSYNC_VISIBILITY`
    no longer answers there (only a missing origin lets it).
  - With a pointer, layer writes into the clone check containment by path only: a symlink committed under
    `machines/<name>/` or `profiles/<p>/` is written through (the first backup refuses one; later runs don't).
    `dotfiles/` has the same gap.
  - `setup` on a machine whose record is a pointer writes the record and profile to the state folder, replacing the
    pointer; the contract doesn't say whether that's meant to start a new first backup.
  - A destination key is `<module> <file>: <path>`, so a module name with a space could collide with another
    module's file; module names don't hold spaces today.
  - "Move a change?" on a `-` line (a removed key, item or file) refuses with `change <n> removes a setting; it can't
move.` and the push stops with exit 1. Phase 8's docs step wrote this into the contract as built; whether a removal
    should move, or the question ask again instead, stays open.
  - A change moved to a narrower group leaves the old layer as the repo holds it ("left as it was"), so the other
    machines don't receive it; a whole file moved narrower keeps the old layer's repo copy instead of leaving it empty.
  - After a move the block is numbered again in group order, so a moved change can take a new number; the contract
    says its number is kept, which needs a number per change that survives regrouping.
- **Left by phase 8.**
  - Step 27 settled "Confirm on Windows" for work #1 from its survey; work #2 and #3, and the unsigned program, are
    phase 9's checklist.
  - The package managers have no stub in the shared-case runners, so the drift rules are core unit tests over stubbed
    lists and the old bash cases.
  - `main.ts` still holds the `statusline` and `machine show` flows and the `pull` and `push` wiring; each moves to
    `src/app/` when it next changes. `import`, `setup`, the retires and `shadow` moved in the phase 8 review.
  - The program's `commit` keeps `commit.sh`'s own lines, including `run commit.sh from master`; they change with the
    cut-over's wording review.
- **Left by the phase 8 review (`docs/archive/plan-single-engine-8-fixes.md`).**
  - **The first push from a private repo (phase 10).** Commit's sync paths are `dotfiles/`, `sync-config.json` and
    `packages/`, so once the guard reads private, a push holding `profiles/`, `machines/` or `sync-config.v2.json`
    stops with `commit or stash changes outside dotfiles/ first.` Phase 10 adds those paths to the sync paths, the
    staged paths and `isSyncPath` when the guard reads private, with a `commit-private-backup` case.
  - **One flow in `app/export.ts`, and one home per helper (cleanup plan after phase 9).** `executeExport`'s three
    branches repeat plan, moves, refusal, block and first backup; `Result`, `writeLines` and `setupTerminal` move to
    `app/io.ts`, `askMoves` to `app/moves.ts` (ending the `export.ts`–`push.ts` cycle). Copies to merge:
    `refusedText`, the `[Y/n]` answer rule, the no-prompt git environment, `VALUES_FILE`,
    `LINKED_DESTINATION_PREFIX`, `sameBytes`, `hasKeyPath`, the `RunCommand` literals, and `diff.ts`'s `byCodeUnit`,
    which should be `drift.ts`'s byte-order `compareC`. `core/plan/move.ts` splits into JSON path, slot and plan
    files.
  - **The missing-value line's stream (case port, 2026-11-16).** With no terminal, bash still prints the value
    prompt (` <prompt>:`) and then `missing value for <PLACEHOLDER>: add it to .user-values.json` on stderr, so the
    merged output reads as one line; the program prints no prompt and the line on stdout. The contract names neither
    the stream nor the prompt, so the shared cases check only exit 1 and unchanged trees for it. Decide the stream
    (stderr, with the other stops) and whether a prompt shows without a terminal, then give the cases the line.
- **Left by the case port (`docs/archive/plan-single-engine-8-port.md`, 2026-11-17).**
  - **Drift in export and preview.** The contract ("Package drift", "Program") and "Drift stays in export and
    preview" above say the program reports `DRIFT` after an export's or a preview's orphan report; the program
    reports drift only in `mksync doctor` (`src/app/doctor.ts` is the only caller of `core/drift.ts`). No shared case
    catches it, since the runners have no package-manager stub. Either the program adds the report (and skips it
    under `--only`, as the contract's "Picking files" says), or the contract moves drift to doctor.
  - **Windows ACL on an existing file with explicit grants.** Resolved in the case port's finish: a new file in a
    folder with no inheritable rules (the CI runner's temp folder) gets the token's default DACL as explicit SYSTEM
    and Administrators grants, which `icacls /inheritance:r /grant:r *<SID>:F` kept. `src/adapters/acl.ts` now runs
    the PowerShell engine's calls (a fresh protected `FileSecurity` with one rule for the token's SID) through
    `powershell.exe`, the path passed in an environment variable; `run.ps1`'s ACL check covers it.
- **Workflow on a personal Windows or macOS machine (cut-over decision 12).** Module `claude-worker` (the plan
  workflow and the DeepSeek worker) is `os: ["linux"]`, since its hooks and `bin/` scripts are bash and the only
  personal machine is Linux. When a personal Windows or macOS machine exists: widen the entries' `os`, and either port
  the bash scripts or run them under Git Bash on Windows (macOS runs them with Homebrew's bash).
- **Workflow keys in phase 10.** Claude's `settings.json` keeps the workflow's `hooks` wiring in the Linux OS layer, and
  `CLAUDE.md`'s workflow text is base text, because a `personal` profile layer can't be committed while the repo is
  public. Phase 10 moves both to the `personal` profile layer, so a work machine on Linux wouldn't get them either.

### Confirm on Windows

The first five items below are on the run sheet (`docs/windows-cutover-run.md`, "Work #2 and #3: the extra checks"),
each with its command and what to paste back, for work #2 and #3 when the user is at them. They don't block phase 10.

- **Unset `USERPROFILE` (phase 4).** The PowerShell engine doesn't stop when `USERPROFILE` is unset (paths become
  `\.config\…`, `SKIPPED`, exit 0), so `home-unset` runs on Linux and macOS only. Fix the old engine with the case, or
  record it as a known difference.

- **Values file access on Windows (phase 4).** The program writes `.user-values.json` without the "no inherited
  access" ACL that the PowerShell engine sets; the Windows adapter adds it, checked on the VM.
- **Command lookup in the repo folder (phase 4).** The program starts `git` (and shadow `cmd.exe`) by bare name with
  the repo as working folder. Whether Bun's lookup on Windows searches that folder first, so a `git.exe` committed to
  the repo would run; if so, resolve through `PATH` only.
- **Leak scan's `bash` (phase 8 review).** The program runs bare `bash`; with WSL installed, `System32\bash.exe` can
  come before Git Bash on `PATH` and can't open the script, so every push stops at "could not run". Find Git Bash
  explicitly and pass the script path with `/`.
- **The OS caption's code page (phase 8 review).** PowerShell 5.1 writes piped output in the console code page, and
  the program decodes it as UTF-8, so a localized caption with accents comes out garbled; set
  `[Console]::OutputEncoding` first, and give the call a timeout.
- **The survey (step 27).** Work machine #1's answer (`docs/archive/windows-survey.md`, "Answer", 2026-11-16) settled the
  next five items for that machine; work #2 and #3 are asked the same when the user is at them (phase 9's checklist).

- **Shell (work #1: Git Bash).** Claude Code's Bash tool is Git Bash (MSYS2 bash 5.2, `MINGW64`), and neither hook
  sets `"shell"`, so hooks and the statusline command start under Git Bash, as the documentation says. Its
  PowerShell tool is PowerShell 7.6; the current statusline command launches `powershell.exe` (5.1) itself.
- **Git Bash and `jq` (work #1: both).** Git for Windows 2.50 with Git Bash, `jq` 1.6, PowerShell 5.1 and 7;
  `CLAUDE_CODE_GIT_BASH_PATH` unset. So decision 4 holds there: the program's leak scan runs `bash`, and `mksync
doctor`'s `bash` line is `OK`. A work machine without Git Bash still can't push until it has one.
- **Current layout (work #1).** `settings.json` holds `hooks` (a `PreToolUse` hook with a matcher and a
  `SessionStart` hook that runs `node.exe`, the work tool's own `hooks/work-tool-1-cache-heal.mjs`), `statusLine`
  (`powershell.exe` running `~/.claude/statusline.ps1`), `enabledPlugins` and `extraKnownMarketplaces` (two work
  marketplaces), `effortLevel`, `modelSettings`, `autoUpdatesChannel`, `tui`, the two notification flags, `autoMode`
  (`environment`, 25 items) and `model`. `CLAUDE.md` is 69 lines with one import line, `@WORK-TOOL-3.md`. Three skills
  are links, not folders. None of the Linux hooks is there.
- **`$HOME` in commands (work #1: both work).** `$HOME/.claude` and `~/.claude` list the same folder under Git Bash
  and under Windows PowerShell 5.1 (`-NoProfile`); PowerShell 7 wasn't tested on its own.
- **Hooks on Windows (confirmed by the user, 2026-11-16).** The work machines get none of the Linux hooks: they serve
  the plan workflow and its worker, which run on personal Linux only. So no PowerShell twins, `hooks` stays in the
  Linux overlay, and `WINDOWS_OVERLAY_KEYS` in `tools/claude-layout.ts` stays empty: every other key is in the base
  already. The rule behind it, in the user's words: sync and back up only what we create or change. Work #1's own two
  hooks look installed by the work tool (`hooks/work-tool-1-cache-heal.mjs`, next to its `heal-partial-install.log`);
  a hook a tool installs is the tool's, so it isn't synced, and the tool puts it back. Telling the two apart is
  "Owner of a setting" under "Open".
- **The unsigned program (settled 2026-11-18).** Work machines don't get the downloaded `mksync.exe` and IT isn't
  asked: they run from the clone (`SYNCSETTINGS_RUNTIME=node`), whose `mksync.cmd` shim is on the user `Path`. Work #1
  ran the whole check that way ("Real-machine results"). Bun 1.3.14 also runs the launcher there, and neither launcher
  checks Bun's version, so nothing is added to them. The release program stays for personal machines and CI.
- **`mksync` from Git Bash on a run-from-clone machine (settled 2026-11-18, cut-over step 9).** The Node install
  puts only `mksync.cmd` on the `Path`. Git Bash doesn't run a `.cmd` without its extension, so `mksync --version`
  there is `command not found` (127) while `mksync.cmd --version` works, in the local VM and on work #1. Claude Code
  runs hooks and the `statusLine` command through Git Bash, so part 2's synced `mksync statusline` would fail there.
  Of the two fixes (the Windows overlay calls `mksync.cmd`, or the installer also writes an extensionless `mksync`
  script), the installer one is taken: the synced command stays `mksync` on every OS and every install mode, where
  `mksync.cmd` exists only on a run-from-clone machine.
- **mksync as an npm package (open, idea).** `npm install -g` would put `mksync` on `PATH` on any machine with Node,
  with `npm update -g` for updates. Against it, for now: it publishes to the public npm registry (a release decision),
  `package.json` is `private`, and an install from npm is as visible on a work machine as the clone's `mksync.cmd`
  shim, which needs no registry. Revisit after v1.0.0.
