# The repo owner's GitHub account on a shared machine (`v1.2.2`)

Found 2026-11-27 on work #2 (`docs/plan-work-machines.md`, step 13), on `v1.2.1`, before the private switch. Work #2
has two GitHub accounts signed in to `gh`: the employer's (active) and the repo owner's. Against a private repo the owner
owns, from work #2:

- `git ls-remote https://github.com/<owner>/<private repo> HEAD`: `remote: Repository not found.`, exit 128. Git
  Credential Manager signs in with the employer's account.
- `gh repo view github.com/<owner>/<private repo> --json visibility`: `Could not resolve to a Repository`, exit 1. `gh`
  uses the active account.
- With the owner's token, both work: `gh auth token --user <owner>` in `GH_TOKEN` makes `gh repo view` print
  `{"visibility":"PRIVATE"}`, and git with
  `-c credential.https://github.com.helper= -c "credential.https://github.com.helper=!f() { test "$1" = get && echo
username=<owner> && echo password=$(gh auth token --user <owner>); }; f"` lists `HEAD`, exit 0, no prompt.

So once SyncSettings is private, work #2 can't `git pull` (its only update path, since it runs from the clone), and
`mksync` can't open a PR, read a release or tell the repo's visibility. The design's line "Windows uses Git Credential
Manager" (`docs/design-layers.md`, the `gh` install paragraph) holds only with one account. Step 13 of
`docs/plan-work-machines.md` waits for this release on work #1 and work #2.

Branch `engine/gh-account`. Contract: `docs/sync-contract.md` ("Front door": `doctor`; the installers' clone).

## Decided (proposed, for review)

1. **The owner** is the owner in the clone's `origin` URL (`parseGitHubOrigin`, `src/adapters/visibility.ts`). The
   **owner token** is what `gh auth token --user <owner>` prints. No owner (not a GitHub origin), a failing or empty
   answer, or an owner name outside `^[A-Za-z0-9-]{1,39}$` means no owner token: everything runs as today.
2. **Every `gh` call `mksync` makes** (`pr create`, `release view`, `release download`, `repo view`) runs with
   `GH_TOKEN=<owner token>` in that child's environment when there is one, asked once per run. The token is never
   printed, logged or written. The active `gh` account is never switched.
3. **The clone's own git login.** The installers write, into the clone's `.git/config` only (never `~/.gitconfig`,
   which is synced): `credential.https://github.com.helper` set to the empty value, then to
   `!f() { test $1 = get && echo username=<owner> && echo password=$(gh auth token --user <owner>); }; f` (no double
   quotes: PowerShell 5.1 strips them from native arguments). Only when `gh` is signed in and the owner token exists;
   a rerun replaces both values, so it stays two lines. The owner name passes the check in 1 before it goes into the
   string. The token is fetched by git each time, never stored.
4. **`doctor` says when a clone needs it.** A new line `git login`: `OK` when the clone's helper names the owner, or
   when the owner token is the active account's token (`gh auth token`, local, no network); else
   `WARN git login: git signs in as another GitHub account; run the install line again`. No `gh`, or no owner token:
   no line. The doctor writes nothing.
5. **Not in this hotfix.** A new machine whose active `gh` account can't see the private repo can't fetch
   `install.ps1` either: the docs say to run `gh auth switch --user <owner>` for the install line, then switch back.
   It goes in the design's "Open" list.

## Step 1: The gh stub learns accounts `[worker]`

Files: `tests/parity/run.sh`, `tests/parity/run.ps1`, `tests/parity/README.md`.

- A case may set `"ghAccounts": ["<name>", …]` in `case.json` (first entry is the active one). With it, the gh stub
  answers `auth token` with `tok-<active>` and `auth token --user <name>` with `tok-<name>` (exit 0), or exit 1 with
  nothing printed for a name not in the list. Without `ghAccounts`, `auth token` exits 1 (as an unsigned `gh`).
- Every stub call whose environment holds `GH_TOKEN` logs its line prefixed with `GH_TOKEN=<value> ` before the cut to
  the first two words (the prefix isn't counted as a word). `auth token` calls are logged as other calls.
- Both runners clear a caller's `GH_TOKEN`, as they clear `GH`. The case validator accepts `ghAccounts` only with
  `"stubs": ["gh"]`.
- README: the `ghAccounts` field and the `GH_TOKEN=` prefix.

Test: `tests/parity/run.sh` (every existing case still passes: none sets `ghAccounts` or sees `GH_TOKEN`).

## Step 2: Shared cases for the owner token `[worker]`

Files: new folders under `tests/parity/cases/`, `expect/` written from "Decided" 2 and 4, not from engine output.
Model each on an existing `commit-*` case with `"stubs": ["gh"]` and a GitHub `origin` owned by `owner1`.

| Case                      | `ghAccounts`          | Command  | Expected                                                                     |
| ------------------------- | --------------------- | -------- | ---------------------------------------------------------------------------- |
| `commit-gh-owner-token`   | `["work1", "owner1"]` | `commit` | `gh.log`: `auth token`, then `GH_TOKEN=tok-owner1 pr create`; exit as today  |
| `commit-gh-owner-active`  | `["owner1"]`          | `commit` | `gh.log`: `auth token`, `GH_TOKEN=tok-owner1 pr create`                      |
| `commit-gh-no-owner`      | `["work1"]`           | `commit` | `gh.log`: `auth token`, then `pr create` with no prefix                      |
| `doctor-git-login-warn`   | `["work1", "owner1"]` | `doctor` | stdout holds `WARN     git login: git signs in as another GitHub account; …` |
| `doctor-git-login-ok`     | `["owner1"]`          | `doctor` | stdout holds `OK       git login`                                            |
| `doctor-git-login-helper` | `["work1", "owner1"]` | `doctor` | clone config has the helper for `owner1`: `OK       git login`               |
| `doctor-git-login-no-gh`  | none                  | `doctor` | no `git login` line                                                          |

Test: `tests/parity/run.sh --engine dist/mksync gh-` and `doctor-git-login` fail on `v1.2.1` for the missing
behavior (missing prefix, missing line), not for a broken case.

## Step 3: `gh` runs as the owner `[worker]`

Files: `src/adapters/gh.ts`, `src/adapters/gh.test.ts`, `src/adapters/release.ts`, `src/adapters/visibility.ts`.

- `gh.ts`: `ownerToken(owner, deps)`: validates the name ("Decided" 1), runs `gh auth token --user <owner>` once per
  process (cached per owner), returns the trimmed token or `undefined`. `runGh` takes an optional `token` and passes
  `GH_TOKEN` in the child's env only. `prCreate` takes the owner from its caller.
- `release.ts` and `visibility.ts`: their `gh` calls pass the owner token (the release owner is the repo's).
- Unit tests: a bad owner name never runs `gh`; a failing or empty answer is `undefined`; the env holds `GH_TOKEN`
  only when a token was found; the token never appears in a returned error text.

Test: `bun test src/adapters/gh.test.ts src/adapters/release.test.ts src/adapters/visibility.test.ts`, then
`bun run build && tests/parity/run.sh --engine dist/mksync commit-gh-`.

## Step 4: The doctor's `git login` line `[worker]`

Files: `src/app/doctor.ts`, `src/core/front/doctor.ts`, their tests.

The fact and the line from "Decided" 4: owner from `origin`, `ownerToken`, the active token (`gh auth token`), and
`git config --local --get-all credential.https://github.com.helper` in the clone. Pure core decides the line; the app
gathers the facts.

Test: `bun test src/app/doctor.test.ts src/core/front/doctor.test.ts`, then
`bun run build && tests/parity/run.sh --engine dist/mksync doctor-git-login`.

## Step 5: `install.sh` writes the clone's login `[worker]`

Files: `install.sh`, `tests/linux/install.sh`.

After the clone or the pull, when the installer used gh's helper (`$gh_release` true) and the origin is on
`github.com`: owner from the origin URL, checked as in "Decided" 1, owner token via `${GH:-gh} auth token --user`; then
`git -C "$dir" config --local --replace-all credential.https://github.com.helper ''` and
`git -C "$dir" config --local --add credential.https://github.com.helper '<the helper>'`. Writes nothing otherwise.
New install cases (gh stub with two accounts): a new clone gets exactly the two lines; a rerun keeps two; a bad owner
name, an unsigned `gh` or a non-GitHub origin writes none; the token is in no output.

Test: `tests/linux/install.sh`.

## Step 6: `install.ps1` writes the clone's login `[worker]`

Files: `install.ps1`, `tests/windows-vm/` (its install cases).

The same as step 5 in PowerShell 5.1 (no `??`, no ternary), `Invoke-Git` for both `config` calls, the helper string
without double quotes.

Test: `tests/windows-vm/vm.sh status` is 0, then the VM's install cases; a work-machine-shaped run (two gh accounts,
`SYNCSETTINGS_RUNTIME=node`) leaves the two lines in `.git/config` and `git ls-remote` through them reaches the stub.

## Step 7: Docs `[inline: user-facing docs]`

`docs/sync-contract.md` (the doctor line, the owner token, the installers' clone login), `docs/design-layers.md` (fix
the "Windows uses Git Credential Manager" line; "Open": "Decided" 5), `docs/daily-workflow.md` (a machine with two
GitHub accounts), `README.md` (the `gh auth switch` note for a new machine), `CHANGELOG.md` and `package.json`
`1.2.2`. The finish then releases `v1.2.2` after the user's OK.

Test: `npx prettier --check` on the changed docs; `bun run lint`.

## After the release

Back to `docs/plan-work-machines.md` step 13: while the repo is still public, work #1 and work #2 run their install
line again (`SYNCSETTINGS_RUNTIME=node`), `mksync --version` prints `1.2.2` and `mksync doctor` reads
`OK       git login`; Linux runs `mksync update`. Then the private switch.
