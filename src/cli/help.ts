/**
 * The help texts (contract "The program", "Help"): one per topic, held byte for
 * byte to the contract by help.test.ts. A topic is the command words before the
 * first argument that isn't one; `top` is `mksync --help` alone.
 */

export type HelpTopic =
  | "top"
  | "status"
  | "doctor"
  | "pull"
  | "push"
  | "diff"
  | "check"
  | "preview"
  | "setup"
  | "update"
  | "statusline"
  | "machine"
  | "profile"
  | "setting"
  | "machine show"
  | "machine retire"
  | "profile show"
  | "profile retire"
  | "setting list"
  | "setting move"
  | "export"
  | "import"
  | "commit";

/** Every topic's text, each ending with one newline. */
export const HELP_TEXT: Readonly<Record<HelpTopic, string>> = {
  top: `usage: mksync <command> [<args>]

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
`,
  status: `usage: mksync status

Shows the OS, the repo, origin, what isn't sent, this machine's state and the
next command. mksync with no command runs it. Writes nothing.

Exits 0, or 2 on a usage error.
`,
  doctor: `usage: mksync doctor

Checks what mksync needs, one OK, WARN or MISSING line each, with the command
that installs what is missing. Writes nothing.

Exits 0, 1 with a MISSING line, or 2 on a usage error.
`,
  pull: `usage: mksync pull [--yes] [--force] [<path>...]

Takes the repo's changes: fast-forwards the clone, shows what would change,
asks, then applies it (each changed file keeps a .bak).

Arguments:
  <path>...     only these repo paths; the pull then records no sync point

Options:
  --yes         apply without asking; refuses a pull with no sync point
  --force       skip the check for files changed here; asks [y/N]

Exits 0 when done or declined, 1 on an error, 2 on a usage error.
`,
  push: `usage: mksync push [--yes] [--force] [-m <msg>] [<path>...]

Sends this machine's changes: exports them into the clone, shows them, asks,
then opens a pull request from a sync/ branch. Never pushes to master.

Arguments:
  <path>...     only these repo paths; the push then records no sync point

Options:
  --yes         answer every question with its suggestion
  --force       also send files that changed on both sides
  -m <msg>      the commit message (default: one made from the changes)

Exits 0 when done or declined, 1 on an error, 2 on a usage error.
`,
  diff: `usage: mksync diff [<path>...]

Says which side changed each file since the last sync: IN (the repo), OUT
(this machine), BOTH, or ? with no sync point. Writes nothing.

Arguments:
  <path>...     only these repo paths

Exits 0 when nothing differs, 3 when something does, 1 on an error, 2 on a
usage error.
`,
  check: `usage: mksync check [<path>...]

Shows what a pull would change on this machine. Writes nothing.

Arguments:
  <path>...     only these repo paths

Exits 0 when nothing would change, 3 when something would, 1 on an error, 2 on
a usage error.
`,
  preview: `usage: mksync preview

Shows what a push would send, and runs the leak scan on it. Writes nothing.

Exits 0, 1 on an error, or 2 on a usage error.
`,
  setup: `usage: mksync setup [--name <machine>] [--profile <name>] [--replace <machine>]
                    [--label <text>] [--alias <name>]
                    [--claude none|claude|claude-deepseek]
                    [--mode push|pull-only] [--existing backup|keep|stop]
                    [--bootstrap | --no-bootstrap] [--value KEY=VALUE]...
                    [--yes]

First run: scans this machine, asks what it is for, shows a summary, and only
after a yes writes the machine record and its values and takes the first sync.
Each flag answers one question.

Options:
  --name <machine>     this machine's name (default: the hostname up to its
                       first dot)
  --profile <name>     the profile: personal, or a work profile
  --replace <machine>  take over an old machine's record
  --label <text>       a new profile's label, to find it in lists
  --alias <name>       the public name push branches use
  --claude <mode>      none, claude or claude-deepseek (default: claude when
                       it is installed, else none)
  --mode <mode>        push or pull-only (default: push)
  --existing <action>  files already here: backup, keep or stop
                       (default: backup)
  --bootstrap          also restore apps and packages (Ubuntu only)
  --no-bootstrap       don't ask about apps and packages
  --value KEY=VALUE    a value for <KEY>; repeat for each
  --yes                answer every other question with its suggestion

Exits 0 when done or stopped, 1 on an error, 2 on a usage error.
`,
  update: `usage: mksync update

Replaces the installed mksync with the newest release, checked as the
installers check it.

Exits 0, 1 on a failed download or check, 2 when run from the clone or on a
usage error.
`,
  statusline: `usage: mksync statusline

Prints Claude Code's status line from the JSON on stdin. Claude Code runs it.

Exits 0, or 2 on a usage error.
`,
  machine: `usage: mksync machine <command>

Commands:
  show          print this machine's record
  retire        retire a machine record, so it can't push

Run mksync machine <command> --help for its options.
`,
  profile: `usage: mksync profile <command>

Commands:
  show          print a profile: label, modules, value keys, layer files
  retire        retire a profile, so a first run won't offer it

Run mksync profile <command> --help for its options.
`,
  setting: `usage: mksync setting <command>

Commands:
  list          the settings the layers above the base set
  move          move one setting, or one whole file, into another layer

Run mksync setting <command> --help for its options.
`,
  "machine show": `usage: mksync machine show

Prints this machine's record: name, profile, OS, Claude mode, push mode and
modules. Never a value.

Exits 0, 1 with no record, or 2 on a usage error.
`,
  "machine retire": `usage: mksync machine retire <name> [--yes]

Marks a machine record retired, so it can't push. Nothing is deleted.

Arguments:
  <name>        the machine to retire

Options:
  --yes         retire without asking

Exits 0 when retired, 1 when declined or on an error, 2 on a usage error.
`,
  "profile show": `usage: mksync profile show [<name>]

Prints a profile: its label, modules, value keys and the files its layer
holds. Never a value.

Arguments:
  <name>        the profile (default: this machine's)

Exits 0, 1 when there is no such profile, or 2 on a usage error.
`,
  "profile retire": `usage: mksync profile retire <name> [--yes]

Marks a profile retired, so a first run won't offer it. Nothing is deleted.

Arguments:
  <name>        the profile to retire

Options:
  --yes         retire without asking

Exits 0 when retired, 1 when declined or on an error, 2 on a usage error.
`,
  "setting list": `usage: mksync setting list [--profile <p>]

Lists every setting the layers above the base set on this machine, layer by
layer. Never a value, only its placeholder.

Options:
  --profile <p>  that profile's layer instead of this machine's

Exits 0, or 2 on a usage error.
`,
  "setting move": `usage: mksync setting move <file> [<key>] --to base|os|profile|machine
                           [--dry-run | --yes]

Moves one setting, or one whole file, into another layer, keeping this
machine's merged result. Shows the writes and asks first.

Arguments:
  <file>        the entry's file, as sync-config.json names it
  <key>         the key path in a json entry (editor.fontSize); none for
                other kinds

Options:
  --to <layer>  base (all machines), os (this OS), profile or machine
  --dry-run     show the writes and write nothing
  --yes         move without asking

Exits 0 when moved, 1 when refused or declined, 2 on a usage error.
`,
  export: `usage: mksync export [--only <path>]... [--yes]
       mksync export --preview
       mksync export --diff [--only <path>]...

Copies this machine's files into the clone, values turned into placeholders.
mksync push runs it.

Options:
  --only <path>  only this repo path; repeat for more
  --yes          answer the new-setting questions with their defaults
  --preview      what an export would send; writes nothing (mksync preview)
  --diff         which side changed each file; writes nothing (mksync diff)

Exits 0, 1 on an error, 2 on a usage error, 3 when --diff finds changes.
`,
  import: `usage: mksync import [--force] [--reset-values] [--only <path>]...
       mksync import --check [--only <path>]...

Writes the repo's files onto this machine, placeholders filled with its
values; each changed file keeps a .bak. mksync pull runs it.

Options:
  --only <path>   only this repo path; repeat for more
  --force         overwrite without asking
  --reset-values  ask every value again instead of using the saved ones
  --check         what an import would change; writes nothing (mksync check)

Exits 0, 1 on an error, 2 on a usage error, 3 when --check finds changes.
`,
  commit: `usage: mksync commit [-m <msg>] [--partial]

Runs the checks before pushing, commits the exported files on a sync/ branch
and opens a pull request. mksync push runs it.

Options:
  -m <msg>      the commit message (default: one made from the changes)
  --partial     record no sync point (a push of some files only)

Exits 0, or 1 on an error or a failed check, 2 on a usage error.
`,
};

/** The help text for one topic. */
export function helpText(topic: HelpTopic): string {
  return HELP_TEXT[topic];
}
