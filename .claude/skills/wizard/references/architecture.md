# Architecture: a flow engine, a prompter port, thin adapters

Prompt libraries draw one question well. Most of them don't do navigation across questions: the
library of every stack lacks "back" between prompts, or has it only inside one form (each stack
file says which). So the navigation belongs to a small engine the project
owns, and the library is an adapter behind an interface. That split also makes the whole wizard
testable without a terminal.

```
entry point (init) ──► terminal check ──► engine ──► Prompter (port)
                                            │           ├── library adapter (real terminal)
                                            │           └── scripted prompter (tests)
                                            ▼
                               plan: commands + argv ──► review ──► the commands' own run()
```

## Pieces

Written as TypeScript-like pseudocode (a sketch, not a library); map it to the stack file's language.

```ts
type Kind = 'text' | 'select' | 'multiselect' | 'confirm' | 'password';
const BACK = Symbol('back');     // the user asked for the previous step
const CANCEL = Symbol('cancel'); // Ctrl-C / Esc

interface Step {
  id: string;                        // the key in `answers`; also the test name
  kind: Kind;
  flag?: string;                     // the option or positional this answer becomes
  env?: string;                      // secrets only: the environment variable instead of a flag
  message: string;
  hint: string;
  choices?: { value: string; label: string; hint?: string }[]; // from the declaration
  initial?(answers, context): unknown;   // from config/state, then the declared default
  validate?(value): string | null;       // the command's own validator (per item for multiselect)
  when?(answers, context): boolean;      // branch predicate; absent means always
}

type Review = 'run' | 'back' | 'edit' | 'decline' | typeof CANCEL;

interface Prompter {
  ask(step: Step, initial: unknown): Promise<unknown | typeof BACK | typeof CANCEL>;
  review(summary: string[], commands: string[]): Promise<Review>;
  pickStep(steps: Step[]): Promise<string | typeof CANCEL>;  // "Change an answer"
  note(message: string): void;                               // to stderr
}
```

Every step has exactly one of `flag` or `env`, a `hint`, and a `validate` unless its kind can't be
invalid (a select or a confirm). A flow is data plus two functions:

- `steps`: the step table from references/flow.md, in order.
- `plan(answers) → Command[]`: turns answers into the commands to run, each one as
  `{ path, positionals, options, env }`. It is pure, which is what the parity test checks.
- `format(command) → string`: the shell line shown in the review (quoted, defaults omitted,
  secrets shown as `NAME=…`, never their value).

**Given values are keyed by step id.** The `init` command parses its own flags with the normal
parser, then maps each one to its step (`fromFlags(flow.steps, parsedValues)`), so `answers`,
`when`, `initial`, and `plan` all read one shape: `answers[step.id]`.

## The engine loop

```ts
async function runFlow(flow, answers, context, prompter, start = 0, given = new Set()) {
  const asked: number[] = [];            // history of steps actually asked
  let i = start;
  while (i < flow.steps.length) {
    const step = flow.steps[i];
    if (given.has(step.id) || (step.when && !step.when(answers, context))) { i++; continue; }
    const value = await prompter.ask(step, answers[step.id] ?? step.initial?.(answers, context));
    if (value === CANCEL) return { status: 'cancelled' };
    if (value === BACK) { if (asked.length) i = asked.pop()!; continue; }
    const problem = invalid(step, value);             // runs validate per item for a multiselect
    if (problem) { prompter.note(problem); continue; } // ask again, same step
    answers[step.id] = value; asked.push(i); i++;
  }
  return { status: 'answered', answers: prune(flow, answers, context), asked };
}

async function wizard(flow, given, context, prompter) {   // given: step id → value from flags
  let answers = { ...given }, start = 0, last = -1;
  for (;;) {
    const result = await runFlow(flow, answers, context, prompter, start, new Set(Object.keys(given)));
    if (result.status === 'cancelled') return result;
    answers = result.answers; last = result.asked.at(-1) ?? last;
    const commands = plan(answers);
    const choice = await prompter.review(summary(answers), commands.map(format));
    if (choice === 'run') return { status: 'run', commands };
    if (choice === 'decline') return { status: 'declined' };
    if (choice === CANCEL) return { status: 'cancelled' };
    const choices = askable(flow, answers, context);
    if (choice === 'back' ? last < 0 : choices.length === 0) {   // every value came from flags
      prompter.note('Nothing to change: every value came from flags.'); continue; // review again
    }
    const id = choice === 'back' ? flow.steps[last].id : await prompter.pickStep(choices);
    if (id === CANCEL) return { status: 'cancelled' };
    start = flow.steps.findIndex((s) => s.id === id); // later answers stay as defaults
  }
}
```

`prune` removes the answers of steps whose `when` is now false (and never touches given values),
so a stale answer never reaches `plan`. `askable` lists the steps that are reachable and not given.
Split these into helpers if the project caps function length; the behaviour is what matters.

Rules the engine keeps:

- Going back re-asks with the previous answer as the default; nothing already answered is lost.
- Re-entering after "back" or "edit" re-asks the steps after the chosen one with their earlier
  answers as defaults, so branches that change get asked and stale ones get pruned.
- The engine performs no I/O except through the prompter and the read-only `context`.
- Validation runs in the engine even when the adapter also validates inline, so the scripted
  prompter exercises it too.

## Back

**Required:** the review offers **Back** (to the last asked step) and **Change an answer** (pick any
step). This works in every library, so every wizard has it.

**Per step, wherever the library allows it** (expected, but the review is the guarantee):

1. **Select steps** get a last choice `← Back`, which the adapter returns as `BACK`.
2. **Text steps**: the library's key hook if it has one; otherwise a lone `<` typed as the answer
   means back, and the hint says so. Pick one convention per project and keep it. Never apply it
   to password steps.
3. **Confirm steps**: shown as a select with Yes / No / `← Back` when the library's confirm prompt
   can't express back.
4. **Multi-select and password steps**: back through the review only (a `← Back` item would be
   selectable alongside real values, and `<` could be a real password).

## Running the plan

- The run step calls the **same function the parser dispatches to** for each command, with parsed
  values built from `plan`. When the actions can't be imported without side effects, run the entry point
  as a child process with the argv instead. Either way there is one code path.
- Before running, re-validate each command's argv with the parser's own validation (for example
  by parsing the formatted line). This catches drift between `plan` and the declarations.
- Stop at the first non-zero exit, and print what ran and the commands that remain.
- Ctrl-C while the commands run: let the running command finish or stop the way it normally does,
  run nothing after it, print what ran and what remains, and exit 130, even when the interrupted
  command was the last one.
- Secrets go to the command through its environment variable (`command.env`), never as argv.

## Where the files go

```
src/wizard/engine.*        # runFlow, wizard, BACK/CANCEL, the Prompter port: no library imports
src/wizard/<name>-flow.*   # steps, plan, format for this entry point
src/wizard/<library>.*     # the adapter: the only file that imports the prompt library
src/commands/init.*        # declaration: entry point flags, terminal check, calls the engine
test/wizard-*.test.*       # scripted prompter tests (references/testing.md)
```

Adding a wizard to an existing CLI touches only `src/wizard/`, the new command's declaration,
and the minimal readiness prerequisites. Domain code does not change.

## Choosing the library

Use the one the project already has. Otherwise take the stack file's recommendation. An adapter is
about 40–80 lines; if it grows past that, the library is fighting the engine, so move the logic
into the engine, not the adapter.
