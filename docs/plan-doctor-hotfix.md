# Doctor hotfix: Git Bash and winget on Windows (`v1.1.5`)

Found 2026-11-26 on work #2 (`docs/plan-work-machines.md`, step 8), on `v1.1.4`. `mksync doctor` reads
`WARN bash: needed by the leak scan; install Git for Windows from https://git-scm.com` on a machine where the leak scan
would run fine and winget is installed. The plan's rule ("A bug stops the plan") holds `docs/plan-work-machines.md` at
step 9 until this is on work #2: a `git pull` in its clone, since it runs from the clone. Contract:
`docs/sync-contract.md` ("Front door", `doctor`). Branch `engine/doctor-hotfix`, cut from `engine/work-2`, so its one PR
also carries step 8's docs commit; then release `v1.1.5` for the machines that run the downloaded program.

## The bugs

1. **The doctor and the leak scan look for different `bash`es.** The doctor checks a bare `bash` on `PATH`
   (`src/app/doctor.ts`, `bash: onPath("bash")`). On Windows the leak scan runs Git's own `bash.exe`, found from `git`
   (`findBash`, `src/adapters/leakscan.ts`), because a bare `bash` can be WSL's launcher. Git for Windows' default
   install puts only `Git\cmd` on `PATH`, so work #2 (no WSL) gets `WARN` while a push scans fine; work #1 reads `OK`
   only because WSL's `System32\bash.exe` is on `PATH`, which the leak scan never runs. The VM has the same `PATH` as
   work #2 (`C:\Tools\git\cmd` only).
2. **`which` misses app execution aliases.** `winget.exe` in `%LOCALAPPDATA%\Microsoft\WindowsApps` is a 0-byte
   reparse point. `which` (`src/adapters/process.ts`) takes a candidate only when `statSync(…).isFile()`. Checked in the
   VM on 2026-11-26 with a Bun-compiled probe: `statSync` throws `EACCES`, `lstatSync` reports a symbolic link
   (`isFile` false), `accessSync(X_OK)` passes, and spawning it prints winget's version. So the doctor never finds
   winget and gives the git-scm.com hint. Node (the clone launcher on work machines) is not in the VM; work #2 checks
   it.

## Decided (proposed, for review)

1. **One home for "is there a bash for the scan".** `src/adapters/leakscan.ts` exports a pure
   `hasScanBash(platform, gitPath, exists, onPath)`: on `win32`, `findBash(platform, gitPath, exists) !== undefined`;
   elsewhere `onPath("bash")`. The doctor's `bash` fact calls it with `process.platform`, `which("git")`, `existsSync`
   and its `onPath`. Off Windows nothing changes. The doctor's lines and their wording don't change.
2. **An app execution alias counts as a command on Windows.** A candidate is a command when `statSync` says it is a
   file; a folder never is; on Windows only, when `statSync` throws or reports neither a file nor a folder, `lstatSync`
   reporting a symbolic link counts too (the alias `stat` can't follow). `accessSync(X_OK)` still applies, and
   `isSpawnable` (the `.exe`/`.cmd`/… suffix) is unchanged. Off Windows a dangling symlink stays not found. This applies
   to every bare-name lookup (`run`, `runSync`, `which`), so a Store alias such as `python.exe` is now found too; the
   program runs none of those.
3. **Not in this hotfix.** "The working folder after install" (design, "Open") changes where every command finds the
   repo: it stays open for its own decision.

## Step 1: `which` takes an app execution alias `[worker]`

Files: `src/adapters/process.ts`, `src/adapters/process.test.ts`.

- Add an exported pure `isCommandEntry(followed, linked, windows)` where `followed` and `linked` are
  `{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean } | undefined` (the `statSync` and
  `lstatSync` results, `undefined` when they throw). It returns `true` when `followed?.isFile()`; `false` when
  `followed?.isDirectory()`; otherwise `windows && linked?.isSymbolicLink() === true`.
- `isFile(file)` calls `statSync`, and `lstatSync` only when the first says neither file nor folder (or throws) and
  `IS_WINDOWS`, then returns `isCommandEntry(…, IS_WINDOWS)`. Each `catch` keeps its one-line reason comment.
- Unit cases for `isCommandEntry`, each with its result: a file, Linux → `true`; a file, Windows → `true`; a folder,
  Windows, with a link `lstat` → `false`; `stat` throws and `lstat` is a link, Windows → `true`; the same on Linux →
  `false`; both throw, Windows → `false`; `stat` returns a link (neither file nor folder) and `lstat` is a link,
  Windows → `true`; `stat` throws and `lstat` is a plain file (not a link), Windows → `false`.

Test: `bun test src/adapters/process.test.ts` and `bun run lint`.

## Step 2: The doctor asks the leak scan's bash `[worker]`

Files: `src/adapters/leakscan.ts`, `src/adapters/leakscan.test.ts`, `src/app/doctor.ts`, `docs/sync-contract.md`.

- `leakscan.ts`: export `hasScanBash(platform, gitPath, exists, onPath)` as decision 1 says, next to `findBash`, with a
  TSDoc line naming the doctor as its caller.
- `doctor.ts`: `bash: hasScanBash(process.platform, which("git"), existsSync, onPath)`.
- Unit cases for `hasScanBash`, each with its result: `win32`, git `C:\Git\cmd\git.exe`, `C:\Git\bin\bash.exe` exists
  → `true`, and `onPath` is never called; `win32`, git under `C:\Git\mingw64\bin\git.exe` with `C:\Git\bin\bash.exe`
  → `true`; `win32`, no git → `false`; `win32`, git found but no `bin\bash.exe` → `false`, even when `onPath("bash")`
  would say `true` (WSL's launcher); `linux`, `onPath` `true` → `true`; `linux`, `onPath` `false` → `false`.
- Contract, `doctor`'s `bash` item: on Windows the line is `OK` when Git's own `bash.exe` is found from `git`, as the
  leak scan finds it, and a `bash` elsewhere on `PATH` (WSL's) doesn't count.

Test: `bun test src/adapters/leakscan.test.ts src/core/front/doctor.test.ts`, `bun run lint`, and
`tests/parity/run.sh doctor` (no Linux output changes).

## Step 3: The Windows check `[inline: the VM run and its reading need judgment]`

Files: `tests/windows-vm/lookup-check.ps1`, `tests/windows-vm/README.md`.

- Check 4: `mksync doctor` in the throwaway clone, with the VM's own `PATH` (`C:\Tools\git\cmd`, no `bin`): the output
  has `OK       bash`.
- Check 5, when `Get-Command winget` finds it: `doctor` with `PATH` set to `System32` and the `WindowsApps` folder
  only (no git) prints `install with winget install --id Git.Git -e` and not `git-scm.com`. Skipped, with a line
  saying so, when the VM has no winget.
- README: the two checks in the `lookup-check.ps1` description.

Test: `tests/windows-vm/vm.sh run` with `lookup-check.ps1` passes, check 4 fails with step 2 reverted and check 5 with
step 1 reverted (both locally, not committed).

## Step 4: Docs, PR and release `v1.1.5` `[inline: release run and its verification need judgment]`

Files: `package.json`, `CHANGELOG.md`, the program's version (`rtk grep -rn '1\.1\.4' src package.json`),
`docs/design-layers.md`, `docs/plan-work-machines.md`, `docs/windows-cutover-run.md`.

- Design "Open": "The doctor's bash and winget lookups" marked done for `v1.1.5`, with the decisions; "Confirm on
  Windows", the leak-scan `bash` item, notes the doctor now agrees.
- `docs/plan-work-machines.md`: step 9 starts with `git -C %USERPROFILE%\SyncSettings pull` and `mksync doctor` on
  work #2 (expects `OK       bash`, the version `1.1.5`); steps 10 to 12 expect `1.1.5`.
- Bump to `1.1.5`; a changelog entry naming bugs 1 and 2.
- `tests/all.sh` (with the VM layer), `leak-scan`, review (`ts-code-reviewer`), push, PR, `reviewed` label,
  `pr-ready`, merge.
- Tag `v1.1.5` and release as `v1.1.4` was, after the user's OK; check `SHA256SUMS` and `mksync --version`;
  `mksync update` on this machine.

Test: `npx prettier --check docs/*.md`, the release checks above, and `mksync --version` prints `1.1.5` here.
