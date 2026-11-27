# Changelog

Newest first. Each release is a `v<x.y.z>` tag on `master`; update a machine with `mksync update`.

## v1.2.0 (2026-11-27)

- More of the first run is guessed: a value rule's `suggest` takes one source or a list, and the first source that
  answers is the suggestion. New sources, read locally with no network: `origin-owner` (the owner in the clone's
  `github.com` origin), `gh-hosts-login` (`gh config get -h github.com user`), `passwd-name` (the full name of this
  Linux or macOS user) and `gh-path` (`gh` on `PATH`). `sync-config.json` uses them for `<YOUR_GH_OWNER>`,
  `<YOUR_GH_USERNAME>` and `<YOUR_NAME>`.
- `<GH_CLI_PATH>` takes the `gh` found on `PATH` and saves it as a machine value; the fixed default is the fallback.
  It is never asked.
- The first push of a machine with a record suggests an answer for files that offer no `p` (an import, dconf or a
  folder): `[s/r/k] [s]` on `personal`, `[s/r/k] [k]` on a work profile, and Enter takes it. Without a record the
  question is unchanged.
- The public name push suggests is `<profile>-<os>` (`work2-windows`, `personal-linux`) instead of your login.
- A profile value is refused only as a whole token, ended by any character but a letter or digit: `A4` no longer
  refuses `#90a4ae`, but still refuses `team-A4_tools`. The `refused:` line names the change number the block above it
  prints for that change.

## v1.1.10 (2026-11-27)

- The first push of a machine with a record offers `p` for a JSON settings file or a whole-file entry:
  `Send this machine's version (s), keep its differences in profile work2 (p), take the repo's (r) or skip (k)? [p]`.
  `p` keeps the file's differences in the profile layer and leaves the shared file alone; for a JSON file, shared
  settings this machine lacks are added to it (a `.bak` first) and every value it had stays. Push prints
  `PROFILE <file>  (<n> change(s) kept in profile <p>; <m> shared setting(s) added here)`. Enter takes `p` on any
  profile but `personal`, `s` there. While the repo is public the profile stays in local state, so `p` alone opens no
  PR. `--yes` takes each file's suggestion, and its warning names the profile; on a work profile it stops with
  "could not tell which side is newer" when the diff fails, instead of sending everything (`--force` still sends).
- A change keeps its number through moves: after `1` moves to the profile, the next block still calls it `1`, and a
  group lists its changes in number order.
- A push that ends with `Nothing to send.` records the sync point at `HEAD` when no file was skipped, no path was
  picked, the clone is clean and up to date with `origin/master`. A first sync answered with `r` and `p` alone no
  longer asks the whole picker again, and `mksync diff` stops saying `?`.
- `mksync preview`'s summary counts the files waiting for a value:
  `3 file(s) would change; 1 more wait(s) for a value (mksync push asks for it).`
- An interactive `mksync pull` asks for every value this machine uses that nothing fills, as push does, before its
  check and guard, so it no longer stops with "could not tell which side is newer" for a missing value. `--yes`, and
  end of input to a question, keep the stop.
- The check's change block shows a missing value as its placeholder (`<YOUR_GH_OWNER>`) instead of an internal
  marker.

## v1.1.9 (2026-11-26)

- The first push of a machine with no sync point asks about each file that differs, in path order, with its line
  count: `Send this machine's version (s), take the repo's (r) or skip (k)? [s/r/k]`. `r` takes the repo's version
  (keeping a `.bak`), `k` leaves both sides, and with no `s` file push prints `Nothing to send.` and opens no PR. End
  of input skips the rest. `--yes` still sends every file that differs, after its warning.
- Push asks for every value this machine uses, also for files it doesn't send and with picked paths
  (`mksync push <path>`), and asks before it compares the two sides, so a file waiting for a value is no longer passed
  over: a file changed on both sides now stops the push. It saves every value it knows first, so the commit's search
  knows them all. `mksync push --yes` stops with the missing-value line when any of them is unknown, before anything
  is exported or pushed.
- `mksync pull` and `setup` stop with "could not tell which side is newer" when the diff left out a file for a
  missing value, since that file can hold this machine's change. `mksync push` asks the value.
- `mksync preview` and push's commit search every changed file for each value this machine knows (saved, inferred or
  a default) and for its hostname, whatever the file's own rules: `ERROR: a cached value for <PLACEHOLDER> is in
<file>; …` or `ERROR: this machine's hostname is in <file>; …`, with a hint to move the line to
  `~/.gitconfig.machine` or `~/.bashrc.local`. The value is never printed.
- `mksync diff` goes on past a file whose value is missing: it prints
  `SKIPPED <file>  (needs <PLACEHOLDER>: mksync push or pull asks for it)` and exits 3.
- On Windows, a file under `dotfiles/windows/` that differs only in line endings (CRLF against LF) is no change.
- The leak scan allows the bare SSH address of the big Git hosts (`insteadOf = git@github.com:`, also
  `git@gitlab.com`, `git@bitbucket.org`, `git@ssh.dev.azure.com`). Followed by an owner or a path
  (`git@github.com:Org/repo`) it is still a hit, as `git@` at any other host is.

## v1.1.8 (2026-11-26)

- Claude's `settings.json` names the owner of your own repos with its own placeholder, `<YOUR_GH_OWNER>`, apart from
  `<YOUR_GH_USERNAME>`, git's credential account in Windows' `.gitconfig.local`. On a work machine the two can differ.
  Nothing to migrate: push and pull read the owner from the unchanged line in your local file.
- The value question names the files that need the value: `GitHub username (~/.gitconfig.local):`.
- `mksync preview` lists every file when a value is missing. A file waiting for one reads
  `SKIPPED <file>  (needs <PLACEHOLDER>: mksync push asks for it)`, the rest are shown and scanned, and preview exits 1.
  `mksync check`'s note reads `needs <PLACEHOLDER>: mksync push or pull asks for it`.
- `mksync doctor` reads git's own view of its config and warns, without changing its exit code, about
  `~/.config/git/config`, an include mksync doesn't sync, a missing `~/.gitconfig.local`, and on Windows a `gh` on
  `PATH` that isn't the saved `<GH_CLI_PATH>`.
- A rule can suggest its answer: `"suggest": "gh-login"`, `"git-user-name"` or `"git-user-email"` runs
  `gh api user --jq .login` or `git config --global user.name` / `user.email` and shows the result as the question's
  default, `GitHub username (~/.gitconfig.local) [you]:`. Enter takes it, typing replaces it, and `--yes` (push and
  pull), end of input and `preview` never use it; output with a control character is no suggestion. The config check
  refuses any other `suggest`. `<YOUR_GH_USERNAME>`, `<YOUR_NAME>` and `<YOUR_EMAIL>` use them.

## v1.1.7 (2026-11-26)

- A rule's `defaultEnv: "HOME"` is the home folder on every OS. On Windows, which sets no `HOME`, it is `%USERPROFILE%`
  with forward slashes (`C:/Users/you`), the form Git Bash and Claude Code's hook commands read. A Windows machine no
  longer stops at `missing value for <HOME>` (Claude's `settings.json`), and pull no longer asks for it. Other
  variables are read as they are.
- Sanitize also replaces a Windows path value written with the other slash: `C:/Users/you` in its backslash forms
  (`C:\Users\you`, `C:\\Users\\you`), and a saved `C:\Users\you` as `C:/Users/you`. The leak scan's `windows-profile` rule now also finds `C:/Users/…`.
- `mksync push` asks for a value nothing fills (saved, read from this machine's files, `default`, `defaultEnv`), as
  `pull` does, and saves the answer on the profile or the machine record (`.user-values.json` without one). An empty
  answer or end of input stops the run. `--yes`, `preview`, `diff` and `check` never ask.
- A value that holds placeholder text, such as a pasted `<HOME>`, counts as no value: push and pull refuse it as an
  answer, and a saved one is never written into a file.
- On Windows, answers piped from PowerShell no longer read its byte order mark as the first answer.
- The missing-value stop names the way out:
  `missing value for <PLACEHOLDER>: run mksync push or pull in a terminal to enter it`. It replaces
  "add it to profile … or machine …" and "add it to .user-values.json".
- On Windows, `mksync doctor` no longer counts `<HOME>` as unset. With a machine record, its values line reads
  `<n> value(s) not saved yet; mksync push or pull fills them from this machine's files or asks for them`.

## v1.1.6 (2026-11-26)

- `mksync push` and `mksync preview` read each placeholder's value from this machine's own files, as `pull` does, and
  push saves it (on the profile or the machine record). A machine set up with "stop" no longer stops at
  `missing value for <YOUR_NAME>` with nothing to fill it in. Export reads a value only from a line nothing else
  could be taken for: exactly one local line fits the repo line, and every file agrees. A `defaultEnv` that is set,
  such as `HOME`, wins. Anything less certain still stops, so a shifted line can't leave a real value unsanitized.
- Push refuses a profile's value in a shared file also when the value was just read from this machine, not only when
  it was saved before.
- With a machine record, `mksync doctor`'s values line reads
  `<n> value(s) not saved yet; mksync push or pull reads them from this machine's files; pull asks for the rest`; setup no longer asks for
  them there.
- `mksync setup` suggests `3) no` for a linked folder in or under a hidden one, such as `~/.nvm` or `~/.cargo/bin` (`~/.config` aside):
  Enter no longer
  syncs a tool's install folder.

## v1.1.5 (2026-11-26)

- `mksync doctor` on Windows reads `OK bash` when Git Bash is found from `git`, as the leak scan finds it. Before, it
  looked for `bash` on `PATH` only: a machine with just Git's `cmd` folder there was told to install Git, and WSL's
  `bash.exe`, which the scan never runs, counted as found.
- Commands installed as Windows app execution aliases (`winget.exe` in `WindowsApps`) are found on `PATH`, so the
  doctor names `winget install …` where winget is installed.

## v1.1.4 (2026-11-26)

- `mksync push` no longer puts the machine's hostname in the branch name. A machine's record keeps a public name
  (`alias`), asked once on its first push from a terminal: the login is suggested and the hostname is refused. Without
  a terminal and with no public name, push stops before committing and says so.
- The status line shows only the last part of a Windows directory (`C:\…\SyncSettings` → `SyncSettings`).
- Commands (`git`, `gh`, `bash`) are found on `PATH` only. On Windows a `git.exe` in the clone used to run in place of
  git; relative `PATH` folders are now skipped on every OS.

## v1.1.3 (2026-11-25)

- A new key in a JSON file the repo holds in one layer only (Claude's `settings.json`) no longer goes to "All
  machines" by itself on a machine with a record. `mksync push` asks where it goes and suggests the profile, or all
  machines on `personal`; `mksync preview` and `mksync diff` plan that suggestion. A work machine's own Claude
  settings now stay in its local state while the repo is public.
- The leak scan no longer flags a GNOME extension ID in a dconf `.ini` on Windows. A Windows path's drive letter
  (`C:\…`) is read as part of the file name, so hit lines show the right line number there too.
- `mksync setup` asks `Write the record?` after "stop", since nothing is applied.
- `mksync diff` no longer lists a file under an old `<file>.linked/` folder in the repo (the Windows `vs.bat` before
  `MakuCustomAlias` became its own entry): nothing reads or writes those folders any more.

## v1.1.2 (2026-11-25)

- `mksync diff` sees every layer of a JSON file (common, OS, profile and machine), not only the last one. Before, it
  could say `This machine and the repo agree.` when `mksync check` said a pull would drop a new item, and the pull
  guard, setup's "keep mine" and the status line agreed with it. They now stop, or keep the item.
- Such a file still prints one line. A change in the repo and one on this machine in different layers is `BOTH`.
- `--only` accepts the path the diff prints when the file also has a profile or machine layer.
- The `ctx-print-guard` hook is synced for Linux.
- A JSON file whose local version is what the repo already builds, with the change in another layer, no longer prints a
  false `BOTH`.
- `mksync diff` exits 1 for a file it can't plan (invalid JSON, or a new setting on a machine with no record) instead of
  saying both sides agree, so `mksync pull` stops until it's fixed or `--force` is given.
- One run's backups always go into one folder, even when the run crosses a second.
- `mksync push` no longer sends the repo's newer files back to their old version: it leaves `IN` files alone and stops on
  `BOTH`. `mksync push --force` sends `BOTH` files as this machine has them.
- A `BOTH` file that stops a pull or push shows the lines of both sides.
- Pull and push still ask, but Enter is now No (`[y/N]`); `--yes` still applies. A declined push puts the repo folder
  back as it was.
- `mksync diff` also sees the base file of an `import` entry with an OS layer, and a layer the repo gained.
- A commit that has to bring the clone up to date first records no sync point.
- New page: [Pull and push modes](docs/pull-push-modes.md).

## v1.1.1 (2026-11-23)

- "Keep mine" in `mksync setup` no longer undoes the repo's newer files. After a first sync it sends only the files
  changed on this machine (`OUT` and `BOTH`) into the repo folder, then imports, so files changed only in the repo
  still arrive. Before a first sync it still sends everything. With the bootstrap, setup does this before the script,
  whose import step then only imports.
- `mksync setup` with nobody to answer (no terminal, such as Claude Code's `!`) no longer applies: end of input at
  `Write the record and apply? [Y/n]` stops with `Stopped: nothing was written.` An empty answer is still yes, piped
  answers still work, and `--yes` still applies.
- New shared cases prove `mksync pull` stops before overwriting a JSON file that holds an item only this machine has
  (a hook, say). The contract explains why an import drops such an item and that `mksync push` keeps it.

## v1.1.0 (2026-11-23)

- `mksync setup` keeps this machine's changes. It asks every question first, the bootstrap one included, then shows
  the summary and asks `Write the record and apply?`; a no writes nothing.
- Above question 4 a line says how many files the import would overwrite and, after a first sync, which side changed
  them. With `OUT` or `BOTH` files it suggests "keep mine"; "back up and replace" lists them and needs a `[y/N]`
  confirm, and `--yes` refuses, as `mksync pull --yes` does.
- A yes to the bootstrap no longer drops answer 4: setup hands it to `bootstrap/linux.sh`, whose import step backs up
  and replaces, keeps this machine's files (export, then import), or stops, before the links, plugins and preview.
- A pull-only `--yes` refusal no longer suggests `--existing keep`, which pull-only can't use.

## v1.0.2 (2026-11-20)

- Installs and `mksync update` check the program against `SHA256SUMS` only. The attestation check is gone, since
  GitHub makes no attestation for a private repo on the Free plan.
- Both files come from the same release: through a signed-in `gh`, or over HTTPS while the repo is public.
- The docs describe the finished program: finished plans and research moved to `docs/archive/`, the README has a
  "Develop" section, and this changelog starts.

## v1.0.1 (2026-11-20)

- Private-repo prep: the installers and `mksync update` work through `gh`, so they keep working once the repo is
  private.

## v1.0.0 (2026-11-20)

- One engine: `mksync`, the TypeScript program, is the only engine. The bash and PowerShell engines are deleted.
- `sync-config.json` is config v2; a v1 config stops with exit 2.
- The Claude layout is live, and a fresh Ubuntu bootstrap runs the installed program.
- Update from `v0.9.0` with `mksync update`.

## v0.9.0 (2026-11-18)

- Cut-over part 1: the config is read by `schemaVersion`, and the layout's personal keys are in place.
