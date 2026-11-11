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

| | One shared `statusline.sh` | `mksync statusline` |
|---|---|---|
| Needs on Windows | Git Bash and `jq` | the `mksync` program, already installed by the restore |
| Runs under | Git Bash only | Git Bash or PowerShell: the command is a program name, the same in both |
| Code | one bash file, as today | one TypeScript command, tested by the shared cases |
| Start-up on Windows | Git Bash, then `jq` and `git`; not measured | about 57 ms (Bun, `docs/single-engine-research.md` section 3), plus `git` |
| Change by hand | edit the file, see it on the next refresh | edit the source and rebuild, or wait for a release |

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
- **Layer:** where the file's content lives. Base is every machine; OS is one OS (or a list); profile is one profile;
  machine is one machine record. Values (`<YOUR_EMAIL>`, `<HOME>`) are in "Values" in the last column, not a layer
  of their own: an account belongs to the profile, a path to the machine.
- **Receives:** which machines end up with the file today, when their profile lists the module.
- **Merge:** how the layers combine. "Whole file" means one layer owns the file (values still hydrate). "JSON" merges
  keys, later layers win. "`@import`" keeps one file per layer and the base file imports the others. "dconf" loads
  only the listed keys. "Dir" syncs a folder entry by entry.

| Entry | Module | Layer | Receives | Merge | Values |
|---|---|---|---|---|---|
| `dotfiles/common/git/.gitconfig` | `git` | base | all | whole file | `<YOUR_NAME>`, `<YOUR_EMAIL>`: profile |
| `dotfiles/common/git/ignore` | `git` | base | all | whole file | |
| `dotfiles/windows/git/.gitconfig.local` | `git` | OS (Windows) | Windows | whole file | `<YOUR_GH_USERNAME>`, `<YOUR_GH_ORG>`: profile; `<GH_CLI_PATH>`: machine |
| `dotfiles/linux/git/.gitconfig.local` | `git` | OS (Linux) | Linux | whole file | |
| `dotfiles/macos/git/.gitconfig.local` | `git` | OS (macOS) | macOS | whole file | |
| `dotfiles/macos/shell/.zshrc` | `shell` | OS (macOS) | macOS | whole file | |
| `dotfiles/macos/shell/.zprofile` | `shell` | OS (macOS) | macOS | whole file | |
| `dotfiles/windows/shell/.bashrc` | `shell` | OS (Windows) | Windows | whole file | linked folders: machine (see Open) |
| `dotfiles/windows/shell/.bash_profile` | `shell` | OS (Windows) | Windows | whole file | |
| `dotfiles/linux/shell/.bashrc` | `shell` | OS (Linux) | Linux | whole file | |
| `dotfiles/linux/shell/.profile` | `shell` | OS (Linux) | Linux | whole file | |
| `dotfiles/common/tmux/.tmux.conf` | `tmux` | OS (Linux, macOS) | Linux, macOS | whole file | |
| `dotfiles/common/starship/starship.toml` | `starship` | OS (Linux, macOS) | Linux, macOS | whole file | |
| `dotfiles/common/wezterm/wezterm.lua` | `wezterm` | OS (Linux, macOS) | Linux, macOS | whole file | |
| `dotfiles/common/htop/htoprc` | `htop` | OS (Linux, macOS) | Linux, macOS | whole file | |
| `dotfiles/common/gh/config.yml` | `gh` | OS (Linux, macOS) | Linux, macOS | whole file | |
| `dotfiles/linux/rtk` | `rtk` | OS (Linux) | Linux | dir | |
| `dotfiles/linux/gnome/mimeapps.list` | `gnome` | OS (Linux) | Linux | whole file | |
| `dotfiles/linux/gnome/bookmarks` | `gnome` | OS (Linux) | Linux | whole file | `<HOME>`: machine |
| `dotfiles/linux/gnome/applications/disco-datos.desktop` | `gnome` | machine (see Open) | personal Linux | whole file | |
| `dotfiles/linux/gnome/applications/mis-discos.desktop` | `gnome` | machine (see Open) | personal Linux | whole file | |
| `dotfiles/linux/wezterm/wezterm-xwayland` | `wezterm` | OS (Linux) | Linux | whole file | |
| `dotfiles/linux/wezterm/wezterm-xwayland.desktop` | `wezterm` | OS (Linux) | Linux | whole file | `<HOME>`: machine |
| `dotfiles/common/vscode/settings.json` | `vscode` | base | Linux, macOS (Windows: see Open) | JSON | `<HOME>`: machine; `<YOUR_WORK_MARKETPLACE>`: profile |
| `dotfiles/common/vscode/snippets` | `vscode` | base | Linux, macOS (Windows: see Open) | dir | |
| `dotfiles/windows/windows-terminal/settings.json` | `windows-terminal` | OS (Windows) | Windows | whole file | |
| `dotfiles/common/claude/CLAUDE.md` | `claude` | base, profile adds one | Linux, macOS; Windows in phase 7 | `@import` | |
| `dotfiles/common/claude/RTK.md` | `claude` | base | all with Claude | whole file | |
| `dotfiles/linux/claude/settings.json` | `claude` | base, OS overlay | Linux | JSON | `<HOME>`: machine; `<YOUR_GH_USERNAME>`: profile |
| `dotfiles/linux/claude/statusline.sh` | `claude` | none: replaced by `mksync statusline` | Linux until cut-over | whole file | |
| `dotfiles/common/claude/sampleGrok.md` | `claude` | none (see Open) | Linux, macOS | whole file | |
| `dotfiles/linux/claude/hooks` | `claude` | OS (Linux) | Linux | dir | |
| `dotfiles/linux/claude/skills/mk-delegate` | `claude-worker` | OS (Linux) | Linux with DeepSeek | dir | |
| `dotfiles/linux/claude/skills/mk-check` | `claude-worker` | OS (Linux) | Linux with DeepSeek | dir | |
| `dotfiles/common/claude/docs/token-routing-map.html` | `claude` | base | all with Claude | whole file | |
| `dotfiles/linux/claude/bin/mk-exec` | `claude-worker` | OS (Linux) | Linux with DeepSeek | whole file | |
| `dotfiles/linux/claude/bin/workflow-report` | `claude-worker` | OS (Linux) | Linux with DeepSeek | whole file | |
| `dotfiles/linux/claude/bin/metrics-archive` | `claude` | OS (Linux) | Linux | whole file | |
| `dotfiles/linux/claude-worker/CLAUDE.md` | `claude-worker` | OS (Linux) | Linux with DeepSeek | whole file | |
| `dotfiles/linux/claude-worker/settings.json` | `claude-worker` | OS (Linux) | Linux with DeepSeek | JSON | |
| `dotfiles/linux/claude/bin/worker-mode` | `claude-worker` | OS (Linux) | Linux with DeepSeek | whole file | |
| `dotfiles/linux/gnome/dconf/interface.ini` | `gnome` | OS (Linux) | Linux | dconf | |
| `dotfiles/linux/gnome/dconf/input-sources.ini` | `gnome` | OS (Linux) | Linux | dconf | |
| `dotfiles/linux/gnome/dconf/wm-keybindings.ini` | `gnome` | OS (Linux) | Linux | dconf | |
| `dotfiles/linux/gnome/dconf/privacy.ini` | `gnome` | OS (Linux) | Linux | dconf | |
| `dotfiles/linux/gnome/dconf/session.ini` | `gnome` | OS (Linux) | Linux | dconf | |
| `dotfiles/linux/gnome/dconf/power.ini` | `gnome` | OS (Linux) | Linux | dconf | |
| `dotfiles/linux/gnome/dconf/shell.ini` | `gnome` | OS (Linux) | Linux | dconf | |
| `dotfiles/linux/gnome/dconf/ptyxis.ini` | `gnome` | OS (Linux) | Linux | dconf | |
| `dotfiles/linux/gnome/dconf/nautilus.ini` | `gnome` | OS (Linux) | Linux | dconf | |
| `dotfiles/linux/gnome/dconf/file-chooser.ini` | `gnome` | OS (Linux) | Linux | dconf | |
| Windows Claude settings (expected) | `claude` | OS (Windows) overlay on the base | Windows; confirm in phase 7 | JSON | `<HOME>`: machine |
| Windows statusline (expected) | `claude` | none: `mksync statusline` | Windows; confirm in phase 7 | (no file) | |
| Windows `CLAUDE.md` (expected) | `claude` | base, work profile adds one | Windows; confirm in phase 7 | `@import` | |

Example, a base file with a value per profile: `dotfiles/common/vscode/settings.json` lists three Copilot plugin
marketplaces, the last one `<YOUR_WORK_MARKETPLACE>`. The file is base: the same on every machine with the `vscode`
module. The value is per profile: work #1's profile holds `https://marketplace.example.com/work-1`, work #2's holds its
own. Pull on work #1 writes the file with work #1's address; push turns it back into `<YOUR_WORK_MARKETPLACE>`, so
nothing from job #1 reaches job #2. The `personal` profile has no work marketplace, which is the open question below.

## Layers

A file is built from up to four layers, in this order: **base**, **OS**, **profile**, **machine**. When two layers set
the same thing, the later one wins: the machine beats the profile, the profile beats the OS, the OS beats the base.
"The same thing" depends on the merge type from the catalog:

| Merge | What two layers can both set | Who wins |
|---|---|---|
| whole file | the whole file | the latest layer that has the file; the others aren't read |
| JSON | one key path (`editor.fontSize`); one array item | the latest layer with that key. Objects merge key by key; arrays collect the items of every layer ("Merge and split") |
| `@import` | nothing: each layer has its own file | no conflict. The base file imports the others, base first, so Claude reads the machine's lines last |
| dconf | one listed key | the latest layer with that key |
| dir | one file inside the folder | the latest layer with that file; files from all layers are kept |

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

| Profile | Modules |
|---|---|
| `personal` | `git`, `shell`, `tmux`, `starship`, `wezterm`, `htop`, `gh`, `rtk`, `gnome`, `vscode`, `claude`, `claude-worker` |
| `work-1` | `work-base`, `git`, `shell`, `vscode`, `windows-terminal`, `claude` |

On work #1 (Windows) `personal`'s `gnome` would be off anyway; on a second personal machine running macOS, `gnome`
and `windows-terminal` are off and the rest apply.

What goes in `work-base` comes from the Windows inventory (phase 7). Until then it is an empty module.

**The profile file** holds four things:

```json
{
  "modules": ["work-base", "git", "shell", "vscode", "windows-terminal", "claude"],
  "values": {
    "<YOUR_EMAIL>": "jane@example.com",
    "<YOUR_GH_ORG>": "example-org",
    "<YOUR_WORK_MARKETPLACE>": "https://marketplace.example.com/work-1"
  },
  "destinations": {
    "vscode settings.json: chat.agent.enabled": "profile"
  },
  "retired": false
}
```

- `modules`: as above.
- `values`: the profile's own values (next section).
- `destinations`: the answers to "where does this new setting go?" from push, so every machine with this profile
  knows them (see "New settings"). The key format is fixed in "Config v2".
- `retired`: `true` once the job ends. The profile stays as the last backup, and the first run no longer suggests it.

Until the repo is private, profile files live in the machine's local state, never in the repo. The first push after
the switch commits them.

Example: job #2 ends. Its profile gets `"retired": true` on the next push from work #2. A new work laptop's first run
lists `personal`, `work-1` and `work-3`, not `work-2`.

## Values

A value fills a `<PLACEHOLDER>` on pull and turns back into it on push, as today. What changes is where it's kept:

| Value | Kept on | Why |
|---|---|---|
| `<YOUR_NAME>` | profile | the name on the job's accounts |
| `<YOUR_EMAIL>` | profile | an account |
| `<YOUR_GH_USERNAME>` | profile | an account |
| `<YOUR_GH_ORG>` | profile | an account |
| `<YOUR_WORK_MARKETPLACE>` | profile | the job's service |
| `<HOME>` | machine | a path |
| `<GH_CLI_PATH>` | machine | a path |

The rule for a new placeholder: an account, a name or an address of the job's service goes on the profile; a path or
anything about this one computer goes on the machine. If a placeholder ends up in both, the machine wins, as in
"Layers".

**Moving `.user-values.json`.** On a machine's first run of the new engine, each key of `.user-values.json` goes to the
profile or to the machine by the table above. A placeholder that isn't in the table is asked about once. The old file
is left as it is, so the old engine still works until cut-over, and is deleted then.

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

Push reads the local file, hydrates nothing, and compares it, parsed, with what pull would write now. Whitespace, key
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
"all machines" (a personal machine). The answer is stored twice: the key goes to that layer, and the destination goes
to the profile's `destinations`, so the next new value of the same key on another `personal` machine isn't asked again.

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
  "modules": { "add": [], "remove": ["vscode"] },
  "values": { "<HOME>": "C:\\Users\\jane", "<GH_CLI_PATH>": "C:\\Tools\\gh\\bin\\gh.exe" },
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
After the switch, in the repo as `machines/<name>.json`, and the local state keeps only the record's name.

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
Same as: mksync setup --profile work-1 --replace wk1-laptop --claude claude --push --existing backup
```

The suggested answers, in brackets:

1. **The profile.** The profile of the record whose hostname is exactly this one, with "replaces `<machine>`". With no
   exact match there is no suggestion and no scoring: the user picks a number or types a new profile name. Retired
   profiles aren't listed.
2. **Claude.** "Claude only" when the scan found `claude`, else "none". DeepSeek is never suggested; it's chosen.
3. **Push or pull only.** "Push with a preview".
4. **Existing files.** "Back up and replace": each file is backed up as `<file>.bak` before the pull writes it, as
   today. "Keep mine" runs a push (with its preview) before the pull; "stop" ends without writing anything but the
   record.

With `--yes` and no terminal, every question needs its flag; a missing one stops with `missing --profile` (exit 2).

**`mksync whoami`** prints the record:

```text
$ mksync whoami
machine   wk1-laptop
profile   work-1
os        windows
claude    Claude only
mode      push with a preview
modules   work-base, git, shell, windows-terminal, claude (vscode off on this machine)
```

When the hostname or domain no longer matches the record, it adds a warning on stderr and still exits 0:

```text
warning: the record says hostname wk1-laptop, this machine is wk1-new.
If this is a new machine, run: mksync setup --replace wk1-laptop
```

Push and pull print the same warning, and push stops on it (exit 1), so two machines never push from one record.

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
retired or moved to another profile on its own.

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

Example: today, personal Linux pushes a VS Code change. The preview shows the change and `held until the repo is
private: profiles/personal.json, machines/personal-linux.json`; the PR has the VS Code change only.

## Open

### Design

- **A profile without a value.** `personal` has no `<YOUR_WORK_MARKETPLACE>`. Today import stops rather than write a
  placeholder. Options: the profile marks the value "none" and the engine drops that array item; or the item moves out
  of the base into each work profile's JSON layer, which "Merge and split" adds by item. The second needs no new rule
  and is the likely answer; it changes the worked example in "Catalog", so it waits for the user.
- **Linux-only or personal-only.** There is one Linux machine and it is personal, so every Linux row could be an OS
  layer or the `personal` profile. The table says OS for tools (they'd suit any Linux machine) and machine for the two
  disk launchers (`disco-datos.desktop`, `mis-discos.desktop`), which name this machine's disks.
- **Tools that could reach Windows.** `tmux`, `starship`, `wezterm`, `htop`, `gh`, `rtk` and VS Code are Linux and macOS
  today. Whether each also belongs on Windows (`gh` and VS Code likely do) is a profile choice for the work machines.
- **`sampleGrok.md`.** An old Windows `CLAUDE.md`, kept for reference. Drop it at cut-over, or keep it as a document
  outside the sync.
- **`.bashrc` linked folders on Windows.** `detectLinkedPaths` becomes `dir` entries at cut-over (roadmap). Whether
  those entries live on the machine record or on the work profile is decided with "Linked folders".
- **Removing a key in a later layer.** JSON merge can add and replace keys, not remove one the base sets. Options: a
  `null` in the later layer removes the key, or removal isn't supported. Claude and VS Code treat some `null` values as
  meaningful, so `null` may need an explicit marker instead.
- **`~` instead of `<HOME>` in Claude settings.** Claude Code expands `~` in commands on every OS (see "Statusline and
  hooks on Windows"), so `settings.json` could drop `<HOME>` and its escaping. Needs the `$HOME` check under "Confirm
  on Windows".
- **`<YOUR_NAME>` per profile.** It's likely the same on every profile. Keeping it per profile costs one prompt per job;
  a shared value would need a fifth place (the user), which the decisions don't have.
- **Machine-state keys.** Which keys of Claude's `settings.json` (and VS Code's) are this machine's state, never pushed
  and kept on pull. Found by diffing the file before and after a few sessions, on Linux first.
- **Editing one hook.** Array items are compared whole, so changing one command inside a `hooks.<event>[]` item is a
  removed item (from its layer) plus a new item (asked about). Correct, but two lines in the preview for one edit. A
  key per item (the `matcher`) would make it one change; worth it only if hook edits turn out frequent.
- **New commands and flags.** `mksync whoami`, and `setup`'s `--profile`, `--replace`, `--claude`, `--push`/`--pull-only`
  and `--existing` are new; the contract's "Front door" changes with them. Also how a profile or machine is retired
  from the command line (`mksync retire <machine>`, `mksync profile retire <name>`?). The `cli` skill reviews the names
  before phase 6.
- **Retiring a profile with live machines.** Refuse while a non-retired machine uses it, or warn and go on.
- **Two records, one hostname.** A replaced machine's hostname can come back (a reinstall). The exact-match suggestion
  then names the newest record with that hostname; older ones are retired or listed in `replaced`.
- **`metrics-archive` and the hooks.** They serve the plan workflow, not the DeepSeek worker, so they're in `claude`
  rather than `claude-worker`. Whether the work machines want them is part of "Hooks on Windows".

### Confirm on Windows

- **Shell.** Which shell Claude Code uses for the statusline and hooks on each work machine: Git Bash or PowerShell.
  (`claude doctor`, or a hook that prints `$0`.) The docs say Git Bash when Git for Windows is installed.
- **Git Bash and `jq`.** Whether Git for Windows (with Git Bash) and `jq` are installed on work #1 to #3, and whether
  `CLAUDE_CODE_GIT_BASH_PATH` is set anywhere.
- **Current layout.** The current Windows statusline (`statusLine` in `%USERPROFILE%\.claude\settings.json`, and the
  script it calls), and what else is in `~/.claude` there: hooks, skills, `CLAUDE.md`. Names that point at an employer
  are redacted (`work-tool-1`) before they reach the repo.
- **`$HOME` in commands.** Whether `$HOME/.claude/…` in a hook or statusline command resolves under both Git Bash and
  PowerShell, or only `~` does.
- **Hooks on Windows.** Which of the Linux hooks the work machines need, and whether each gets a PowerShell twin
  (`"shell": "powershell"`) or stays Linux-only.
