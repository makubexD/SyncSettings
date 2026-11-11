# Flow: designing the wizard a newcomer walks through

The wizard answers one question for someone who has never used the app: "what do I run, and
with what?" It asks, checks each answer, shows the result, and then runs the real commands.
When it is done, the user has also seen the one-line command they can type next time.

## 1. Entry point

- One command starts it: `app init` when it creates something new, `app setup` when it
  configures something that exists. If the project already has a name for this, keep it.
- It is a normal command: listed in `app --help` with a one-line summary, with its own
  `app init --help` that prints help and runs nothing.
- A bare `app` on a terminal with nothing set up yet may end its help with one line:
  `new here? run 'app init'`. Never start the wizard without being asked.
- Any flag the command accepts can be passed to the wizard too; each flag given skips its step.
  `acme init --theme docs` asks only the rest.

## 2. From commands to steps

List the commands the wizard will end up running, in order. The examples here use an imaginary
static-site tool, `acme`, which runs `acme login`, `acme site create`, then `acme target add`.
For each command, list its inputs, then make a **step table**. Every row maps to exactly one
flag, positional, or (secrets only) environment variable:

| step | asks | kind | flag / positional / env | default | validator | hint | when |
|---|---|---|---|---|---|---|---|
| token | Your acme access token | password | `ACME_TOKEN` for `acme login` | none | `validateToken` | create one at Settings → Tokens; it is never shown or saved in history | not logged in |
| site | Site name | text | `site create <name>` | directory name | `validateSiteName` | lowercase letters, digits, dashes; part of the site's address | no site yet |
| theme | Theme | select | `--theme` | `blog` | choices | docs: sidebar and search; shop: product pages | no site yet |
| features | Extras | multi-select | `--feature` (repeatable) | none | `validateFeature`, per item | add or remove later with `acme site update` | no site yet |
| target | Where to publish | select | `target add <provider>` | `pages` | choices | pages: free hosting; bucket: your own storage | always |

Rules for the table:

- **Multi-select maps to one repeatable flag** (or one comma-separated option); its validator
  runs per item. A follow-up question *per selected item* can't be one step: keep it out of the
  wizard (the hint says which command adds the rest) or make it a second, separate run.
- **Secrets map to an environment variable** (or stdin) the command already reads, never a flag;
  see references/contract.md.
- **Nothing wizard-only.** An input with no flag either gets a flag first (a readiness
  prerequisite) or is dropped. A question that silently decides something ("how many people?"
  to pick a tier) is a hidden flag. Ask for the real option, and explain it in the hint.
- **Validators are the command's own**, imported, never copied. A copy drifts, and the wizard then
  accepts what the command refuses, or the reverse.
- **Defaults come from state**: config, the detected environment (directory name, git remote,
  what already exists), then the declared default. Show where a default came from when that
  isn't obvious.
- **Choices come from the declaration**, in the same order, with a hint per choice when the
  names alone don't explain them.

## 3. Decision tree

Branching goes in the `when` column: a predicate over earlier answers or the detected state.
Draw the tree before writing code:

```
init
├── logged in? ── no ──► token ─┐
│               └ yes ──────────┤
├── site exists? ── no ──► site → theme → features ─┐
│                 └ yes ────────────────────────────┤
└────────────────────────────────────────────────────► target → review
```

- Skip what is already true (the site exists, the flag was given) rather than asking and then
  ignoring the answer.
- Keep it shallow: about seven questions on the common path at most. Advanced options keep their
  defaults unless the user picks "customise" at a single branch point.
- One decision per step. "Template and region?" is two steps.

## 4. Every step has

- **a message**: a short question in plain words, not the flag name (`Where to publish?`, not `--provider`);
- **a hint**: one line saying what the choice changes, or how to change it later;
- **validation**: run on submit; the error appears under the field, in the command's own words,
  and the step asks again. Never move on with an invalid value;
- **back where the library allows it**: returns to the previous *asked* step with its answer as
  the default (references/architecture.md lists how per step kind). Back from the first step asks it again.
  Back is always available at the review, so a step kind with no back is still covered;
- **cancel**: Ctrl-C (and Esc where the library supports it) leaves without changes; see references/contract.md.

Warnings belong at the step that causes them ("`bucket` needs your storage credentials set
up first"), not at the end.

## 5. Review, then the equivalent commands

After the last step and before anything changes:

```
Review
  login     token from ACME_TOKEN
  site      field-notes (theme docs, search)
  target    pages

This runs:
  ACME_TOKEN=… acme login
  acme site create field-notes --theme docs --feature search
  acme target add pages

› Run   Back   Change an answer   Decline
```

- Show the equivalent command lines exactly as a user would type them, quoted for the shell,
  with defaults omitted. They are the lesson: next time the user can skip the wizard.
- For destructive or remote steps, also show the command's dry-run output (when it has one)
  and default the confirmation to **no**.
- **Back** returns to the last asked step; **Change an answer** lists the steps and jumps to one;
  both re-ask the later steps with their answers as defaults. **Decline** leaves everything
  unchanged (exit 1).

## 6. Running

- Run the commands in order through the same function the parser calls. Stop at the first
  failure: report which command failed and what already happened, and print the remaining
  commands so the user can finish by hand.
- Print each command's own output unchanged: its payload stays on stdout.
- End with one line of next steps (`next: acme publish`), not a celebration.

## 7. Writing it down (design report)

The design is complete when it has: the readiness verdict, the entry point, the tree, the
step table, the review screen as it will appear, the non-terminal behaviour (references/contract.md),
and the open questions. Step names in the table become test names later.
