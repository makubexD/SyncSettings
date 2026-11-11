# .NET: System.CommandLine

Sources: [System.CommandLine overview](https://learn.microsoft.com/dotnet/standard/commandline/) ·
[How to parse and invoke](https://learn.microsoft.com/dotnet/standard/commandline/how-to-parse-and-invoke) ·
[Syntax](https://learn.microsoft.com/dotnet/standard/commandline/syntax)

The API changed substantially between the long-running betas and the 2.0 release. Check the
package version in the project first; the notes below follow the current docs (2.0 API:
`SetAction`, `Parse(...).Invoke()`). For a beta-era project (`SetHandler`,
`InvocationContext`), map the same ideas and say the details are unverified.

## Choosing

- **System.CommandLine** (Microsoft, used by the `dotnet` CLI): nested commands, typed
  options and arguments, generated help, suggestions, and completion. The notes below cover it.
- If the project already uses another parser (for example Spectre.Console.Cli), keep it and
  map the same ideas: declarations feed help, usage errors exit 2, payload stays on stdout.
  Say which details you could not verify for that library.

## Wiring the grammar

- `RootCommand` for the binary, `Command` per noun with `Subcommands` for verbs,
  `Option<T>` for options, `Argument<T>` for positionals. Descriptions feed generated help.
- `command.SetAction(parseResult => { ...; return 0; })` defines what runs; read values with
  `parseResult.GetValue(option)`. Async actions return `Task<int>`.
- Help (`--help`, `-h`, `-?`, `/h`, `/?`) and `--version` are added to the root
  automatically, as is the suggest directive for completion. Document only `--help`/`-h`.
- Options accept `--name value` and `--name:value`/`--name=value`; `--` ends options.
  Options are case-sensitive; keep them lowercase-hyphenated.

## Exit codes and streams

- `rootCommand.Parse(args).Invoke()` returns the action's `int`. On parse errors the built-in
  parse-error action runs instead of your action and returns 1. It writes the error messages to
  the configured **error** writer, but its "did you mean" suggestions and the help it shows
  (`ShowHelp` is on by default) go to the **output** writer, which is stdout. That breaks the
  contract twice: exit code 1 instead of 2, and text on stdout for a usage error.
- Fix both in one place: when the parse has errors, invoke with stdout pointed at stderr, and
  map the code to 2. Return 1 from actions for operational failures.

  ```csharp
  var r = root.Parse(args);
  if (r.Errors.Count == 0) return await r.InvokeAsync();
  await r.InvokeAsync(new InvocationConfiguration { Output = Console.Error });
  return 2;
  ```

  If the project pins a different 2.x API, map the same idea (replace the parse-error action,
  or redirect its output) and say the details are unverified. Add a test that a usage error
  leaves stdout empty.
- `--help` together with an invalid token: confirm with a test that help still exits 0, as the
  grammar requires; if the parse reports errors first, handle the help option before mapping to 2.

### Streams

Payload to `Console.Out`, diagnostics to `Console.Error`. Decide color with the contract's
precedence (`references/contract.md`) for your own coloring; check `Console.IsOutputRedirected`
/ `IsErrorRedirected` per stream.

## Version

The built-in `--version` prints the bare informational version (`1.4.0`). The grammar wants
`<name> <version>`: replace the version option's action to print both.

## Tests

Parse in-process with `rootCommand.Parse("release deploy 1.4.0")` and assert on
`ParseResult.Errors` and bound values; for the full contract, run the built app with
`Process.Start` (redirected stdout/stderr) and assert on `ExitCode`.

## Packaging

Ship as a .NET tool (`<PackAsTool>true</PackAsTool>`, `<ToolCommandName>app</ToolCommandName>`)
or a self-contained single-file executable.
