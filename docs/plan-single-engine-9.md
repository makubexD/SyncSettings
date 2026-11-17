# One engine, phase 9: ready for cut-over

Roadmap: `docs/plan-single-engine.md`, phase 9. Design: `docs/design-layers.md` ("Release and update", "Open").
Contract: `docs/sync-contract.md`. Goal: everything the cut-over needs that can be built and tested on this Linux
machine (and the local VM) before the old engines go: the program runs on Bun or Node from the clone, a release
workflow, `mksync update`, installers that download the program, `setup` with doctor and the bootstrap question, and
the "before cut-over" fixes left in the design. The cut-over itself (tag a release, the real-Windows checklist, the
Claude layout, deleting the old engines) touches the live repo and the real machines; it is a second plan,
`docs/plan-single-engine-9-cutover.md`, written when this one finishes ("After this plan").

## Shared rules

- Branch `engine/cutover-prep`, one commit per step, one PR at the end. The PR adds a workflow
  (`.github/workflows/release.yml`), so it waits for the user's `reviewed` label (CLAUDE.md, "Claude auto-approval").
- **Old engines frozen.** No change to `export.sh`, `import.sh`, `commit.sh`, `sync`, `sync.cmd`, `scripts/linux/`,
  `scripts/windows/`, `sync-config.json`, `tests/linux/engine.sh`, `tests/windows/`. A shared case whose expected
  result changes here for the program only gets `oldEngines: ["none"]` (the runners skip the old engines for it) and
  a description line saying which decision changed it.
- **Contract first** (CLAUDE.md rule 2). A rule visible in exit codes, status lines or files gets its shared case and
  contract text in the same step, before the code; `expect/` is written from the contract.
- **Public repo.** Fixtures use `example.com`, `/home/user`, `C:\Users\user`, profiles `work-1` and `personal`,
  machines `wk1-laptop` and `home-linux`. Release fixtures use `v0.0.1` and fake programs (`echo` scripts), never a
  real download. `leak-scan` stays green.
- **No network in tests.** Downloads go through one base URL (`MKSYNC_RELEASE_URL` in the program,
  `SYNCSETTINGS_RELEASE_URL` in the installers) that tests point at a local folder (`file://`) or a local server
  started by the test. Nothing reaches `github.com`, `sudo`, `apt-get` or the real home.
- **Layout.** `src/core/` stays pure; new I/O goes in `src/adapters/`, flows in `src/app/`, parsing in `src/cli/`.
  Tests sit next to their file. No new dependencies.
- Each worker step: about 3 files (a shared case folder counts as one), one concern. Test commands run that step's
  cases and tests only; `tests/all.sh` runs once, in the finish.
- Shared-case test command, used by the steps below with their `<filter>`:
  `bun run build && tests/parity/run.sh --engine dist/mksync <filter>`.

## Decisions to confirm in review

Proposals with a recommendation each; the review of this plan confirms or changes them before `/next`. Step 1
writes them into the design and the contract.

1. **Node runs the source, not a build.** Node 22.18 and newer strip TypeScript types without a flag, and work #1 has
   Node 26.13. The source already imports with `.ts` extensions; the only blocker today is one parameter property
   (`src/core/json/value.ts:81`) plus the 19 `Bun.*` calls. So: `erasableSyntaxOnly` in `tsconfig.json`, every
   `Bun.*` call behind one process adapter on `node:child_process`, and `node src/main.ts` runs the program from the
   clone with no build and no `npm install`. No `dist/mksync.mjs`. Required: Node 22.18. Bun from the clone runs
   `bun src/main.ts`; the oldest Bun to accept (work #1 has 1.3.14, the repo pins 1.4.4) is checked on the real
   machine in the cut-over plan.
2. **Launchers.** `mksync` (sh) and `mksync.cmd` at the repo root run `bun src/main.ts` or `node src/main.ts` with the
   arguments. `MKSYNC_RUNTIME=bun|node` picks one; unset, the first installed of Bun then Node. Neither installed:
   `ERROR: mksync needs Bun or Node 22.18 or newer to run from the clone.`, exit 2. Node older than 22.18: the same
   line, exit 2.
3. **Installers download the program; the clone stays.** The program finds its config in the clone, so the
   installers still clone (or fast-forward) the repo, then download the program for the OS and CPU from the latest
   release, check its SHA256 against `SHA256SUMS`, run `gh attestation verify` when `gh auth status` succeeds, and
   install it as `~/.local/bin/mksync` (`%LOCALAPPDATA%\mksync\mksync.exe` on Windows, on the user `Path`).
   `--runtime bun|node` (`-Runtime` on Windows) skips the download and links the clone's launcher instead: the
   run-from-clone fallback for a machine that blocks the program. A failed checksum stops with
   `ERROR: mksync-<os>-<arch> does not match SHA256SUMS.`, exit 1, and installs nothing.
4. **Releases.** A tag `v<x.y.z>` that equals `package.json`'s `version` makes a release with the four programs,
   `SHA256SUMS` and a provenance attestation; a tag that doesn't match fails the workflow. The first release is
   `v0.9.0`, tagged by the user at the start of the cut-over plan (a publish, so it is the user's GO); `v1.0.0` follows
   the deletion of the old engines.
5. **`mksync update`.** Downloads the latest release the same way as the installers (SHA256 always, attestation when
   `gh` is signed in), and replaces itself only when the release is newer than `mksync --version`: `mksync is up to
date (v<x.y.z>).`, exit 0, otherwise `mksync updated: v<old> -> v<new>.`, exit 0. A failed download or check
   changes nothing, exit 1. On Windows the running program renames itself `mksync.old.exe` first, and every start
   deletes a leftover `mksync.old.exe` next to it. Run from the clone (a launcher), it refuses:
   `ERROR: mksync runs from the clone here: update it with git pull.`, exit 2. No `--check` flag (YAGNI).
6. **`schemaVersion` newer than the program's.** A config with a `schemaVersion` above 2 stops with
   `ERROR: sync-config.v2.json: this config needs a newer mksync: run mksync update.`, exit 2, before anything else is
   read. Below 2, or not a number, keeps `unsupported config schemaVersion <n>`. `mksync pull` that fast-forwards to
   such a config prints the same line after the pull, exit 2, and writes nothing.
7. **Usage errors exit 2.** An unknown option, clashing flags, a repeated flag and an unknown verb in a group exit 2,
   as a missing command does (the `cli` skill's contract; design "Open", "Exit code for usage errors"). The program
   only; the cases that pin exit 1 today get `oldEngines: ["none"]`.
8. **Typed answers.** Every typed answer (values, setup, the overwrite and move questions) is trimmed of spaces, tabs
   and `\r` at both ends, as bash `read -r` does plus the `\r` a Windows terminal leaves. An answer that is only
   spaces counts as empty.
9. **Overwrite prompt on a terminal.** Import asks `Overwrite <file>? [Y/n]` per file as it reaches it, reading one
   line at a time, so a terminal user sees each question before answering. Piped answers keep working unchanged (the
   shared cases).
10. **Links and atomic writes.** Every write of a state file (`.user-values.json`, the sync point, profiles,
    machine records, `machine.json`) and of a repo file goes to a temp file in the same folder (0600 for state) and a
    rename; a state or repo path that is a symlink is refused with `ERROR: <path> is a symlink.`, exit 1. Home files
    keep following links (people link their dotfiles); a link inside a `dir` entry's folder is skipped with
    `SKIPPED <path> (symlink)`.
11. **Config paths checked on read.** `parseV2` refuses an entry `file` that is empty, absolute, holds `..` or `\`,
    with `ERROR: sync-config.v2.json: entry <file> has an unsafe path.`, exit 1, and an `import` entry without
    `{layer}` in `importName` with `ERROR: sync-config.v2.json: entry <file> needs {layer} in importName.`, exit 1.
12. **The front door's commands.** `export`, `import` and `commit` stay (the shared cases drive them) but leave the
    usage line; `update` joins it. `shadow` stays hidden until the deletion, then goes with the old engines.
13. **No ESLint.** `tsc --noEmit` under `strict` plus `erasableSyntaxOnly` stays the lint; ESLint waits until a rule
    it adds is needed (YAGNI, no new dependency).

## Step 1: Decisions into the design and the contract `[inline: records the plan review's decisions]`

Files: `docs/design-layers.md`, `docs/sync-contract.md`.

- Design: a section "Decided in phase 9" with decisions 1 to 13 as confirmed in review, one bullet each. In "Open",
  mark settled (with "Settled in phase 9, decision <n>") the items "Run from the clone on Bun or Node", "Exit code for
  usage errors", "Typed answers and `read -r`", "Atomic profile and record writes", "Overwrite prompt on a terminal",
  the "Security review, phase 4" items covered by decisions 10 and 11, "`mksync export` and `mksync import`" and
  "ESLint".
- Contract: under "Front door", the usage line of decision 12 and the exit-2 rule of decision 7, marked "(program;
  the old engines exit 1)".

Test: `bun tools/check-config.ts && npx prettier --check docs/design-layers.md docs/sync-contract.md`.

## Step 2: Erasable syntax only `[worker:low]`

Files: `tsconfig.json`, `src/core/json/value.ts`.

- `tsconfig.json`: add `"erasableSyntaxOnly": true` to `compilerOptions`.
- `value.ts`: replace the parameter property `constructor(private readonly text: string) {}` with a declared
  `private readonly text: string;` field assigned in the constructor. No other change.

Test: `bun run lint && bun test src/core/json`.

## Step 3: The process adapter `[worker]`

Files: `src/adapters/process.ts`, `src/adapters/process.test.ts`.

Built on `node:child_process` and `node:fs` only (no `Bun.*`), so it runs under Bun and Node. Exports:

- `run(argv, options)`: async; options `cwd`, `env`, `input` (a string fed to stdin, else stdin ignored),
  `timeoutMs`. Resolves `{ code, stdout, stderr }` (strings, UTF-8); a missing command resolves `{ code: 127,
missing: true }` instead of throwing; a timeout kills the process and resolves `{ code: 124, timedOut: true }`.
- `runSync(argv, options)`: the same contract, synchronous (`spawnSync`).
- `which(name)`: the full path of the first match on `PATH` (on Windows also trying each `PATHEXT` suffix), or
  `null`.
- `readAllStdin()`: the whole of stdin as a string.
- `stdinLines()`: an async iterator of lines from stdin, without their line end, ending at EOF; reading one line
  doesn't consume the next (for the per-file prompt of step 12).

Tests (each against real small commands: `sh -c`, `printf`):

- `run(["sh", "-c", "printf out; printf err >&2; exit 3"])` → code 3, stdout `out`, stderr `err`.
- `input: "a\nb\n"` with `cat` → stdout `a\nb\n`.
- a command that doesn't exist → `missing: true`, code 127, no throw.
- `timeoutMs: 100` on `sleep 5` → `timedOut: true` within 2 s.
- `runSync` gives the same results for the first three.
- `which("sh")` is an absolute path; `which("no-such-cmd-xyz")` is `null`.

Test: `bun test src/adapters/process.test.ts`.

## Step 4: git, gh and visibility on the process adapter `[worker]`

Files: `src/adapters/git.ts`, `src/adapters/gh.ts`, `src/adapters/visibility.ts`.

Replace each `Bun.spawn` with `run` from `./process.ts`, keeping every existing behavior: the environment passed,
`stdin: "ignore"`, the 5 s `gh` limit (as `timeoutMs`), and the existing results on a missing command. No change to
any exported signature.

Test: `bun run lint && bun test src/adapters/git src/adapters/gh src/adapters/visibility && bun run build &&
tests/parity/run.sh --engine dist/mksync push-`.

## Step 5: dconf, osname, packages and statusline on the process adapter `[worker]`

Files: `src/adapters/dconf.ts`, `src/adapters/osname.ts`, `src/adapters/packages.ts`, `src/adapters/statusline.ts`.

As step 4, with `run` or `runSync` matching the `Bun.spawn` or `Bun.spawnSync` it replaces. `dconf.ts`'s `input`
becomes the `input` option. Four files: each change is a one-call swap.

Test: `bun run lint && bun test src/adapters/dconf src/adapters/osname src/adapters/packages
src/adapters/statusline && bun run build && tests/parity/run.sh --engine dist/mksync dconf-`.

## Step 6: scan, leak scan and the app flows on the process adapter `[worker]`

Files: `src/adapters/scan.ts`, `src/adapters/leakscan.ts`, `src/app/commit.ts`, `src/app/doctor.ts`,
`src/app/status.ts`.

As step 4; `Bun.which` becomes `which`. Five files: each change is a one- or two-call swap.

Test: `bun run lint && bun test src/adapters/scan src/adapters/leakscan src/app && bun run build &&
tests/parity/run.sh --engine dist/mksync status-`.

## Step 7: stdin and the last runners `[worker]`

Files: `src/main.ts`, `src/app/import.ts`, `src/adapters/engine.ts`, `src/adapters/acl.ts`.

- `main.ts` (`statusline`) and `app/import.ts`: `Bun.stdin.text()` becomes `readAllStdin()`.
- `engine.ts` and `acl.ts` use `run`/`runSync` from `./process.ts` instead of their own `node:child_process` calls
  (design "Open", "Boundaries review": shadow's runner duplicating git's).
- After this step `grep -rn "Bun\." src --include=*.ts | grep -v "\.test\.ts"` prints nothing.

Test: `bun run lint && bun test src && test -z "$(grep -rn 'Bun\.' src --include=*.ts | grep -v '\.test\.ts')"`.

## Step 8: The launchers `[worker]`

Files: `mksync`, `mksync.cmd`, `tests/linux/launcher.sh`.

Decision 2. `mksync` (POSIX sh, executable) and `mksync.cmd` resolve their own folder, pick the runtime and `exec`
it on `<folder>/src/main.ts` with every argument, passing the exit code through. Node's version comes from
`node -p process.versions.node`, compared as numbers.

`tests/linux/launcher.sh` (on PATH stubs named `bun` and `node` that print their arguments):

- `MKSYNC_RUNTIME=node`, both stubs → runs `node <repo>/src/main.ts status --x`.
- `MKSYNC_RUNTIME=bun` → `bun <repo>/src/main.ts …`.
- unset, both present → bun; only node (22.18.0) → node.
- only node 22.17.1 → the decision 2 line, exit 2.
- neither → the decision 2 line, exit 2.
- `MKSYNC_RUNTIME=deno` → `ERROR: MKSYNC_RUNTIME must be bun or node.`, exit 2.
- the exit code of the runtime (stub exits 3) comes back as 3.

Test: `tests/linux/launcher.sh`.

## Step 9: Shared cases on Node and Bun from the clone `[worker:low]`

Files: `tests/parity/run.sh`, `tests/parity/README.md`, `tests/all.sh`.

- `run.sh --engine ./mksync` already runs a program path; check that the launcher works there with
  `MKSYNC_RUNTIME` passed through from the caller's environment, and say so in the README ("Engines").
- `tests/all.sh`: after `parity-program`, a layer `parity-node` (`MKSYNC_RUNTIME=node tests/parity/run.sh --engine
./mksync`), skipped with `parity-node: Node 22.18 not found, skipped` when nvm's or the PATH's Node is older or
  missing (load `~/.nvm/nvm.sh` when present).

Test: `source ~/.nvm/nvm.sh && MKSYNC_RUNTIME=node tests/parity/run.sh --engine ./mksync json- &&
MKSYNC_RUNTIME=bun tests/parity/run.sh --engine ./mksync json-`.

## Step 10: Usage errors exit 2 `[worker]`

Files: `src/cli/parse.ts`, `src/cli/parse.test.ts`, the shared cases that expect exit 1 for a usage error (the worker
lists them: `grep -l` on `"exitCode": 1` across cases whose `expect/` holds `Unknown option`, `is repeated` or a
clashing-flags line).

Decision 7. Each listed case: `exitCode` 2 and `oldEngines: ["none"]`, its description gaining
`Exit 2 since phase 9 decision 7.` `parse.ts`: the usage-error results carry code 2. Unit tests: unknown option,
clashing `--preview --only`, `--preview --yes`, a repeated `--profile` and `mksync machine list` each give code 2.

Test: `bun test src/cli && bun run build && tests/parity/run.sh --engine dist/mksync` (all cases: the change is
cross-cutting).

## Step 11: Typed answers trimmed `[worker]`

Files: `tests/parity/cases/values-answer-trimmed/`, `tests/parity/cases/setup-answer-trimmed/`, the answer reader
(the worker names it: `askValues` and setup's line reader share one `trimAnswer` in `src/core/`).

Decision 8. Cases, `oldEngines: ["none"]`:

- `values-answer-trimmed`: a pull asking `<GIT_EMAIL>`, stdin `"  user@example.com\t\r\n"` → the hydrated file holds
  `user@example.com`.
- `setup-answer-trimmed`: setup's profile question answered `" 1 \r"` picks profile 1, as `1` does.

Unit test for `trimAnswer`: `" a b \t\r"` → `a b`; `"   "` → empty; `"\r"` → empty.

Test: `bun test src/core && bun run build && tests/parity/run.sh --engine dist/mksync answer-trimmed`.

## Step 12: The overwrite prompt per file `[worker:high: reasoning: import's plan takes all answers up front; asking per file changes the plan's shape (a callback or a two-pass plan) without changing any piped result]`

Files: `src/core/plan/import.ts`, `src/app/import.ts`, `src/app/import.test.ts`.

Decision 9. The core plan returns the files that need an answer, in order, before any write; the app asks each one
with `stdinLines()` (step 3), printing `Overwrite <file>? [Y/n] ` then reading one line, and passes the answers back
to finish the plan. EOF answers the rest as the contract already says (no). Every shared `import-` and `pull-` case
passes unchanged.

Unit test with a fake line source: three files needing answers; the question for file 2 is printed only after the
answer for file 1 was read (record the interleaving of prints and reads); answers `n`, `y`, EOF give skip, write,
skip.

Test: `bun test src/app/import.test.ts src/core/plan && bun run build && tests/parity/run.sh --engine dist/mksync
import- && tests/parity/run.sh --engine dist/mksync pull-`.

## Step 13: Config paths checked on read `[worker]`

Files: `tests/parity/cases/config-v2-unsafe-file/`, `tests/parity/cases/config-v2-import-no-layer/`,
`src/core/config/v2.ts` (+ its test).

Decision 11. Cases, v2 only (the old engines can't read v2):

- `config-v2-unsafe-file`: entries `../x`, `/etc/x`, `a\\b` and `""`, one case per command run of `mksync status`:
  four runs, each `ERROR: sync-config.v2.json: entry <file> has an unsafe path.`, exit 1, nothing written.
- `config-v2-import-no-layer`: an `import` entry whose `importName` lacks `{layer}` → its line, exit 1.

Unit tests in `v2.test.ts` for the same five inputs, and for `a/b.json` passing.

Test: `bun test src/core/config && bun run build && tests/parity/run.sh --engine dist/mksync config-v2-`.

## Step 14: Atomic state writes and refused links `[worker]`

Files: `src/adapters/store.ts`, `src/adapters/store.test.ts`, `src/adapters/atomic.ts`.

Decision 10, state half. `atomic.ts`: `writeAtomic(path, text, mode)` writes `<dir>/.<name>.<pid>.tmp` with `mode`,
fsyncs, and renames over `path`; it refuses with `ERROR: <path> is a symlink.` when `path` is a symlink (checked with
`lstat`). `store.ts`: `writePrivateFile` and every state write (values, sync point, profiles, records,
`machine.json`) go through it with 0600.

Tests: an existing 0644 file is 0600 after the write and never readable at 0644 with the new text (check the temp
file's mode before the rename by stubbing `rename`); a symlinked `.user-values.json` is refused and its target
unchanged; a failing rename leaves the old file intact and no temp file behind.

Test: `bun test src/adapters/store.test.ts src/adapters/atomic`.

## Step 15: Atomic repo writes and links in dir entries `[worker]`

Files: `src/adapters/fs.ts`, `src/adapters/fs.test.ts`, `tests/parity/cases/dir-link-skipped/`.

Decision 10, repo half. Repo file writes go through `writeAtomic` (mode copied from the file it replaces, else 0644);
a repo path that is a symlink is refused. Home writes are unchanged.

- Case `dir-link-skipped` (`os: ["linux"]`, `oldEngines: ["none"]`): a `dir` entry whose home folder holds `a.txt`
  and a symlink `b.txt -> a.txt` (the runner's `setup` can't make links: write the case so `home/` holds the link
  as committed by git, or, if the runner can't carry one, move this check to a unit test in `fs.test.ts` and say so).
  Push: `a.txt` exported, `SKIPPED <dir>/b.txt (symlink)`.
- Unit tests: a repo write through a symlink refused; a repo write keeps the old file's mode.

Test: `bun test src/adapters/fs.test.ts && bun run build && tests/parity/run.sh --engine dist/mksync dir-`.

## Step 16: A config newer than the program `[worker]`

Files: `tests/parity/cases/config-v2-newer-schema/`, `tests/parity/cases/pull-newer-schema/`,
`src/core/config/v2.ts` (+ test).

Decision 6.

- `config-v2-newer-schema`: `schemaVersion: 3`, `mksync status` → the decision 6 line, exit 2.
- `pull-newer-schema`: `origin/` holds a commit raising `schemaVersion` to 3; `mksync pull` → the line after the
  fast-forward, exit 2, `expect/home/` unchanged.
- Unit tests: 3 and 99 → the newer line; 1, `"2"` and a missing key → `unsupported config schemaVersion <n>`.

Test: `bun test src/core/config && bun run build && tests/parity/run.sh --engine dist/mksync newer-schema`.

## Step 17: Release files `[worker]`

Files: `scripts/ci/release-files.sh`, `tests/linux/release-files.sh`, `package.json`.

`scripts/ci/release-files.sh <tag> <out-dir>`: refuses (exit 1, `ERROR: tag <tag> does not match package.json
version <v>.`) unless `<tag>` is `v` + `package.json`'s version; builds the four programs with the targets and names
`ci.yml`'s `program-build` uses (`mksync-linux-x64`, `mksync-linux-arm64`, `mksync-darwin-arm64`,
`mksync-windows-x64.exe`) into `<out-dir>`, and writes `<out-dir>/SHA256SUMS` (`sha256sum` format, file names only,
sorted). `package.json`: `version` `0.9.0`.

`tests/linux/release-files.sh`: a mismatched tag exits 1 with the line and builds nothing; `v0.9.0` gives the four
files and a `SHA256SUMS` that `sha256sum -c` accepts from inside the folder.

Test: `tests/linux/release-files.sh`.

## Step 18: The release workflow `[inline: a workflow file whose actions are pinned by SHA from network lookups]`

Files: `.github/workflows/release.yml`.

On `push` of tags `v*`: one `ubuntu-latest` job with `permissions: contents: write, id-token: write,
attestations: write`; checkout, `setup-bun` (same SHA as `ci.yml`), `bun install --frozen-lockfile`,
`scripts/ci/release-files.sh "$GITHUB_REF_NAME" release`, `actions/attest-build-provenance` on `release/mksync-*`, then
`gh release create "$GITHUB_REF_NAME" release/* --title "$GITHUB_REF_NAME" --notes-file <notes>` where the notes are
the tag message. Every action pinned by commit SHA (closing the design's "upload-artifact by tag" item for this
file).

Test: `actionlint .github/workflows/release.yml` if installed, else
`python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" .github/workflows/release.yml`.

## Step 19: The update plan `[worker]`

Files: `src/core/update/update.ts`, `src/core/update/update.test.ts`.

Pure. `assetName(os, arch)` → `mksync-linux-x64`, `mksync-linux-arm64`, `mksync-darwin-arm64`,
`mksync-windows-x64.exe`, or `null` for anything else; `parseSums(text)` → a map name → hex, refusing a malformed line;
`isNewer(current, tag)` comparing `x.y.z` numerically (`v` optional); `planUpdate({ current, latestTag, sums,
downloadedSha })` → `up-to-date`, `replace` or `mismatch`.

Tests: each `assetName` pair and `("linux", "ia32")` → null; `parseSums` on a two-line file and on a bad line;
`isNewer("0.9.0", "v0.10.0")` true, `("1.0.0", "v1.0.0")` false, `("1.2.0", "v1.1.9")` false; the three plan
results.

Test: `bun test src/core/update`.

## Step 20: `mksync update` `[worker]`

Files: `src/adapters/release.ts`, `src/app/update.ts`, `src/cli/parse.ts` (+ `parse.test.ts`).

Decision 5. `release.ts`: the latest tag from `<base>/latest` (`MKSYNC_RELEASE_URL`, default
`https://github.com/makubexD/SyncSettings/releases`; the latest-tag lookup follows the `/latest` redirect and reads
the tag from the final URL; under `file://` a `latest` file holds the tag), then `<base>/download/<tag>/<asset>` and
`SHA256SUMS`, with `fetch` (works in Bun and Node). `app/update.ts`: refuses under a launcher (`MKSYNC_LAUNCHER=1`,
which step 8's launchers must set: the worker adds that one line to both), plans with step 19, verifies the
attestation with `gh attestation verify <file> --repo makubexD/SyncSettings` when `gh auth status` exits 0,
writes the new program next to the running one and renames it over (Windows: rename the running one to
`mksync.old.exe` first). On every start `main.ts` deletes a `mksync.old.exe` beside `process.execPath` on Windows.
`parse.ts`: `update`, no options; in the usage line.

Tests in `src/app/update.test.ts` with a temp folder as `MKSYNC_RELEASE_URL` (`file://`) holding a fake release and
`process.execPath` replaced by a temp file: up to date → its line, file untouched; newer → replaced, its line;
checksum mismatch → exit 1, file untouched; under a launcher → the refusal, exit 2.

Test: `bun test src/app/update.test.ts src/core/update src/cli && bun run lint`.

## Step 21: install.sh downloads the program `[worker]`

Files: `install.sh`, `tests/linux/bootstrap.sh` (its installer cases).

Decision 3, Linux and macOS. After the clone: pick the asset from `uname -s`/`uname -m`, download it and
`SHA256SUMS` from `SYNCSETTINGS_RELEASE_URL` (default as step 20), check with `sha256sum`/`shasum -a 256`, verify the
attestation when `gh auth status` succeeds, install to `$SYNCSETTINGS_BIN/mksync` (default `~/.local/bin`) with mode
0755, then run `mksync setup`. `--runtime bun|node`: no download; link the clone's `mksync` launcher there instead.
Keep bash 3.2 syntax.

New cases in `tests/linux/bootstrap.sh`, against a `file://` release folder with a fake program:

- install → `$bin/mksync` is the fake program, mode 0755, setup ran through it.
- a `SHA256SUMS` that doesn't match → the decision 3 line, exit 1, no `$bin/mksync`.
- `--runtime node` → `$bin/mksync` links to `<clone>/mksync`, nothing downloaded.
- an unsupported `uname -m` (`SYNC_ARCH=ia32` override) → `ERROR: no mksync program for linux ia32.`, exit 1.

Test: `tests/linux/bootstrap.sh install`.

## Step 22: install.ps1 downloads the program `[worker]`

Files: `install.ps1`, `tests/windows-vm/install-check.ps1`.

Decision 3, Windows; PowerShell 5.1 rules (no `??`, no ternary). As step 21 with `Get-FileHash -Algorithm SHA256`,
`%LOCALAPPDATA%\mksync\mksync.exe` added to the user `Path` once, and `-Runtime bun|node` writing a `mksync.cmd` shim
there that calls the clone's `mksync.cmd`. `install-check.ps1` runs the same four checks as step 21 against a folder
release and prints `install-check: ok`.

Test: `tests/windows-vm/vm.sh status && tests/windows-vm/vm.sh run 'powershell -NoProfile -ExecutionPolicy Bypass
-File tests/windows-vm/install-check.ps1' || echo "VM down: run in the finish"`.

## Step 23: Setup cases: doctor first and the bootstrap question `[worker]`

Files: `tests/parity/cases/sync-setup-offers-bootstrap/`, `sync-setup-doctor-fails/`,
`front-macos-setup-no-bootstrap/`, `front-macos-bootstrap-flag/`, `docs/sync-contract.md` ("setup").

The four cases the port left (`docs/port-inventory.tsv`, rows with target `phase 9`), written from the bash engine's
contract text (`scripts/linux/front.sh` lines 486-530 show today's rules: doctor runs first and a failure stops setup
with its exit code; on Ubuntu with `bootstrap/linux.sh` present setup asks `Run the Ubuntu bootstrap first? [y/N]`;
`--bootstrap` runs it without asking; on macOS no question, and `--bootstrap` is `ERROR: --bootstrap is Ubuntu
only.`). The bootstrap itself is a stub in the case (`stubs: ["bootstrap"]`, logging its run); the runner gains that
stub if it lacks one. The cases run on bash now (it has the rules) and fail on the program until step 24. Update the
inventory rows' verdict to `PORT` → the case names.

Test: `tests/parity/run.sh sync-setup- && tests/parity/run.sh front-macos-`.

## Step 24: Setup runs doctor and offers the bootstrap `[worker]`

Files: `src/app/setup.ts`, `src/cli/parse.ts` (+ test), `src/adapters/osname.ts` (the Ubuntu check, if not there).

The step 23 cases pass on the program: doctor first (its failure stops setup with doctor's exit code, before any
question), then on Ubuntu with an executable `bootstrap/linux.sh` the question (stdin answer), `--bootstrap` on
`setup`, and the macOS refusal.

Test: `bun test src/cli src/app && bun run build && tests/parity/run.sh --engine dist/mksync sync-setup- &&
tests/parity/run.sh --engine dist/mksync front-macos-`.

## Step 25: The usage line `[worker:low]`

Files: `src/cli/parse.ts`, `src/cli/parse.test.ts`, `docs/sync-contract.md` ("Front door").

Decision 12: the usage line lists `status`, `doctor`, `setup`, `pull`, `push`, `check`, `diff`, `preview`, `update`,
`machine`, `profile`, `statusline`; `export`, `import`, `commit` and `shadow` still parse but aren't listed. The
unit test pins the new line; the contract quotes it.

Test: `bun test src/cli && bun run build && tests/parity/run.sh --engine dist/mksync usage`.

## Step 26: Docs `[inline: user-facing docs need judgment]`

Files: `docs/sync-contract.md`, `docs/design-layers.md`, `README.md`, `docs/daily-workflow.md`.

- Contract: "Install" (decision 3, both installers, the fallback), "Update" (decision 5), "The program" (Node and Bun
  from the clone, decision 2), each new error line of this plan, checked against the cases.
- Design: "Release and update" as built (asset names, `MKSYNC_RELEASE_URL`, the attestation rule), "Tests" (the
  `parity-node` layer, the launcher and release scripts), "Open" pruned of what this plan settled, and the real-Windows
  checklist grown with: the installer on a work machine, `mksync update`, `--runtime node` on work #1's Node 26 and
  Bun 1.3.14.
- `README.md`: install lines, `mksync update`, the fallback, in plain words for a first-time reader.
- `docs/daily-workflow.md`: `mksync update` where updating is mentioned.

Test: `npx prettier --check docs README.md && bun tools/check-config.ts`.

## After this plan: `docs/plan-single-engine-9-cutover.md`

Written by `/next` when this plan finishes (its PR merged). The order, each needing the user where marked:

1. **The user tags `v0.9.0`** (a publish). The release workflow runs; its files are checked.
2. Shadow again on personal Linux (`mksync shadow`), every difference explained.
3. **The real-Windows checklist on work #1** (the user, with redacted answers): install with `irm … | iex` or
   `-Runtime node`, first run, pull, push, `mksync update`, statusline, shadow for a week. Work #2 and #3 when the user
   is at them. Failures get fix steps before step 6.
4. **The user's calls, asked before the layout runs:** which of `enabledPlugins`, `extraKnownMarketplaces`,
   `permissions` and `autoMode` move from the base to profile `personal`; `~` for `<HOME>` in `hooks` and
   `statusLine`; `<YOUR_WORK_MARKETPLACE>` moving into the work profiles' layer; which work profile owns each
   `.linked/` tree; `sampleGrok.md` dropped or kept as a document.
5. `bun tools/claude-layout.ts <repo>`, reviewed, then `--cutover`; the synced `statusLine` runs `mksync statusline`;
   `statusline.sh` retired. The `.linked/` trees moved with `git mv` to `dir` entries.
6. Tag `two-engines-final`; delete `export.sh`, `import.sh`, `commit.sh`, `sync`, `sync.cmd`, `scripts/linux/` and
   `scripts/windows/` engine files (the CI scripts in `scripts/ci/` stay), their suites, `mksync shadow`,
   `detectLinkedPaths`; `sync-config.v2.json` becomes `sync-config.json`; `tests/all.sh`, `ci.yml` and `CLAUDE.md`
   ("Today's engines") follow.
7. **The user tags `v1.0.0`.**
