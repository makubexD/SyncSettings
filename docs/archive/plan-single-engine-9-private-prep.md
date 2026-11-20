# One engine, phase 9 follow-up: ready for a private repo

Roadmap: `docs/plan-single-engine.md`, between phase 9 (done, `v1.0.0`) and phase 10 (private repo, the final step).
Design: `docs/design-layers.md` ("Open": "Lines that name the deleted engine", "Setup's bootstrap edges", "Installing
from a private repo"; "Release and update"). Contract: `docs/sync-contract.md`. Goal: everything a private repo needs
works while the repo is still public, released as `v1.0.1`, so phase 10 only flips the visibility.

## Shared rules

- **One branch,** `engine/private-prep`, one PR in the finish. Step 8 bumps the version on the branch. After the
  finish merges the PR, Claude tags `v1.0.1` on `master` (the user's GO for this plan covers it, 2026-11-20), watches
  the release workflow, checks the Linux asset (`SHA256SUMS`, `gh attestation verify`, `--version`), and runs
  `mksync update` from a real `v1.0.0` program in a temp home twice: with the signed-in `gh` on `PATH` (read-only
  commands only) and with no `gh` on `PATH`. The results go in the project memory and the reply.
- **Contract first** (CLAUDE.md rule 2): step 1 writes the contract and the shared cases before any code.
- **Public repo.** Fixtures use `example.com`, `/home/user`, `C:\Users\user`, profile `work-1`, machine
  `wk1-laptop`. `leak-scan` stays green.
- **Never the real machine or the real GitHub.** `gh` is always a stub (`GH=` in the installers, a stub on `PATH` for
  the program). Nothing in a test may reach `github.com`.
- Each worker step: about 3 files, one concern. Test commands run that step's tests only; `tests/all.sh` runs once,
  in the finish.
- Shared-case test command: `bun run build && tests/parity/run.sh --engine dist/mksync <filter>`.

## Decided

1. **Private installs go through `gh`** (the user, 2026-11-20). The install line becomes "install `gh`, `gh auth
login`, then `gh api` fetches the installer", which works on a public and a private repo alike, so it ships now.
   No public releases-only repo.
2. **Release downloads use `gh` when it is signed in,** in the installers and in `mksync update`: `gh release view`
   for the latest tag, `gh release download` for the asset and `SHA256SUMS`. Without a signed-in `gh` they keep the
   plain HTTPS download (it works while the repo is public). `SYNCSETTINGS_RELEASE_URL` / `MKSYNC_RELEASE_URL` with a
   `file://` base keep the HTTPS-free test path unchanged.
3. **The installer's clone authenticates through `gh`** when it is signed in:
   `git -c 'credential.https://github.com.helper=' -c 'credential.https://github.com.helper=!gh auth git-credential'
clone …`, set for that one command only. Nothing is written to `~/.gitconfig` (a synced file). After the first
   pull, Linux and macOS get the same helper from the synced `.gitconfig.local`; Windows uses Git Credential Manager.
4. **New lines.** `mksync status`: `not checked: run mksync check to see why` and `the machine check failed; run mksync
check to see why.` The export summary: `If this is a new machine, run  mksync setup  first to apply the repo
settings.` `mksync commit` off `master`: `ERROR: run mksync commit from master (current: <branch>).`
5. **`setup --bootstrap` on Windows** stops like macOS: `ERROR: --bootstrap is Ubuntu only.`, exit 1, before the
   doctor. Same line and code as macOS, rather than the "unknown option, exit 2" the design guessed.
6. **The run sheet** (`docs/windows-cutover-run.md`) gains the five "Confirm on Windows" checks and the `gh` install
   line, so work #2 and #3 settle them when the user is at them. They don't block phase 10.

## Step 1: Contract and shared cases for the new lines `[inline: contract text and expect/ written from it]`

Files: `docs/sync-contract.md`, `tests/parity/cases/export-local-missing/expect/lines.txt` (new),
`tests/parity/cases/setup-windows-bootstrap-flag/` (new).

- Contract: decision 4's four lines where `status`, the export summary and `mksync commit` are described; decision 5
  in the `mksync setup` row (line ~700), "Bootstrap" (~1226), the macOS notes (~1598) and the OS table (~1620): Windows
  has no bootstrap question and `--bootstrap` errors, as on macOS. The bootstrap edge the design left "to confirm"
  goes in as is: the question comes after the record and profile are written, and the `stop` answer skips it.
- `export-local-missing/expect/lines.txt`: `Note: 1 file(s) skipped because they do not exist locally.` then
  `If this is a new machine, run  mksync setup  first to apply the repo settings.`
- `setup-windows-bootstrap-flag`: `os: ["windows"]`, the model is `front-macos-bootstrap-flag` (same config, `gh`
  stub, `setup` with `bootstrap: true` and `stderr: true`); `expect/output.txt` `ERROR: --bootstrap is Ubuntu only.`,
  `expect/exit` `1`.
- The status lines and the commit line have no shared case (a check failure and a non-`master` branch can't be set up
  by the runner); step 2's unit tests hold them.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync export-local-missing` fails on the new line;
`npx prettier --check docs/sync-contract.md`.

## Step 2: The program's lines name mksync `[worker]`

Files: `src/core/front/status.ts`, `src/core/plan/run.ts`, `src/app/commit.ts`, and their tests
(`src/core/front/status.test.ts`, `src/app/commit.test.ts`; `src/core/plan/run.ts`'s line through
`src/core/plan/export.test.ts` if no run test exists).

Decision 4's lines replace `run ./import.sh --check to see why` (both in `status.ts`), `run  ./import.sh  first` (in
`run.ts`) and `run commit.sh from master` (the `NOT_MASTER_PREFIX` in `commit.ts`). Comments that cite the old
scripts as history stay. Unit tests assert each new line; no test may still expect an old one.

Test: `bun test src/core/front src/core/plan src/app/commit.test.ts && bun run build && tests/parity/run.sh --engine
dist/mksync export-local-missing`.

## Step 3: `--bootstrap` refused on Windows `[worker]`

Files: `src/app/setup.ts`, `src/app/setup.test.ts`.

The check before the doctor that refuses `--bootstrap` on `macos` also refuses it on `windows`, with the same
`BOOTSTRAP_ONLY_MACOS` line (rename the constant to `BOOTSTRAP_ONLY_UBUNTU`) and exit 1. Unit test: `executeSetup`
on `windows` with `bootstrap: true` returns code 1 and that line, before anything is printed. If `executeSetup` is too
heavy to call in a unit test, export the guard as `bootstrapRefusal(os, command): Result | undefined` and test that
for `windows`, `macos` (refused) and `linux` (undefined).

Test: `bun test src/app/setup.test.ts && bun run lint`. The Windows shared case runs in the finish (VM layer).

## Step 4: `mksync update` downloads through gh `[worker:high: reasoning: the release adapter's Result types, the gh adapter's timeout rules and the update flow's error lines must line up, and the spec can't list them without reading three modules]`

Files: `src/adapters/release.ts`, `src/adapters/release.test.ts` (new if missing), `src/app/update.ts`.

Decision 2 for the program. When the release base is the default GitHub URL (not `MKSYNC_RELEASE_URL`) and
`gh auth status` exits 0: `latestTag` runs `gh release view --repo makubexD/SyncSettings --json tagName -q .tagName`,
and `download` runs `gh release download <tag> --repo makubexD/SyncSettings -p <asset> -D <dir> --clobber` and reads
the file. Use the existing process adapter with the same time limit the gh adapter uses (`src/adapters/gh.ts`); `GH`
names another binary, as in `commit.ts`. A gh failure keeps today's error lines (`ERROR: cannot get the mksync release:
<reason>.`), with gh's first stderr line as the reason. No signed-in gh: today's `fetch` path, unchanged. Tests: a gh
stub (a temp script) for "signed in, view and download work", "signed in, download fails → the error line", "not
signed in → fetch path is used (a `file://` base proves it)".

Test: `bun test src/adapters/release.test.ts src/app/update.test.ts && bun run lint`.

## Step 5: install.sh clones and downloads through gh `[worker]`

Files: `install.sh`, `tests/linux/install.sh`.

Decisions 2 and 3 in bash. When `"${GH:-gh}" auth status` exits 0: the clone gets the two `-c` options of decision 3
(with `${GH:-gh}` in the helper), the latest tag comes from `gh release view …`, and the asset and `SHA256SUMS` from
`gh release download <tag> --repo makubexD/SyncSettings -p <asset> -p SHA256SUMS -D "$tmp"`; the checksum and
attestation checks stay. `SYNCSETTINGS_RELEASE_URL` set: today's curl path, unchanged. New cases in
`tests/linux/install.sh`, with the existing gh stub extended to log its arguments and serve `release view` and
`release download` from a fixture folder: "gh signed in → no curl to github.com, gh release download called with the
asset and SHA256SUMS", "gh signed in → clone carries the credential helper", "gh not signed in → curl path as before".
The stub must not let a test reach the network.

Test: `tests/linux/install.sh && shellcheck -x install.sh tests/linux/install.sh`.

## Step 6: install.ps1 clones and downloads through gh `[worker]`

Files: `install.ps1`, `tests/windows-vm/install-check.ps1`.

Step 5 in PowerShell 5.1 (no `??`, no ternary): when `gh auth status` exits 0 (the existing `Invoke-Gh` helper),
`git -c … clone` with decision 3's helper, `gh release view` for the tag and `gh release download` for the asset and
`SHA256SUMS`. `SYNCSETTINGS_RELEASE_URL` set: today's `Invoke-WebRequest` path. `install-check.ps1` gains the same
three cases with a `gh.cmd` stub on `PATH`.

Test: `tests/windows-vm/vm.sh run 'powershell -NoProfile -ExecutionPolicy Bypass -File
tests/windows-vm/install-check.ps1'` (skipped with a line when the VM is down; then CI's `program-windows` covers it)
and PSScriptAnalyzer on `install.ps1` as CI runs it.

## Step 7: The gh install lines and the run sheet `[inline: user-facing instructions]`

Files: `README.md`, `docs/daily-workflow.md`, `docs/windows-cutover-run.md`.

- README and the daily workflow: the install lines of decision 1. Linux: install `gh` (`sudo apt-get install gh`),
  `gh auth login`, then `gh api -H 'Accept: application/vnd.github.raw' repos/makubexD/SyncSettings/contents/install.sh
| bash`. macOS: `brew install gh`, the same. Windows: `winget install --id GitHub.cli -e`, a new terminal,
  `gh auth login`, then `gh api -H 'Accept: application/vnd.github.raw'
repos/makubexD/SyncSettings/contents/install.ps1 | Out-String | iex`. The `--runtime node` variants the same way.
  Say why: the repo goes private, and these lines work before and after.
- The run sheet (decision 6): the `gh` install line, and one item per "Confirm on Windows" check (unset `USERPROFILE`,
  the values file's access rules, command lookup in the repo folder, WSL's `bash` before Git Bash, the OS caption's
  code page), each with the command to run and what to paste back, in the sheet's answer block.

Test: `npx prettier --check README.md docs/daily-workflow.md docs/windows-cutover-run.md && scripts/ci/leak-scan.sh`.

## Step 8: Version 1.0.1 `[inline: tiny edit, one line]`

Files: `package.json`.

`"version": "1.0.1"`. The tag and the release follow the merge (Shared rules).

Test: `bun run build && dist/mksync --version` prints `mksync 1.0.1`.

## Step 9: Docs `[inline: user-facing docs need judgment]`

Files: `docs/design-layers.md`, `docs/plan-single-engine.md`, `docs/sync-contract.md` (if steps 4 to 6 changed a
visible line), `docs/configuration.md` or `docs/layout.md` only if they name the install line.

- Design: "Installing from a private repo" moves from "Open" to "Release and update" as decided (decisions 1 to 3);
  "Lines that name the deleted engine" and "Setup's bootstrap edges" are closed with the plan step that settled them;
  the "Confirm on Windows" entries say they are on the run sheet for work #2 and #3.
- Roadmap: phase 10's first bullet notes that installs and updates already work on a private repo (this plan), so the
  phase starts with the visibility switch. This plan is recorded under phase 9 as done.

Test: `npx prettier --check docs/design-layers.md docs/plan-single-engine.md && scripts/ci/leak-scan.sh`.
