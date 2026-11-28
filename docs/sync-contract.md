# Sync engine contract

SyncSettings has one engine: `mksync`, a TypeScript program compiled per OS ([The program](#the-program)), with
modules, profiles and layered settings ([design-layers.md](design-layers.md)). It reads `sync-config.json`, the
`.user-values.json` values and the machine records, and follows the rules on this page on Linux, macOS and Windows.
The bash and PowerShell engines it replaced were deleted at the cut-over; their last state is the git tag
`two-engines-final`.

This page is for contributors. If you change how `mksync` behaves, change this page in the same PR, and add a case that
proves the rule. The shared cases in [`tests/parity/`](../tests/parity/README.md) are this page in executable form, so
a rule that shows in exit codes, status lines and files gets a shared case first, with `expect/` written from this
page. Text the shared runner doesn't read (notes, messages) and internal functions go in the unit tests
(`bun test src`). A rule that differs between operating systems is listed under
[Known differences](#known-differences). Every other rule applies on all three.

A file's label below is its repo path, such as `dotfiles/linux/shell/.bashrc`: the entry's `file` under the layer
folder it comes from (`repoPath` in the older wording). To add or change an entry in `sync-config.json`, see
[configuration.md](configuration.md).

## Flow

```mermaid
flowchart LR
    L[Local files] -->|export: compare, sanitize, copy changed| R[dotfiles/ in repo]
    R -->|commit: branch + PR| G[GitHub master]
    G -->|git pull| R
    R -->|import: compare, prompt, .bak, hydrate| L
```

- **Export** reads every selected entry's local file. It compares the file with the repo copy by content (never by
  date), sanitizes it, and writes only the files that changed. It ends with the [orphan report](#orphan-report) and, on
  Linux, the [drift report](#package-drift).
- **Commit** runs the [checks before pushing](#checks-before-pushing), stages `dotfiles/`, `sync-config.json` and
  `packages/` (if it exists), commits on a `sync/<os>-<machine>-…` branch (`sync/linux-…` on Linux, `sync/macos-…` on a
  Mac) and opens a PR. It never pushes to `master`. See [review-gate.md](review-gate.md).
- **Import** reads every selected entry's repo file and hydrates its placeholders. If the local file differs, import
  asks before overwriting it (unless forced) and keeps a `.bak` copy of the old file.

A [dconf entry](#dconf-entries-merge-dconf) follows the same flow with a dconf folder in place of the local file.

## Config

`mksync` looks for its config in the current folder, then each parent, and reads the first it finds, in this order
([cut-over decision 8](archive/plan-single-engine-9-cutover.md)):

1. `sync-config.v2.json`, which only a clone from before v1.0.0 still has, so a machine that ran `mksync update` before
   its first pull past v1.0.0 still loads its old clone's config and can pull;
2. else `sync-config.json`.

Either file is read as config v2 ([configuration.md](configuration.md)). Every `ERROR:` line about the config names
the file it read. A `sync-config.json` whose JSON object has no `schemaVersion` is an old v1 config, and every command
stops before it reads another field ([cut-over decision 7](archive/plan-single-engine-9-cutover.md)):

```text
ERROR: sync-config.json: needs schemaVersion 2; this is an old config.
```

exit 2. A `schemaVersion` above 2 means the program is too old for the config
([design, "Decided in phase 9"](design-layers.md#decided-in-phase-9), decision 6). Any other value (below 2, not a
number) gets the unsupported line. Both exit 2:

```text
ERROR: <config file>: this config needs a newer mksync: run mksync update.
ERROR: <config file>: unsupported config schemaVersion <n>.
```

A config that isn't a JSON object stops with `ERROR: <config file>: invalid JSON.`, exit 1. No config in the folder
or its parents stops with `ERROR: no sync-config.json or sync-config.v2.json in this folder or
its parents.`, and a config file that can't be read with `ERROR: cannot read <file>.`, both exit 1.

Shared cases: `config-v2-in-sync-config` (a v2 `sync-config.json` is read), `config-v2-old-clone` (both files: the
`sync-config.v2.json` wins), `config-v1-refused` (decision 7's line), `config-v2-in-sync-config-newer` and
`config-v2-newer-schema` (schema 3).

## Entry selection

An entry runs on the systems in its effective `os`: the entry's `os` list when it has one, else its module's `os`,
else all three ([configuration.md, "`os`"](configuration.md#os)). With a machine record, an entry whose module the
profile doesn't turn on is skipped too ([Layers](#layers)). After the config's entries come the linked folders the
profile and the machine record hold ([Linked folders](#linked-folders)); they run on this machine whatever its system.

Entries run in the order they appear in `sync-config.json`. The config is checked as a whole before any file is
touched, so a bad entry for one system stops every system ([Path safety](#path-safety)).

### Which system

`mksync` runs for its host's system: `linux`, `macos` or `windows`. `SYNC_OS` overrides it, but only with a value for
the same host: `linux` or `macos` off Windows, `windows` on Windows. Tests set `SYNC_OS=macos` on Linux to cover macOS
behavior. Any other value, or another host, stops the run with exit code 1:

```text
ERROR: SyncSettings runs on Linux, macOS and Windows; this is <value>.
```

The profile and machine come from the machine record ([Machines](#machines)). `SYNC_HOSTNAME`, `SYNC_DOMAIN` and
`SYNC_TOOLS` stand in for the scan, as `SYNC_OS` does for the system ([The scan](#the-scan)).

## Picking files

Every command that walks entries takes a repeatable `--only <path>` (`mksync pull`, `push`, `diff` and `check` take
the paths as arguments and pass them on as `--only`). A path is either a repo path or a local path:

- A path starting with `dotfiles/` is a repo path. It is accepted when an entry selected for this OS owns it: the path
  equals its label, or starts with `<label>/` for a `dir` entry. A `json` entry whose label is a profile or machine
  layer also accepts the label the [diff](#diff) prints for it. A trailing `/` is dropped. A path with a `..`
  segment is refused.
- Any other path is a local path. A leading `~/` becomes `$HOME/` (a lone `~` becomes `$HOME`), a path that doesn't
  start with `/` is joined to the current folder, and `.` and `..`
  segments are folded lexically, without following links.

A local path resolves to a repo path by comparing it with each selected entry's resolved `localPath`, folded
the same way: equal to a file entry gives its label; equal to a `dir` entry's folder gives its label, and
inside that folder gives `<label>/<rest>`. A `dconf` entry has no local path and is matched by its label only.

A path that matches no entry for this OS stops the run before it touches any file:

```text
ERROR: <path> is not synced on this machine.
```

Then a repo file is selected when there is no `--only`, or its repo path equals a selected path, or starts with
`<selected>/`. An entry is walked when that rule selects one of its files, or when a pick lies under the entry's own
path, so the picked file inside it is still reached.

`mksync import --only` handles only the selected files: every other entry and file gets no status line and no count,
and `--check --only` lists only the selected files. With `--only` only the picked entries' values are requested, so a
missing value that only an unpicked entry needs does not stop the run. A run with `--only` never records the sync
point, because the machine agrees with only part of the repo. `--only` with no path after it is an error, exit 1.

`mksync export --only` writes only the selected files. It removes a repo file gone from a `dir` entry's folder only
when that file is selected, and skips the orphan and package drift reports: a partial run doesn't see the whole repo.
`--diff --only` labels only the selected paths, and its counts and hints cover only them. When `--only` is given and no
file gets a status line or a diff label, the run prints `  WARNING: --only matched no file.` before the summary; the
exit code and counts don't change. `--preview` with `--only` is an error, exit 1.

## Path safety

When it reads the config, `mksync` checks every entry, for any system, and stops with exit code 1 before it touches a
file. Each line names the entry's `file`:

```text
ERROR: <config file>: entry <file> has an unsafe path.
ERROR: <config file>: entry <file> has a backslash in localPath.
ERROR: <config file>: entry <file> has an unknown localPaths key <key>.
ERROR: <config file>: entry <file> has an invalid defaultEnv.
ERROR: <config file>: entry <file> has an invalid suggest.
ERROR: <config file>: entry <file> needs a dconfPath like /org/gnome/shell/.
```

- `file` is unsafe when it is empty, starts with `/` or a drive letter (`C:`), holds a `..` segment, or holds a `\`
  ([design, "Config v2"](design-layers.md#config-v2), decision 11). A symlink anywhere under `dotfiles/` gets the
  same line, with the symlink's repo path in place of `<file>`.
- `localPath` and every [`localPaths`](#localpath) value use forward slashes; its keys are `linux`, `macos` or
  `windows`.
- A `sanitize` rule's `defaultEnv` matches `^[A-Za-z_][A-Za-z0-9_]*$`, because it names an environment variable.
- A `sanitize` rule's `suggest`, when present, is one source or a non-empty list of distinct sources, each
  `gh-login`, `gh-hosts-login`, `origin-owner`, `git-user-name`, `git-user-email`, `passwd-name` or `gh-path`
  ([Sanitize and hydrate](#sanitize-and-hydrate)). An empty list, a repeated source or any other value is invalid.
  A name outside that list, alone or in a list of names, is the one exit-2 line here, since a newer config may name
  a source a newer `mksync` has; it names the first such name:
  `ERROR: <config file>: entry <file> has an unknown suggest source <name>; if the config is newer, run mksync update.`
- A `dconf` entry has no `localPath`. Its `dconfPath` must start and end with `/`, hold at least one segment of
  letters, digits, `.`, `_` or `-`, and have no `..` segment. So `/` alone is refused, and nobody dumps the whole
  database by accident.

The other shape checks stop the same way, exit 1, with these endings after `entry <file>`: `needs file and localPath
as strings`, `names unknown module <m>`, `has an unknown merge <m>`, `can not use <field> with merge <merge>`,
`can not use escapeBackslashes with merge json`, `has elevate other than false`, `has linked other than true`,
`needs {layer} in importName`, `has an os that is not a list of linux, macos or windows`, `lists os <os> outside module
<m>`, `has a trailing / in file`, `needs keys as a non-empty list of strings` and `is inside dir entry <dir>`; a module
gets `module <m> has an os that is not a list of linux, macos or windows`. The fields are in
[configuration.md](configuration.md). CI lint (`tools/check-config.ts`) runs the same parser on the repo's config.

## `localPath`

| Form                   | Example                | Works on     |
| ---------------------- | ---------------------- | ------------ |
| `~/` + forward slashes | `~/.config/git/ignore` | every system |
| an absolute path       | `C:/MakuCustomAlias`   | its system   |

`~` is the user's home: `$HOME` on Linux and macOS, `USERPROFILE` on Windows, where `/` becomes `\` after `~` is
expanded. An absolute path, such as `C:/MakuCustomAlias` ([cut-over decision 4](archive/plan-single-engine-9-cutover.md)),
belongs on an entry whose `os` names one system. With no home folder set the run stops with exit code 1 before
touching a file: `ERROR: the home folder is not set (HOME).` (`(USERPROFILE).` on Windows).

A symlink at a file entry's `localPath` is followed: export reads the target, and import writes through the link,
which stays a link. A link to a missing target counts as a missing local file. Inside a `dir` entry links are skipped
([Directory entries](#directory-entries-merge-dir)).

`localPaths` (optional) is an object keyed by system, for a file whose content is shared but whose folder differs, such
as VS Code's `~/.config/Code/User` on Linux and `~/Library/Application Support/Code/User` on macOS. On a system named in
it, its value replaces `localPath`; elsewhere `localPath` applies. A key for a system the entry doesn't run on is
allowed and never used. The swap happens when the entry is selected, so every later rule sees one `localPath`.

## Statuses

Each file gets one status line: the status word, its label (the repo path, or `<label>/<rel>` inside a
directory entry) and sometimes a note in parentheses. The line is `  WORD       label`, the word padded to 11
characters, on every system; on a terminal the word is colored. The word, the label and the notes listed below are the
contract, and tests match on them.

### Export

| Case                                              | Status      | Note                                                   |
| ------------------------------------------------- | ----------- | ------------------------------------------------------ |
| Local path matches an exclude pattern             | `SKIPPED`   | `matches exclude pattern`                              |
| Local file missing                                | `SKIPPED`   | `local file not found: <path>`                         |
| Repo file missing                                 | `ADDED`     | `sanitized` if the entry has rules                     |
| Same content                                      | `UNCHANGED` |                                                        |
| Different content                                 | `MODIFIED`  | `sanitized` if the entry has rules                     |
| `merge: dir`: repo file no longer present locally | `REMOVED`   | `no longer in source`                                  |
| `merge: dconf`: `dconf` isn't installed           | `SKIPPED`   | `dconf not installed`                                  |
| `merge: dconf`: nothing left after `keys`         | `SKIPPED`   | `no settings under <path>`; a repo file stays as it is |
| `merge: dconf`: `dconf dump` failed               | `ERROR`     | `dconf dump failed`                                    |
| Read, write or copy failed                        | `ERROR`     | the reason                                             |

An export that copies nothing but skipped missing local files ends its summary with
`Note: <n> file(s) skipped because they do not exist locally.` and
`If this is a new machine, run  mksync setup  first to apply the repo settings.`

### Import

| Case                                                                      | Status      | Note                                                             |
| ------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------- |
| Local path matches an exclude pattern                                     | `SKIPPED`   | `matches exclude pattern`                                        |
| Repo file missing                                                         | `SKIPPED`   | `not found in repo`                                              |
| Local file missing                                                        | `CREATED`   |                                                                  |
| Same content                                                              | `UNCHANGED` |                                                                  |
| Different content, overwrite accepted                                     | `UPDATED`   | `backup saved as <name>.bak`                                     |
| Different content, user answered no                                       | `SKIPPED`   | `user skipped`                                                   |
| `merge: dir`: local file not in the repo                                  | `EXTRA`     | `not in repo; kept`                                              |
| `merge: dconf`: `dconf` isn't installed                                   | `SKIPPED`   | `dconf not installed`                                            |
| `merge: dconf`: `HOME` isn't the login home                               | `SKIPPED`   | `HOME is not the login home; dconf left alone`                   |
| `merge: dconf`: `${XDG_CONFIG_HOME:-$HOME/.config}` isn't `$HOME/.config` | `SKIPPED`   | `XDG_CONFIG_HOME is not ~/.config; dconf left alone`             |
| `merge: dconf`: nothing set under `dconfPath` yet                         | `CREATED`   | no prompt, no backup                                             |
| `merge: dconf`: every repo key already has that value                     | `UNCHANGED` | nothing is loaded                                                |
| `merge: dconf`: dump, backup or load failed                               | `ERROR`     | `dconf dump failed`, `cannot create backup`, `dconf load failed` |
| Read, write or copy failed                                                | `ERROR`     | the reason                                                       |

### Both

| Case                                                   | Status   | Note                                                                 |
| ------------------------------------------------------ | -------- | -------------------------------------------------------------------- |
| File under `dotfiles/` that no entry owns              | `ORPHAN` | `no entry in sync-config.json; git rm it or add an entry`            |
| Linux, export: a package list and the machine disagree | `DRIFT`  | see [Package drift](#package-drift); the label is `<manager>/<name>` |

An `ERROR` affects only its own file. `mksync` moves on to the next entry, and the run still exits 0. Exit code 1
is reserved for problems that stop the whole run: invalid config, a missing placeholder value, a failed `git pull`, or a
failed [check before pushing](#checks-before-pushing).

## Overwrite prompt

Unless `--force` is given, import asks `Overwrite <file>? [Y/n]` before it replaces a local file whose content
differs. An empty answer means yes. End of input (for example `< /dev/null`) also counts as an empty answer, on every
system, so a non-interactive run without `--force` overwrites. The `.bak` copy is still written. Force skips only the
prompt, never the `.bak`. For a dconf entry, `<file>` is the entry's `dconfPath`.

## Sanitize and hydrate

An entry's `sanitize` rules hold the placeholders for its file. On export, sanitizing replaces real values with
placeholders. On import, hydrating puts the values back.

**Where values come from**, in this order:

1. The cached value: the machine record's or its profile's ([Values on a machine](#values-on-a-machine)), or without a
   record `.user-values.json` next to `sync-config.json` (gitignored, keys are placeholders). A value that isn't a
   string is read as its JSON text (`8080` is `"8080"`, `null` is `"null"`) and saved back as that string.
2. Values inferred from the existing local file (below), on import and export alike. They are never used for a placeholder that
   already has a cached value.
3. The rule's `default`, then the environment variable named by `defaultEnv`, taken without a prompt.
   `defaultEnv: "HOME"` is the program's home folder on every OS: `$HOME` on Linux and macOS, `%USERPROFILE%` with
   forward slashes on Windows (`C:/Users/user`), where `HOME` is usually unset; Git Bash and Claude Code's commands
   read that form. Any other name is read from the environment as it is.

A value that holds placeholder text (`<`, a capital letter, then capitals, digits or `_`, then `>`, such as `<HOME>`)
counts as no value, wherever it comes from, so hydrate never writes a placeholder and sanitize never keeps one as a
value. 4. A prompt, only for a placeholder none of these fills.

Before the first question it prints
`\n  Enter values to fill the placeholders in the config files:\n\n`, then ` <prompt> (<file>, …):` for each, and a
newline after the last answer. The files are the `localPath` of each entry being written (pull) or sent (push) that
has the rule, as `sync-config.json` writes it (`~/.claude/settings.json`), de-duplicated, in entry order. A value that
appears in none of those files is still asked: the program can't tell without the value, and skipping would fail open.

**Suggested answers.** A rule may name a `suggest` source, or a list of them ([configuration](configuration.md#sanitize)).
When push or pull is about to ask for that placeholder, it runs the sources in list order, each at most once, and
stops at the first that answers; that source's trimmed output is shown before the colon:
` <prompt> (<file>, …) [<value>]:`. An empty answer then takes the suggestion; a typed answer wins. Each source runs
its command directly, with no shell, under the same 5-second limit. The sources are:

- `gh-login`: `gh api user --jq .login` (asks GitHub over the network).
- `gh-hosts-login`: `gh config get -h github.com user`, the login `gh` saved for `github.com`; no network.
- `origin-owner`: the owner part of the clone's `origin`, read with `git remote get-url origin`, when that address is
  on `github.com` (`https://github.com/<owner>/<repo>`, `git@github.com:<owner>/<repo>`,
  `ssh://git@github.com/<owner>/<repo>`); nothing for another host.
- `git-user-name`: `git config --global user.name`.
- `git-user-email`: `git config --global user.email`.
- `passwd-name`: the current user's full name, up to its first comma: on Linux the full-name field of
  `getent passwd <user>`, on macOS `id -F`; nothing on Windows, or when the field is empty.
- `gh-path`: the path of `gh` found on `PATH`, the way `mksync doctor` finds it; nothing when it isn't found.

A source that fails, runs past 5 seconds, prints nothing, prints more than one line, prints a control character (or a Unicode format character: a bidi override, a zero-width mark, a line separator, the BOM) or
prints placeholder text doesn't answer, and the next source runs; when none answers, the prompt reads as without a
suggestion.

A rule with a `default` and `suggest` including `gh-path` is the one case where a source is used without a prompt, as
a default is, so it runs under `--yes` too: a cached value still wins, and otherwise, when `gh` is found, its path
takes the `default`'s place and is saved as an inferred value is ([Values on a machine](#values-on-a-machine), or
`.user-values.json` without a record), so export sanitizes it (the path can hold the user name). When `gh` isn't
found, the `default` is used and nothing is saved. Neither is asked. The other exception is `setup --yes`
([`mksync setup`](#mksync-setup)): it runs the sources and takes each value's suggestion, because its summary's
`Values:` block prints every one before anything is written and the values stay on this machine. Otherwise a
suggestion is never used without its prompt: `--yes` (push and pull), `preview`, `diff`, `check` and `status` run no
source, and end of input never takes a suggestion, so a suggestion can't fill a value unseen. With no input the source
still runs before the first prompt, and the run stops there as below. Each prompt is printed before its answer is read. An empty answer or end of input leaves the value
missing, so the run stops as below, after the prompts printed so far; with no input at all a run stops as it did
before. An answer that holds placeholder text stops the run at once with the missing-value line. Answers are read from
stdin after a leading byte order mark (`U+FEFF`, which Windows PowerShell puts before piped text) is dropped. `--check`, `preview`, `export --preview`, `status` and `diff` never ask.

**Push asks.** Export (push) without `--yes` asks for each value nothing above fills, on stdin, as import does:
the same header and ` <prompt> (<file>, …):` lines, in rule order, before the change list. It asks for every
placeholder of the entries this machine syncs (this OS's entries, with its profile's and machine's layers) that nothing
fills, not only those of the files it sends: skipped files and an entry whose local file is missing still count,
since a later push or pull needs the value for them, and the commit's [cached-value search](#checks-before-pushing)
must know each one. Picked paths don't narrow it: `mksync push <path>` asks every such value too. Each question names the files that need it, a missing one
too. Push asks these before its [diff guard](#front-door) runs, so the guard and the export find them saved. An empty answer or end of input stops the run at once with the
missing-value line, and so does an answer that holds placeholder text. The answers are saved as inferred values are:
on the record and the profile by [Values on a machine](#values-on-a-machine), else in `.user-values.json`. Then every
value it knows, inferred ones too, is saved where a full export saves it, before the guard. `--yes` asks nothing, and
a value still unknown stops the push with the missing-value line, exit 1, before anything is exported: the commit
pushes its branch to the public repo before anyone reviews the PR, so it never runs without every value. With no input
(`< /dev/null`) the header is printed and the run stops at the first question.

`mksync import --reset-values` prompts again for every placeholder and skips inference.
The cached value is only the prompt's default. With no cached value, a suggestion comes before the rule's `default`
and `defaultEnv`, and a prompt that shows one stops the run at end of input, as one with no default does. The program prints each prompt before reading its answer. With a machine record, an answer that differs from the record's or the
profile's value replaces it there; a new one is placed as in [Values on a machine](#values-on-a-machine). The program
takes the flag on `import` only so far.
New values are saved back to `.user-values.json`. Each save leaves the file readable by the current user only: mode 600
on Linux, also tightening an existing file, and no inherited access on Windows. The Windows save doesn't need a domain
controller, so it works on a domain laptop that's off the network.

**Inference.** Import and export (push, `preview`, `diff`) read values from this machine's files, each its own way. A
cached value still wins, and an inferred one comes before `default` and `defaultEnv`, except as below. Entries left out
by `--only` or skipped still count.

- _Import._ For each entry with rules whose local and repo files both exist, `mksync` compares the two files line by
  line, up to the shorter one, with `\r` stripped. Take a repo line that contains a placeholder, paired with a local
  line that doesn't. If the local line starts with the text before the placeholder and ends with the text after it,
  the text in between is the value. The first value found wins.
- _Export._ Export runs on files that have drifted, and a wrong value would leave the real one unsanitized in the
  repo, so it reads a value only from a line nothing else could be taken for. A repo line that contains a placeholder gives a value only
  when exactly one local line, anywhere in the file, fits the text before and after it. The placeholder is not
  inferred when a repo line fits two local lines with different values, when two repo lines or two entries give
  different values, or when its rule has a `defaultEnv` that is set (the environment's value is used). A value read
  from a `json` entry is JSON-unescaped. A placeholder left without a value stops the export as below.

Empty results are ignored. For a rule with `escapeBackslashes: true`, each `\\` in the inferred value becomes `\`,
because the file holds the doubled form.

**Sanitize (export).** Values are replaced longest first, so a value that contains a shorter one is replaced whole.
For each value that contains `\`, its backslash-doubled form (`C:\\Tools`) is replaced before the plain form
(`C:\Tools`), so files that escape backslashes sanitize too. A value that starts with a drive and a slash is also
replaced written with the other slash, after the forms above: `C:/Users/user` in its backslash forms
(`C:\\Users\\user`, `C:\Users\user`), and `C:\Users\user` as `C:/Users/user`, so a file that writes the home folder
either way sanitizes.

**Hydrate (import).** Each placeholder gets its value. If the rule has `escapeBackslashes: true` and the value
contains `\`, the placeholder gets the backslash-doubled value instead.

**No rescan.** Neither side scans text it has already put in. A short value that also appears in another placeholder's
name (`SER` in `<USER_NAME>`) leaves that placeholder whole. A value that holds a placeholder (`x<B>y`) counts as no
value (above), so it is never written. `mksync` replaces in two passes, first with tokens made of the control bytes `\x01`-`\x03` and then with
the result, so a synced file holding that byte run is not supported.

**Missing value.** If a placeholder has no value after all of the above, with or without a terminal, `mksync` prints
`missing value for <PLACEHOLDER>: run mksync push or pull in a terminal to enter it` and exits 1 before writing any
file. The line is the same with or without a machine record. Output names the
placeholder, never its value. `preview` and `check` don't stop: they mark the files that need the value `SKIPPED`
and carry on ([Export preview](#export-preview), [Import check](#import-check)).

## Compare

- Files without rules: byte for byte, except shared files on Windows, below.
- Shared files on Windows: a file under `dotfiles/common/` without sanitize rules is compared with CRLF folded to LF,
  and export writes it with LF line endings; a file holding a NUL byte is compared and copied byte for byte. Import
  writes the repo's bytes, so a local CRLF copy with the same lines counts as `UNCHANGED`.
- Windows files on Windows: a text file (no NUL byte) under `dotfiles/windows/` is compared with CRLF folded to LF too,
  so a CRLF copy of an LF repo file (Git for Windows writes `.bash_profile` with CRLF) is `UNCHANGED`. Writes don't
  change: export writes the local bytes and import the repo's, and `.gitattributes`'s `-text` keeps them. A file with a
  NUL byte stays byte for byte.
- Files with rules: the sanitized local text (export) or the hydrated repo text (import) against the other side,
  after turning CRLF into LF and trimming whitespace at the end of the file. A file that differs only in line
  endings or trailing blank lines counts as `UNCHANGED`, and nothing is written. The compare is case-sensitive, so a
  change of case counts as `MODIFIED`.

Text is written byte for byte: no BOM, and trailing newlines are kept.

Git keeps the bytes too. `.gitattributes` marks `dotfiles/windows/**` as `-text`, so a Windows file with CRLF lines
comes back from git as export wrote it, and `mksync diff` agrees with the machine after a push. `dotfiles/common/**`
and `dotfiles/linux/**` stay LF.

## Backups

Import copies the old local file to `<file>.bak` before overwriting it, replacing any older `.bak`, in every entry type.
`*.bak` is in `excludePatterns`, so a `.bak` inside a synced directory is never exported.

A dconf entry has no local file to sit next to, so its backup is `~/.local/state/sync-settings/dconf/<file>.bak`, where
`<file>` is the name of the repo file. It holds the raw dump of `path`, written before each `UPDATED`. Loading it back
restores the old values, but a key that had no value before keeps the repo's value, because a load never removes a key.

Every import that overwrites a file also copies the old version into a folder for that run:

- Linux and macOS: `${XDG_STATE_HOME:-$HOME/.local/state}/sync-settings/backups/<run>/<label>`
- Windows: `%LOCALAPPDATA%\SyncSettings\backups\<run>\<label>`, with `\` separators

`<run>` is `YYYYMMDD-HHMMSS-<pid>` in local time. The folder is created at the first backup of the run, so a run that
overwrites nothing makes none, and a `--check` run never makes one. After the run the newest 20 run folders are kept
and older ones removed, sorted by name. When the run made a dated copy, the summary adds `  Backups    : <folder>`. A
failed dated copy prints a `WARNING` line and doesn't change the exit code; the `.bak` stays the backup that must
succeed.

## Exclude patterns

`excludePatterns` are globs matched against the local path's file name, or the end of the path. A match is skipped
on export and import, and inside directory entries too.

## Directory entries (`merge: dir`)

An entry with `"merge": "dir"` syncs a whole folder, recursively.

- Only regular files are synced. Symlinks are `SKIPPED` with the note `symlink`. A symlink at the folder's own
  path is followed.
- A symlink is not a file of the folder, so on export a local file that is now a symlink is `SKIPPED` with the note
  `symlink`, then its repo copy is `REMOVED` with the note `no longer in source`, unless the empty-folder rule below
  keeps the repo files.
- `excludePatterns` apply to every file. `sanitize` is not allowed on a `dir` entry (the config check fails).
- No entry may have its `file` inside a `dir` entry's `file`, including another `dir` entry (the config check fails).
- If the local folder is missing on export, the entry is `SKIPPED` with the note `local folder not found: <path>`.
- If no local file passes the symlink and exclude checks (an empty folder, or one holding only symlinks or excluded
  files) while the repo folder still holds at least one file, the entry is `SKIPPED` with the note
  `local folder is empty; repo files kept` and no repo file is removed.
- Export deletes repo files that are gone locally or are now excluded (`REMOVED`; git keeps the history), then
  removes empty folders under the entry's folder in the repo.
- Import never deletes. A local file that the repo doesn't have is reported as `EXTRA` and kept, so a file you
  haven't exported yet survives an import.
- Each file inside follows the same compare, prompt and `.bak` rules as a plain entry.

## Linked folders

A file entry with `"linked": true` names folders, the way a `.bashrc` names a scripts folder. `mksync` doesn't copy
those folders; it offers each one as a `dir` entry. The file is read for folder paths: a drive folder (`/c/Tools`,
`C:\Tools`) and a home folder (`~/`, `$HOME/`, `%USERPROFILE%\`), a trailing `/*.<ext>` and slash dropped. Each
folder that exists, isn't synced by any entry and hasn't been answered is asked once, by `mksync setup` after its
four questions:

```text
.bashrc uses ~/work-tool-1-scripts (12 files, 40 KB). Sync it as a folder? 1) this profile  2) this machine  3) no [1]
```

- The suggestion is `1` for a folder in the home with fewer than 1000 files and under 10 MB with no part of its path starting with `.` (a leading `~/.config` aside), else `3`: a folder in or under a hidden one (`~/.nvm`, `~/.cargo/bin`) is a tool's own install. `--yes` takes
  it. An answer other than `1` to `3` prints `Pick 1 to 3.` and asks again.
- `1` adds a `dir` entry to the profile's `entries` list, stored under `profiles/<p>/linked/<folder name>/`; `2` adds
  it to the machine record's `entries`, under `machines/<m>/linked/<folder name>/`. Both are state files, so the
  [public-repo guard](#public-repo-guard) holds them while the repo is public.
- `3` stores `"linked: <localPath>": "no"` in the profile's `destinations`, and the folder isn't asked again.
- `mksync status` asks nothing; it prints `Linked folder not synced: <path> (mksync setup asks)` for each folder not
  answered yet.
- A found folder whose name is `.` or `..`, or the home folder itself, is never offered. A `dir` entry whose `file`
  has an empty, `.` or `..` part, or a `\`, is refused with `entry <file> is outside linked/`.

## dconf entries (`merge: dconf`)

Linux only. An entry with `"merge": "dconf"` syncs one dconf folder with one `.ini` file. On Windows and macOS the
config check still validates it, and the entry stays `SKIPPED`.

- **Repo file.** Export owns it, so it is byte for byte what `dconf dump` prints, filtered by `keys`.
- **`keys`.** An allowlist of shell globs matched against a key's name relative to `dconfPath`, such as `font-name` or
  `Profiles/abc/label`. `*` also matches `/`. Without `keys`, the whole subtree goes. A section left with no keys is
  dropped. A key nobody named stays out on purpose, because the repo is public and the leak scan can't recognize
  coordinates or shell history.
- **Export.** Compares bytes with the repo file. An empty result is `SKIPPED` and never touches the repo file. A failed
  repo write is an `ERROR` for that entry, and the run moves on.
- **Import merges; it never resets.** `dconf load` leaves keys the file doesn't name, so a key only the machine has
  doesn't count as a difference. A key reset to its default on one machine disappears from the repo file, and another
  machine keeps its old value.
- **Login-home guard.** Import won't load when `$HOME` isn't the home in `getent passwd`. dconf writes go over the session
  bus to a service that keeps the login session's `HOME`, so `HOME=$(mktemp -d) mksync import` would otherwise change the
  real desktop. Export needs no guard: `dconf dump` reads the file under `$XDG_CONFIG_HOME`.
- **Session bus.** Import needs the graphical session. From a text console, each entry that has to load reports `ERROR`
  with `dconf load failed`. Export works without a bus.
- **Bad repo file.** One invalid value fails the whole load, so no key of that entry is written.
- **No `sanitize` or `localPath`.** The config check fails on them. A home path in a dump stops at
  the leak scan.
- **Leak scan.** An extension UUID has the shape of an address, so the `enabled-extensions` and `disabled-extensions` lines
  of an `.ini` under `dotfiles/linux/gnome/dconf/` are exempt from the email rule. Every other line, file and suffix isn't.
- **Commands.** `mksync` runs `dconf` and `getent passwd` from `PATH`. The shared cases run against stubs of both, so
  no case touches a real session bus.

## Checks before pushing

Commit runs these after the check for changes outside the sync paths, and before it creates a branch or a commit. A
failure exits 1 and leaves no branch, no commit and no PR.

Commit first prints its banner, then runs the checks:

```text

  +==========================================+
  |        SyncSettings -- COMMIT           |
  +==========================================+

```

**Changes outside the sync paths.** Any `git status --porcelain` line for a path outside `dotfiles/`,
`sync-config.json` and `packages/` stops the commit, listing each line under a heading:

```text
  Changes outside sync paths:
    ?? .config/
ERROR: commit or stash changes outside dotfiles/ first.
```

**Leak scan.** `scripts/ci/leak-scan.sh` runs on the sync paths. Skipping it is not an option: a scan that cannot run stops
the commit the same way a hit does. A rule that tests a file's path compares it with `/` as the separator, whatever the
OS: a Windows path given with `\` is folded to `/` first, so an allowance (such as the dconf extension lines below)
matches on Windows as on Linux. A hit's
file keeps its drive (`C:\…`): the drive's colon is part of the path, so the line number after it is still right.

| Scan result                                    | Message                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| Exit 1                                         | `ERROR: the leak scan found the lines above; nothing was committed.` |
| Script or bash missing, or any other exit code | `ERROR: leak scan could not run; nothing was committed.`             |

When a rule hits, the scan prints its hit lines, then a blank line, then one hint for each rule that hit, once per
rule and in the order the rules run. A hint never repeats the matched text.

| Rule                                     | Hint                                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `home-path`                              | `write $HOME or ~ instead of the full path, or add a <HOME> sanitize rule (defaultEnv HOME) to the file's entry.` |
| `windows-profile`                        | `write %USERPROFILE% or ~ instead of the full path, or add a sanitize rule to the file's entry.`                  |
| `email`                                  | `move it behind a sanitize rule placeholder, such as <YOUR_EMAIL>.`                                               |
| `private-key`, `github-token`, `api-key` | `remove it from the file; keep secrets in a file the repo doesn't sync.`                                          |

**Cached values.** The changed sync files are searched for every known value, whichever file's rule it belongs to:
each value in `.user-values.json` (with a record, the record's and its profile's values, below), ignoring case and
including the backslash-doubled form, and the machine's hostname (the record's `hostname`; without a record none), in its
full and short form, as a whole word, ignoring case. A placeholder on its own passes. The value never appears in
arguments or output. A hit prints one of the error lines, then the hint line, and stops the commit:

```text
ERROR: a cached value for <PLACEHOLDER> is in <file>; nothing was committed.
ERROR: this machine's hostname is in <file>; nothing was committed.
  Keep that line in a file the repo doesn't sync (~/.gitconfig.machine, ~/.bashrc.local), or add the placeholder's rule to the file's entry.
```

The same search runs in the [export preview](#export-preview).

A search that cannot finish stops the commit too, with `ERROR: could not search for cached values; nothing was committed.`

The checks run in this order: changes outside the sync paths, the [public-repo guard](#public-repo-guard), the leak
scan, the cached values. Besides:

- **Unpushed history.** Besides the tracked paths, the guard reads every commit in `origin/master..HEAD`
  (`git log -z --name-only`, so a path git would quote is read as it is). While the repo is public, a commit that adds or changes a path under `profiles/` or
  `machines/` is refused with the guard's `refused` line for that path, even when a later commit removed it from the
  index, because pushing the branch would publish it.
- **The leak scan stays bash.** `mksync` runs `bash scripts/ci/leak-scan.sh`. With no `bash` on `PATH` (a Windows
  machine without Git Bash) the scan can't run, and the commit stops with that line.
- **Cached values with a record.** The values searched are the record's and its profile's, where `.user-values.json`
  holds them without one.
- **On `master`.** After the checks, commit runs only from `master`: any other branch stops it with
  `ERROR: run mksync commit from master (current: <branch>).`, exit 1, before the fetch.
- **The PR.** Branch `sync/<os>-<alias>-<stamp>`, naming the record's `alias`. A record without one asks for it once,
  on the first push from a terminal: the prompt suggests `<profile>-<os>` from the record's profile and this OS, in
  alias form (lowercased, each run of other characters a `-`): `work2-windows`, `personal-linux`. It names no person
  or account, and the login is no longer read. The suggestion is checked as an answer is (below);
  one that fails the check (a profile name that makes it too long, or equal to the hostname) is not shown. An empty
  answer takes the suggestion; an answer equal to the machine's hostname or its short
  form, compared in alias form (`WORK_PC01` matches `work-pc01`), is refused with `ERROR: '<answer>' is this machine's hostname;
pick another public name.`, any other invalid answer with `ERROR: invalid machine alias '<answer>' (use a-z, 0-9, -).`,
  and a usable answer is saved in the record and followed by `Saved public name: <alias>` on stderr. A save that fails
  (a read-only state folder) stops with `ERROR: could not save the public name in <file>; nothing was committed.`,
  exit 1. A stored `alias` is checked the same way on every push, so one edited by hand or carried to a machine with
  that hostname stops with the same errors. `push --yes` with a record that has no alias takes the suggestion without
  asking and prints `Saved public name: <alias>` as above; a suggestion the check refuses stops as without a
  terminal. Setup saves the guess at the first run ([`mksync setup`](#mksync-setup)), so most records have one.
  Without a terminal and without `--yes`, push stops before any commit with
  `ERROR: machine <name> has no public name yet; run mksync push in a terminal to set one.`, exit 1.
  Without a record, the `git config syncsettings.machine` alias is asked once and saved as before. The PR body adds
  `Profile: <p>` when there is a record.
- **Git failures.** A git step that fails (reading the branch, the fetch, the counts, creating the branch, reading the
  new commit, switching back) prints git's own error lines and exits 1. A commit that succeeded is never undone: when reading it back fails, the branch and its commit stay.

## Orphan report

At the end of an export, `mksync` lists every file under `dotfiles/` that no entry owns, as `ORPHAN`. A file is
owned if it is a file or dconf entry's `file` under `dotfiles/common/` or the folder of a system the entry runs on,
or lies under such a `dir` entry's folder. Entries for
all systems count, so every system prints the same list. The report
never deletes anything, and never changes the change count or the exit code.

## Package drift

Linux only: on Windows and macOS the report prints nothing. Right after the orphan report, in an export and in a
preview, `mksync` compares `packages/linux/` with the machine. With no such folder it prints nothing. An import never reports drift.
The managers are read once per export or preview, and only when it covers the whole repo: an export or a preview with `--only`,
and a `mksync push <path>…`, print no report, since a partial run doesn't see every package list
([Picking files](#picking-files)). A diff (`mksync diff`, and the guard diff of a push or a pull) never reads the
managers, so a push reads them once. `mksync doctor` reads the same report, so its count is the number of `DRIFT` lines a
preview of the whole repo prints.

The report never writes a file, never changes a count and never changes the exit code. It runs no install command. `DRIFT` isn't
counted, and neither are its `SKIPPED` lines, so the "file(s) skipped" note keeps counting files only.

| Manager      | Present: is a listed name installed?                                                                                | Chosen: is an installed name listed?                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `apt`        | `dpkg-query`, status `installed`, for `apt.txt` and `deb.txt`                                                       | `apt-mark showmanual`, against both lists                                        |
| `snap`       | `snap list`, without rows whose `Notes` has `base` or `snapd`                                                       | Same                                                                             |
| `npm`        | Folders in the newest `$HOME/.nvm/versions/node/*/lib/node_modules` by `sort -V`, with `@scope/name` as one package | Same                                                                             |
| `pipx`       | `pipx list --short`, first field                                                                                    | Same                                                                             |
| `vscode`     | `code --list-extensions`                                                                                            | Same                                                                             |
| `font`       | Folders in `$HOME/.local/share/fonts/NerdFonts/`                                                                    | Same                                                                             |
| `extension`  | Folders in `$HOME/.local/share/gnome-shell/extensions/`                                                             | Same                                                                             |
| `apt-source` | Files in `<root>/etc/apt/sources.list.d/`, compared by content                                                      | Same                                                                             |
| `apt-key`    | `<root>/usr/share/keyrings/<name>`, or else `<root>/etc/apt/keyrings/<name>`, compared by content                   | None: system keyrings hold plenty of stock keys, so only listed keys are checked |

- **Two sources for apt.** "Present" and "chosen" differ on purpose. A listed package marked auto, such as `dconf-cli`, stays
  quiet, and a dependency never counts as extra. `apt-mark` names lose any `:arch` suffix.
- **npm reads folders.** `npm` isn't called, because which `npm` runs depends on the shell, and the wrong one lists a
  different tree with no error.
- **`drift-ignore.txt`.** `<manager> <name>` lines. They take a name out of the "chosen" check for that manager only. Lint
  fails on a name that is both listed and ignored.
- **`DRIFT_ROOT`.** `<root>` is `${DRIFT_ROOT:-}`, a test-only variable that moves the `apt-source` and `apt-key` lookups, which
  are read-only.

| Case                          | Status    | Label                    | Note                                      |
| ----------------------------- | --------- | ------------------------ | ----------------------------------------- |
| Listed, not present           | `DRIFT`   | `<manager>/<name>`       | `in packages/linux/<file>, not installed` |
| Chosen, not listed or ignored | `DRIFT`   | `<manager>/<name>`       | `installed, not in packages/linux/<file>` |
| Source or key differs         | `DRIFT`   | `<manager>/<name>`       | `differs from packages/linux/apt-sources` |
| Tool missing                  | `SKIPPED` | The list                 | `<tool> not installed`                    |
| Tool fails                    | `SKIPPED` | The list                 | `<tool> failed`                           |
| nvm folder missing            | `SKIPPED` | `packages/linux/npm.txt` | `nvm not installed`                       |

When `dpkg-query` works and `apt-mark` is missing or fails, the `apt` block still prints its
`in packages/linux/<file>, not installed` lines, then `SKIPPED packages/linux/apt.txt (apt-mark …)` in place of the
extras.

For `apt-source` and `apt-key`, `<file>` is `apt-sources`, and a listed source or key that can't be read counts as not
installed. A failing tool never stops the rest of the report. A missing font or extension folder means nothing is present, so
it isn't `SKIPPED`.

Drift is never reported in an import, a check or a diff. `mksync doctor` adds one line on Linux when the report has any
`DRIFT`: `WARN drift: <n> package(s) differ; run mksync preview`.

**Leak scan.** An extension UUID has the shape of an address, so a whole well-formed line of
`packages/linux/gnome-extensions.txt` is exempt from the email rule, and so is a whole `extension <uuid>` line of
`packages/linux/drift-ignore.txt`. The UUID must use the characters `check-packages.sh` allows (letters, digits, `.`,
`_`, `-`), and one whose part after `@` is a mail provider's own domain (`gmail.com`, `outlook.com`, …, matched whole)
still fails, since that is an address. An address anywhere else in those files still fails, and so does the same line in
any other file. The `private-key` rule also catches an armored PGP private key (`-----BEGIN PGP PRIVATE KEY BLOCK-----`),
now that `apt-sources/keyrings/` takes `.asc` keys.

## Up-to-date check

Export and import start by checking whether the repo is behind `origin/master`:

- Not a git repo, no `origin` remote, or a branch other than `master`: no check, no message.
- `git fetch` fails: `NOTE: could not reach origin; skipping the up-to-date check.` and the run continues.
- Up to date: no message.
- Behind, with a terminal: `Repo is <n> commit(s) behind origin/master. Pull now (git pull --ff-only)? [Y/n]`. Yes
  pulls, prints `Pulled <n> commit(s); run the command again.` and exits 0, so the next run uses the
  pulled config and scripts. If the pull fails: `ERROR: pull failed; resolve it and rerun.` and exit 1.
  No continues without pulling.
- Behind, without a terminal: `WARNING: repo is <n> commit(s) behind origin/master; run git pull --ff-only.` and the
  run continues.

## Export preview

`mksync preview` (`mksync export --preview`) shows exactly what a commit would send, and writes nothing to the repo or
the machine.

- It plans a normal export in memory, writes the repo tree that export would leave (`dotfiles/` and
  `sync-config.json`) to a temp folder, and compares it with `HEAD`. Changes exported earlier but not yet committed
  therefore show too.
- The [drift report](#package-drift) runs as in an export. The diff and the leak scan cover `dotfiles/` and
  `sync-config.json` only, so a hand edit to `packages/` doesn't show.
- Status lines are the same as in a real export, followed by a `--stat` summary and the full diff. Text is sanitized,
  so the diff holds placeholders, not real values.
- The temp folder is removed at the end, also after a failure. A placeholder value answered during a preview is not
  saved.
- The leak scan runs on the result before any diff prints. A clean scan prints `Leak scan: clean.` A hit prints
  `WARNING: the leak scan found the lines above. Fix them before committing.`, leaves the diff out so the leaked text
  stays off the screen, and the preview exits 1. A scan that cannot run prints `ERROR: leak scan could not run; nothing
was committed.`, prints no diff and exits 1.
- After a clean scan, the files the preview would change are searched for every known value, as a commit searches
  them ([Cached values](#checks-before-pushing)). A hit prints the commit's error line ending in
  `; nothing was written.` (`ERROR: a cached value for <PLACEHOLDER> is in <file>; nothing was written.`, or
  `ERROR: this machine's hostname is in <file>; nothing was written.`) and the hint line, leaves the diff out, and
  the preview exits 1. The value is never printed.
- A file whose placeholder has no value (after the cached value, inference, `default` and `defaultEnv`; a preview
  never asks and runs no `suggest` source) prints `SKIPPED <file>  (needs <PLACEHOLDER>: mksync push asks for it)`,
  `<file>` its repo path, one line per file, naming the first such placeholder in rule order. These lines come first,
  in entry order, before the other status lines. The preview goes on with the other files: their status lines, the
  summary, the leak scan and the diff. A skipped file is left out of the export as a push's `IN` file is, so the temp
  tree holds its repo copy unchanged: it shows no diff and adds nothing new to scan. The guard's held block still
  follows. The summary counts them after the files that would change:
  `  3 file(s) would change; 1 more wait(s) for a value (mksync push asks for it).`, also when no other file would
  change (`  0 file(s) would change; 1 more …`, not `Repo is up to date.`). Without a waiting file the summary
  is unchanged. The preview then exits 1, after `Nothing was written. Run mksync push to send it.`, so a script still
  sees it.
- With no differences: `Nothing would be sent: the repo matches HEAD.` A file deleted from `dotfiles/` but still in
  `HEAD`, and an edit to `sync-config.json`, are differences.
- `--preview` with `--reset-values` is an error, and a preview outside a git repo with a commit is an error. Both exit 1.
- The up-to-date check does not run.
- A preview ends with `Nothing was written. Run mksync push to send it.` on every system.

## Import check

`mksync check` (`mksync import --check`) reports what an import would change and writes nothing: no file, folder,
backup, mode, `.user-values.json` or dconf key, and no prompt.

- The header says `IMPORT CHECK`. The up-to-date check doesn't run.
- Values come from `.user-values.json` and inference from the local files, as in an import. A placeholder still
  without a value takes the rule's `default`, then its `defaultEnv` value, in memory only. An entry with a placeholder
  that still has no value is `SKIPPED` with `needs <PLACEHOLDER>: mksync push or pull asks for it`, naming the first
  such placeholder in rule order, and counts as a change.
- A file import would create is `CREATE`, one it would overwrite is `UPDATE`; both count as changes. A file in a
  missing folder is a `CREATE`. `UNCHANGED`, `SKIPPED` and `EXTRA` are as in an import.
- dconf runs the import's checks and `dconf dump`, which only reads. An empty dump is `CREATE`, keys the repo would
  change are `UPDATE`.
- No changes: `This machine matches the repo.` and exit 0. Changes: `<n> file(s) would change. mksync pull
overwrites them (each keeps a .bak).` then `If you changed them on this machine, run mksync push first.` and
  exit 3. Any `ERROR` line ends with `<n> error(s); see the ERROR lines above.` and exit 1, so an entry that
  couldn't be checked never reads as a match.
- `--check` with `--reset-values` is an error, exit 1. `--force` is accepted and does nothing.
- When something would change, the [grouped block](#push-preview) follows the status lines
  and comes before the summary line, with the header `Changes from the repo:`. A line takes the group of the layer its
  new content comes from: a json key the latest layer that sets it, a whole file the latest layer that holds it, an
  `import` side file its own layer. `+` is a key or file the local copy lacks (a new file is `new file, <n> line(s)`),
  `M` one that differs, `-` a key the import would drop, listed under the entry's latest layer. A json change prints
  both sides sanitized, as the [push preview](#push-preview) does: the repo side the placeholder its layer
  holds, the local side the placeholder the value it replaces stands in for. A value nothing fills prints as its
  placeholder (`<YOUR_GH_OWNER>/sigil`), never as the program's internal marker. Nothing to change: no block. Pull asks
  once for all groups; skipping a group isn't offered.

## Sync point

A per-machine file remembers the repo commit the machine last agreed with: on Linux and macOS,
`${XDG_STATE_HOME:-$HOME/.local/state}/sync-settings/last-sync`; on Windows,
`%LOCALAPPDATA%\SyncSettings\last-sync`. It holds one line, the full SHA.

It is read only when that line is 40 hex characters and the commit exists in the clone; anything else counts as no
sync point.

A real import writes it, with `HEAD`, when the run had no `ERROR` line, no `SKIPPED` line noted `user skipped`, `HEAD`
resolves, and `git status --porcelain -- dotfiles sync-config.json` is empty (so `HEAD` is what was imported). The
summary then prints `Sync point : <first 7 of the SHA>` after the `file(s) applied` line. A check (`--check`) writes
nothing, and neither does an import that skipped a prompt, hit an error, or ran on a dirty tree. A run with `--only`
writes nothing either, because the machine agrees with only part of the repo.

`mksync commit` writes it after the PR opens and the clone is back on `master`, with the sync commit's parent (the
`master` commit the branch starts from), not the sync commit itself: until the PR merges, `origin/master` still has
the old files, and with the sync commit as the base they would read as `IN` and a pull would undo the push. A run
that failed before that (commit, push or PR) writes nothing. A PR that `gh` fails to open leaves the pushed branch and exits 1 with
`ERROR: PR creation failed; branch <branch> is pushed. Run: gh pr create --base master --head <branch>`. A partial commit (`mksync commit --partial`, which
`mksync push` uses when it is given paths, when it left an `IN` file alone, or when `--force` passed a failed diff)
writes nothing either, for the same reason as a partial import: the machine agrees with only part of the repo. After a
push that left an `IN` file, a recorded point would make that file read as `OUT`, and the next push would undo the
repo's change. A commit that fast-forwarded the clone first writes nothing either: no diff compared the commits it
brought with this machine.

A push that sends nothing and leaves this machine in agreement with the repo records it too: when the push ends with
`Nothing to send.` (every first-sync file answered `r` or `p`, or every change kept in a private layer), it writes
`HEAD` when no file was answered `k`, no path was picked, `git status --porcelain` over the push paths (`dotfiles`,
`packages`, `sync-config.json`, `profiles`, `machines`) is empty, and `HEAD` is `origin/master` after the push's
fetch. With a `k` file, picked paths, a dirty clone, a clone behind `origin/master` or a failed fetch, it writes
nothing, as before.

A write that fails prints `WARNING: could not record the sync point in <file>.` and never changes the exit code.

## Diff

`mksync diff` (`mksync export --diff`) says which side changed each file, without writing anything. It compares
three versions of `dotfiles/`, read from git objects, with no temp folder:

- `base`: the sync point's tree, plus the private layers below. With no sync point, `theirs` stands in for `base`.
- `theirs`: `origin/master` when that ref exists, else `HEAD`, plus the private layers below. `mksync export --diff`
  never fetches; `mksync diff` fetches first.
- `mine`: `base` with an export's writes applied in memory, the export planned with `base` as the repo side. Starting
  from `base` means any file export doesn't touch still equals `base`.
  The diff never asks: a [new setting](#new-settings) is planned for its suggested layer, as with `--yes`.

The private layers are the profile's and the machine's layer files of the `json` entries ([Layers](#layers)). No git tree holds them, so
the diff reads the stored ones and adds the same content to `base` and `theirs`, and so to `mine` before the export's
writes. They never give `IN`: a private layer the export would leave alone gives nothing, and a setting the export
would write into one gives `OUT`. They have no history, so what one holds and the local file lacks may never have been
applied here (a profile just chosen): it gives nothing, and a pull applies it. That is the case when the export would
only remove from the layer file, or when the local file is exactly what git's layers alone build.

Only paths this OS's entries own are compared: a `json` entry owns the file of each of its
[layers](#layers) (base, OS, profile and machine), an `import` entry its base and OS layer files, any other file or
dconf entry the layer file it reads in `base` and the one it reads in `theirs`, and a dir entry the `<label>/` prefix of
both. A path in the sync point's tree that no current entry or [linked folder](#linked-folders) owns (a file a later
`dir` entry replaced, one the config no longer lists, or one under a v1 `<file>.linked/` tree, which no entry owns) isn't listed or counted, the way another system's paths
aren't. Every file of one entry folds into one line at its label, except a dir entry's. With `--only`, only the selected entries' paths are labeled and counted. A missing file counts
as a version, and each owned path in the union of the three trees gets at most one verdict:

| `mine` vs `base`                 | `theirs` vs `base`         | Label                                             |
| -------------------------------- | -------------------------- | ------------------------------------------------- |
| same                             | same                       | none                                              |
| same                             | differs                    | `IN`: only the repo changed, a pull takes it      |
| differs                          | same                       | `OUT`: only this machine changed, a push sends it |
| differs                          | differs, `mine` = `theirs` | none: both made the same change                   |
| differs                          | differs, `mine` ≠ `theirs` | `BOTH`: merge by hand                             |
| no sync point, `mine` ≠ `theirs` |                            | `?`                                               |

A `json` entry prints one line, however many of its layer files changed, so `--only` and the counts see the entry
once. Its label is always a `dotfiles/` path: the OS file if it exists, else the base file, else the file under
the entry's write root. A private layer's path is never printed. The verdicts of its layer files fold into that line:

| Verdicts of the entry's layer files | Label  |
| ----------------------------------- | ------ |
| any `BOTH`                          | `BOTH` |
| an `OUT` and an `IN`                | `BOTH` |
| `OUT`, no `IN`                      | `OUT`  |
| `IN`, no `OUT`                      | `IN`   |
| `?` (no sync point)                 | `?`    |
| none                                | none   |

A `BOTH` gives no label when an export planned with `theirs` as the repo side would change none of the entry's layer
files: the local file holds what `theirs` already builds, only with the same change in other layers.

A `BOTH` made of an `OUT` and an `IN` in two layers is still one entry: pulling it would drop this machine's change.

The lines print through the normal status formatter (`OUT        dotfiles/…`), sorted by code unit.
The header names the sync point (`Last sync  : <short> (<date>)`, or `none recorded on this machine`) and the ref
compared (`Repo       : origin/master <short>` or `Repo       : HEAD <short>`).

```text
  SyncSettings -- DIFF (linux)

  Last sync  : 1a2b3c4 (2026-11-01)
  Repo       : origin/master 5d6e7f8

  OUT        dotfiles/linux/shell/.bashrc
  IN         dotfiles/common/git/.gitconfig

  --------------------------------------------------

  2 file(s) differ: 1 in, 1 out, 0 both.
  IN: mksync pull takes them. OUT: mksync push sends them.
```

The hint line names only the labels present; `BOTH` adds `BOTH: changed on both sides; merge by hand.` With no sync
point the summary reads `N file(s) differ. No sync is recorded on this machine, so the newer side is unknown.` and
`Run mksync pull or mksync push once to record one.` When nothing differs it prints `This machine and the repo agree.`

A file whose placeholder has no value (after the cached value, inference, `default` and `defaultEnv`; the diff never
asks) doesn't stop the diff. It prints
`SKIPPED <file>  (needs <PLACEHOLDER>: mksync push or pull asks for it)` among the labels, sorted with them, naming the
first such placeholder in rule order, and gets no label of its own. The summary then adds
`  <n> file(s) need a value first; mksync push or pull asks for it.`, and the "agree" line doesn't print. An interactive
push asks those values before its guard runs, so its guard never meets one; with `--yes` the push stops at the
missing-value line before its guard.

The exit code is 0 when nothing differs and no file was skipped, 3 when something does or a file was skipped, and 1 on
an error: a failed export plan prints its
lines and `ERROR: the export for the diff failed; see above.` (a plan that only fails for some files, such as invalid
JSON, an unreadable file or a new setting with no machine record, prints their `ERROR` lines; a failed dconf dump is not
one of them); a tree git can't read stops it with
`ERROR: cannot read <ref> from git.`, and a clone with no commit with `ERROR: --diff needs a git repo with a commit.`
`--diff` cannot be combined with `--preview` or `--yes` (error, exit 1). The diff writes no repo
file, no sync point and no `.user-values.json`.

### Conflict block

When a `BOTH` file stops `mksync pull` or `mksync push`, they show the lines of both sides. `mksync diff` itself prints
no block. One block per `BOTH` file, in the order of the label lines, after the last of them:

```text
  --- repo           dotfiles/common/parity/b.conf
  +++ this machine   dotfiles/common/parity/b.conf
  @@ -1 +1 @@
  -repo line
  +machine line
```

- The body is git's unified diff from `theirs` to `mine`, with git's own header dropped and two spaces in front of each
  line. Both sides are the sanitized repo form. The user's git diff settings (external diff, color) don't apply.
- A control or text-direction character (tab excepted), in a line or a path, prints as `\u` and its four-digit hex
  code. A body line over 200 characters is cut there, ending in `…`.
- Over 40 body lines: the first 40, then `  … <n> more line(s)`.
- A binary file's body is `  binary files differ`.
- A side that doesn't have the file has ` (missing)` at the end of its header line.
- A `json` entry gets one block per `dotfiles/` layer file where `theirs` and `mine` differ. A private layer is never
  printed, and a file of any other merge type that has one gets no block: its local content is the private layer's.

## Front door

`mksync` on `PATH` is [the program](#the-program), which the installers download ([Install](#install)):
`~/.local/bin/mksync` on Linux and macOS, `%LOCALAPPDATA%\mksync\mksync.exe` on Windows. Every `[Y/n]` prompt takes an
empty answer or end of input as yes, every `[y/N]` prompt as no, except `mksync setup`'s confirm, where end of input is
no ([`mksync setup`](#mksync-setup)). Commands, wording and exit codes are the same on every
system, except where this section says otherwise.

| Command                                            | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Exit                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `mksync`, `mksync status`                          | Prints OS, repo, origin, unsent, machine, and the next command. When the check finds changes and a sync point exists, it runs the diff: the machine line gives its summary (`N file(s) differ: I in, O out, B both`) and the next command is `mksync pull` (in only), `mksync push` (out only), or `mksync diff, then push or pull file by file.` (both, or in and out). No sync point, a failed diff or a diff that agrees keeps the plain machine line and next command. Writes nothing in the repo or home; it fetches `origin master`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 0                                                               |
| `mksync doctor`                                    | One `OK`, `WARN` or `MISSING` line per check, below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 0, or 1 with a `MISSING` line                                   |
| `mksync pull [--yes] [--force] [path…]`            | Refuses with exported changes not sent. Fetches, fast-forwards, then (without `--yes`) asks for every value of this machine's entries that nothing fills, with push's questions, suggestions and saving (an empty answer or end of input goes on, and the guard stops as before), then the import check. Nothing to change: a pull without paths still runs the import to record the sync point. Changes with no sync point: `--yes` refuses, interactive warns and asks `Apply these changes? [y/N]`. Otherwise (unless `--force`) the diff stops it on an `OUT` or `BOTH` file; then asks `Apply these changes? [y/N]` and runs `mksync import --force`. Picked paths go to the check, the diff and the import as `--only`, so a partial pull records no sync point                                                                                                                                                                                                                                                                             | 0, or 1 on an error                                             |
| `mksync push [--yes] [--force] [-m <msg>] [path…]` | First runs `git fetch -q origin master`: any commit in `HEAD..origin/master` stops it with `ERROR: origin has updates; run mksync pull first.`, nothing exported (a failed fetch skips this check). Then asks for every value of this machine's entries that nothing fills, picked paths or not (with `--yes`, an unknown one stops it), then the diff guards it (with no sync point and no `--yes`, it asks per file instead): an `IN` file is left alone, a `BOTH` file stops it unless `--force`. Then runs the export without the `IN` files. Picked paths go to the diff and the export as `--only`. Any path, an `IN` file left alone, an `r` or `k` answer to the first-sync question, or a failed diff passed with `--force` makes `mksync commit` run with `--partial`, so that push records no sync point. Nothing changed: `Nothing to send`. Otherwise shows `git status --short` (over `dotfiles`, `packages`, `sync-config.json`, `profiles` and `machines`), asks `Open a PR with these changes? [y/N]`, then runs `mksync commit` | 0, or the failing step's code                                   |
| `mksync diff [path…]`                              | Fetches `origin master` with the status's 15-second timeout; offline prints `Offline: comparing with the last fetch.` and carries on. Then runs `mksync export --diff` ([Diff](#diff)): one line per changed file saying which side changed it. Picked paths go through as `--only`, so only those are labeled and counted. Writes nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 0 when nothing differs, 3 when something does, or 1 on an error |
| `mksync check`, `mksync preview`                   | The [import check](#import-check) and the [export preview](#export-preview); neither writes anything                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 0, 3 from a check that found changes, or 1 on an error          |
| `mksync setup [--yes] [--bootstrap] …`             | Doctor first: a `MISSING` line stops setup with exit 1, before the import check or any question. Then the scan, the profiles, the machine record's questions with the import check's and diff's summary above question 4, and on Ubuntu with an executable `bootstrap/linux.sh` `Also restore apps and packages … [y/N]` (`--bootstrap` chooses it). Then the summary, the guard block and `Write the record and apply?` ([`mksync setup`](#mksync-setup)); only a yes writes anything. The bootstrap runs question 4's choice as its import step; without it, setup acts on question 4. macOS and Windows never ask, and `--bootstrap` there is `ERROR: --bootstrap is Ubuntu only.`, exit 1, before the doctor                                                                                                                                                                                                                                                                                                                                  | 0, or 1 on an error                                             |
| `mksync update`                                    | Replaces the installed program with a newer release, checked as the installers check ([Update](#update))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 0, 1 on a failed download or check, 2 run from the clone        |
| `mksync machine …`, `mksync profile …`             | The machine record and retiring a machine or profile ([Machines](#machines))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | as there                                                        |
| `mksync setting list`, `mksync setting move …`     | Lists the settings the layers above the base set, and moves one setting into another layer ([`mksync setting`](#mksync-setting))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | as there                                                        |

`mksync pull` protects this machine's own changes: when the import check finds changes, `--force` isn't given and a
sync point exists, it runs the diff ([Diff](#diff)) first. Any `OUT` or `BOTH` line prints, then a
[conflict block](#conflict-block) per `BOTH` file, then `ERROR: <n> file(s) changed on this machine
since the last sync, and a pull would overwrite them.` and `Run mksync push first, or mksync pull --force to overwrite
them (each keeps a .bak).`, and the pull stops with exit 1 before anything is applied. `IN` lines never block.
A diff that fails (exit 1), or that leaves out a file whose value is missing (its `SKIPPED … needs` line: that file can
hold this machine's change), stops the pull with `ERROR: could not tell which side is newer; run mksync diff to see why,
or mksync pull --force.` `mksync push` asks the value and saves it, so the next pull can compare the file. `--force` skips the diff and still asks the apply question; `--yes` answers it. The clone
fast-forwards before the question, so a declined pull leaves the clone updated and this machine as it was.

Without a sync point every label would be `?`, so the diff doesn't run and the first pull is guarded instead: with
`--yes` it stops with `ERROR: no sync is recorded on this machine, so a pull can't tell which side changed these
files.` and `Run mksync diff, then mksync push, mksync pull <path> without --yes, or mksync pull --force (each keeps a .bak).`,
exit 1; interactive it prints `No sync is recorded on this machine: if you changed these files here, a pull overwrites
them (each keeps a .bak).` and asks `Apply these changes? [y/N]`, so only an answer starting with `y` or `Y` applies.
When nothing differs, a pull without paths still runs the import, which records the sync point. `mksync setup` guards the same way before
its confirm: with `--existing backup`, a sync point and an `OUT` or `BOTH` file (or a failed diff), it shows them and asks
`[y/N]`, and `--yes` stops with exit 1 ([`mksync setup`](#mksync-setup)). The bootstrap it runs imports as setup's fourth
answer says (`MKSYNC_SETUP_EXISTING`), so only that answer changes files.

`mksync push` protects the repo's newer files the same way. Its order: the origin check, the value questions (unless
`--yes`), the diff guard or, with no sync point, the per-file questions, then the export. With a sync point it runs the
diff after the value questions and before the export; a failed fetch leaves it comparing with the last one. Picked paths narrow it.

- **`OUT`** files are sent.
- **`IN`** files are left alone: the export skips them, writing, removing and counting nothing for them. Their lines
  print, then a sentence, on stdout, and the push goes on:

  ```text
    IN         dotfiles/common/parity/b.conf
    1 file(s) are newer in the repo and were left alone; run mksync pull to take them.
  ```

- **`BOTH`**: the `BOTH` lines and their [conflict blocks](#conflict-block) print on stdout, then the two lines below on
  stderr, and the push stops with exit 1 before the export writes anything. `IN` files get no line in that run.

  ```text
    ERROR: 1 file(s) changed on both sides since the last sync.
    Merge by hand, then run mksync push --force <path>; or mksync pull --force <path> takes the repo's version (keeps a .bak).
  ```

- **`--force`** sends the `BOTH` files too, as this machine has them, through the PR, with no `BOTH` line or block. It
  still leaves `IN` files alone and still asks; `--yes` answers.
- **A failed diff** (exit 1) stops the push with this line on stderr, exit 1. With picked paths the diff's own stdout
  prints first, so a path that isn't synced is named. With `--force` the push goes on, exports every file and commits
  with `--partial`.

  ```text
    ERROR: could not tell which side is newer; run mksync diff to see why, or mksync push --force.
  ```

- **No sync point, `--yes`**: the newer side is unknown, so the diff doesn't run and the push sends every file that
  differs, after this line on stdout. `--yes` isn't refused: a PR is reviewed before it is merged, unlike a pull, and push has stopped already if a
  value this machine syncs is unknown.

  ```text
    WARNING: no sync is recorded on this machine, so this sends every file that differs.
  ```

  With a machine record, `--yes` takes each file's suggestion from the question below instead: `p` where it is offered
  on a work profile, `s` otherwise. On a work profile that needs the diff: when it fails, the push stops with the
  could-not-tell line, exit 1, nothing exported, as the interactive push does (`--force` sends every file that
  differs). When at least one file takes `p`, the warning names the profile and the count:

  ```text
    WARNING: no sync is recorded on this machine; the differences of 1 file(s) stay in profile work2, the rest are sent.
  ```

- **No sync point, interactive**: after the value questions ([Push asks](#sanitize-and-hydrate)), the diff runs and
  push asks about each file it labels `?`, in path order, with its line count:

  ```text
    No sync is recorded on this machine, so the newer side of each file is unknown. mksync preview shows each change.

    dotfiles/common/claude/RTK.md  28 line(s) changed
    Send this machine's version (s), take the repo's (r) or skip (k)? [s/r/k]
  ```

  With a machine record and a `json` or `whole` entry, the question also offers `p`, keep this machine's differences
  in its profile, and ends with a suggestion:

  ```text
    dotfiles/common/claude/settings.json  109 line(s) changed
    Send this machine's version (s), keep its differences in profile work2 (p), take the repo's (r) or skip (k)? [p]
  ```

  The suggestion is `p` on any profile but `personal`, `s` on `personal`; an empty answer takes it. With a record, a
  file that offers no `p` (an `import`, `dconf` or `dir` entry) asks `[s/r/k]` and also ends with a suggestion: `s` on
  `personal`, `k` on any other profile, so an Enter on a work machine never sends a file to the shared layers:

  ```text
    dotfiles/linux/dconf/desktop.ini  12 line(s) changed
    Send this machine's version (s), take the repo's (r) or skip (k)? [s/r/k] [k]
  ```

  An empty answer takes it. Without a record the question stays `[s/r/k]` with no suggestion, and an empty answer
  asks again.

  `s` sends the file; `r` overwrites the local file with the repo's, as `mksync pull --force <path>` does (keeping a
  `.bak`); `k` leaves both sides. `p` keeps the file's differences in the profile layer and changes neither the base
  nor the OS layer:

  - `json`: every changed or new key and every new array item goes to the profile layer, as a
    [move](#move-a-change) to `profile <p>` would place it. A key or array item the base or OS layer has and the local
    file lacks is removed nowhere. After the export, the local file is written from its layers, as an import writes
    it (keeping a `.bak`), so it gains those settings; every value this machine already had stays as it was.
  - `whole`: the local file becomes the profile layer's copy; the base keeps its own.
  - Before the export's status lines for that entry it prints
    `  PROFILE    dotfiles/common/claude/settings.json  (9 change(s) kept in profile work2; 4 shared setting(s) added here)`.
  - A `p` file gets no [new-setting](#new-settings) question: its new settings already have the profile as their
    layer.
  - The profile layer is private: while the repo is public it stays in local state ("Held until the repo is
    private", [Public-repo guard](#public-repo-guard)), so `p` alone opens no PR.

  Any other answer prints `  Pick s, p, r or k.` when `p` is offered, else `  Pick s, r or k.` (`p` included), and
  asks again; end of input is `k` for that file and every one after it. The `r` files are imported first (a failed
  import stops the push with its code), then the export runs with the `r` and `k` files skipped and the `p` files
  kept in the profile, then the import of the `p` files (a failed one stops the push with its code), then the commit
  and PR as usual. With nothing left to send the push prints `  Nothing to send.`, records the
  [sync point](#sync-point) when it may, and exits 0, with no PR. `mksync setup`'s `keep` and `backup` answers are
  unchanged.

The export skips the `IN` files instead of picking the `OUT` ones, so any other file an earlier export left stale in the
repo folder is rewritten, and a [linked folder](#linked-folders)'s files, which `--only` refuses, are still sent.

The commit stages every push path, so a stale `IN` file would still be sent. A push that would leave an `IN` file alone, or
a file answered `r` or `k` at the first-sync question, while `dotfiles/`, `profiles/` or `machines/` has changes not committed, stops before the export with this line on
stderr after the `IN` lines, exit 1, `--force` included:

```text
  ERROR: the repo folder has changes not sent yet, and they can hold older versions of these files; run git stash -u, then push again.
```

A declined PR question leaves no trace when the push paths had no changes before the export: the tracked files the
export changed are restored and the untracked files it added are removed, and no other file is touched. Moves made in
that run are lost with them. It prints `  Nothing sent; the repo folder is as it was.`, exit 0. If the push paths had
changes before the export, or the export also changed the record, a profile or a layer in local state (the first
backup, a move or an answer kept there), every file stays and the `Kept in the repo.` line prints, exit 0: what moved
out of local state is only in the repo folder. A
restore that fails, or that leaves a change behind (`ERROR: the repo folder still has changes.`), prints the error and the `Kept in the repo.` line, exit 1.

`pull` and `push` need the clone on `master` with an `origin` remote. The status fetch has a 15-second timeout. The
status's OS name is `PRETTY_NAME` from `/etc/os-release` (or the file `SYNC_OS_RELEASE` names) on Linux, the
version `sw_vers -productVersion` prints on macOS, and `SYNC_OS_NAME` or the Windows caption on Windows. `--yes` answers the `[Y/n]` questions, and pull's and push's
`[y/N]` ones. It never answers the bootstrap
question, because bootstrap uses `sudo`; `--bootstrap` does. Setup's `--yes` answers its confirm, except after a guard
block. An unknown option (a remaining argument that starts with
`-`) prints `Unknown option: <arg>` on stderr and exits 2, before any fetch or child step.

Status lines and the next command, in this order of precedence:

| State                             | Next                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------- |
| Not a git clone, or no origin     | `run mksync doctor.`                                                             |
| Origin has updates                | `mksync pull`                                                                    |
| Exported changes not sent         | `mksync push`                                                                    |
| The machine differs from the repo | `mksync pull to take the repo's version, or mksync push to send this machine's.` |
| Otherwise                         | `nothing to do.`                                                                 |

More rules per command:

- **`status`** never suggests `mksync push` on a pull-only machine: it skips the unsent row, and a machine that differs
  gets `mksync pull`, or `mksync pull --force to take the repo's version (each keeps a .bak).` when the diff finds an
  `OUT` or `BOTH` file. It adds the [linked folder](#linked-folders) lines after the machine line. When the import
  check itself fails, the machine line is `not checked: run mksync check to see why` and the next command is
  `the machine check failed; run mksync check to see why.`
- **`doctor`** checks what the program needs, in this order: `git`; on macOS `brew` (`MISSING brew: install from
https://brew.sh`); `gh` and its sign-in; `git login`, only when `gh` holds a token for the owner of the clone's
  `origin` (the owner as configured, `git config --get remote.origin.url`, before any `insteadOf`): `OK` when the
  first effective `credential.https://github.com.helper` (read across all scopes with `git config --get-all`, in git's
  order; the effective ones are those after the last empty value) runs `gh auth token --hostname github.com --user
<owner>` with the owner as a whole name, or is `gh auth git-credential` and `gh`'s active token
  (`gh auth token --hostname github.com`, asked only then) equals the owner's, else
  `WARN git login: git signs in as another GitHub account; run the install line again` (tokens are compared in memory,
  never printed; the doctor writes nothing); `repo clone with origin` (`WARN repo has no origin remote`); `machine record`
  (`WARN no machine record; run mksync setup`); `values` (`WARN <n> value(s) not set; mksync setup asks for them` without a record, `WARN <n> value(s) not saved yet; mksync push or pull fills them from this machine's files or asks for them` with one); then git's own view of its config, up to four `WARN` lines in this order, none of which changes the exit code:
  `WARN git also reads ~/.config/git/config; mksync syncs ~/.gitconfig only` when that file exists;
  `WARN git includes <path>, which mksync doesn't sync` for each `include.path` or `includeIf.*.path` value in the
  global config (`git config --global`) other than `~/.gitconfig.local` and `~/.gitconfig.machine`, the home folder
  written as `~` with `/` after it; `WARN ~/.gitconfig.local is missing; mksync pull creates it from the repo` when this OS has a repo
  copy of it and the file is missing; and on Windows only,
  `WARN gh is <found path>, not <GH_CLI_PATH value>; mksync pull would point git at the wrong gh` when both are known
  and differ, compared without case and with `\` and `/` taken as one; `bash` (`WARN bash: needed by the leak scan; install with
<command>`; on Windows `install with winget install --id Git.Git -e`, or `install Git for Windows from
https://git-scm.com` without `winget`; on Windows the line is `OK` when Git's own `bash.exe` is found from `git`, as
  the leak scan ([Checks before pushing](#checks-before-pushing)) finds it, and a `bash` elsewhere on `PATH`, such as
  WSL's launcher, doesn't count); on Linux the `drift` line of [Package drift](#package-drift). A `MISSING` line
  names the install command (`sudo apt-get install …`, `brew install …`, `winget install --id …`) and is followed by
  `Fix the MISSING items, then run mksync doctor again.`
- **`pull`** fetches, then counts `HEAD..origin/master`: at 0 it runs no merge; at `n` it fast-forwards, prints
  `  Pulled <n> commit(s).`, reads the config again and goes on. A pulled config that needs a newer mksync stops the
  pull right after that line with `ERROR: sync-config.json: this config needs a newer mksync: run mksync update.`,
  exit 2, writing nothing ([design, "Decided in phase 9"](design-layers.md#decided-in-phase-9), decision 6). Its check
  prints the grouped block of the [import check](#import-check).
- **`push`** checks the clone first, before the export: a clone that isn't on `master` with an `origin` remote prints
  `ERROR: push needs the repo clone on master with an origin remote.` and exits 1, with nothing exported. A push whose
  [up-to-date check](#up-to-date-check) pulled stops there, exit 0, after `Pulled <n> commit(s); run the command
again.`, with no PR question.
- **`push`** on a pull-only machine prints `this machine is pull-only (see mksync machine show)` and exits 1, before the
  diff guard. Otherwise it runs the export with its grouped block and questions ([Push preview](#push-preview)), then
  [Move a change](#move-a-change), the profile-value rule and the guard, then `Open a PR with these changes? [y/N]`
  and `mksync commit`.
- **`pull`** and **`push`** share these lines: `ERROR: <command> needs the repo clone on master with an
origin remote.`, `ERROR: the repo has changes not sent yet; run mksync push first, or git restore them.`,
  `Nothing applied.` after a declined apply, `Nothing to send: the repo matches this machine.` (`Nothing to send.` when
  an `IN` file was left alone), and after a declined PR question `Nothing sent; the repo folder is as it was.`, or
  `Kept in the repo. Run mksync push again, or git restore dotfiles to drop them.` when the repo folder already had
  changes or the export changed local state. Both questions, `Apply these changes? [y/N]` and `Open a PR with these changes? [y/N]`, take only an answer
  starting with `y` or `Y` as yes.
- **`diff`** stops on a clone with no commit with `ERROR: --diff needs a git repo with a commit.`, and on a tree git
  can't read with `ERROR: cannot read <ref> from git.`, exit 1.

### mksync setting

A work machine's first sync keeps its differences in its profile ([`p`](#front-door)). `mksync setting` shows what
the layers above the base set and moves one setting at a time into another [layer](#layers).

```text
mksync setting list [--profile <p>]
mksync setting move <file> [<key>] --to base|os|profile|machine [--dry-run | --yes]
```

`<file>` is the entry's `file` as `sync-config.json` writes it (`vscode/settings.json`), or for a `dir` entry
`<file>/<name inside>`. `<key>` is a `json` key path exactly as the change block prints it (`editor.fontSize`,
`permissions.allow[]`): required for a `json` entry, refused for every other kind. Usage errors, on stderr, exit 2,
before anything is read or written:

```text
ERROR: setting needs list or move
ERROR: unknown setting command <verb>
ERROR: missing --to
ERROR: --to takes base, os, profile or machine
ERROR: --dry-run and --yes can't be used together
ERROR: no entry <file> in sync-config.json
ERROR: <file> is a json entry; name a key
ERROR: <file> is not a json entry; it moves as a whole file, with no key
```

So are `ERROR: setting move needs a file` (no `<file>`), `ERROR: --profile needs a value.` and
`ERROR: --to needs a value.` (the flag last, or followed by another option), and `ERROR: <flag> is repeated.` (`--profile`,
`--to`, `--dry-run` or `--yes` given twice). The flags go anywhere after the verb. Unlike `machine` and `profile`, an
unknown verb names the group (`unknown setting command <verb>`). An option in the verb's place, a third positional
argument, or any argument after `setting list` other than `--profile <p>` is `Unknown option: <arg>`, exit 2, as
everywhere else.

#### `mksync setting list`

For this machine's record, every setting a layer above the base sets, from the base up:

```text
Settings above the base on wk1-laptop (profile work1):

vscode  settings.json
  editor.fontSize      all machines: 14  profile work1: 15
  window.zoomLevel     Linux machines: 1
claude  settings.json
  permissions.allow[]  all machines: 4 item(s)  profile work1: 2 item(s)
git     .gitconfig.local
  (whole file)         Windows machines: 12 line(s)

Other profiles: unknown while the repo is public.
```

- An entry is listed when its OS, profile or machine layer holds a file. A `json` line is a key path that one of
  those layers sets; its cells name each layer that sets it, base first, with the change block's group words
  (`all machines`, `<OS> machines`, `profile <p>`, `this machine`). A value is the sanitized compact JSON: up to 40
  characters as it is, longer ones cut to their first 37 and `...`. An array path counts the items each layer holds
  (`<n> item(s)`).
- Any other kind is one `(whole file)` line with a cell per layer that holds the file: `<n> line(s)`, or
  `same as <group>` when its bytes equal a wider layer's. An `import` side file prints under its resolved name.
- Layout: an entry line is the module, two spaces, the entry's `file` without its first folder, as the change block
  prints it. A setting line is two spaces, the key path (or `(whole file)`), two spaces, then its cells, two spaces
  apart, each `<group>: <value>`. Module and key are padded to the widest in the listing. A blank line follows the
  header and comes before the last line.
- Order: the config's entry order, then key path in code-unit order. Nothing above the base: one line `(none)` in
  place of the entries, between the two blank lines.
- No record: header `Settings above the base on this machine:`, the OS layer only.
- `--profile <p>` lists that profile's layer and this machine's OS layer instead of the record's, under the header
  `Settings above the base in profile <p>:`, with no machine layer. A profile this machine doesn't hold is
  `ERROR: unknown profile <p>`, exit 2.
- While the repo is public the last line is `Other profiles: unknown while the repo is public.`, never "none": this
  machine holds only its own profile ([Public-repo guard](#public-repo-guard)). Once private, `--profile` can name
  every profile in the repo and the line goes.
- Values are never printed, only their placeholders. `list` reads; it never writes or asks. Exit 0.

#### `mksync setting move`

**Source and target.** The source is the narrowest layer that sets the key (or holds the file) on this machine; the
target is `--to`'s layer (`base` is all machines, `os` this OS's machines, `profile` the record's profile, `machine`
this machine). The move follows [Move a change](#move-a-change) word for word, so this machine's merged result is the
same after it as before it:

- A narrower move writes the target and leaves the source as it is.
- A wider move writes the target and removes the key from the source, unless a layer between them sets it; then the
  source keeps it. A move that removes the last key of an object removes the emptied object too.
- An array path moves every item the source holds that the target doesn't.
- A whole file, or an `import` side file, moves as a whole, under the same rule.
- Because the source is the narrowest layer, no narrower one can override the moved value, so Move a change's refusals
  (`moving <path> to <layer> would change the merged result`, `a layer narrower than <layer> has the file`) can't be
  reached from the command line. They stay in the program as guards, exit 1.

Lines and codes:

| Case                                           | Prints                                                         | Exit |
| ---------------------------------------------- | -------------------------------------------------------------- | ---- |
| The target is already the source               | `<file> <key> is already in <group>; nothing to move.`         | 0    |
| No layer sets the key or holds the file        | `ERROR: no layer sets <key> in <file>`                         | 1    |
| `--to profile` or `--to machine` and no record | `ERROR: --to <layer> needs a machine record; run mksync setup` | 2    |

A whole-file move leaves `<key>` out of the first line, and its second line is `ERROR: no layer holds <file>`.

**Checks.** Text bound for the base or an OS layer is checked after sanitize, before anything is written or asked:

- The [profile-value search](#profile-values), with its two lines naming the setting instead of a change number:

  ```text
  refused: <module> <file> <key> holds a value of profile <p> (<KEY>) and would reach <group>.
  Leave it in "profile <p>", or put <KEY> in the file instead.
  ```

- A placeholder that the value table places in the profile (its value lives in `profiles/<p>.json`):
  `refused: <module> <file> <key> holds <KEY>, a value of profile <p>; machines outside it have no value for it.`
- This machine's home folder as written in the text (as it is, with `\` doubled, and with `/` for `\` on Windows),
  ignoring case on Windows and macOS: `refused: <module> <file> <key> holds this machine's home folder.` The leak
  scan's `home-path` rule covers only Linux; this check covers every OS.
- The [leak scan](#export-preview) on a temporary copy of the clone with the move applied, as the preview runs it. A
  hit prints the scan's lines, then `refused: the leak scan found the lines above.`

`would reach` names the group in lower case, as the profile-value rule does. Any refusal exits 1 and writes nothing.

**Preview and question.**

```text
Move vscode settings.json editor.fontSize: 15
  from profile work1 to all machines
MODIFIED dotfiles/common/vscode/settings.json
MODIFIED profiles/work1/vscode/settings.json
Move it? [y/N]
```

- The status lines are the writes, in the export's words and order (`ADDED`, `MODIFIED`, `REMOVED`), with the paths
  the snapshot uses. State files are written with their `.bak`, as every state write is.
- The question is `[y/N]`, as push's PR question, because a move changes what other machines receive. An empty
  answer, `n` or end of input prints `Nothing moved.`, exit 1, as `machine retire`'s decline. No terminal and no
  `--yes`: `ERROR: setting move needs a terminal or --yes`, exit 2.
- `--dry-run` runs the checks (a refusal still exits 1), prints the preview and `Nothing written (--dry-run).`, exit 0. `--yes` writes without asking.
- After the writes: `Moved. mksync push sends it to the other machines.` when a base or OS file changed, else
  `Moved.`: profile and machine layers take effect at once while the repo is public. Exit 0.

**Never a write to `master`.** `setting move` commits nothing and runs no git command beyond reading status. Base
and OS writes stay in the clone's working tree; the next `mksync push` exports (the live file already equals the
merge, so nothing else changes), commits them on its `sync/<os>-…` branch and opens its PR. A file the move would
write in `dotfiles/` that already differs from the clone's `HEAD` stops it before anything is written:
`refused: <path> has changes that aren't sent; run mksync push first.`, exit 1.

### Install

The installers clone the repo, since the program reads its config there, then install the program from the latest
GitHub release ([design, "Release and update"](design-layers.md#release-and-update)). A release holds four programs,
`mksync-linux-x64`, `mksync-linux-arm64`, `mksync-darwin-arm64` and `mksync-windows-x64.exe`, and `SHA256SUMS`. The
installer picks the one for this OS and CPU and checks its SHA256 against `SHA256SUMS`, the only check. Nothing is
written to the bin folder before it passes. Its errors, each exit 1:

```text
ERROR: no mksync program for <os> <arch>.
ERROR: could not find the latest release at <base>.
ERROR: could not download <url>.
ERROR: <asset>: checksum does not match SHA256SUMS.
```

A latest link that names no `v<x.y.z>` tag (GitHub's `/releases` page while no release exists) is `could not find the
latest release`.

**Through `gh`.** When `SYNCSETTINGS_RELEASE_URL` is unset or empty and `gh auth status` succeeds (decided once per
run), the installer works on a private repo too: the tag comes from
`gh release view --repo makubexD/SyncSettings --json tagName -q .tagName`, the asset and `SHA256SUMS` from
`gh release download <tag> --repo makubexD/SyncSettings -p <asset> -p SHA256SUMS -D <temp folder>`, and the checks
above run unchanged. The clone, and the pull of an existing clone whose origin is on `github.com`, runs with
`-c credential.https://github.com.helper= -c 'credential.https://github.com.helper=!gh auth git-credential'` for that
one git command; nothing is written to `~/.gitconfig`. A failing `gh` gives the same error lines as a failing
download. Otherwise the installer downloads over HTTPS as above.

**The clone's GitHub login.** After the clone or pull, through `gh` and with an origin on `github.com`: the owner from
`git config --get remote.origin.url` must match `^[A-Za-z0-9-]{1,39}$`, and `gh auth token --hostname github.com --user <owner>` must print
a token (discarded, never printed). Then the installer writes, into the clone's `.git/config` only,
`credential.https://github.com.helper` as the empty value and then
`!f() { test $1 = get || return 0; t=$(gh auth token --hostname github.com --user <owner>) && test -n $t && echo username=<owner> && echo password=$t; }; f`
(no double quotes, which PowerShell 5.1 strips), and prints `  Git signs in to github.com as <owner> in <dir>`. A rerun
keeps exactly those two values; a failing write is a warning, and when the second value fails after the empty one was
written, the key is unset again, and the install goes on. So a machine whose active `gh` account, or Git Credential Manager login, is someone
else's still pulls the owner's private repo. Any other case writes nothing.

**`gh` as the owner.** Every `gh` call the program makes (`pr create`, `release view`, `release download`, `repo view`)
runs with `GH_TOKEN` set, in that child's environment only, to `gh auth token --hostname github.com --user <owner>`'s answer for the clone's
origin owner (`makubexD` for the release), asked once per run. No valid owner name or no answer: `gh` runs as its
active account, as before. `gh pr create` also gets `--repo github.com/<owner>/<repo>` when the clone's configured
origin is a `github.com` repo. The active account is never switched.

The run-from-clone fallback, for a machine that blocks the program: `--runtime bun|node` (`SYNCSETTINGS_RUNTIME` on
Windows) skips the download and puts the clone's launcher on `PATH` instead ([The program](#the-program)).

`install.sh`, run with a signed-in `gh` as
`gh api -H 'Accept: application/vnd.github.raw' repos/makubexD/SyncSettings/contents/install.sh | bash` (flags after
`bash -s --`; while the repo is public, `curl -fsSL https://raw.githubusercontent.com/makubexD/SyncSettings/master/install.sh | bash`
works too):

- Linux and macOS ([macOS](#macos) has its own rules); Windows shells and other systems stop with a message, exit 1.
- Missing `git`, `jq` or `cmp`: offers `sudo apt-get install` where `apt-get` exists. Otherwise it names the packages
  and exits 1. Unlike the `[Y/n]` rule below, end of input at this question is no: nobody is there to answer, so it
  installs nothing and exits 1.
- Clones the repo, or fast-forwards an existing clone, so running it again updates. A folder that isn't a clone, or a
  `mksync` that isn't its link, stops it without touching either.
- Installs the program as `$SYNCSETTINGS_BIN/mksync` (a temp file and a rename, mode 0755), or with
  `--runtime bun|node` links the clone's `mksync` launcher there. An existing `mksync` that is neither a link into the
  clone nor the same bytes stops it with `ERROR: <bin>/mksync already exists; remove it and run this again.`, exit 1;
  the same bytes are left as they are. Prints the `PATH` line if needed, then runs `mksync setup` (`--yes` passed on)
  unless `--no-setup`, and ends with `  Installed. Run mksync any time.`
- Removes `~/.local/bin/sync` when it is a symlink into the clone, a left-over of installers from before v1.0.0, and
  prints `removed the old sync link`; anything else at that path is left alone
  ([cut-over decision 9](archive/plan-single-engine-9-cutover.md)).
- `usage: install.sh [--yes] [--no-setup] [--runtime bun|node]` on stderr, exit 1, for any other argument.
- The script is functions with `main "$@"` as its last line, so a cut-off download runs nothing.
- Answers come from the terminal (`/dev/tty`) when stdin is the piped script.

| Variable                          | Default                                                                 |
| --------------------------------- | ----------------------------------------------------------------------- |
| `SYNCSETTINGS_REPO_URL`           | `https://github.com/makubexD/SyncSettings.git`                          |
| `SYNCSETTINGS_DIR`                | `$HOME/SyncSettings`                                                    |
| `SYNCSETTINGS_REF`                | `master`                                                                |
| `SYNCSETTINGS_BIN`                | `$HOME/.local/bin`                                                      |
| `SYNCSETTINGS_RELEASE_URL`        | `https://github.com/makubexD/SyncSettings/releases`                     |
| `SYNCSETTINGS_TTY`                | stdin if it's a terminal, else `/dev/tty` if readable, else `/dev/null` |
| `SYNC_ARCH`                       | `uname -m`                                                              |
| `SYNC_OS_RELEASE` (status, setup) | `/etc/os-release`                                                       |

`install.ps1`, run in PowerShell with a signed-in `gh` as
`gh api -H 'Accept: application/vnd.github.raw' repos/makubexD/SyncSettings/contents/install.ps1 | Out-String | iex`
(while the repo is public, `irm https://raw.githubusercontent.com/makubexD/SyncSettings/master/install.ps1 | iex` works
too):

- Windows only; elsewhere it points to the bash installer, exit 1. It needs PowerShell 5.1. Errors are thrown and caught
  at the top, so `iex` never closes the user's window.
- Missing `git` (required) or `gh` (for push): offers `winget install --id Git.Git` / `GitHub.cli` where `winget` exists,
  then reloads `Path` for the session. Git still missing stops it; gh missing is a warning.
- Clones the repo, or fast-forwards an existing clone, so running it again updates. A folder that isn't a clone stops
  it without touching it.
- Installs the program as `mksync.exe` in the bin folder (a temp file and a move). With `SYNCSETTINGS_RUNTIME=bun|node`
  it writes two launchers there instead: `mksync.cmd`, marked `rem SyncSettings launcher` on its second line, which
  calls the clone's `mksync.cmd`; and `mksync` (no extension, ASCII, LF), marked `# SyncSettings launcher` on its
  second line, which Git Bash runs as `exec "<clone>/mksync" "$@"` with the clone path in forward slashes. A
  `mksync.exe` with other bytes, or a `mksync.cmd` or `mksync` without its marker, stops it with
  `ERROR: <path> already exists; remove it and run this again.`; installing the program removes its own `mksync.cmd`
  and `mksync`. It also removes the old default launcher, `%LOCALAPPDATA%\SyncSettings\bin\mksync.cmd`, when it is
  ours.
- Adds the bin folder to the user `Path` if missing (new windows pick it up), then runs `mksync setup` unless
  `SYNCSETTINGS_NO_SETUP=1`; a failed setup stops it with `ERROR: setup failed; run mksync setup to see why.`
- The script is one function called on its last line, so a cut-off download runs nothing. It takes no parameters, since
  `iex` can't pass any; settings come from the environment.

| Variable                   | Default                                             |
| -------------------------- | --------------------------------------------------- |
| `SYNCSETTINGS_REPO_URL`    | `https://github.com/makubexD/SyncSettings.git`      |
| `SYNCSETTINGS_DIR`         | `%USERPROFILE%\SyncSettings`                        |
| `SYNCSETTINGS_REF`         | `master`                                            |
| `SYNCSETTINGS_BIN`         | `%LOCALAPPDATA%\mksync`                             |
| `SYNCSETTINGS_YES`         | unset; `1` answers the `[Y/n]` questions            |
| `SYNCSETTINGS_NO_SETUP`    | unset; `1` skips `mksync setup`                     |
| `SYNCSETTINGS_RELEASE_URL` | `https://github.com/makubexD/SyncSettings/releases` |
| `SYNCSETTINGS_RUNTIME`     | unset; `bun` or `node` installs the launcher        |
| `SYNC_ARCH`                | `PROCESSOR_ARCHITECTURE`                            |
| `SYNC_OS_NAME` (status)    | the Windows caption                                 |

### Update

`mksync update` replaces the installed program with the latest release
([design, "Decided in phase 9"](design-layers.md#decided-in-phase-9), decision 5). It reads the latest tag at
`MKSYNC_RELEASE_URL` (default `https://github.com/makubexD/SyncSettings/releases`) and compares it with its own
version (`mksync --version`). With `MKSYNC_RELEASE_URL` unset or empty and `gh auth status` succeeding, the tag and
the files come through `gh release view` and `gh release download`, as the installers do ([Install](#install)); a
failing `gh` call gives the same error line, with `gh`'s first stderr line as the reason:

- Not newer: `mksync <version> is up to date.`, exit 0, nothing downloaded but the tag.
- Newer: it downloads `SHA256SUMS` and the program for this OS and CPU, checks the SHA256, writes it next to itself
  as `<program>.new`, and renames it over itself: `mksync updated: <old> -> <new>.`, exit 0. On Windows the running program first moves to
  `mksync.old.exe`, and every start of the program deletes a leftover `mksync.old.exe` next to it.
- Any failure changes nothing, exit 1:

  ```text
  ERROR: no mksync release for <platform>-<arch>.
  ERROR: cannot get the mksync release: <reason>.
  ERROR: SHA256SUMS: <reason>.
  ERROR: <asset>: checksum does not match SHA256SUMS; nothing changed.
  ERROR: cannot replace <program>: <reason>; nothing changed.
  ```

- Run through the clone's launcher, or by any runtime running the source (a program not named `mksync` or
  `mksync.exe`, so `bun src/main.ts update` never overwrites `bun`), it refuses with
  `ERROR: mksync runs from the clone here; update it with git pull.`, exit 2.

## The program

`mksync` is one TypeScript engine compiled to one program per OS (`mksync.exe` on Windows)
([design](design-layers.md)). The installers put it on `PATH` ([Install](#install)).

On Windows the program starts only `.exe` and `.com` commands, never through cmd.exe, whose quoting can't carry free
text such as a PR body safely. A tool that is only a `.cmd` or `.bat` (a `gh.cmd` on `PATH`, or `GH` naming one) counts
as missing and gets that command's "not found" error.

Every command the program starts by name (`git`, `gh`, `bash`, …) is found on `PATH` only, never in the working folder
or the repo, so a `git.exe` committed to the repo never runs. Empty and relative `PATH` folders are skipped, on every
OS; on Windows one pair of double quotes around a folder (`"C:\Program Files\Git\cmd"`) is dropped first, as Windows
does, and an exact `PATH` key wins over another spelling such as `Path`. A command not on `PATH` gets its "not found"
error, as a missing one does, and so does every command when the environment has no `PATH` at all (exit 127, never the
working folder); a name holding a path separator (`GH` naming a file) runs as given.

The clone can also run the program from its source, with no build and no `npm install`: `mksync` (sh) and `mksync.cmd`
at the repo root run `bun src/main.ts` or `node src/main.ts` with the arguments
([design, "Decided in phase 9"](design-layers.md#decided-in-phase-9), decisions 1 and 2). `MKSYNC_RUNTIME=bun|node`
picks the runtime; unset, the first installed of Bun, then Node. Node must be 22.18 or newer, the first that runs
TypeScript without a flag. The launchers set `MKSYNC_LAUNCHER=1`, which is how `mksync update` knows to refuse. Their
errors, each exit 2:

```text
ERROR: MKSYNC_RUNTIME must be bun or node.
ERROR: mksync needs Bun or Node 22.18 or newer to run from the clone.
```

Besides the [front door](#front-door)'s commands, it has the lower-level verbs they run. The shared cases drive these
directly; they run but stay off the usage line
([design, "Decided in phase 9"](design-layers.md#decided-in-phase-9), decision 12):

| Command                                                            | Does                                                                               |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `mksync export [--only <path>…] [--yes]`                           | the export ([Flow](#flow)); `--yes` answers [New settings](#new-settings)          |
| `mksync export --preview`, `mksync export --diff [--only <path>…]` | `mksync preview` ([Export preview](#export-preview)) and the [Diff](#diff)         |
| `mksync import [--force] [--reset-values] [--only <path>…]`        | the import ([Sanitize and hydrate](#sanitize-and-hydrate) for `--reset-values`)    |
| `mksync import --check [--only <path>…]`                           | `mksync check` ([Import check](#import-check))                                     |
| `mksync commit [-m <msg>] [--partial]`                             | [Checks before pushing](#checks-before-pushing), the branch and PR, the sync point |
| `mksync statusline`                                                | [Statusline](#statusline)                                                          |
| `mksync --version`                                                 | prints `mksync <version>`, exit 0                                                  |

- Exit codes, status words, labels, notes and `ERROR:` lines are this contract's. Where they differ between systems,
  [Known differences](#known-differences) says so.
- An unknown option prints `Unknown option: <arg>` on stderr and exits 2. So do clashing flags, a repeated flag and an
  unknown verb in a group (`mksync machine list`) ([design, "Decided in phase 9"](design-layers.md#decided-in-phase-9),
  decision 7). Run with no command, it prints this usage line on stderr and exits 2:

  ```text
  usage: mksync status | mksync doctor | mksync pull [--yes] [--force] [<path>...] | mksync push [--yes] [--force] [-m <msg>] [<path>...] | mksync diff [<path>...] | mksync check [<path>...] | mksync preview | mksync setup [--name <machine>] [--profile <name>] [--replace <machine>] [--claude none|claude|claude-deepseek] [--mode push|pull-only] [--existing backup|keep|stop] [--bootstrap | --no-bootstrap] [--yes] | mksync update | mksync machine show | mksync machine retire <name> [--yes] | mksync profile retire <name> [--yes] | mksync setting list [--profile <p>] | mksync setting move <file> [<key>] --to base|os|profile|machine [--dry-run | --yes] | mksync statusline | mksync --version
  ```

- It reads the config as [Config](#config) says, `.user-values.json` next to it, and the state folder
  ([Sync point](#sync-point)).
- Flag errors, each exit 1 before anything runs: `ERROR: --only needs a path.`, `ERROR: --diff cannot be combined
with --preview or --yes.`, `ERROR: --check cannot be combined with --reset-values.`, and `Missing value for -m` for a
  `-m` with nothing after it (`commit`, `push`).

### Layers

The program builds a file from up to four layers, in order: base (`dotfiles/common/`), OS (`dotfiles/<os>/`),
profile and machine ([design, "Layers"](design-layers.md#layers)).

**Profile and machine.** They come from the machine record ([Machines](#machines)): the profile
`<state>/profiles/<profile>.json` with its layer `<state>/profiles/<profile>/`, and the machine layer
`<state>/machines/<name>/`. `<state>` is the folder of the [sync point](#sync-point). With no record (every machine
before its first `mksync setup`): no profile or machine layer, and every module is on, as before. The program never
reads `profiles/` or `machines/` from the repo while it's public. The phase 5 variables that chose them by hand
(`SYNC_PROFILE`, `SYNC_MACHINE`) were removed in phase 6.

A name is lowercase letters, digits and `-`. A layer name can't name another layer: neither the profile nor the machine
may be `linux`, `macos`, `windows`, `common` or `base`, and the machine may not have its profile's name. Side files are
named after their layer (`CLAUDE.<name>.md`), so two layers with one name would overwrite each other's file, and the
next push would send one layer's text into the other.

```text
ERROR: profile <name> not found: <state>/profiles/<name>.json
ERROR: profile <name>: <reason>.
```

Each stops the run with exit code 2 before any file is touched, as the record's own errors do. `<reason>` is
`not valid JSON`, `unknown field <f>`, `<f> has the wrong type`, `unknown module <m>` or
`destination <key> is not a layer`, and for a linked folder's entry ([Linked folders](#linked-folders))
`entry <file> needs file and localPath as strings`, `entry <file> is outside linked/`,
`entry <file> names unknown module <m>` or `entry <file> is not a dir`.

A profile's `destinations` maps a key path (as in the `needs a destination` note below) to a layer slot: `base`,
`os`, `profile` or `machine`. Any other value is `destination <key> is not a layer`. (`base` is accepted since phase 7,
for an answer of "all machines", [New settings](#new-settings).)

**Writes to the state folder.** Before a run overwrites or removes a file under `<state>/profiles/` or
`<state>/machines/`, it copies the old file into the run's dated folder (`backups/<run>/profiles/…`,
[Backups](#backups)), as import does for local files. These writes are never committed, so the
[export preview](#export-preview) leaves them out. A path that would resolve outside `<state>` or the repo (`../` in a
`file`) fails that action with `ERROR`, and the run goes on.

With a record, an entry runs only when its module is on ([Modules on a machine](#modules-on-a-machine)). An entry
that is off gets no status line, as one for another system.

**Labels.** A status line for a layered file uses the repo path of the layer it reads or writes. A profile or machine
layer is labeled `profiles/<name>/<file>` or `machines/<name>/<file>`. Import labels the local file with the latest
layer that holds it, so an entry with one layer keeps its old label.

**`json` entries, import.** Each layer is hydrated first; a value goes in as a JSON string body (`\` as `\\`, `"` as
`\"`, control characters as `\uXXXX`). Then the layers are merged:

- Objects merge key by key, later layers winning; two objects under one key merge the same way.
- Arrays collect items: the base's items in order, then each later layer's items not there yet. Two items are the
  same when they are equal as JSON, key order ignored.
- Keys come in the base's order, then keys only later layers have, in the order those layers list them.
- Numbers are written as their layer writes them (`1.0` stays `1.0`).

The file is written with two-space indent, one key or item per line, `": "` after a key, `{}` and `[]` when empty,
non-ASCII characters as themselves, and a trailing newline: CRLF on Windows, LF elsewhere. It's compared with the local
file parsed, so whitespace, key order and line endings alone are `UNCHANGED`. Keys listed in the entry's
`localOnlyKeys` keep their local value and are never pushed.

Import makes the file equal to the merged layers, so a key or array item only this machine has is dropped; that is
how a removal made on another machine reaches this one. Such a file is `OUT` (or `BOTH`) in the [Diff](#diff), so
`mksync pull` and `mksync setup` stop before overwriting it; run `mksync push` first to keep it.

A layer that isn't JSON (comments and trailing commas included) gets `ERROR` with the note
`not valid JSON: <layer path>`, and the local file is left alone. A UTF-8 BOM at the start of any JSON file, layer or
local, is skipped on read and never written. JSON nested deeper than 512 levels counts as `not valid JSON`.

**`json` entries, export.** The local file is parsed and compared with what import would write now. Each change goes
to one layer, then that layer is sanitized and written in the layout above with LF:

- a changed key goes to the latest layer that sets it;
- a removed key is removed from every layer that sets it, so the next pull doesn't bring back an earlier layer's value;
- a removed array item is removed from the layer that added it;
- a new key or a new array item goes to the layer the profile's `destinations` names for it; when this machine has no
  record, an entry with one layer puts it there. With a record it is a [new setting](#new-settings), whatever the
  number of layers. The destination's file may not exist yet: export creates it (and its folders) with `ADDED` and its
  label.

Each layer written gets `MODIFIED` and its label; with no change the file gets one `UNCHANGED` line, labeled with the
latest layer. A new setting with no layer to go to gives `ERROR`, note `new setting <key path>: needs a destination`,
once per setting, and nothing of that file is written. `<key path>` joins keys with `.` and an array item as `[]`
(`permissions.allow[]`). A local file that isn't JSON gives `ERROR`, note `not valid JSON`.

**`import` entries** (`CLAUDE.md`). Import writes the local file as the base text, then, when a later layer holds the
file, the marker line and one `@<importName>` line per such layer, in layer order:

```markdown
<!-- mksync: layers below are written by mksync pull -->

@CLAUDE.linux.md
@CLAUDE.work-1.md
```

Each of those layers is written next to the local file under its `importName` (`{layer}` is the OS, profile or
machine name), with its own status line. `importName` must hold `{layer}`; an `import` entry whose `importName` is
missing, isn't a string, or lacks it stops with exit 1 when the config is read:

```text
ERROR: sync-config.v2.json: entry <file> needs {layer} in importName.
```

Export stores the text above the marker in the base layer, compared with CRLF
folded to LF; an edit to the block itself is not stored and prints the note
`import block is written by mksync, edit not pushed` on the base's status line. The marker that counts is the last
marker line followed only by `@` lines and blank lines; a marker line quoted inside the base text stays base text.
Blank lines after the block and a missing final newline aren't an edit to it. Each side file is exported to its layer as a whole file, with CRLF folded to LF before it is sanitized and
compared, on every OS. Text is written with CRLF on Windows and LF elsewhere.

Side files are local files like any other: import compares each one, asks before overwriting it and backs it up as
`<file>.bak`. On export, a side file that isn't there locally leaves its layer as it is (`UNCHANGED`).

As every `ERROR` ([Both](#both)), these affect only their own file, and the run still exits 0.

**Shared cases for layers** give `configV2` like every case, and may set files
in the state folder (`state/machine.json` and `state/profiles/` for the record) and, in `env`, `SYNC_HOSTNAME`,
`SYNC_DOMAIN`, `SYNC_TOOLS` and `MKSYNC_VISIBILITY` (the phase 5 `SYNC_PROFILE` and `SYNC_MACHINE` were removed).
They run on every OS.

### Machines

Each machine has one record, written by `mksync setup` ([design, "Machine records"](design-layers.md#machine-records)).

**The record** is `<state>/machine.json`:

```json
{
  "name": "wk1-laptop",
  "alias": "work-user",
  "profile": "work-1",
  "os": "windows",
  "hostname": "wk1-laptop",
  "domain": "corp.example.com",
  "claude": "claude",
  "pullOnly": false,
  "modules": { "add": [], "remove": ["windows-terminal"] },
  "values": { "<HOME>": "C:\\Users\\user" },
  "replaced": [],
  "retired": false
}
```

Every field is required except `alias`, and no other is allowed. `alias` is a machine alias (lowercase letters, digits
and `-`, at most 24 characters), the public name push branches use, written only when set. `name` and `profile` are
names (lowercase letters, digits and `-`, not a layer's name, `name` not equal to `profile`); `os` is `linux`, `macos` or `windows`; `hostname` a string;
`domain` a string or `null`; `claude` is `none`, `claude` or `claude-deepseek`; `pullOnly` and `retired` booleans;
`modules.add` and `modules.remove` lists of the config's module names; `values` maps placeholders to strings;
`replaced` lists `{"hostname": <string>, "domain": <string or null>, "date": "<YYYY-MM-DD>"}`, oldest first. The program
writes it in this key order in the layout of `json` entries ([Layers](#layers)): two-space indent, one key or
item per line (the example's one-line `modules` and `values` are input the program reads, not what it writes), `{}` and
`[]` when empty, LF and a trailing newline, readable by the current
user only (as `.user-values.json`, [Sanitize and hydrate](#sanitize-and-hydrate)); the profile file the same way. A
state file is written atomically — a temp file in the same folder and a rename — and a state path that is a symlink
stops the run with `ERROR: <path> is a symlink.`, exit 1. A repo file is written the same way, keeping the mode of
the file it replaces (a new one gets the umask's), and a repo path that is a symlink stops the run with the same
error. The sync point and dconf backups hold no secrets and keep
their mode (a new one gets the umask's); values, records and profiles are mode 600. A
bad record stops every command with exit 2 before any file is touched, on stderr:

```text
ERROR: machine record (machine.json in the state folder): <reason>.
```

`<reason>` is `not valid JSON`, `unknown field <f>`, `missing field <f>`, `<f> has the wrong type`,
`<f> must be lowercase letters, digits and -; this is <value>`, `<f> can't be <value>: it names another layer`,
`<f> can't be <value>` (an `os` or `claude` outside its list), `unknown module <m>` or `can't be read`. A bad profile
file stops the same way as `ERROR: profile <name> (profiles/<name>.json in the state folder): <reason>.`

Only a missing file means "no record yet" (or no such profile). A record or profile file that is there but can't be
read (a folder in its place, no read permission) is `can't be read`, never treated as missing.

The one exception is `setup --replace`: it reads past a bad local record and goes on as if this machine had none, so a
record nothing else can read can be replaced. A bad profile file still stops it.

**Where records are kept.** While the repo is public, only in local state: the record in `<state>/machine.json`, its
profile and any other profile made on this machine in `<state>/profiles/<name>.json`. Once the repo is private, the
first push moves them to the repo (phase 7 and 8) and rewrites the local record as `{"name": "<name>", "home": "repo"}`;
from then on the record is `machines/<name>.json` and the profiles `profiles/<name>.json` in the clone. Reading a record
never needs the network. A `home` record whose file isn't in the clone stops with
`ERROR: machine <name> not found: machines/<name>.json`, exit 2.

#### Modules on a machine

A module is on when the profile's `modules` or the record's `modules.add` lists it, the record's `modules.remove`
doesn't, the Claude mode keeps it (`none` turns off `claude` and `claude-worker`; `claude` turns off `claude-worker`),
and its `os` includes this system. The order is the profile's, then `add`'s.

#### Values on a machine

With a record, on `import`, `export` and `setup` alike, a placeholder's value comes from the record's `values`, then
the profile's `values`; `.user-values.json` is neither read nor written. Inference and the prompt
([Sanitize and hydrate](#sanitize-and-hydrate)) follow as before, and a value inferred or asked during the run is saved
where it belongs, in the state folder — or, with a pointer record, in the clone's `machines/<name>.json` and
`profiles/<name>.json`, a write that prints no status line — the way `setup` writes the record and the profile
(profile first):

| Placeholder                                                                                                        | Kept on |
| ------------------------------------------------------------------------------------------------------------------ | ------- |
| `<YOUR_NAME>`, `<YOUR_EMAIL>`, `<YOUR_GH_USERNAME>`, `<YOUR_GH_OWNER>`, `<YOUR_GH_ORG>`, `<YOUR_WORK_MARKETPLACE>` | profile |
| `<HOME>`, `<GH_CLI_PATH>`                                                                                          | machine |

On `import` and `export`, any other placeholder goes on the profile. `setup` asks about it once, and saves the answer
with it:

```text
<OTHER>: kept on 1) this profile 2) this machine [1]
```

An empty answer, end of input or `--yes` takes `1`. With no value after all of this, the run prints
`missing value for <PLACEHOLDER>: run mksync push or pull in a terminal to enter it` and exits 1 before writing any file. A
preview saves nothing ([Export preview](#export-preview)). Without a record, values work as in
[Sanitize and hydrate](#sanitize-and-hydrate), `.user-values.json` included.

#### The scan

`setup` reads the machine first: the OS (as [Which system](#which-system)), the hostname (lowercase), the domain
(`USERDNSDOMAIN` on Windows, lowercase; `null` elsewhere), the global git email (shown, never stored), which of
`git`, `gh`, `jq`, `code`, `claude`, `tmux`, `starship`, `wezterm`, `htop` and `rtk` are on `PATH`, and how many of this
system's config entries already exist locally. `SYNC_HOSTNAME`, `SYNC_DOMAIN` (empty means `null`) and `SYNC_TOOLS` (a
comma list of the tools found) replace what the scan reads; tests set them.

```text
Scanning this machine...
  OS         windows
  Hostname   wk1-laptop
  Domain     corp.example.com
  Git email  user@example.com
  Tools      git, gh, code, claude (not found: jq, tmux, starship, wezterm, htop, rtk)
  Files      9 of 14 windows entries already exist here
```

A missing domain or git email shows `none`; with every tool found the `(not found: …)` part is left out.

#### `mksync setup`

```text
mksync setup [--name <machine>] [--profile <name>] [--replace <machine>] [--label <text>] [--alias <name>]
             [--claude none|claude|claude-deepseek] [--mode push|pull-only] [--existing backup|keep|stop]
             [--bootstrap | --no-bootstrap] [--value KEY=VALUE]... [--yes]
```

It runs the doctor first: a `MISSING` line stops it with exit 1, before any question. Then it scans, prints the
profile guess when it makes one, lists the profiles, asks four questions (and the label after the first, for a new
profile), the linked-folder questions and, on Ubuntu, the bootstrap question, then the value questions, prints the
summary and `Same as:`, then the guard block when one applies, then asks to confirm. Nothing is written before a yes,
and after it setup asks nothing. After it, setup writes the record and the profile with the values, runs the bootstrap
if it was chosen, then acts on the fourth answer. The profiles listed are `personal` and every profile in the store that isn't retired, each with its non-retired
machines;
while public the heading is `Profiles on this machine:`, after the switch `Profiles in this repo:`:

```text
Profiles on this machine:
  1) personal
  2) work1       machine wk1-laptop
  This looks like wk1-laptop (same hostname): choosing 2 replaces it.

1/4 What is this machine for? [2]
2/4 Claude here? 1) none  2) Claude only  3) Claude plus DeepSeek [2]
3/4 Push with a preview, or pull only? 1) push with a preview  2) pull only [1]
  3 file(s) differ: 3 in, 0 out, 0 both.
4/4 Files that are already here? 1) back up and replace  2) keep mine, push them first  3) stop [1]
  Also restore apps and packages from packages/linux (uses sudo)? [y/N]
 Home folder (~/.claude/settings.json) [/home/jane]:

Machine wk1-laptop: profile work1 (acme), Claude only, push with a preview.
Public name: work1-linux
Values:
  <HOME> = /home/jane (old machine)
Same as: mksync setup --profile work1 --replace wk1-laptop --claude claude --mode push --existing backup --alias work1-linux --no-bootstrap
Write the record and apply? [Y/n]
```

With no hostname match, on a fresh work machine while the repo is public:

```text
Guess: new profile work1 (Windows); other machines' profiles can't be seen while the repo is public, so check the number

Profiles on this machine:
  1) personal

1/4 What is this machine for? [work1]
 Label for work1, to find it in lists (optional):
```

- **Layout.** The scan block, the profile list, the questions and the summary are separated by one blank line; each
  question is printed with one space after it and no newline, so answers piped on stdin leave the questions on one
  line. A question a flag answers isn't printed.
- **Values before the summary.** After the linked-folder and bootstrap questions, setup asks every value this run's
  writes would ask ([Sanitize and hydrate](#sanitize-and-hydrate)): the import's, built from the chosen profile,
  record and entries, and, with `keep`, the whole export's (not only keep's paths, since a path `--only` refuses
  falls back to the whole export). `stop` writes only the record, so it asks only the `kept on` and replace
  questions. Each is asked once, in the import's words, with its guess in brackets; the `<KEY>: kept on …` question
  ([Values on a machine](#values-on-a-machine)) and the replace re-ask come here too, in that order and before the
  import's header, which is printed once before the first of the others. A value the profile or record already has, or a `--value` gives, isn't asked. The values are saved with
  the record after the confirm (placed by the value table), before the import, the keep export and the bootstrap
  script run, so none of them asks again: after the confirm setup asks nothing. `mksync pull` still shares its input
  with its import.
- **Answers.** A question takes its flag; without one, it's asked on stdin, and an empty answer takes the suggestion
  in brackets. End of input takes it too, except at the confirm, where end of input is no (see below), and at a value
  question, which stops with `ERROR: missing value for <KEY>`, exit 1, nothing written; so do an empty answer to a
  value question with no guess and an answer that holds placeholder text. A choice is digits only (`0x2` or `2.0`
  is a bad answer). The first question takes a number or a new profile name; a bad answer prints
  `Pick 1 to <n> or type a new profile name.` and asks again (end of input stops as below). Answers are trimmed of
  spaces, tabs and `\r` at both ends, so an answer that is only spaces counts as empty (phase 9 decision 8). A
  byte order mark before the first line of input is dropped too: Windows PowerShell pipes one when `$OutputEncoding` is
  UTF-8 with a BOM.
- **Suggestions.** The profile: the one whose non-retired record has exactly this hostname, with the `This looks like`
  line (always none while public); with two or more such records, or none, the profile guess below. Claude: `2` when
  the scan found `claude`, else `1`. Mode: `1`. Existing files: `1`, or `2` as "What differs" says.
- **The profile guess.** When no `--profile`, `--replace` or hostname match decides the profile, setup guesses from
  the scan, never from the domain's name: on Linux with no domain, `personal`; with a domain, or on any OS but Linux, a
  new profile `work<n>`. `<n>` is one more than the largest number of any profile named `work<n>` or `work-<n>` that
  this machine knows (the store's, retired ones included, and local state's), else 1; `workbench` or `work-x` don't
  count. A line before the profile list names it and why:
  `Guess: personal (Linux, no domain).`, `Guess: new profile work<n> (Windows).`, `(macOS)` or
  `(Linux, joined to a domain)`. While the repo is public a `work<n>` line ends
  `; other machines' profiles can't be seen while the repo is public, so check the number` in place of the full stop.
  The guess is question 1's suggestion: `[<n>]` for a listed profile, `[<name>]` for a new one.
- **`--yes`** asks nothing and takes every suggestion, with two limits. It takes the profile guess only when the guess
  is `work<n>` and the repo is private; otherwise, after the guess line, it stops with `ERROR: missing --profile`,
  exit 2 (a wrong `personal` would put a work machine's settings in the shared layers; a wrong `work<n>` only keeps
  them out). It takes every value guess; a value with no guess and no `--value` stops before anything is written with
  `ERROR: missing value for <KEY>; pass --value KEY=<value>`, exit 2. `install.sh --yes` runs `setup --yes`, so on a
  personal machine it stops and asks for `--profile`.
- **No suggestion.** End of input on a question with no suggestion, or `--yes` without its flag, stops with
  `ERROR: missing --<flag>`, exit 2, before anything is written.
- **Label.** When setup creates a profile other than `personal`, it asks after question 1, also when `--profile`
  answers question 1 (`--mode pull-only` with `--existing keep` stops before it, exit 1):
  `Label for <profile>, to find it in lists (optional):`. An empty answer or end of input leaves none; `--yes`
  doesn't ask. `--label <text>` sets it without asking; with a profile that already exists it stops with
  `ERROR: --label names a new profile; <profile> already exists`, exit 2. A label is 1 to 30 letters, digits, spaces
  and `.-_&` with no placeholder text, else `ERROR: --label: use 1 to 30 letters, digits, spaces or .-_&`, exit 2 (a
  typed answer is asked again). It is saved as the profile's `label` key, after the others, and shows in the profile
  list (`  2) work1  (acme)`) and the summary (`profile work1 (acme)`). It is private: it never goes into a branch name,
  a commit message or a PR, and while public the profile stays in local state. Unlabelled profiles print as before.
- **Public name.** Setup doesn't ask it: it guesses `<profile>-<os>` in alias form, as [the PR](#checks-before-pushing)
  does, and `--alias <name>` sets it, checked as a typed public name is, before any question (its refusal, exit 2). On
  `--replace` the old record's alias is kept unless `--alias` is given, also for a pull-only record, so a later switch
  to push keeps its branch prefix. A new pull-only machine gets none, and so does a guess the check refuses (push asks
  later).
- **`--value KEY=VALUE`**, repeatable, answers a value question without asking. `KEY` is the placeholder with or
  without its `<` `>` (`--value YOUR_NAME=Jane` and `--value '<YOUR_NAME>=Jane'` are the same), since a bare `<` is a
  shell redirect. It also replaces a saved value. Refused before any question, exit 2:
  `ERROR: --value <KEY>: no rule uses this placeholder`, `ERROR: --value <KEY>: empty value`,
  `ERROR: --value <KEY>: value holds a control character` (a value is one line, as a typed answer is; a replace guess
  from `defaultEnv` holding one is no guess), and a value holding placeholder text, with the typed value's refusal word
  for word.
- **Name.** `--name`, else the hostname up to its first dot (macOS reports `<name>.local`; the record keeps the
  whole hostname). A name that isn't valid stops with
  `ERROR: <value> isn't a valid machine name; use --name <machine>.`, exit 2; a profile name likewise with
  `--profile <name>`. `--name` with `--replace` stops with `ERROR: --name and --replace can't be used together.`,
  exit 1. A machine name equal to the chosen profile (from the hostname, `--name`, or a profile typed or picked at
  question 1) stops before anything is written with
  `ERROR: machine <name> can't share its profile's name; use --name <machine>.`, exit 2.
- **A new profile** gets `shell`, `git`, then each module whose tool the scan found (`gh`, `code` for `vscode`, `claude`
  for `claude` and, with Claude plus DeepSeek, `claude-worker`, `tmux`, `starship`, `wezterm`, `htop`, `rtk`), then
  `gnome` on Linux and `windows-terminal` on Windows, in the config's module order; `destinations` empty, `retired`
  false, then `label`, written last, when one was given.
- **Values.** `.user-values.json`, if there is one, is copied once by the table in
  [Values on a machine](#values-on-a-machine), asking about any other placeholder as there (before the summary); a key
  the profile or record already has keeps its value, and the value question is skipped for it. The file is left as it
  is.
- **Summary.** In this order:

  ```text
  Machine <name>: profile <profile>, <Claude>, <mode>.
  Public name: <alias>
  Values:
    <YOUR_NAME> = Jane Doe (git-user-name)
    <YOUR_EMAIL> = jane@example.com (typed)
  Same as: mksync setup ...
  ```

  then the guard block, when there is one. `<profile>` adds ` (<label>)` when it has one. `<Claude>` is `none`,
  `Claude only` or `Claude plus DeepSeek`; `<mode>` is `push with a preview` or `pull only`. `Public name:` is left out
  when there is none, `Values:` when no value was asked. The source in brackets is the `suggest` source that answered,
  `typed`, `--value`, `--value, replaces the saved value`, `defaultEnv` (a replace guess from the rule's `defaultEnv`)
  or `old machine`. A repeated `--value` key takes the last value.

- **`Same as:`** always names `--profile`, then `--replace <name>` or `--name <name>`, `--label <text>` for a new label,
  `--claude`, `--mode`, `--existing`, `--alias <alias>` when there is one, ` --bootstrap` or ` --no-bootstrap` when the
  bootstrap was offered, and ` --value KEY=VALUE` for every typed or `--value` answer (a guess reproduces itself). A
  token with a character outside `A-Za-z0-9._@/:+=-` is quoted whole in single quotes, `'` written `'\''` on Linux and
  macOS and doubled on Windows, with the typographic quotes U+2018 to U+201B PowerShell also reads as `'` (the Windows
  line targets PowerShell). On Windows a value holding `"` is left out, with
  one line after `Same as:`: `Same as: leaves out --value KEY (its value holds a ").`
- **What differs.** Before question 4, setup runs the [import check](#import-check) and, when it finds changes and a
  [sync point](#sync-point) exists, the [diff](#diff). It prints one line above question 4 (also when a flag answers
  it): with a sync point, `  <n> file(s) differ: <i> in, <o> out, <b> both.`; without one,
  `  <n> file(s) differ. No sync is recorded on this machine, so the newer side is unknown.`; after a failed diff,
  `  <n> file(s) differ; could not tell which side is newer.` A diff that leaves out a file for a missing value counts as
  failed. `<n>` is the diff's count (`<i> + <o> + <b>`); without a
  sync point or after a failed diff it is the check's `UPDATE` count. A `CREATE` never counts, since a file this
  machine lacks has nothing to overwrite, so a fresh machine gets no line. A count of 0 prints no line. Question 4 suggests `2`
  (keep mine) when the diff has an `OUT` or `BOTH` file and the mode is push, else `1`.
- **Guard block.** When the fourth answer is `backup`, a sync point exists and the diff has an `OUT` or `BOTH` file,
  setup prints those diff lines after `Same as:`, then
  `  <n> file(s) changed on this machine since the last sync; back up and replace overwrites them (each keeps a .bak).`
  When the diff failed instead, it prints
  `  Could not tell which side is newer; back up and replace may overwrite files changed here (each keeps a .bak).`
  `IN` lines never make a guard block, and `keep` or `stop` never do.
- **Confirm.** `Write the record and apply? [Y/n] `, or `[y/N] ` after a guard block. When the fourth answer is
  `stop`, nothing is applied, so the question is `Write the record? [Y/n] ` (`stop` never makes a guard block). A no prints
  `Stopped: nothing was written.` and exits 0, with no record, profile, bootstrap or import. An empty answer is yes;
  end of input at `[Y/n]` counts as no, printing `Stopped: nothing was written.` and exiting 0, since with no
  terminal, as under Claude Code's `!`, nobody answered. `--yes` answers yes,
  except after a guard block: there setup stops before anything is written with
  `ERROR: <n> file(s) changed on this machine since the last sync, and setup would overwrite them.` and
  `Run mksync setup --existing keep to push them first, or run it without --yes to confirm.`, exit 1; after a failed
  diff, `ERROR: could not tell which side is newer; run mksync diff to see why, or run setup without --yes to confirm.`,
  exit 1. With `--mode pull-only`, which can't keep, the second line is `Run it without --yes to confirm.` A declined
  or unanswered confirm writes nothing, values included.
- **Bootstrap.** On Ubuntu with an executable `bootstrap/linux.sh`, after question 4 and before the summary:
  `Also restore apps and packages from packages/linux (uses sudo)? [y/N] `; `y` chooses it, while an empty answer or
  end of input skips it. `--bootstrap` chooses it without asking, and `--no-bootstrap` or `--yes` alone skips it
  without asking; both flags together stop with `ERROR: --bootstrap and --no-bootstrap can't be used together`, exit 2. Off Ubuntu `--no-bootstrap` is accepted and does nothing. The `stop` answer to question 4 never asks it. After
  the confirm and the record and profile are written, with `keep` setup runs keep's export as "Then" describes (and
  prints `Pushed into the repo folder; commit it with mksync push.`) before the script, while setup's terminal is still
  open; a failed export stops setup before the script with the export's code, the record and profile staying written.
  Then setup runs the script with `MKSYNC_SETUP_EXISTING` set to the fourth answer (and, with `keep`,
  `MKSYNC_SETUP_EXPORTED=1`; a script that gets `keep` without it, from an older program, runs `export` and prints the
  `Pushed into` line itself), and the script's import step does
  what "Then" says for it in place of its own import: `backup` and `keep` run `import --force` (with keep, the export
  is already done); `stop` prints
  `  SKIPPED    import (mksync setup --existing stop)` and runs no import. The steps after it (links, plugins,
  preview) see the restored files, and the script keeps the terminal for the import's questions. Setup ends with the
  script's exit code and does nothing after it; a failure leaves the record and profile in place. macOS and Windows never ask, and `--bootstrap`
  there is `ERROR: --bootstrap is Ubuntu only.`, exit 1, before the doctor. The installed program passes its
  own path to the script as `MKSYNC_PROGRAM`, and the script's import and preview run that program first, then
  `mksync` from `PATH`, then the clone's `./mksync`. A fresh machine whose bin folder is not on `PATH` yet still
  restores without Bun or Node.
- **Then**, after a yes, it writes the record and the profile. With the bootstrap chosen, the script acts on the fourth
  answer ("Bootstrap"); otherwise setup does: `backup` runs `import --force` (each
  file keeps its `.bak`); `keep`, with a sync point and a diff that ran, runs `export` with `--only` for each file the
  diff labelled `OUT` or `BOTH`, prints `Pushed into the repo folder; commit it with mksync push.`, then runs
  `import --force`, which brings the `IN` files; when the diff labelled no such file, only the import runs and no
  `Pushed into` line prints; without a sync point it runs the whole `export`, since
  the newer side is unknown; after a failed diff `keep` stops before any export with
  `ERROR: could not tell which side is newer; run mksync diff to see why, then run setup again.`, exit 1, the record and
  profile staying written; and when `--only` refuses a path (a layer added since the sync point) the whole export
  runs too; `stop` prints `Stopped: the record is written, no file was changed.` Exit 0, or the
  import's or export's code.

A flag that can't be read stops before the scan, exit 2, like an unknown option: `ERROR: <flag> needs a value.`,
`ERROR: <flag> is repeated.`, `ERROR: <flag> must be one of <a>, <b>, <c>.` (the choices in the usage line's order).

Two answers are refused before anything is written, exit 1. A retired profile, named by `--profile` or typed at the
first question: `ERROR: profile <name> is retired; pick another name.` "Keep mine" (`--existing keep` or answer 2)
with a pull-only mode, since keep pushes first:
`ERROR: --existing keep pushes first, so it can't be used with --mode pull-only.`

A machine that already has a record stops without `--replace`:
`ERROR: this machine is already <name>; use --replace to take over another record.`, exit 1.

**Replace.** `--replace <machine>`, or taking the record the hostname suggests, takes over a record from the store: it keeps the name, profile, Claude mode,
`pullOnly` and module overrides, so the second and third questions aren't asked. `hostname` and `domain` take the
scan's, and the old pair goes to `replaced` with today's date. Each machine value is asked again, before the summary,
with a fresh guess for this machine as the suggestion (its rule's `suggest` sources, then its `defaultEnv`), else the
old machine's value (`old machine` in the summary), in the import's words without its header:
` <prompt> (<files>) [<value>]:` (a value no rule names shows its placeholder as the prompt). The old record's
alias is kept, pull-only included. A record not in the store, or retired, stops with
`ERROR: no machine <name> here; records are shared once the repo is private.`, exit 1 (while public the store holds
only this machine's own record, so only a moved disk can take one over). Until the first private push (phase 7) the
taken-over record and its profile are written to local state; the repo's `machines/` and `profiles/` are left as they
are.

#### `mksync machine show`

Prints the record, six lines, exit 0:

```text
machine   wk1-laptop
profile   work-1
os        windows
claude    Claude only
mode      push with a preview
modules   work-base, git, shell, vscode, claude (windows-terminal off on this machine)
```

`modules` lists the modules that are on, then in brackets each one the profile lists that is off and why, joined by
`; `: `<m> off on this machine` (the record's `remove`), `<m> off, <os> only`, `<m> off by the Claude mode`. With none
on it says `none`. A retired record adds a seventh line, `retired   yes`. With no record:
`ERROR: no machine record here; run mksync setup.` on stderr, exit 1.

**Hostname check.** When the scan's OS, hostname or domain isn't the record's, `machine show`, `import` and
`import --check` print on stderr, before anything else, and go on:

```text
warning: the record says hostname wk1-laptop, this machine is wk1-new.
If this is a new machine, run: mksync setup --replace wk1-laptop
```

(`os` and `domain` likewise: `warning: the record says os <os>, this machine is <os>.`,
`warning: the record says domain <d>, this machine has <d>.` with `none` for `null`; one line per difference in the
order os, hostname, domain, then the `If` line once. The layers and modules follow the system the program runs on, not
the record's `os`, and an `os` difference alone only warns, push included: each system keeps its own state folder.)

**Push checks.** `export` stops with exit 1 before writing anything, on stderr, checking in this order (a hostname
or domain difference prints every difference line as above, as `ERROR:`):

```text
ERROR: this machine is retired.
ERROR: this machine is pull-only (see mksync machine show).
ERROR: the record says hostname wk1-laptop, this machine is wk1-new.
If this is a new machine, run: mksync setup --replace wk1-laptop
```

`export --preview` prints the same lines as `warning:` and goes on.

#### Retire

```text
mksync machine retire <name> [--yes]
mksync profile retire <name> [--yes]
```

Retiring sets `retired: true`; nothing is deleted. Each asks first, and `--yes` answers:

```text
Retire machine wk1-laptop? It can't push after this. [y/N]
Retire profile work-1? A first run won't offer it after this. [y/N]
```

The question is printed with one space after it and no newline. Yes prints `Machine <name> retired.` (`Profile <name> retired.`), exit 0. No, an empty answer or end of input prints
`Nothing retired.`, exit 1. Already retired: `Machine <name> is already retired.` (`Profile <name> is already retired.`), exit 0, nothing asked or written. A machine not in the store:
the `no machine <name> here` error above, exit 1; a profile not in the store:
`ERROR: profile <name> not found: <state>/profiles/<name>.json`, exit 1. A profile still used by a record that isn't
retired is refused, naming the first such record by name:
`ERROR: profile <name> is used by machine <machine>; retire or move that machine first.`, exit 1. A retired profile
isn't listed by `setup`; a retired machine isn't offered for `--replace` and can't push.

**The repo store.** When `machine.json` is the pointer `{"name": <name>, "home": "repo"}` (written by the
[first backup](#public-repo-guard)), both commands read and write `machines/<name>.json` and
`profiles/<name>.json` in the repo; the state folder is left as it is. A run reads only its own record,
`machines/<name>.json`, so another machine's broken record doesn't stop it; only `profile retire`'s "used by" reads
every record under `machines/`. A repo record or profile that can't be read stops any command with
`ERROR: <repo path> can't be read: <reason>.` and exit 2, before anything is written; `<reason>` is the record's or
profile's own (`not valid JSON`, …), or for a file that can't be opened `a folder in its place` or
`no read permission`.

### Public-repo guard

Until the repo is private, profiles, records and values never reach it.

**Visibility.** The guard judges where a push goes: every push URL of `origin` (`git remote get-url --push --all
origin`), each judged as below. Any public URL makes the repo public; it is private only when every URL reads
private. With no push URL, `MKSYNC_VISIBILITY` answers, as for any other origin; a git failure other than a missing
origin reads the visibility as unknown, whatever the variable says. For an origin on `github.com`: `gh repo view github.com/<owner>/<repo> --json visibility` when `gh` is signed in, otherwise
`GET https://api.github.com/repos/<owner>/<repo>`; each gets 5 seconds. A `gh` that fails or runs past its 5 seconds
can't tell, and the API is asked; any API failure (no network, no answer in time, an unknown value) counts as public. An owner must start with a letter or digit; a `github.com` origin that doesn't parse is public. An SSH origin
(`ssh://[user@]host[:port]/path` or `[user@]host:path`) on another host name is resolved with `ssh -G <host>`: an alias
whose `hostname` is `github.com` is asked as `github.com`; a host starting with `-`, or a failing `ssh -G`, is public.
For any other origin, `MKSYNC_VISIBILITY` (`private`, anything else or unset is public); the variable is never read for
`github.com`, directly or through an alias.

**Held.** While public and with a record, `export --preview` ends with the local files a private push would add, sorted:

```text
held until the repo is private: 2 file(s)
  machines/wk1-laptop.json
  profiles/work-1.json
```

The preview's diff and its count of files sent leave out paths under `profiles/` and `machines/` in any letter case,
as the guard below folds them.

**Refused.** While public, `export` stops with exit 1 before writing anything when the clone already tracks a path
under `profiles/` or `machines/` (in any letter case, as a case-insensitive file system sees them; each path is shown
as tracked), two lines per path, sorted:

```text
refused: the repo is public, so machines/wk1-laptop.json can't be pushed.
It is kept on this machine and goes in with the first push after the repo is private.
```

The record checks run first, then this one. While public, a clone whose tracked files can't be listed (`git ls-files`
fails or git can't start) stops `export` the same way, exit 1:
`ERROR: can't list the clone's files, so the public-repo guard can't check them.` A private repo needs no listing.
A folder with no `.git` isn't a clone and tracks nothing, so nothing is refused.

**The first backup.** When the guard reads private and the record isn't the pointer yet, `export --preview` ends with
the files a first backup would add, sorted, in place of the held line:

```text
First backup: profiles and machines
  machines/wk1-laptop.json
  profiles/work-1.json
```

The list holds the record, its profile, and every file in their layer folders (`<state>/machines/<name>/` as
`machines/<name>/…`, `<state>/profiles/<profile>/` as `profiles/<profile>/…`). `export` writes them into the repo,
after the entries, each with an `ADDED` or `MODIFIED` status line and its repo path as the label. When the repo already
holds `profiles/<profile>.json`, the two copies are merged: modules joined in the repo copy's order then this
machine's new ones, `destinations` joined, `retired` if either says so. The files are read after the export's own
writes, so a layer file or destination the same export adds is in the backup; a path the export already printed a
status line for isn't printed again. A value or destination the two copies set differently is asked, once per key, in
key order, after the [push preview](#push-preview) block and the
[new-setting](#new-settings) questions, and before any write:

```text
<YOUR_EMAIL> differs on profile work-1:
  repo:         jane@work1.example.com
  this machine: jane.doe@work1.example.com
Keep which? 1) the repo's  2) this machine's [1]
```

The question is printed with one space after it and no newline; answers are read as [`setup`](#mksync-setup) reads
them (`Pick 1 to 2.`), from the same input as the new-setting questions, and `--yes` keeps the repo's without asking.
A destination is shown by its layer slot. When
every file is written, `<state>/machine.json` becomes `{"name": <name>, "home": "repo"}`; from then on the record, the
profile and both layer folders are read from the repo, and every state write in this contract goes to the repo's
copy. A write that fails prints `ERROR: first backup stopped at <repo path>: <reason>.`, puts back the files this
backup already wrote (removes the ones it added, restores the earlier text of the ones it changed), leaves
`machine.json` as it was, and the export exits 1. A path that runs through a symlink in the clone (`machines/` itself,
or a layer file) stops it before any write with `<reason>` `a symlink`. A symlink in the state's layer folders
(`<state>/machines/<name>/`, `<state>/profiles/<profile>/`), or a file there whose bytes aren't UTF-8 text, stops it
before any write too, with the state path in place of the repo path, `<reason>` `a symlink` or `not UTF-8 text`, and
exit 2, as any state file that can't be read. A write of the export itself that fails ends the export with exit 1 and
no backup. A record already in the pointer form has no first backup.

### Push preview

The push side shows its changes grouped by who receives them, widest first. `export --preview` prints the block after
its status lines and before the `--stat` summary; `export` prints it before it writes. It prints only when at least
one change or new setting is found, so a run with nothing to send looks as before.

```text
Changes on wk1-laptop (profile work-1):

All machines
  1  M  vscode  settings.json     editor.fontSize: 14 -> 15
Windows machines
  2  M  git     .gitconfig.local  1 line(s) changed
Profile work-1
  3  +  claude  settings.json     permissions.allow[]: "Bash(work-tool-1 status)"
This machine only
     (none)
```

- **Header.** `Changes on <machine> (profile <profile>):` from the record, then a blank line. With no record:
  `Changes on this machine:` and only the first two groups (there's no profile or machine layer).
- **Groups,** in this order, each always printed: `All machines` (base), `<OS> machines` for this machine's OS
  (`Linux machines`, `Windows machines`, `macOS machines`), `Profile <profile>`, `This machine only`. An empty group is
  one line `(none)`, indented to the kind column. A change belongs to the group of the layer it's written to
  ([Layers](#layers)).
- **Lines:** two spaces, the number, two spaces, the kind (`M` changed, `+` added, `-` removed), two spaces, the module,
  two spaces, the file, two spaces, what changed. The number is right-aligned to the widest number in the block; module
  and file are padded to the widest in the block. Numbers run from 1 in display order across all groups, then on
  through [New settings](#new-settings).
- **The file** is the entry's `file` without its first folder (`claude/settings.json` → `settings.json`,
  `claude/docs/token-routing-map.html` → `docs/token-routing-map.html`); an `import` side file is its resolved
  `importName` (`CLAUDE.work-1.md`); a file inside a `dir` entry is `<file>/<name inside>`.
- **What changed.** For a `json` entry, one line per key path or array item: `<key path>: <old> -> <new>` (`M`),
  `<key path>: <value>` (`+`, `-`), an array item as `<path>[]: <item>`. Values are compact JSON (`"text"`, `14`,
  `{"a":1}`); one longer than 60 characters shows its first 57 and `...`. For a whole file, base text or side file:
  `<n> line(s) changed`, `<n>` the larger of the lines added and removed by a line diff; a file new to its layer is
  `+` with `new file, <n> line(s)`. A `dir` entry's file is a whole file.
- **Order.** Groups as above; inside a group, the config's entry order, then key path in code-unit order, `-` before
  `+` for one path.
- **Values are the sanitized text,** as the layer will hold it: `<YOUR_EMAIL>`, never the value.

Moving a change to another group ("Move a change?") comes with `mksync push` in phase 8; the numbers are already its
handles.

### New settings

A new key or a new array item in a `json` entry has no layer yet ([Layers](#layers)). With a record,
the push side lists it after the groups and asks where it goes. This holds for an entry with one layer too (a
`claude/settings.json` with only the common layer): the one present layer is the answer only without a record, so a
work profile's keys stay in its local state unless the answer says otherwise. The [preview](#push-preview) and the
[diff](#diff) plan each new setting for its suggestion, as `--yes` does:

```text
New settings
  4  +  vscode  settings.json     chat.agent.enabled: true
     Where does it go? 1) all machines  2) Windows machines  3) profile work-1  4) this machine [3]
```

- Choice 1 is the base, 2 this machine's OS layer, 3 the profile, 4 the machine. The suggestion in brackets is
  `3` (the profile), or `1` when the profile is named `personal`.
- A key or array item whose path has a destination in the profile's `destinations` isn't new: it goes there without
  asking and is listed in that layer's group.
- **Asking.** `export` asks each new setting in number order. A path's new items are listed together on consecutive
  lines, and `export` asks once, after the path's last line; the answer covers all of them. The question is printed
  with one space after it and no newline; answers are read as [`setup`](#mksync-setup) reads them: an empty answer or
  end of input takes the suggestion, an answer that isn't `1` to `4` prints `Pick 1 to 4.` and asks again. `--yes`
  takes every suggestion without asking; the block still prints, with no question line.
- **The answer is stored.** The setting is written to the chosen layer (a missing layer file is created, `ADDED`). For
  an array item, the destination key `<module> <file>: <path>` also goes into the profile's `destinations` with the
  layer slot (`base`, `os`, `profile`, `machine`), so the next item there isn't asked; the file is the entry's `file`
  as the block shows it, after its module folder, so the same path in another file is a different key
  (`parity settings.json: delta[]`). The profile is written with its backup, as every state write. With a pointer
  record that profile is the clone's `profiles/<profile>.json`, and the export lists that write
  (`MODIFIED profiles/<profile>.json`) and counts it, as the first backup does; an import's write to the clone's
  record prints no line. A new key's answer isn't stored: the key now has a layer.
- **The preview** never asks: in place of each question, after the path's last line, it prints
  `     goes to: <choice> (asked by mksync export)`, `<choice>` the suggestion's words (`profile work-1`). Its status
  lines show the writes `export --yes` would make, the suggestion's layer included (`ADDED profiles/work-1/<file>`
  when that layer file is new).
- `--preview` with `--yes` stops with `ERROR: --preview and --yes can't be used together.`, exit 1, before anything
  runs.
- With no record nothing is asked: the [`needs a destination`](#layers) `ERROR` stays. A new file in a
  `dir` entry isn't asked either; it goes to the entry's latest layer.

### Move a change

`mksync push`, with a record and without `--yes`, asks after the block and the new-setting questions:

```text
Move a change? Type its number, or press Enter to go on:
```

- A number from the block asks `Move it to? 1) all machines  2) <Os> machines  3) profile <p>  4) this machine
[<current>]`, where `<current>` is the number of the group the change is in. Any other answer to either question
  prints `Pick 1 to <n>.` and asks again; an empty answer or end of input to the first one goes on. End of input to
  either question ends its line, so the output after it starts on a line of its own.
- A `json` key moved to a narrower group is written into that group's layer and left as it was in the old one: the
  narrower layer now overrides it for the machines it covers. Moved to a wider group, it is written into the new
  layer and removed from the old one, unless a layer between the two sets it, which would win once it's gone; then the
  old layer keeps it. A whole file, or an `import` side file, moves as a whole, under the same rule: a wider move
  past a layer that has the file keeps the old copy, and a narrower move past one is refused with
  `a layer narrower than <layer> has the file`. A removed setting or file has nothing to place, so moving it prints
  `change <n> removes a setting; it can't move.` Either refusal stops the push with exit 1 before anything is written.
- On this machine, the merged result of every file is the same after a move as before it; only who else receives the
  change differs. A `json` move that would change it (a layer between the two, or a narrower one, setting the same key
  differently) is refused with `moving <path> to <layer> would change the merged result`, and the push stops with
  exit 1 before anything is written. A key is found by its own key path, so a name holding a `.` (`"[python]"` >
  `"editor.formatOnSave"`) moves whole. A move that removes the last key of an object removes the emptied object too.
- A layer file a move creates prints its `ADDED` or `MODIFIED` line right after its entry's other lines, before any
  `ORPHAN` line.
- The block prints again after each move, with the change under its new group and its number kept. A change's number
  is set once, when the block first prints, and stays with it through every move; new settings keep theirs too. A group
  lists its changes in number order, so a moved change can appear between higher numbers, and typing a number always
  names the same change.
- The [profile-value rule](#profile-values) and the [guard](#public-repo-guard) run after the
  last move, so moving a change to `profile <p>` lets a refused value through.
- `--yes` and a machine without a record never ask; nothing moves.

### Profile values

A profile's values don't leave the profile. Before the push side writes anything, each layer text bound for the base
or an OS layer is searched, after sanitize, for every non-empty value of the record's profile, ignoring case. The values searched are the profile's
with those the run saves to it, so a value [inferred](#sanitize-and-hydrate) in this run is searched like a saved one.
A value is a hit only as a whole token: the character just before it and the one just after it, when there is one,
are not ASCII letters or digits. So a profile value `A4` is a hit in `"team": "A4"` and `team-A4_tools` but not in
`#A4B3C2` or `pa4ge`. A hit stops the run with exit 1 before any write, two lines per hit, ordered by change number then
placeholder. The change number is the one the change block above prints for that change:

```text
refused: change 1 (vscode settings.json) holds a value of profile work-1 (<YOUR_EMAIL>) and would reach all machines.
Move it to "profile work-1", or put <YOUR_EMAIL> in the file instead.
```

`would reach` names the group in lower case (`all machines`, `linux machines`). The message names the placeholder,
never the value. `export --preview` prints the same lines after the block and exits 1. Each value is searched in the
forms sanitize replaces: as it is, with its backslashes doubled, and for a `json` entry as a JSON string body (`\\`,
`\"`); a `json` entry's text is also searched with every escape read back in one pass (`\n`, `\t`, `\"`, `\\`, `\/`,
`\uXXXX`), so a value right after a `\n` is still a whole token. An `import` entry with no
`importName` is still searched, its hit named by its repo path. The machine's values aren't searched. This is not a
guarantee: a value written another way, or another profile's value, is the [leak scan's](#export-preview) job.

### Statusline

`mksync statusline` replaces `~/.claude/statusline.sh`: Claude Code runs it with its JSON payload on stdin, and it
prints one line on stdout and exits 0, whatever fails. It takes no options or arguments (any is `Unknown option:
<arg>`, exit 1) and prints nothing on stderr. The synced `settings.json` runs `mksync statusline`.

**Payload fields** (missing, `null` or a payload that isn't JSON: empty): `model.display_name`, `workspace.project_dir`,
the directory (`cwd`, else `workspace.current_dir`, else `workspace.project_dir`), `cost.total_cost_usd`,
`context_window.remaining_percentage`, `context_window.used_percentage`, `context_window.total_input_tokens`,
`context_window.context_window_size`, `context_window.current_usage.cache_creation_input_tokens` and
`cache_read_input_tokens` (0 when missing), `output_style.name`, `session_id`.

**Context-window file.** When `session_id` matches `^[A-Za-z0-9_-]+$` and the window size is digits only, the size and a
newline are written to `<CTX_WINDOW_DIR>/<session_id>` (default `~/.claude/state/ctx-window/`, folders created). A
failed write is ignored.

**Sections,** in this order, joined by `ESC[90m|ESC[0m` (a gray bar); each is wrapped in its color and `ESC[0m`, and
left out when empty or when what it reads fails. Colors: gray `ESC[90m`, cyan `ESC[96m`, green `ESC[92m`, yellow
`ESC[93m`, dim yellow `ESC[33m`, red `ESC[91m`, magenta `ESC[95m`, blue `ESC[94m`.

| Section          | Text                                                                                                                                                                                                                                                                                                  | Color                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Time             | local `HH:MM`                                                                                                                                                                                                                                                                                         | gray                                      |
| Model            | the display name                                                                                                                                                                                                                                                                                      | cyan                                      |
| Virtual env      | `.venv` when the project folder has a `.venv` folder and a `pyproject.toml`; else the last part of `VIRTUAL_ENV`; else `conda:<CONDA_DEFAULT_ENV>`                                                                                                                                                    | green                                     |
| Project type     | the first of `pyproject.toml` `Python`, `package.json` `Node.js`, `Cargo.toml` `Rust`, `go.mod` `Go`, a `*.csproj` or `*.sln` `.NET`, in the project folder                                                                                                                                           | blue                                      |
| Directory        | the directory's last part, split on `/` or `\` (one trailing separator dropped)                                                                                                                                                                                                                       | yellow                                    |
| Git branch       | in the directory (or the working folder when there's none): the branch, `*` when `git status --porcelain` lists anything, ` ↑<n>` and ` ↓<n>` against the upstream when not 0, then a space and the last commit's age from `%cr` shortened (`3 hours ago` → `3h`; `y`, `mo`, `w`, `d`, `h`, `m`, `s`) | magenta                                   |
| Git changes      | `(+<ins>,-<del>)` summed over staged and unstaged `--numstat` (binary files skipped) when either is not 0, then `<n>?` for untracked files, space-separated                                                                                                                                           | yellow                                    |
| Cost and context | `Cost: $<cost to 2 places>` (green under 0.5, dim yellow to 2, red above), then ` ESC[90m                                                                                                                                                                                                             | ESC[0m ` when both, then the context part | per part |
| Cached           | `Cached: <tokens>`, cache creation plus cache read, when above 0                                                                                                                                                                                                                                      | cyan                                      |
| Load             | `Load: <1-minute load average>` from `/proc/loadavg`                                                                                                                                                                                                                                                  | cyan                                      |
| Memory           | `Mem: <used>G/<total>G`, one decimal, from `/proc/meminfo` (`MemTotal` minus `MemAvailable`, in GiB)                                                                                                                                                                                                  | cyan                                      |
| Output style     | the style name, unless it's `default`                                                                                                                                                                                                                                                                 | blue                                      |
| Worker mode      | `WORKER` when `~/.claude/state/worker-mode` exists                                                                                                                                                                                                                                                    | green                                     |

- **Context part.** The percent left is `remaining_percentage` rounded, else 100 minus `used_percentage`, rounded.
  Color: green above 60, dim yellow from 30, red below. Text: `Context: <bar> <used>/<size> (<pct>%)` when both token
  counts are there and the size isn't 0, else `Context: <bar> <pct>%`. The bar is `[` plus one `█` per full 10 percent
  left (0 to 10) and `░` for the rest, plus `]`. The part ends with a space, dim yellow `CLEAR` and `ESC[0m`
  (so the part ends with two resets) when the tokens used reach the clear limit: `CONTEXT_CLEAR_AT` (default 200000), or 70% of the window size
  when that's smaller.
- **Token counts:** `1.5k`, `2M`: one decimal over 1000 (`k`) and 1000000 (`M`), a trailing `.0` dropped; below 1000
  the number rounded.
- **Rounding** is C's `printf` on a double, the cost's 2 places included: the value as stored rounds to the nearest,
  and only an exact tie goes to the even digit. `1050` tokens is `1.1k` (1.05 is stored a little above), `1250` is
  `1.2k`, a cost of `0.125` is `0.12`.
- **No section at all:** `Statusline data unavailable`.
- **Windows:** Load and Memory are left out.
- **Test overrides,** as `SYNC_HOSTNAME` is for the scan: `SYNC_NOW` is the time text, `SYNC_LOAD` the load text,
  `SYNC_MEM` the memory as `<used>/<total>`, each in MiB, or in GiB with a `G` (`1280/2048`, `1.2G/2G`), shown as
  the Memory section shows `/proc/meminfo`, and `SYNC_GIT=none` leaves out both git sections.

## macOS

`mksync` runs on macOS as the compiled `mksync-darwin-arm64`; it needs no bash or `jq` of its own. The installer and the
leak scan are bash scripts, so macOS still needs Homebrew. The reasons and the options weighed are in
[macos-research.md](archive/macos-research.md). macOS is tested in CI only (`macos-checks`).

- **Skipped**: dconf entries (`SKIPPED`, as on Windows), the [package drift](#package-drift) report, and
  `bootstrap/linux.sh`.
- **Front door**: the status's OS is the version `sw_vers -productVersion` prints. `doctor` adds a `brew` line after
  `git` (`MISSING brew: install from https://brew.sh`), and its install hints name `brew install …`. `setup` has no
  bootstrap question, and `--bootstrap` stops with `ERROR: --bootstrap is Ubuntu only.`, exit 1, as on Windows.
- **`install.sh`**: without `brew`, it stops with `ERROR: install Homebrew first: https://brew.sh`, exit 1. A missing `jq`
  or Homebrew bash 4.4 gets `Install with Homebrew: brew install bash jq [Y/n]`, never `sudo`. End of input is no, as
  at the apt question: it installs nothing and exits 1. The program download, the `PATH` hint and `mksync setup` work
  as on Linux. It reads `SYNC_OS` as `mksync` does ([Which system](#which-system)).
- **Layout**: `dotfiles/macos/<tool>/` holds macOS-only files. Files shared with Linux live in `dotfiles/common/<tool>/`
  with `"os": ["linux", "macos"]` ([layout.md](layout.md)).

## Known differences

`mksync` keeps a difference between systems only where the system forces one. Each row below is one; every other rule
on this page holds on Linux, macOS and Windows alike. The two old engines' own differences went with them at the
cut-over (tag `two-engines-final`).

| Behavior                                             | Linux                                                  | macOS                                       | Windows                                                          |
| ---------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------- | ---------------------------------------------------------------- |
| Exclude patterns                                     | case-sensitive                                         | case-sensitive                              | case-insensitive: the file system decides                        |
| Shared files without rules ([Compare](#compare))     | byte for byte                                          | byte for byte                               | CRLF folded to LF: Git on Windows may check a file out with CRLF |
| `dotfiles/windows/` text files ([Compare](#compare)) | not synced here                                        | not synced here                             | compared with CRLF folded to LF, written byte for byte           |
| `merge: dconf`                                       | supported                                              | validated, `SKIPPED`                        | validated, `SKIPPED`                                             |
| [Package drift](#package-drift)                      | supported                                              | prints nothing                              | prints nothing                                                   |
| File modes                                           | kept                                                   | kept                                        | not kept: Windows has none                                       |
| `.user-values.json` access                           | mode 600                                               | mode 600                                    | no inherited access                                              |
| `mksync setup`                                       | offers `bootstrap/linux.sh` on Ubuntu; `--bootstrap`   | no bootstrap question; `--bootstrap` errors | no bootstrap question; `--bootstrap` errors                      |
| `mksync doctor`                                      | adds the `drift` line                                  | adds `brew`                                 | `bash` hint names Git for Windows                                |
| `mksync` on `PATH`                                   | `~/.local/bin/mksync`                                  | `~/.local/bin/mksync`                       | `%LOCALAPPDATA%\mksync\mksync.exe`                               |
| Installer                                            | `install.sh`, `curl … \| bash`, `sudo apt-get install` | `install.sh`, `brew install bash jq`        | `install.ps1`, `irm … \| iex`, winget                            |
| Leak scan                                            | `bash` on `PATH`                                       | `bash` on `PATH`                            | needs Git Bash; without it a commit stops                        |
| Commands the program starts                          | any on `PATH`                                          | any on `PATH`                               | `.exe` and `.com` only ([The program](#the-program))             |

Since the cut-over, these rules hold on every system where the old engines differed: import creates a missing target
folder; end of input at the overwrite prompt counts as yes; status lines are `WORD       label`, colored only on a
terminal; sanitized text that isn't valid UTF-8 keeps its bytes; an invalid `defaultEnv` name stops the run; the import
check counts a missing folder as `CREATE`; a value with a default is taken without a prompt; `mksync push` behind
origin stops before the export. Linked folders become `dir` entries ([Linked folders](#linked-folders)), and the
elevated import into another user's profile (`-User`) is gone.
