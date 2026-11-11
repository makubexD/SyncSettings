# Auditor brief

This brief can be handed to a fresh-context reviewer (a subagent, a second session, or a
different model) or followed directly. It needs only the four files it names, all in this
skill. Every `references/…` path here is relative to the skill root, the folder holding
`SKILL.md`, not to this file. The auditor reads, and runs only commands proven read-only. It
never edits files.

Read `references/grammar.md`, `references/contract.md`, `references/findings.md`, and
`references/migration.md` before classifying anything.

## Scope

Audit the binary or command group the request names. With none named, audit every binary the
package declares (its `bin`, console scripts, or main entry), and say which in the report.
Leave unrelated tools in the same repository out, and say so under "Not verified".

## 1. Discovery (read only)

Inspect every surface users and scripts actually invoke, not only the parser registration:

- entry points, package `bin`/`scripts`, console-script or module entry, Makefiles and task
  runners, CI workflows, Docker/Podman entrypoints, shell completion files;
- command registration: subcommands, positionals, options, aliases, defaults, help text;
- configuration files, environment variables, exit codes;
- stdout versus stderr, structured output, error text;
- tests that lock the current surface; README, docs, and examples.

Search the entire repository for actual usage of the command name and of every subcommand
and option string you might recommend changing, and record each hit with file and line. Do
not assume the implementation is the only source of truth.

## 2. Running the CLI safely

Running commands is evidence, but a CLI that mishandles help can deploy when asked for help.
Before running anything:

1. Read the dispatch code. Confirm that `--help`, unknown commands, and unknown options are
   handled before any command's action runs, and that the command you plan to run touches
   no file, network, or shared state.
2. If you cannot confirm that for a command, do not run it: run `--help` only at the root
   and group levels where it is proven safe, and list the rest under "Not verified".
3. Never run a command that writes, deletes, deploys, prompts, or contacts a remote, even
   with `--dry-run`, unless the code shows the dry run is honored.
4. Do not build or install the project to get a runnable binary (builds write files and can
   run install scripts). If no runnable entry exists, audit from code and say so.

When a command is safe, record stdout, stderr, and exit code separately. Feed stdin from an
empty pipe (not the null device, which Windows reports as a terminal), and unset
`NO_COLOR` and `FORCE_COLOR` so you see the defaults. Capture output in memory or in files under
a fresh temporary directory, never inside the project: an audit leaves the tree as it found it.

Record a default only when help, code, or a test states it. Unknown stays unknown.

## 3. Current model

Draw the command tree for the scope:

```
app
├── users
│   ├── list
│   └── get <id>
└── release
    └── deploy <version>
```

Then one command card per command (defined in `references/findings.md`).

## 4. Findings

Check hierarchy, naming, positionals, options, help, output, composability, errors, exit
codes, interaction, configuration, and compatibility against `references/grammar.md` and
`references/contract.md`. Write each finding with the template and classes in
`references/findings.md` (the class describes the change), with evidence a reader can open. Order by severity.

## 5. Target

Show CURRENT → TARGET for recommended changes only, then the full target tree. Name the
in-repo callers and the migration from `references/migration.md` for each `BREAKING` or
`COMPATIBILITY` row, and end with the approval block from `references/findings.md`.

## Output

Return the report in the audit shape from `references/findings.md`, including "Not verified". Do not
implement anything, even if a fix looks trivial.
