# Smart first run, phase 4: help and messages (`v1.5.0`)

Roadmap: `docs/plan-smart-first-run.md` (phase 4). Branch `engine/help-and-messages`. Contract:
`docs/sync-contract.md` ("Front door", its `pull` row and prompt rule, "mksync setting", "The program", "Machines").
Design: `docs/design-layers.md` ("Decided in phase 9", decision 7; "Open").

The user said yes to phase 4 on 2026-11-27, breaking changes included. It closes the last audit rows: WIZ-10 (pull's
apply question defaults to yes), CLI-1 (`--help` at every level), CLI-2 (an unknown command says so), CLI-3 (contract
lines that say exit 1 where the program exits 2) and CLI-4 (`mksync profile show`, which
`docs/plan-work-machines.md` steps 3 and 4 already tell the user to run).

**Breaking.** An empty answer to pull's question now applies; `--help` and `-h` change output and exit code, and
`mksync` alone now runs the status (exit 0) instead of printing a usage line; an unknown command or group verb prints a new line. No command or flag is renamed; one verb is added
(`profile show`). Every test runs on stubs in throwaway folders, as the shared cases do.

## Decided (proposed, for review)

1. **`--help` and `-h`, at every level.** An argument that is exactly `--help` or `-h`, anywhere on the line, prints
   help on stdout and exits 0. It reads no repo, record, config or network, and runs nothing, whatever else is on the
   line (`mksync push --yes --help` pushes nothing). The topic is the command words before the first argument that
   isn't one: `mksync --help` (top level), `mksync pull --help`, `mksync pull dotfiles/x --help` (pull),
   `mksync setting --help` (the group), `mksync setting move vscode/settings.json --help` (the verb). Help wins over
   every other parse rule, including a flag that takes a value: `mksync push -m --help` prints push's help, because no
   message is exactly `--help` or `-h` (alternative: keep `-m`'s rule that the next argument is the message, and push
   with the message `--help`; rejected, a typo would open a PR). An unknown command or group verb with `--help` is
   still decision 4's or 5's error, exit 2: there is no help to show for it. The lower-level verbs (`export`,
   `import`, `commit`) answer `--help` with their own text but stay off the top-level list.
   - Not added (kept in the design's "Open"): a `mksync help <command>` verb (the `cli` skill's second spelling; a new
     command name) and "did you mean" suggestions.

2. **Help format.** Every text fits in 80 columns, ends with one newline, and is written once in the contract ("The
   program", a new "Help" subsection, one `text` block per topic) and once in `src/cli/help.ts`, which a unit test
   holds to the contract byte for byte. Line endings follow every other stdout text. The top level:

   ```text
   usage: mksync <command> [<args>]

   Keeps this machine's settings in step with the repo.

   Every day:
     status        where this machine stands, and the next command
     pull          take the repo's changes onto this machine
     push          send this machine's changes as a pull request
     diff          which side changed each file since the last sync
     check         what a pull would change; writes nothing
     preview       what a push would send; writes nothing

   Set up and look after:
     setup         first run: the machine record, its values, the first sync
     doctor        check what mksync needs
     update        replace mksync with the newest release
     machine       show or retire a machine record
     profile       show or retire a profile
     setting       list the settings above the base, or move one
     statusline    print Claude Code's status line

   Options:
     -h, --help    show this help; mksync <command> --help shows a command's
     --version     print mksync's version

   Exit codes: 0 done, 1 failed or declined, 2 usage error, 3 changes found
   (check, diff).
   ```

   A command: its usage line (wrapped at a space, the next line indented under the first argument), one or two
   sentences, `Arguments:` and `Options:` with each default and allowed value, and its exit codes from the contract's
   table. For example:

   ```text
   usage: mksync pull [--yes] [--force] [<path>...]

   Takes the repo's changes: fast-forwards the clone, shows what would change,
   asks, then applies it (each changed file keeps a .bak).

   Arguments:
     <path>...     only these repo paths; the pull then records no sync point

   Options:
     --yes         apply without asking; refuses a pull with no sync point
     --force       skip the check for files changed here; asks [y/N]

   Exits 0 when done or declined, 1 on an error, 2 on a usage error.
   ```

   A group lists its verbs:

   ```text
   usage: mksync setting <command>

   Commands:
     list          the settings the layers above the base set
     move          move one setting, or one whole file, into another layer

   Run mksync setting <command> --help for its options.
   ```

   Topics: the top level; `status`, `doctor`, `pull`, `push`, `diff`, `check`, `preview`, `setup` (every flag
   `parseSetup` takes, `--alias`, `--label` and `--value` included), `update`, `statusline`; the groups `machine`,
   `profile`, `setting`; `machine show`, `machine retire`, `profile show`, `profile retire`, `setting list`,
   `setting move`; `export`, `import`, `commit`. Step 1 writes every text in the contract.

3. **No command runs `mksync status`** (user decision, 2026-11-28): `mksync` alone prints and exits exactly as
   `mksync status` does, as the Front door table's first row and the README already say. Today's one-line usage on
   stderr, exit 2, goes; help is only on `--help` and `-h`.

4. **An unknown command** (a first word that is no command and doesn't start with `-`) prints, on stderr, exit 2:

   ```text
   ERROR: unknown command <word>
   Run mksync --help for the list of commands.
   ```

   Today it prints the usage line. A first word starting with `-` other than `--help`, `-h` and `--version` stays
   `Unknown option: <arg>`, exit 2. `Unknown option:` keeps its wording and gets no hint line (alternative: add
   `Run mksync <command> --help for its options.`; it appears in about ten contract places and no shared case, so it
   can follow in a later phase; kept in "Open").

5. **Group verbs name the group,** as `setting` already does. On stderr, exit 2, each followed by
   `Run mksync <group> --help for its commands.`:

   ```text
   ERROR: machine needs show or retire
   ERROR: unknown machine command <verb>
   ERROR: profile needs show or retire
   ERROR: unknown profile command <verb>
   ERROR: setting needs list or move
   ERROR: unknown setting command <verb>
   ```

   Today `mksync machine list` is `Unknown option: list` and `mksync machine` alone prints the usage line. The setting
   lines keep their wording and gain the hint. An option in the verb's place stays `Unknown option: <arg>`.

6. **Pull's apply question defaults to yes (WIZ-10).** After the diff guard passes, pull asks
   ` Apply these changes? [Y/n]`: an empty answer or one starting with `y` or `Y` applies; any other answer, and end
   of input, prints `  Nothing applied.`, exit 0 (end of input is no: nobody is there to answer). Two questions stay
   `[y/N]`, where an empty answer and end of input are no:
   - `pull --force`, which skipped the diff guard: ` Apply these changes? [y/N]`.
   - The first pull with no sync point, after its warning (proposed: it overwrites files the pull can't check, as
     `--force` does; alternative: `[Y/n]` there too, since the warning line is printed right above it).

   Push's `Open a PR with these changes? [y/N]`, `setting move`'s and the retire questions are unchanged. `--yes`
   still answers every one of them. The Front door's prompt rule becomes: every `[Y/n]` prompt takes an empty answer
   or end of input as yes, every `[y/N]` prompt as no, except `mksync setup`'s confirm and pull's
   `Apply these changes? [Y/n]`, where end of input is no.

7. **Contract exit codes corrected to the program (CLI-3).** Every parse error exits 2 (design, "Decided in phase 9",
   decision 7, and the shared cases `reset-values-check-refused` and `push-preview-yes`), so the contract changes, not
   the code. The four lines the audit found, all in "The program" ("Flag errors, each exit 1 before anything runs"):
   1. `ERROR: --only needs a path.` (also "Picking files": "`--only` with no path after it is an error, exit 1")
   2. `ERROR: --diff cannot be combined with --preview or --yes.` (also "Diff": "(error, exit 1)")
   3. `ERROR: --check cannot be combined with --reset-values.` (also "Import check": "is an error, exit 1")
   4. `Missing value for -m` "(`commit`, `push`)": `push` prints it; `commit` prints `ERROR: -m needs a value.`; both
      exit 2. The line is corrected to name each.

   Two more found while checking, corrected the same way: "New settings" says `ERROR: --preview and --yes can't be
used together.` exits 1 (it exits 2, case `push-preview-yes`), and "Export preview" says `--preview` with
   `--reset-values` "is an error ... exit 1" (it is `Unknown option: --reset-values`, exit 2; the not-a-git-repo half
   of that line stays exit 1). `--preview` with `--only` is the export's own refusal and stays exit 1 (case
   `preview-only-refused`). A shared case, `flag-errors-exit`, pins all of them.

8. **`mksync profile show [<name>]` (CLI-4).** Prints a profile from the store `profile retire` reads, exit 0, never
   a value:

   ```text
   profile   work1
   label     job 1 laptop
   modules   work-base, git, shell, vscode, claude
   values    <WORK_EMAIL>, <WORK_ORG>
   layer     2 file(s): claude/settings.json, vscode/settings.json
   ```

   - `<name>` defaults to this machine's record's profile. `label` prints only when the profile has one; a retired
     profile adds `retired   yes` last, as `machine show` does.
   - `values`: the profile's value keys with their `<` `>`, in code-unit order, never their values; `none` with
     none. `layer`: the entry `file`s (a `dir` entry's as `<file>/<name inside>`) the profile layer holds, in the
     config's entry order, from the folder `setting list --profile` reads; `0 file(s)` with none.
   - No `<name>` and no record: `ERROR: no machine record here; run mksync setup, or name a profile.`, exit 1. A
     profile not in the store: retire's `ERROR: profile <name> not found: <state>/profiles/<name>.json`, exit 1. A
     second positional or an option: `Unknown option: <arg>`, exit 2.
   - Alternative: no new verb; `docs/plan-work-machines.md` points at `mksync setting list --profile work1`, which
     already shows that layer key by key. Proposed to add it: `machine show` has a `profile` counterpart, and the
     summary (label, modules, value keys) isn't in `setting list`.

9. **Version `v1.5.0`.** `CHANGELOG.md` gets `### Changed` for decisions 3 to 6 (breaking, worded as `v1.3.0` words
   its changes) and `### Added` for decisions 1, 2 and 8. `v1.4.0`'s move entry is corrected: a move bound for the
   base or an OS layer is refused when it holds a profile value or a machine value, not only a profile value. The tag
   and release wait for the user, as before.

## Step 1: Contract and design `[inline: contract wording]`

Files: `docs/sync-contract.md`, `docs/design-layers.md`.

- Contract, "Front door": the prompt rule (decision 6), the `pull` row and the first-pull paragraph (`[Y/n]` after
  the guard, `[y/N]` with `--force` and with no sync point), the `pull`/`push` shared-lines bullet, the table's first
  row (decision 3).
- Contract, "The program": a "Help" subsection with decisions 1 and 2 and one `text` block per topic (every text in
  full); the no-command line and the usage block replaced by decision 3; decisions 4 and 5's lines; decision 7's
  corrections there and at each repeated statement ("Picking files", "Export preview", "Import check", "Diff", "New
  settings").
- Contract, "mksync setting": the unknown-verb paragraph says every group names itself, and both lines gain the hint.
- Contract, "Machines": a `#### mksync profile show` section after `machine show` (decision 8); the front door's
  `machine …, profile …` row names it.
- Design: "Decided in phase 9" decision 7 gets a note pointing at the contract's group-verb lines; the item near
  "An unknown verb in a group (`mksync machine list`) exits 1" is marked settled; "Open" gains decision 1's two
  leftovers and decision 4's `Unknown option` hint.

Test: `npx prettier --check docs/sync-contract.md docs/design-layers.md`; `grep -n "#### Help\|#### .mksync profile
show." docs/sync-contract.md` prints two lines; `grep -n "each exit 1 before anything runs" docs/sync-contract.md`
prints nothing.

## Step 2: A raw command line in the shared cases `[worker:low]`

Files: `tests/parity/run.sh`, `tests/parity/run.ps1`, `tests/parity/README.md`.

- A command `args` with a field `argv` (an array of strings, required, may be empty) next to `command`: it runs
  `./mksync` (`mksync.cmd` in `run.ps1`) with exactly those arguments, no options added; any `options` key on it is
  the runner's unknown-option error. Its output is whole stdout, as `setup` and `machine-show` are; `stderr: true`
  adds stderr after it, as for every command. README's command list gains it, with one example.

Test: `bash -n tests/parity/run.sh`, then `bun run build && tests/parity/run.sh --engine dist/mksync
"front-|reset-values|machine-show"` passes (no case uses `args` yet); `run.ps1` runs in the VM layer.

## Step 3: Shared cases for help `[worker]`

Files: `tests/parity/cases/help-top/`, `tests/parity/cases/help-command/`, `tests/parity/cases/help-group/`.

Each `os` linux, a plain clone with one `whole` entry, every command `args` with `stderr: true`. Write `expect/` from
the contract's "Help" texts (step 1), not from the program.

- `help-top`: `["--help"]` → the top-level text on stdout, nothing on stderr, exit 0; `["-h"]` → the same;
  `["--version", "--help"]` → the same; `["status"]` and then `[]` → the same status lines on stdout, the same exit
  (decision 3).
- `help-command`: `["pull", "--help"]` → pull's text, exit 0; `["status", "-h"]` → status's text, exit 0;
  `["push", "--yes", "--help"]` → push's text, exit 0, and the clone's `HEAD`, branches and files unchanged (no
  `gh.log`); `["push", "-m", "--help"]` → push's text, exit 0; `["setting", "move", "vscode/settings.json",
"--help"]` → setting move's text, exit 0; `["export", "--help"]` → export's text, exit 0.
- `help-group`: `["setting", "--help"]`, `["machine", "--help"]`, `["profile", "-h"]` → each group's text, exit 0.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync help-` reports 3 failed.

## Step 4: Shared cases for unknown commands and the flag errors `[worker]`

Files: `tests/parity/cases/unknown-command/`, `tests/parity/cases/unknown-group-verb/`,
`tests/parity/cases/flag-errors-exit/`.

All `os` linux, commands `args` with `stderr: true`, nothing on stdout, no file changed. Write `expect/` from the
contract.

- `unknown-command`: `["bogus"]` → `ERROR: unknown command bogus` and `Run mksync --help for the list of commands.`,
  exit 2; `["bogus", "--help"]` → the same two lines, exit 2; `["-x"]` → `Unknown option: -x`, exit 2.
- `unknown-group-verb`: `["machine", "list"]` → `ERROR: unknown machine command list` and
  `Run mksync machine --help for its commands.`; `["machine"]` → `ERROR: machine needs show or retire` and the
  hint; `["profile", "list"]` → `ERROR: unknown profile command list` and `Run mksync profile --help for its
commands.`; `["profile"]` → `ERROR: profile needs show or retire` and the hint; `["setting", "copy"]` →
  `ERROR: unknown setting command copy` and `Run mksync setting --help for its commands.`; each exit 2.
- `flag-errors-exit`: `["export", "--only"]` → `ERROR: --only needs a path.`; `["export", "--diff", "--yes"]` →
  `ERROR: --diff cannot be combined with --preview or --yes.`; `["import", "--check", "--reset-values"]` →
  `ERROR: --check cannot be combined with --reset-values.`; `["push", "-m"]` → `Missing value for -m`;
  `["commit", "-m"]` → `ERROR: -m needs a value.`; `["export", "--preview", "--yes"]` →
  `ERROR: --preview and --yes can't be used together.`; `["export", "--preview", "--reset-values"]` →
  `Unknown option: --reset-values`; each exit 2.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync "unknown-|flag-errors"` reports 2 failed
(`flag-errors-exit` passes: the program already exits 2, decision 7).

## Step 5: The help texts `[worker:low]`

Files: `src/cli/help.ts`, `src/cli/help.test.ts`.

- `HelpTopic` (a union of decision 2's topics, `"top"` for the top level), `HELP_TEXT: Readonly<Record<HelpTopic,
string>>` with every text copied byte for byte from the contract's "Help" subsection, and
  `helpText(topic): string`. No logic beyond the lookup.
- Unit tests: for every topic, the text equals the contract's `text` block under that topic's heading (the test reads
  `docs/sync-contract.md`, finds the "Help" subsection and its blocks); every line is at most 80 columns; every text
  ends with exactly one `\n`; the record's keys are exactly the contract's topics, none missing, none extra.

Test: `bun test src/cli/help.test.ts`.

## Step 6: Parse help, unknown commands and group verbs `[worker]`

Files: `src/cli/parse.ts`, `src/cli/parse.test.ts`.

- A `ParsedCommand` kind `help` (`topic: HelpTopic`). `parseArgs` first looks for an argument
  that is exactly `--help` or `-h`; when there is one, it resolves the topic from the command words before the first
  argument that isn't one (decision 1) and returns `help`, unless the first word is no command (decision 4's error)
  or the group's verb is unknown (decision 5's error). No command: the `status` command, exactly as `["status"]` parses (decision 3).
- Decision 4's error for an unknown first word; decision 5's two lines per group for `machine` and `profile`; the
  hint appended to both setting errors. Each message is the full two lines without a trailing newline. `profile show
--help` is help (its topic exists); `profile show` alone stays an unknown verb here
  (`ERROR: unknown profile command show`) until step 12 adds it. `UsageCommand` and `USAGE` go; `main.ts`'s
  re-export of `USAGE` is left for step 7.
- Unit tests, each with its exact result: `--help` → `help top`; `-h`; `[]` → the `status` command; `pull --help`;
  `pull --yes --force --help` → `help pull`; `pull dotfiles/x -h` → `help pull`; `push -m --help` → `help push`;
  `setup --name --help` → `help setup`; `setting --help` → `help setting`; `setting move a b --to base --help` →
  `help setting move`; `machine retire wk1 --help` → `help machine retire`; `export --help`; `commit -m x --help`;
  `--version --help` → `help top`; `bogus` and `bogus --help` → decision 4's error, 2; `-x` → `Unknown option: -x`,
  2; `machine`, `machine list`, `profile`, `profile list`, `setting`, `setting copy` → decision 5's lines, 2;
  `machine list --help` → the unknown-verb error, 2. Every existing test that expected `USAGE` for an unknown word
  now expects decision 4's error.

Test: `bun test src/cli/parse.test.ts`.

## Step 7: Print help from the program `[worker]`

Files: `src/main.ts`, `src/main.test.ts`.

- `run()`: the `help` kind returns `{ code: 0, stdout: helpText(topic), stderr: "" }`; the `usage` case and the `USAGE` re-export go (nothing else
  imports it).
- Unit tests: `run(["--help"])` and `run(["setting", "move", "--help"])` with their exact code and streams; `run([])`
  returns the status command;
  `run(["push", "--yes", "--help"])` returns a result, not a command to execute.

Test: `bun test src/main.test.ts` and `bun run build && tests/parity/run.sh --engine dist/mksync
"help-|unknown-|flag-errors"` pass (steps 3 and 4).

## Step 8: Shared cases for pull's question `[worker]`

Files: `tests/parity/cases/pull-default-no/` (renamed with `git mv` to `pull-default-yes/`),
`tests/parity/cases/pull-eof-no/`, `tests/parity/cases/pull-force-enter-no/`,
`tests/parity/cases/pull-no-sync-point-enter/`.

All `os` linux, `git` remote, an `IN` file `parity/b.conf`, interactive (no `--yes`). Write `expect/` from the
contract (decision 6).

- `pull-default-yes`: sync point, stdin `\n`. Expect the file applied (`UPDATED dotfiles/common/parity/b.conf`, the
  local file now the repo's, its `.bak` in `expect/home/`), no `Nothing applied.`, exit 0. Its description says why
  the default changed.
- `pull-eof-no`: sync point, stdin empty (end of input). Expect `Nothing applied.`, the local file unchanged, exit 0.
- `pull-force-enter-no`: sync point, `--force`, stdin `\n`. Expect `Nothing applied.`, file unchanged, exit 0.
- `pull-no-sync-point-enter`: no sync point, stdin `\n`. Expect the `No sync is recorded on this machine: …` line,
  `Nothing applied.`, file unchanged, exit 0.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync "pull-(default|eof|force-enter|no-sync-point-enter)"`
reports 1 failed (`pull-default-yes`; the other three hold today's behavior, which decision 6 keeps).

## Step 9: Pull asks `[Y/n]` `[worker]`

Files: `src/app/pull.ts`, `src/app/pull.test.ts`, `src/main.ts`.

- `PullDeps.ask(question, answers)`, where `answers` is `{ readonly empty: boolean; readonly end: boolean }` (what
  an empty answer and end of input mean). The apply question after the guard is ` Apply these changes? [Y/n]` with
  `{ empty: true, end: false }` unless `input.force`, where it stays `[y/N]` with `{ empty: false, end: false }`; the
  no-sync-point question is unchanged (`[y/N]`, both false).
- `main.ts`: `pullAnswer` and `askTerminalQuestion` take `answers` (`undefined` from the terminal is `end`, a trimmed
  empty answer is `empty`); push's PR question passes `{ empty: false, end: false }`, unchanged in effect.
- Unit tests: after the guard, an empty answer applies; `y` applies; `n` and `x` print `Nothing applied.`; end of
  input prints `Nothing applied.`; the question text is `[Y/n]`; with `--force` the text is `[y/N]` and an empty
  answer doesn't apply; no sync point, an empty answer doesn't apply; `--yes` asks nothing. Existing tests that
  expected a no default after the guard are updated.

Test: `bun test src/app/pull.test.ts src/app/push.test.ts` and `bun run build && tests/parity/run.sh --engine
dist/mksync pull-` pass.

## Step 10: Shared cases for `profile show` `[worker]`

Files: `tests/parity/cases/profile-show/`, `tests/parity/cases/profile-show-no-record/`.

Both `os` linux, commands `args`, `stderr: true`. Write `expect/` from the contract (decision 8).

- `profile-show`: a record with profile `work1`, its profile with a label `job 1 laptop`, modules `git, vscode`,
  values `<WORK_ORG>` and `<WORK_EMAIL>` (the values themselves must not appear anywhere in the output), a layer file
  for `vscode/settings.json`; a second profile `work2`, retired, with no label, values or layer files. Commands:
  `["profile", "show"]` → decision 8's five lines for `work1` (`values    <WORK_EMAIL>, <WORK_ORG>`,
  `layer     1 file(s): vscode/settings.json`), exit 0; `["profile", "show", "work2"]` → `profile`, `modules`,
  `values    none`, `layer     0 file(s)`, `retired   yes`, exit 0; `["profile", "show", "work9"]` →
  `ERROR: profile work9 not found: <state>/profiles/work9.json` (the runner's state placeholder), exit 1;
  `["profile", "show", "work1", "x"]` → `Unknown option: x`, exit 2. Nothing written.
- `profile-show-no-record`: no record; `["profile", "show"]` →
  `ERROR: no machine record here; run mksync setup, or name a profile.`, exit 1.

Test: `bun run build && tests/parity/run.sh --engine dist/mksync profile-show` reports 2 failed.

## Step 11: Render `profile show`, pure `[worker]`

Files: `src/core/machine/profile-show.ts`, `src/core/machine/profile-show.test.ts`.

- `renderProfileShow(profile, layerFiles)` returns decision 8's lines, in the layout of `renderMachineShow`
  (`src/core/machine/show.ts`: the same label column width). `layerFiles` is the list of entry files, already in
  config order.
- Unit tests: the five lines with a label; no label → no `label` line; retired → `retired   yes` last; no values →
  `values    none`; no files → `layer     0 file(s)`; keys sorted by code unit (`<B>` before `<a>`); a value never
  appears in the output.

Test: `bun test src/core/machine/profile-show.test.ts`.

## Step 12: `mksync profile show` `[worker]`

Files: `src/cli/parse.ts`, `src/cli/parse.test.ts`, `src/main.ts`.

- Parse: `profile show [<name>]` → `{ kind: "profile-show", target?: string }`; a second positional or any option is
  `Unknown option: <arg>`, 2 (`--help` already went to step 6's branch).
- `main.ts`: the kind in `run()` and `execute`: read the store as `profile retire` does (state or repo store), take
  `target` or the record's profile, the two errors of decision 8 (exit 1), the layer's files from the folder
  `setting list --profile` reads (`src/app/setting.ts`; reuse its helper, don't copy it), print `renderProfileShow`,
  exit 0.
- Unit tests: `profile show`, `profile show work1`, `profile show work1 x` and `profile show --yes` with their exact
  results.

Test: `bun test src/cli/parse.test.ts` and `bun run build && tests/parity/run.sh --engine dist/mksync
"profile-show|help-"` pass.

## Step 13: Docs, changelog and version `[inline: user-facing docs]`

Files: `CHANGELOG.md`, `README.md`, `docs/daily-workflow.md`, `docs/pull-push-modes.md`, `package.json`,
`docs/plan-smart-first-run.md`.

- `CHANGELOG.md` `v1.5.0`: `### Changed` (pull's `[Y/n]` and its two `[y/N]` exceptions; `mksync` alone prints the
  help, exit 2; the unknown command and group verb lines; the contract's exit codes corrected, no behavior change)
  and `### Added` (`--help`/`-h` at every level; `mksync profile show`). `v1.4.0`'s move entry: "holds a profile
  value or a machine value".
- `README.md`: the command list gains `profile show` and a line on `mksync --help`.
- `docs/daily-workflow.md` and `docs/pull-push-modes.md`: every "Enter is No" for pull's question says Enter applies
  after the check, and stays No for `--force` and the first pull; the first-pull paragraph keeps `[y/N]`; a short
  "Getting help" paragraph.
- `package.json` `1.5.0`. Roadmap: phase 4 points at this plan and is marked done when the PR merges.

Test: `npx prettier --check docs README.md CHANGELOG.md`; `grep -n '"version": "1.5.0"' package.json` prints one
line; `grep -n "Enter is No" docs/daily-workflow.md` names only `--force` or the first pull.
