# Changelog

Newest first. Each release is a `v<x.y.z>` tag on `master`; update a machine with `mksync update`.

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
