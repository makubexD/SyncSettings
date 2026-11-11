# Node.js / TypeScript: @clack/prompts

Recommended library: [`@clack/prompts`](https://www.npmjs.com/package/@clack/prompts) (checked
against 1.8.x). If the project already uses `@inquirer/prompts`, `enquirer`, or `prompts`, keep it
and write the same adapter for that library.

## What the library gives you, and what it doesn't

| Need | @clack/prompts | Source |
|---|---|---|
| step kinds | `text`, `password`, `select`, `multiselect`, `confirm` (plus `autocomplete`, `path`, `date`) | [README](https://github.com/bombshell-dev/clack/tree/main/packages/prompts) |
| validation | `validate(value)` returning a message string, an `Error`, or `undefined` for ok (or a Promise of one; a Standard Schema also works), on `text`, `password`, `autocomplete`, `path`, `date`; not on `select` or `multiselect` (the engine validates those). The value can be `undefined` (empty input) | [`TextOptions.validate` in index.d.mts](https://unpkg.com/@clack/prompts@1.8.1/dist/index.d.mts) |
| cancel | each prompt resolves to a cancel symbol on Ctrl-C **or Esc**; test with `isCancel(value)` | [README: Cancellation](https://github.com/bombshell-dev/clack/tree/main/packages/prompts#cancellation); Esc through `@clack/core`'s default `escape → cancel` alias ([core 1.5.1 source](https://unpkg.com/@clack/core@1.5.1/dist/index.mjs)) |
| back | **none**; `group()` only offers `onCancel` | [README: Group](https://github.com/bombshell-dev/clack/tree/main/packages/prompts#group) |
| streams | every prompt accepts `input`, `output` (a `Writable`) and `signal` (`CommonOptions`) | [`CommonOptions` in index.d.mts](https://unpkg.com/@clack/prompts@1.8.1/dist/index.d.mts) |
| defaults | `initialValue` (pre-filled and editable) and `defaultValue` (used when the input is empty) on `text` | [`TextOptions` in index.d.mts](https://unpkg.com/@clack/prompts@1.8.1/dist/index.d.mts) |
| hints | `hint` on each select option; for text, `placeholder` | [`Option<Value>.hint` in index.d.mts](https://unpkg.com/@clack/prompts@1.8.1/dist/index.d.mts) |

Consequences: navigation lives in the engine (`references/architecture.md`); pass `output: process.stderr`
to **every** prompt, `note`, `intro`, and `outro` (the default output is stdout); and treat
`isCancel` as `CANCEL`, never as `process.exit(0)`, which the README's group and cancellation examples show.

## Adapter sketch

```ts
import * as p from '@clack/prompts';
import { BACK, CANCEL, type Prompter, type Step } from './engine.ts';

const io = { output: process.stderr };
const BACK_VALUE = '\u0000back';
const back = { value: BACK_VALUE, label: '← Back' };

function toResult(value: unknown, kind: Step['kind']): unknown {
  if (p.isCancel(value)) return CANCEL;
  if (value === BACK_VALUE || (kind === 'text' && value === '<')) return BACK;
  return value;
}

export const clackPrompter: Prompter = {
  async ask(step: Step, initial: unknown) {
    const message = step.hint ? `${step.message}\n${step.hint}` : step.message;
    const validate = (v: unknown) =>
      (step.kind === 'text' && v === '<' ? undefined : step.validate?.(v ?? '') ?? undefined); // clack passes undefined for empty input
    const done = (value: unknown) => toResult(value, step.kind);
    switch (step.kind) {
      case 'text':     return done(await p.text({ ...io, message, initialValue: initial as string, validate }));
      case 'password': return done(await p.password({ ...io, message, validate }));
      case 'select':   return done(await p.select({ ...io, message, initialValue: initial, options: [...step.choices!, back] }));
      case 'multiselect': return done(await p.multiselect({ ...io, message, initialValues: initial as string[], options: step.choices!, required: false }));
      case 'confirm':  return done(await p.select({ ...io, message, initialValue: initial ?? true,
                         options: [{ value: true, label: 'Yes' }, { value: false, label: 'No' }, back] }));
    }
  },
  // review (Run / Back / Change an answer / Decline), pickStep and note use p.note / p.select
  // with the same `io`. A sketch: map it to the project's step kinds.
};
```

Notes:

- `validate` returns `null` in most command validators; clack wants `undefined` for "ok", hence `?? undefined`.
- `multiselect` has no room for a `← Back` option (it would be selectable alongside real values).
  Offer back there through the review's "Change an answer", or add a follow-up select.
- Type-strip-only TypeScript (Node's `--experimental-strip-types`/default type stripping) works:
  the adapter uses no enums or parameter properties.

## Terminal check

```ts
export const isInteractive = () =>
  process.stdin.isTTY === true && process.stderr.isTTY === true && !process.argv.includes('--no-input');
```

Check this before importing the adapter lazily (`await import('./clack.ts')`), so scripts that
never prompt don't pay for loading the library.

## Tests

- `node --test`, with a scripted prompter (references/testing.md); no clack in unit tests.
- Spawn the entry point with `spawnSync(process.execPath, [entry, 'init'], { input: '' })` for the
  no-terminal test. On Windows, spawn `process.execPath` rather than a shebang script.
- clack itself can be driven with a fake `input` stream and a `Writable` `output` if a project
  wants an adapter test; keep it to one smoke test, since the key sequences are clack's internals.

## Pitfalls

- A prompt without `output: process.stderr` writes to stdout and corrupts piped payloads.
- @clack/prompts decides colour from stdout, not from the stream it writes to: an accepted
  exception to per-stream colour (the contract), since prompts run only when stderr is a terminal.
  Say so in the report.
- `process.exit()` inside a cancel handler skips cleanup and the engine's exit code; return `CANCEL` instead.
- Don't use `p.group` for the flow: it can't go back or branch on validation. Use it only for a
  fixed, back-free sub-form, if ever.
- clack colours with Node's [`util.styleText`](https://nodejs.org/api/util.html) without a `stream` option
  ([core source](https://unpkg.com/@clack/core@1.5.1/dist/index.mjs)), so colour follows whether
  **stdout** is a terminal, not the stderr it draws on (`app init > out.txt` shows plain prompts).
  It still honours `FORCE_COLOR`, `NO_COLOR`, and `TERM=dumb`. Harmless, because prompts run only
  when stderr is a terminal, but note it under "Not verified" instead of claiming per-stream colour.
- `spinner()` writes to its `output` too; pass `io` there as well, and only show it on a terminal.
