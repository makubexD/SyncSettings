# Findings, reports, and validation

## Classes

Each finding gets one class, and the class describes the recommended **change**, not the defect: it
decides what needs an explicit yes. Order reports by this table, then by who is affected.

| Class | Meaning |
|---|---|
| `BREAKING` | Something users or scripts already rely on changes: exit codes, what goes to stdout, flags that are renamed, removed, or take different values, or the commands the wizard runs. Adding a new flag or command is not breaking. |
| `SAFETY` | The change stops the wizard from losing or changing data unexpectedly: partial state, an unconfirmed destructive step, secrets in flags. |
| `UX` | A newcomer gets through more easily: back, hints, review, the equivalent command, discoverability. |
| `CONSISTENCY` | The wizard and the commands agree: the same validators, choices, names, and defaults. |
| `MAINTAINABILITY` | The wizard becomes easier to change: an engine separated from the library, one code path, tests. |
| `COSMETIC` | Wording or layout only. |

A fix that is `SAFETY` but also changes an exit code or stdout is `BREAKING`: the class that needs
approval wins. Say so in the finding.

## Finding template

```
WIZ-3  SAFETY
What:     Cancelling at the theme question leaves ~/.acme/config.json already rewritten.
Evidence: src/setup.ts:57 saveConfig() runs right after the token question; reproduced in a temp
          HOME: answer the token, press Ctrl-C → config.json changed, exit 0.
Affects:  anyone who cancels part-way.
Change:   ask everything first; save only after the review (references/contract.md "No partial state").
```

Every finding needs evidence a reader can open: a file and line, a help line, a test, or a
command with its actual output. Drop a finding you cannot point at. Cite a line number only
from a numbered read of that one file, and check that the line says what you claim.

## Report: audit (also the first turn of refactor)

```
### Readiness            (R1–R8 with evidence, and the verdict)
### Current flow         (the steps as they are asked today, with the flag each maps to, or "none")
### Findings             (ordered by class)
### Target flow          (the step table and tree after the recommended changes)
### Approval
### Not verified
```

The approval block ends the report:

```
Hold for an explicit yes:
- WIZ-1 (BREAKING) exit 2 and name the flags when there is no terminal, instead of reading piped input
Ready when you say to implement:
- WIZ-4 (UX) review step with the equivalent command
```

## Report: design

```
### Readiness
### Entry point           (name, how newcomers find it, flags it accepts)
### Decision tree
### Step table            (references/flow.md columns)
### Review screen         (as it will appear, with the equivalent commands)
### Contract              (no terminal, streams, exit codes, cancel, destructive steps, secrets)
### Decisions             (each non-obvious choice and the rejected alternative)
### Open questions
### Not verified
```

## Report: build and the end of refactor

```
### What changed          (files; finding ids for refactor)
### Validation list       (below, ticked)
### Transcript            (one scripted run: questions → review → equivalent command → result)
### Not verified          (always includes the real-terminal check, with the exact command)
```

## Validation list

- [ ] Readiness R1–R4 hold; any prerequisites were fixed first.
- [ ] Every step maps to one flag or positional; nothing is wizard-only (parity test).
- [ ] Step validators are the commands' own, imported (test asserts identity or the shared import).
- [ ] Flags given on the command line skip their steps.
- [ ] The review offers Back and Change an answer; per-step back exists wherever the library allows it.
- [ ] Cancel exits 130 and leaves files and config unchanged (snapshot test).
- [ ] No terminal and no `--no-input`: exit 2 naming the flags, changes nothing, even when every
      value has a default. `--no-input` with every required value: runs without questions; with one
      missing: exit 2 naming it. stdout empty on exit 2, no hang.
- [ ] Prompts, hints, and the review go to stderr; stdout holds only the commands' payload.
- [ ] A review shows the summary and the equivalent command lines before anything changes.
- [ ] Destructive or remote steps show a dry run and default the confirmation to no.
- [ ] Secrets are never visible as typed, never shown in the equivalent command, never passed as flags.
- [ ] The entry point is in top-level help; `init --help` prints help and prompts nothing.
- [ ] Colour follows FORCE_COLOR, NO_COLOR, TERM=dumb, and the terminal; meaning never rests on colour alone.
- [ ] The prompt library is imported by one adapter file only.
- [ ] The whole suite passes; the output is shown.

## The newcomer test

Close every build and refactor by reading the transcript as someone who has never used the app. Do
they know what each question changes? Could they type the equivalent command tomorrow without the
wizard? Can they tell that nothing happened when they cancelled? "It runs" is not evidence that
it helps.
