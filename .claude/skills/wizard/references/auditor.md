# Auditor brief

This brief is self-contained within this skill, so it can be handed to a fresh-context reviewer
(a second agent, a second session, or a different model) together with the skill folder, or
followed directly. Every `references/…` path here is relative to the skill root, the folder
holding `SKILL.md`, not to this file. The auditor reads, runs only what it has proven safe, and
never edits files.

Read `references/readiness.md`, `references/flow.md`, `references/contract.md`,
`references/architecture.md`, `references/testing.md`, and `references/findings.md`, plus the
matching `references/stack-<lang>.md` (node-ts, python, go, rust, dotnet) for the project's
language and prompt library, before classifying anything.

## Scope

Audit the wizard the request names. With none named, find every interactive entry point: commands
named `init`, `setup`, `configure`, `onboard`, or `new`; any use of a prompt library or of readline/
`input()`/`Console.ReadLine`; and bare-command behaviour that prompts. Say which you audited, and list
the others under "Not verified".

## 1. Readiness

Run the readiness scan (`references/readiness.md`) on the commands the wizard ends up running. Record R1–R8 with
evidence and the verdict. A wizard over a CLI that fails R2 has at least one wizard-only input:
that becomes a finding.

## 2. Discovery (read only)

- The wizard code: every prompt, in order; what each answer turns into; what gets written or called,
  and when (before or after the last question).
- The commands' declarations and validators, to compare with the wizard's.
- Help output and README: is the entry point listed, and what does `--help` on it do?
- Tests covering the wizard, if any.

Build the **current flow** table: each step, its prompt text, and the flag it maps to (or `none`),
the validator it uses (the command's own, a copy, or none), and whether back, cancel, and a hint exist.

## 3. Running the wizard safely

A wizard that mishandles input can create files or delete data when fed an empty pipe. Before
running anything:

1. Read the code path for the invocation you plan to run. Run it only if it cannot write outside
   a scratch directory, delete, or contact a network: run it with the working directory set to a fresh
   temporary directory, with `HOME`, `USERPROFILE`, `APPDATA`, `XDG_CONFIG_HOME` and the app's own
   config variable pointed inside it, and only when the code shows every write lands there.
2. Safe probes, in this order: `<app> --help`; `<app> init --help` (only if the code shows help is
   handled before the wizard starts, or that the wizard's first steps only read); the entry point
   with stdin from an empty pipe (not the null device, which Windows reports as a terminal); and
   scripted answers piped in, to show what a script would experience.
3. Record stdout, stderr, and the exit code separately, plus the files that appear in the temporary
   directory. Unset `NO_COLOR`, `FORCE_COLOR`, and `CI` so you see the defaults.
4. Never run it in the project's own directory, never against real config or remotes, and never
   install or build the project to get a runnable entry. If it can't be run safely, audit from the code
   and say so.

## 4. Findings

Check against the standard: terminal check and non-terminal exit; streams; back; nothing
wizard-only; reused validators; one code path (the commands' own functions); review and
equivalent command; no partial state on cancel; destructive steps reviewed, with a dry run, defaulting
to no; secrets; discoverable and help-safe; exit codes for cancel (130), decline (1), and usage (2);
colour and accessibility; testability (an engine separate from the library, scripted tests).

Write each finding with the template and classes in `references/findings.md`, with evidence a reader can open.
Report only what you can point at. A suspicion you couldn't confirm goes under "Not verified", not
into the findings.

## 5. Target

Show the target flow: the step table after the recommended changes (every row with its flag and
validator) and the tree. Name the prerequisites in the CLI (readiness) separately from the wizard
changes. End with the approval block from `references/findings.md`.

## Output

Return the report in the audit shape from `references/findings.md`, including "Not verified". Don't implement
anything, even if a fix looks trivial.
