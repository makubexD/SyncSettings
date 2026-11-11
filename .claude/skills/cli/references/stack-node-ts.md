# Node.js / TypeScript: node:util parseArgs, commander

Sources: [node:util parseArgs](https://nodejs.org/api/util.html#utilparseargsconfig) ·
[commander README](https://github.com/tj/commander.js#readme)

## Choosing

- **`node:util` `parseArgs`** (stable since Node 20; added in 18.3/16.17): zero dependencies,
  strict by default. It parses options only; you write the subcommand dispatch table. Best
  when the declarations in references/architecture.md are yours anyway.
- **commander**: nested commands, generated help, suggestions. Needs configuration to follow
  the exit-code contract (below).

## Wiring the grammar

### parseArgs

Parse in two passes: global options first, then the command's own options against its
declaration.

```ts
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  args: rest,                       // argv after the command path
  options: {
    environment: { type: 'string', default: 'staging' },
    'dry-run':   { type: 'boolean', short: 'n' },
    tag:         { type: 'string', multiple: true },
  },
  allowPositionals: true,
  strict: true,                     // unknown option or wrong type -> throws
});
```

- Accepts `--name value`, `--name=value`, grouped short flags, and `--`.
- `strict: true` throws a `TypeError` with a `code` starting `ERR_PARSE_ARGS_`
  (for example `ERR_PARSE_ARGS_UNKNOWN_OPTION`). Catch it at the entry point and exit 2.
- `allowNegative: true` (Node 22.4 / 20.16) accepts `--no-<flag>` for booleans.
- `default` (Node 18.11) fills a value only when the option is absent; render it in help from
  the same object.
- `tokens: true` returns the raw token stream when you need custom handling.
- It has no notion of subcommands or help: resolve the command path yourself, and render
  help from your declarations (never a separate string).

### commander pitfalls

- Usage errors (unknown option, missing argument, excess arguments, unknown command) call
  `program.error()`, which exits **1** by default. To follow the contract, call
  `.exitOverride()` and map these `err.code` values to exit 2: `commander.unknownOption`,
  `commander.unknownCommand`, `commander.missingArgument`, `commander.optionMissingArgument`,
  `commander.missingMandatoryOptionValue`, `commander.invalidArgument` (bad choice or custom
  parser), `commander.excessArguments`, `commander.conflictingOption`.
  `commander.helpDisplayed` and `commander.version` stay 0. `commander.help` (a group run
  with no subcommand prints help to stderr and exits 1) should become 0 with help on stdout,
  per the contract for `app` with no arguments. These codes are defined in commander's
  [`lib/command.js`](https://github.com/tj/commander.js/blob/master/lib/command.js), not the
  README (checked against commander 15); re-check them when upgrading.
- Suggestions ("Did you mean --help?") are on by default: `showSuggestionAfterError()`.
- Route output through `.configureOutput({ writeOut, writeErr })` so tests can capture it.
- `.allowUnknownOption()` and `.allowExcessArguments()` weaken the contract; don't use them.
- Use `parseAsync` when actions are async, or rejections escape the exit-code mapping.

## Exit codes and streams

`process.stdout.isTTY` and `process.stderr.isTTY` give the terminal check per stream; apply
the color order from `references/contract.md`. Write payload with
`process.stdout.write`, and set `process.exitCode` rather than calling `process.exit()`
so pending writes to a pipe flush.

## Version

`parseArgs` has no built-in `--version`; handle it yourself and print `<name> <version>`.
commander's `.version('1.4.0')` prints only `1.4.0`; pass the full string instead
(`.version('app 1.4.0')`) or print it in your own option handler.

## Tests

Node has no in-process runner for `parseArgs` or commander, so test the real process:
`node --test` with `child_process.spawnSync(process.execPath, [entry, ...args], { env })`
gives `status`, `stdout`, `stderr` for real-process contract tests. Pass `input: ''` to close
stdin for non-interactive tests. On Windows, spawn `process.execPath` with the script
rather than a `.cmd` shim.

## Packaging

`package.json` `bin` maps the command name to the entry file; the entry needs a
`#!/usr/bin/env node` line. Declare `engines.node` to match the newest API you use
(for example `allowNegative` needs >= 20.16).
