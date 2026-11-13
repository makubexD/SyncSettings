# One engine, phase 7: push, pull and Claude

Roadmap: `docs/plan-single-engine.md`, phase 7. Design: `docs/design-layers.md` ("Push and pull", "New settings",
"Profile values", "Public-repo guard", "Statusline and hooks on Windows", "Catalog", and the Open items marked phase
7). Goal: the program's push side shows its changes grouped by who receives them, asks where a new setting goes and
remembers it, refuses a profile's value bound for a wider layer, and writes the first backup once the repo is private;
pull's check lists the same groups; `mksync statusline` replaces `statusline.sh`; the Claude layout for every OS is
built and proved, ready for cut-over; and work machine #1 answers the design's "Confirm on Windows" list.

## Shared rules

- Branch `engine/push-pull`, one commit per step, one PR at the end.
- **Old engines frozen.** No change to `export.sh`, `import.sh`, `commit.sh`, `scripts/linux/`, `scripts/windows/`,
  `sync-config.json`. The runners (`tests/parity/run.sh`, `run.ps1`) may change; no existing case's `expect/` changes.
- **Contract first** (CLAUDE.md rule 2): step 3 writes this phase's rules into the contract; steps 5 to 9 add the
  shared cases before the code that makes them pass.
- **Public repo.** Fixtures use `example.com`, `/home/user`, `C:\Users\user`, profiles `work-1` and `personal`,
  machines `wk1-laptop` and `home-linux`. The Windows survey's answers are redacted (`work-tool-1`) and shown to the
  user before they're committed. `leak-scan` stays green.
- **Layout** from the design's "Code layout": `src/core/` stays pure (the boundary grep prints nothing). Change lines,
  groups and the profile-value rule in `src/core/plan/`; the statusline's formatting in `src/core/statusline/`, its
  reads (git, load, memory, clock, files) in `src/adapters/statusline.ts`; prompts in `src/cli/`. Tests sit next to
  their file.
- **No new dependencies.** Prompts use `node:readline` as `setup` does.
- **Messages are the contract's.** Every line steps 10 to 26 print is copied from `docs/sync-contract.md` as step 3
  writes it. A worker spec names the section to copy from.
- Each worker step: about 3 files, one concern, tests in the same step. Test commands run that step's tests only.

## Out of this phase

- `mksync push` and `pull` in the front door, the PR per profile, and "Move a change?": phase 8. Until then the push
  side is `dist/mksync export` and the pull check is `dist/mksync import --check`; the preview numbers its lines now,
  so the format doesn't change when moving arrives.
- Skipping a group on pull: stays in the design's Open.
- A new file in a `dir` entry: not asked in this phase; it goes to the entry's latest layer as today (Open).
- The Claude layout going live (the split `settings.json`, the Windows entries, `statusLine` pointing at
  `mksync statusline`): phase 9, by the tool step 26 builds. The v1/v2 check refuses a v2 entry that covers an OS its
  v1 twin doesn't (`src/core/config/check.ts`), and v1 is frozen.
- PowerShell twins of the Linux hooks: listed from the survey (step 25), built only on a real need.

## Decisions to confirm in review

Proposals; the review of this plan confirms or changes them before `/next`. Step 3 writes them into the contract and
the design.

1. **The Windows survey doesn't block.** Step 1 writes the prompt and sends it to the user; the plan carries on.
   Step 25 needs the redacted answer: if it isn't in by then, `/next` stops there and asks for it.
2. **Where the new push side runs until phase 8.** `export --preview` prints the grouped block after its status lines
   and before the `--stat` summary; `export` prints the same block, asks the new-setting questions, applies the
   profile-value rule, then writes. Nothing else of today's preview changes.
3. **Groups and lines.** A change belongs to the group of the layer it's written to: base `All machines`, OS
   `Linux machines` / `Windows machines` / `macOS machines`, profile `Profile <p>`, machine `This machine only`.
   Header `Changes on <machine> (profile <p>):`; with no record `Changes on this machine:` and only the first two
   groups. Every group prints, an empty one as `     (none)`. A line is `<n>  <M|+|->  <module>  <file>  <what>`,
   numbered from 1 across the groups, columns padded to the widest value in the block. `<what>`: for `json`,
   `<key path>: <old> -> <new>` (M) or `<key path>: <value>` (+, -), an array item as `<path>[]: <item>`, values as
   compact JSON cut to 60 characters with `...`; for `whole`, `import` side files and base text,
   `<n> line(s) changed`; for `dir`, the file name inside the folder. Values are the sanitized text. Order: entry order
   of the config, then the order the split reports. Header and blank lines as in the design's example.
4. **The new-setting question.** Only `export` with a record asks; `export --preview` lists each new setting under
   `New settings` with its suggestion and `(asked by mksync export)`. The question is the design's, numbered after the
   changes: `1) all machines  2) <Os> machines  3) profile <p>  4) this machine [<s>]`. The suggestion is the profile's
   stored destination when there is one (then nothing is asked and the line shows where it went), else `profile <p>`,
   or `all machines` when the profile is `personal`. Answers are read as `setup` reads them: a piped line or the
   terminal, empty or end of input takes the suggestion, anything else prints `Pick 1 to 4.` and asks again; `--yes`
   takes the suggestion. A new array item's answer is also stored in the profile's `destinations` (backup first, as
   any state write); a new key's isn't. `destinations` accepts `base` from now on. With no record, today's
   `needs a destination` `ERROR` stays.
5. **The profile-value rule.** Before writing, each layer text bound for base or an OS layer is searched, after
   sanitize, for each non-empty value of the record's profile, ignoring case. A hit prints the design's two `refused:`
   lines (change number, module, file, placeholder, group), and the run stops with exit 1 before any write. The
   preview prints the same lines and exits 1. Machine values aren't searched (the design names the profile's).
6. **Pull groups.** `import --check` prints the grouped block after its status lines, header
   `Changes from the repo:`, same groups and line format, with `+` for a key the local file lacks and `-` for one the
   import would remove. `import` itself prints its status lines as today.
7. **`mksync statusline`.** Reads Claude Code's JSON payload on stdin and prints one line, always exit 0 (a failed
   section is left out, as in the bash script). Same sections, order, colors and text as `statusline.sh`, including
   the context-window write (`CTX_WINDOW_DIR`), `CONTEXT_CLEAR_AT` and the worker-mode flag. Load and memory are
   left out on Windows. Test overrides, as `SYNC_HOSTNAME` is: `SYNC_NOW` (`HH:MM`), `SYNC_LOAD`, `SYNC_MEM`
   (`<used>/<total>` in MiB) and `SYNC_GIT` (`none` skips git). Until cut-over the real `settings.json` keeps
   `statusline.sh`; a dev tool compares the two on recorded payloads.
8. **The Claude layout is built now and goes live at cut-over.** `tools/claude-layout.ts` writes, into a given repo
   folder: the base `dotfiles/common/claude/settings.json`, the Linux overlay (`hooks`, and any top-level key whose
   value holds `<HOME>` or a `.sh` path), the Windows overlay from the survey, `statusLine` in the base as
   `mksync statusline`, and the v2 entries widened to Windows (`settings.json`, `CLAUDE.md`, `RTK.md`, the docs page).
   Its test merges the new Linux layers and gets today's `settings.json` back, `statusLine` aside. Phase 9 runs it and
   drops the check.
9. **The first backup.** When the guard reads private, `export` copies the local profile, its layer folder, the
   record and its machine layer into `profiles/` and `machines/`. A profile the repo already holds is merged with
   `mergeProfileCopies`; each differing value asks `<P> differs on profile <p>: 1) keep the repo's  2) take this
machine's [1]`. After every write succeeds, `<state>/machine.json` becomes the `{"name", "home": "repo"}` pointer.
   The preview shows a group `First backup: profiles and machines` listing the paths. Phase 8's push commits them.
10. **The repo store.** With a pointer record, `machine retire` and `profile retire` read and write `machines/` and
    `profiles/` in the repo, "used by" included. An unreadable repo file prints `ERROR: <repo path> can't be read:
<reason>.`, exit 2.
11. **Command names**, reviewed by the `cli` skill in step 2: `mksync statusline` (no flags) and `mksync export --yes`.

## Step 1: The Windows survey prompt `[inline: user-facing prompt for work machine #1]`

Files: `docs/windows-survey.md` (new).

One prompt the user pastes into Claude Code on work machine #1. It reports names and structure, never values: the
`~/.claude` tree (names, depth 3), the `settings.json` keys (two levels, values replaced by their JSON type), the
`statusLine` command with the user name and any employer name replaced, the shell Claude Code uses for hooks and the
statusline, whether Git Bash, `jq` and `CLAUDE_CODE_GIT_BASH_PATH` exist, whether `$HOME/.claude` and `~/.claude`
resolve under Git Bash and PowerShell, and whether the probe program from `probe/single-engine/` starts. The answer
comes back as one fenced block with fixed headings. Push-notify the user with the file path; don't wait.

Test: `npx prettier --check docs/windows-survey.md`.

## Step 2: Review the new command names `[inline: cli skill review of contract names]`

Files: `docs/plan-single-engine-7.md`, `docs/design-layers.md`.

Run the `cli` skill in design mode over decision 11 and the prompts of decisions 4 and 9. Write its verdict into
decision 11 (a plan edit) and the design's Open (settled, or a migration note).

Test: `npx prettier --check docs/plan-single-engine-7.md`.

## Step 3: This phase's rules in the contract `[inline: contract decisions]`

Files: `docs/sync-contract.md`, `docs/design-layers.md`.

- Contract, program sections: "Push preview (program only)" (decisions 2, 3), "New settings (program only)"
  (decision 4, `destinations` accepting `base`), "Profile values (program only)" (decision 5), the pull block in
  "Import check" (decision 6), "Statusline (program only)" (decision 7, every section with its exact text and
  colors, the overrides), the first backup and the repo store in "Public-repo guard" and "Retire" (decisions 9,
  10), and the usage line with `statusline` and `export --yes`.
- Design: decisions 1 to 11 as rules with an example where there's none; the Open items they settle taken out
  ("Two copies of one profile", retire against the repo store, the pointer write, the repo `can't be read` line).

Test: `grep -c 'Push preview' docs/sync-contract.md` is at least 1; `grep -c 'mksync statusline' docs/sync-contract.md`
is at least 2; `npx prettier --check docs/plan-single-engine-7.md`.

## Step 4: Runner for the new commands `[worker]`

Files: `tests/parity/run.sh`, `tests/parity/run.ps1`, `tests/parity/README.md`.

- `command` may be `statusline`; with an engine other than the program it prints `SKIP <case>: statusline is program
only`. Its stdin is the case's `stdin` file; its whole stdout is kept (as `setup`).
- `options` adds `yes: true` for `export`.
- `env` in a `configV2` case may also set `SYNC_NOW`, `SYNC_LOAD`, `SYNC_MEM`, `SYNC_GIT`, `CONTEXT_CLEAR_AT`, and
  `CTX_WINDOW_DIR` (a path under the case's temp home).
- `export` and `import --check` keep their whole stdout when the case sets `"output": "all"` (already allowed for
  other commands; check it holds for these two).

Test: `bun run build && tests/parity/run.sh --engine dist/mksync` passes as before (94 passed); a scratch case with
`statusline` against bash prints the skip line (in the scratchpad, not committed).

## Step 5: Shared cases for the grouped preview `[worker]`

Files: `tests/parity/cases/push-*/` (new).

Each `configV2`, `"output": "all"`, `expect/` from step 3's "Push preview":

| Case                   | Input                                                                           | Expected                                                   |
| ---------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `push-groups`          | record `wk1-laptop`/`work-1`; changes in a base, a Windows, a profile json file | the header and four groups, lines 1 to 3, `(none)` for one |
| `push-groups-norecord` | no record, a base and a Linux change                                            | `Changes on this machine:`, two groups only                |
| `push-json-lines`      | json key changed, key added, key removed, array item added                      | the four `<what>` forms, long value cut with `...`         |
| `push-text-lines`      | `whole` file with 3 lines changed, an `import` side file changed                | `3 line(s) changed` and the side file's line               |
| `push-sanitized`       | changed value that sanitize turns into `<YOUR_EMAIL>`                           | the line shows `<YOUR_EMAIL>`, never the value             |
| `push-export-prints`   | `push-groups` input, `export --yes`                                             | the same block, then the export's status lines, exit 0     |

Test: `bun run build && tests/parity/run.sh --engine dist/mksync push-` shows 6 failures for the reasons above.

## Step 6: Shared cases for new settings `[worker]`

Files: `tests/parity/cases/newsetting-*/` (new).

| Case                      | Input                                                                  | Expected                                                            |
| ------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `newsetting-preview`      | record `work-1`, a new array item in a two-layer json entry, `preview` | `New settings` line with `[3]` and `(asked by mksync export)`       |
| `newsetting-yes-work`     | same, `export --yes`                                                   | item in the profile layer; `destinations` holds the path: `profile` |
| `newsetting-yes-personal` | profile `personal`, `export --yes`                                     | item in the base; `destinations`: `base`                            |
| `newsetting-answer`       | stdin `4\n`                                                            | item in the machine layer; `destinations`: `machine`                |
| `newsetting-bad-answer`   | stdin `9\n2\n`                                                         | `Pick 1 to 4.` once, item in the Linux layer                        |
| `newsetting-stored`       | profile already has the destination, `export` with no stdin            | no question, item where stored, line under its group                |
| `newsetting-key`          | a new key (not an array item), `export --yes`                          | key in the profile layer, `destinations` unchanged                  |
| `newsetting-norecord`     | no record                                                              | today's `needs a destination` `ERROR`, file unchanged               |
| `newsetting-base-dest`    | profile file with `destinations` value `base`, `import --check`        | no profile error (it was `is not a layer`)                          |

Test: `bun run build && tests/parity/run.sh --engine dist/mksync newsetting-` shows 8 failures (`newsetting-norecord`
passes today).

## Step 7: Shared cases for profile values and pull groups `[worker]`

Files: `tests/parity/cases/profilevalue-*/`, `tests/parity/cases/pull-groups*/` (new).

| Case                      | Input                                                                            | Expected                                         |
| ------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------ |
| `profilevalue-refused`    | profile value `jane@work1.example.com`; base json file gets it, no sanitize rule | the two `refused:` lines, exit 1, repo unchanged |
| `profilevalue-case`       | same value in upper case                                                         | refused                                          |
| `profilevalue-profile-ok` | same change bound for the profile layer                                          | written, exit 0                                  |
| `profilevalue-sanitized`  | base entry has the `<YOUR_EMAIL>` rule                                           | written as the placeholder, exit 0               |
| `profilevalue-preview`    | `profilevalue-refused` input, `preview`                                          | the `refused:` lines, exit 1                     |
| `pull-groups`             | repo base and profile layers differ from local, `import --check`                 | `Changes from the repo:` and the groups          |
| `pull-groups-none`        | nothing differs                                                                  | the block with every group `(none)`              |

Test: `bun run build && tests/parity/run.sh --engine dist/mksync 'profilevalue-|pull-groups'` shows 5 failures
(`profile-ok` and `sanitized` pass today).

## Step 8: Shared cases for the statusline `[worker]`

Files: `tests/parity/cases/statusline-*/` (new).

Each sets `SYNC_NOW=09:30`, `SYNC_LOAD`, `SYNC_MEM`, `SYNC_GIT=none` unless the row says otherwise; `expect/` from
step 3's "Statusline", ANSI codes kept in the expected text as the contract writes them.

| Case                     | Input                                                           | Expected                                   |
| ------------------------ | --------------------------------------------------------------- | ------------------------------------------ |
| `statusline-full`        | payload with model, cwd, cost, context 40%, cache tokens, style | every section in order                     |
| `statusline-empty`       | `{}`                                                            | time, load and memory only                 |
| `statusline-bad-json`    | `not json`                                                      | time, load and memory only, exit 0         |
| `statusline-clear`       | `total_input_tokens` 210000, `CONTEXT_CLEAR_AT` unset           | the `CLEAR` mark                           |
| `statusline-ctx-write`   | `session_id` `abc-1`, `context_window_size` 200000              | file `CTX_WINDOW_DIR/abc-1` holds `200000` |
| `statusline-bad-session` | `session_id` `../x`                                             | no file written                            |
| `statusline-worker`      | `~/.claude/state/worker-mode` exists in the temp home           | the worker-mode section                    |
| `statusline-git`         | `git: local` clone as cwd with one change, `SYNC_GIT` unset     | branch and change count                    |

Test: `bun run build && tests/parity/run.sh --engine dist/mksync statusline-` shows 8 failures (unknown command).

## Step 9: Shared cases for the first backup and the repo store `[worker]`

Files: `tests/parity/cases/backup-*/`, `tests/parity/cases/store-*/` (new).

| Case                 | Input                                                              | Expected                                                                |
| -------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `backup-preview`     | `MKSYNC_VISIBILITY=private`, local record and profile, `preview`   | `First backup: profiles and machines` with both paths                   |
| `backup-export`      | same, `export --yes`                                               | `profiles/work-1.json`, `machines/wk1-laptop.json` in the repo; pointer |
| `backup-merge`       | repo already holds `profiles/work-1.json` with one other module    | modules joined, written once                                            |
| `backup-differ`      | repo copy has another `<YOUR_EMAIL>`, stdin `2\n`                  | the question once; this machine's value kept                            |
| `backup-public`      | same as `backup-export`, public                                    | the held line, nothing written to the repo, no pointer                  |
| `store-retire-repo`  | pointer record, repo holds both, `machine retire wk1-laptop --yes` | `retired: true` in `machines/wk1-laptop.json`, state unchanged          |
| `store-used-by-repo` | pointer, `profile retire work-1 --yes`, repo record uses it        | the `used by` refusal, exit 1                                           |
| `store-unreadable`   | pointer, repo `machines/wk1-laptop.json` not JSON, `machine-show`  | the contract's `can't be read` line, exit 2                             |

Test: `bun run build && tests/parity/run.sh --engine dist/mksync 'backup-|store-'` shows 7 failures (`backup-public`
passes today).

## Step 10: Change lines `[worker]`

Files: `src/core/plan/changes.ts` (new), `src/core/plan/changes.test.ts`, `src/core/plan/types.ts`.

`changeLines(plan)`: one `ChangeLine` (`layer`, `kind` M/+/-, `module`, `file`, `what`) per change the export plan
holds, in decision 3's order and `<what>` forms, from the split's changes and the whole-file line counts.
`importChangeLines(plan)` does the same for an import plan (decision 6). Unit cases: each `<what>` form, the 60
character cut, array items, sanitized values, order across entries.

Test: `bun test src/core/plan/changes.test.ts && bun run lint`.

## Step 11: The grouped block `[worker]`

Files: `src/core/plan/groups.ts` (new), `src/core/plan/groups.test.ts`, `src/main.ts`.

`groupBlock(lines, record)`: the header, the groups, numbering, padding and `(none)` from decision 3, as text lines.
`main.ts` prints it in `export --preview` (after the status lines), in `export` (before the writes) and in
`import --check` (decision 6), and accepts `export --yes`. Unit cases: with and without a record, an empty group, the
padding.

Test: `bun test src/core/plan && bun run build && tests/parity/run.sh --engine dist/mksync 'push-|pull-groups'`
(`push-export-prints` may wait for step 13).

## Step 12: Destinations and the suggestion `[worker]`

Files: `src/core/config/profile.ts`, `src/core/plan/newsettings.ts` (new), `src/core/plan/newsettings.test.ts`.

`destinations` accepts `base`. `newSettingChoices(record, profile, os)` returns the four choices (two with no record)
and the suggestion of decision 4; `storeDestination(profile, path, layer)` returns the profile with the array-item
destination added. Unit cases: work and `personal` suggestions, a stored destination, a new key not stored, `base`
parsed.

Test: `bun test src/core/config src/core/plan/newsettings.test.ts && bun run lint`.

## Step 13: The new-setting question `[worker]`

Files: `src/cli/ask.ts` (new, or the existing prompt helper `setup` uses if it fits), `src/main.ts`,
`src/core/plan/export.ts`.

Export with a record asks each unresolved new setting (decision 4) before it plans the writes, then plans with the
answers as destinations; the preview only lists them. The changed profile is written to state with its backup.
Reuse `setup`'s answer reading (`Pick 1 to <n>.`, end of input takes the suggestion, `--yes`).

Test: `bun test src && bun run build && tests/parity/run.sh --engine dist/mksync 'newsetting-|push-'`.

## Step 14: The profile-value rule `[worker]`

Files: `src/core/plan/profilevalues.ts` (new), `src/core/plan/profilevalues.test.ts`, `src/main.ts`.

`profileValueHits(plan, profile, lines)`: for each write bound for base or an OS layer, the profile values found in
its sanitized text, ignoring case, with the change number and placeholder (decision 5). `main.ts` prints the
`refused:` lines and exits 1 before any write, in `export` and `export --preview`. Unit cases: a hit, upper case, a
profile-layer write, an empty value, a sanitized value.

Test: `bun test src/core/plan/profilevalues.test.ts && bun run build && tests/parity/run.sh --engine dist/mksync
profilevalue-`.

## Step 15: Statusline payload and text sections `[worker]`

Files: `src/core/statusline/format.ts` (new), `src/core/statusline/format.test.ts`.

Port `dotfiles/linux/claude/statusline.sh`'s payload read and the sections that need only the payload: model, venv,
project type (given the file names found), directory, cost and context (progress bar, `fmt_tokens`, colors by
threshold, `CLEAR`), cache, output style. Input: the parsed payload plus a `facts` object (time, load, memory, git,
worker mode) that the adapter fills; output: the line. Same escapes and text as the script. Unit cases: each section
present and missing, each color threshold, `fmt_tokens` at 999, 1000, 1500, 1000000.

Test: `bun test src/core/statusline && bun run lint`.

## Step 16: Statusline facts and the command `[worker]`

Files: `src/adapters/statusline.ts` (new), `src/adapters/statusline.test.ts`, `src/main.ts`.

The facts of step 15: clock, `/proc/loadavg` and `/proc/meminfo` (none on Windows), git branch, dirty mark,
ahead/behind, last commit age and changes as the script runs them, the worker-mode flag, the files that set the
project type; the overrides of decision 7. The context-window write with the script's checks. `mksync statusline`
reads stdin, prints the line, exits 0 whatever fails. Unit cases with temp folders: overrides, bad session id, git
missing.

Test: `bun test src/adapters/statusline.test.ts && bun run build && tests/parity/run.sh --engine dist/mksync
statusline-`.

## Step 17: Statusline parity tool `[worker]`

Files: `tools/statusline-parity.sh` (new), `tools/statusline-payloads/` (new, three recorded payloads with example
values).

Runs `statusline.sh` and `dist/mksync statusline` on each payload in a temp home with the same `CTX_WINDOW_DIR`,
blanks the time, load and memory sections in both, and diffs. Exits 0 when equal.

Test: `bun run build && tools/statusline-parity.sh`.

## Step 18: The first backup, planned `[worker]`

Files: `src/core/machine/backup.ts` (new), `src/core/machine/backup.test.ts`.

`planFirstBackup(local, repo)`: the files to write under `profiles/` and `machines/` (profile, its layer folder, the
record, its machine layer), a repo profile merged with `mergeProfileCopies`, and the differing values as questions
(decision 9). Unit cases: nothing in the repo, a profile in the repo, a differing value answered each way.

Test: `bun test src/core/machine/backup.test.ts && bun run lint`.

## Step 19: The first backup, written `[worker]`

Files: `src/main.ts`, `src/adapters/store.ts`, `src/core/plan/preview.ts`.

With the guard private: the preview group lists the paths; `export` asks the questions, writes the files, then the
pointer. A failed write leaves the record local and stops with the contract's line.

Test: `bun test src/adapters && bun run build && tests/parity/run.sh --engine dist/mksync 'backup-|guard-'`.

## Step 20: Retire against the repo store `[worker]`

Files: `src/core/machine/retire.ts`, `src/adapters/store.ts`, `src/adapters/store.test.ts`.

Decision 10: with a pointer, retire reads and writes the repo's `machines/` and `profiles/`, and "used by" looks there;
an unreadable repo file gives the contract's line, exit 2.

Test: `bun test src/adapters src/core/machine && bun run build && tests/parity/run.sh --engine dist/mksync
'store-|retire-'`.

## Step 21: Audits `[inline: review of user-facing work]`

Run `cli-auditor` on `export`'s question, `--yes` and `statusline`, `wizard-auditor` on the new-setting and backup
questions, and `ts-security-auditor` on the profile-value rule, the first backup and the context-window write. Fixes
become steps after step 26 (the docs step moves to the end), with shared cases first where they change output; what's
left goes in the design's Open.

Test: `tests/all.sh`.

## Step 22: Merge strategies through one interface `[worker]`

Files: `src/core/merge/strategy.ts`, `src/core/merge/types.ts`, `src/core/plan/export.ts`.

Closes the Open item "`strategyFor` covers only `whole`": the merge context carries the local file and the
destinations, the result carries new settings and side files, and export calls `strategyFor(entry.merge)` for
`whole`, `json` and `import` instead of switching on the type. No output changes.

Test: `bun test src && bun run build && tests/parity/run.sh --engine dist/mksync`.

## Step 23: Import plan through the same interface `[worker]`

Files: `src/core/plan/import.ts`, `src/core/plan/check.ts`.

The import and check plans call `strategyFor` as step 22's export does; `parsedJson` uses `core/merge/json.ts`'s parser
(Open, "Finish review, phase 5"). No output changes.

Test: `bun test src && bun run build && tests/parity/run.sh --engine dist/mksync`.

## Step 24: One constant for the state paths `[worker]`

Files: `src/core/guard.ts`, `src/core/plan/preview.ts`, `src/adapters/fs.ts`.

`profiles/` and `machines/` named once in `src/core/guard.ts` and imported by the preview and the adapter (Open,
"Finish review, phase 5"). No output changes.

Test: `bun test src && bun run lint`.

## Step 25: The Windows answers in the design `[inline: needs the user's survey report from work machine #1]`

Files: `docs/design-layers.md`, `docs/plan-single-engine-7.md`.

Needs the answer to step 1's prompt. If it isn't in the conversation or `docs/windows-survey.md`, push-notify and stop
here. Redact it (`work-tool-1`), show the redacted text to the user, then settle "Confirm on Windows": shell, Git Bash
and `jq`, `$HOME` in commands, the current layout, the unsigned program, which hooks the work machines need. Write the
Windows overlay's keys into step 26's spec (a plan edit) and the `~` versus `<HOME>` Open item.

Test: `npx prettier --check docs/design-layers.md docs/plan-single-engine-7.md`.

## Step 26: The Claude layout tool `[worker]`

Files: `tools/claude-layout.ts` (new), `tools/claude-layout.test.ts` (new).

Decision 8: `bun tools/claude-layout.ts <repo folder>` writes the base and Linux `settings.json` layers, the Windows
overlay with the keys step 25 lists, and the v2 entries widened to Windows, and drops the v1 entries' Claude rows
only when given `--cutover`. The test runs it on a temp copy of the repo and merges the Linux layers with
`mergeJson`: the result equals `dotfiles/linux/claude/settings.json` except `statusLine`, which is
`{"type": "command", "command": "mksync statusline"}`. Not run on the real repo in this phase.

Test: `bun test tools/claude-layout.test.ts && bun run lint`.

## Step 27: Docs `[inline: docs step]`

Files: `docs/sync-contract.md`, `docs/design-layers.md`, `docs/plan-single-engine.md`, `README.md` if it lists the
program's commands, `tests/parity/README.md`.

Contract: "The program" table and usage line, the new sections checked against what was built, the count of shared
cases. Design: an "As built in phase 7" note per section; Open updated (settled items out, the audits' leftovers in,
the phase 9 steps the layout tool needs). Roadmap: phase 9 lists running `tools/claude-layout.ts --cutover`, switching
`statusLine`, and retiring `statusline.sh`.

Test: `npx prettier --check docs/*.md && tests/parity/run.sh --engine dist/mksync`.
