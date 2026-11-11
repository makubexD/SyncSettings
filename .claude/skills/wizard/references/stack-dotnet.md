# .NET: Spectre.Console

Recommended library: [Spectre.Console](https://spectreconsole.net/) (checked against
[0.57.2](https://www.nuget.org/packages/Spectre.Console/0.57.2); source links below are pinned to
that tag). If the project already uses Sharprompt, keep it and write the same
adapter.

## What the library gives you, and what it doesn't

| Need | Spectre.Console | Source |
|---|---|---|
| step kinds | `TextPrompt<T>` (with `.Secret()` for passwords), `SelectionPrompt<T>`, `MultiSelectionPrompt<T>`, `ConfirmationPrompt` | [Prompting for user input](https://spectreconsole.net/console/how-to/prompting-for-user-input) |
| validation | `TextPrompt<T>.Validate(Func<T, ValidationResult>)` or `.Validate(Func<T, bool>, message)`; `ValidationResult.Error(msg)` / `.Success()` | [TextPrompt](https://spectreconsole.net/prompts/text), [`TextPromptExtensions.Validate`](https://github.com/spectreconsole/spectre.console/blob/0.57.2/src/Spectre.Console/Prompts/TextPromptExtensions.cs) |
| cancel | `ShowAsync(console, CancellationToken)` on every prompt; Ctrl-C otherwise ends the process through .NET's default `Console.CancelKeyPress` | [`IPrompt<T>.ShowAsync`](https://github.com/spectreconsole/spectre.console/blob/0.57.2/src/Spectre.Console/Prompts/IPrompt.cs) |
| back | **none** | [Prompting for user input](https://spectreconsole.net/console/how-to/prompting-for-user-input) |
| streams | `AnsiConsole.Create(new AnsiConsoleSettings { Out = new AnsiConsoleOutput(Console.Error) })` | [`AnsiConsoleSettings.Out`](https://github.com/spectreconsole/spectre.console/blob/0.57.2/src/Spectre.Console/AnsiConsoleSettings.cs), [`AnsiConsoleOutput(TextWriter)`](https://github.com/spectreconsole/spectre.console/blob/0.57.2/src/Spectre.Console/AnsiConsoleOutput.cs) |
| terminal | `console.Profile.Capabilities.Interactive` | [`Capabilities.Interactive`](https://github.com/spectreconsole/spectre.console/blob/0.57.2/src/Spectre.Console/Capabilities.cs) |
| defaults, hints | `.DefaultValue(...)`, `.AddChoices(...)`, `.UseConverter(...)` for labels | [TextPrompt](https://spectreconsole.net/prompts/text) |

The docs warn that prompts are not thread safe and must not run alongside progress or status
displays.

Consequences: create **one** `IAnsiConsole` that writes to stderr and give it to the adapter,
rather than using the static `AnsiConsole` (which writes to stdout); own back in the engine;
turn Ctrl-C into a cancelled token so it becomes `CANCEL` and exit 130.

## Adapter sketch

This sketch is partial: text and select; add `step.Hint` as a caption the same way.

```csharp
public sealed class SpectrePrompter(IAnsiConsole console, CancellationToken token) : IPrompter
{
    const string Back = "← Back";

    public async Task<Answer> AskAsync(Step step, string? initial)
    {
        try
        {
            if (step.Kind == Kind.Select)
            {
                var prompt = new SelectionPrompt<string>().Title(step.Message)
                    .AddChoices(step.Choices.Select(c => c.Label).Append(Back));
                var label = await prompt.ShowAsync(console, token);
                return label == Back ? Answer.Back : Answer.Of(step.ValueFor(label));
            }
            var text = new TextPrompt<string>(step.Message)
                .Validate(v => v == "<" || step.Validate?.Invoke(v) is not { } msg
                    ? ValidationResult.Success() : ValidationResult.Error(msg));
            if (initial is not null) text.DefaultValue(initial);
            var value = await text.ShowAsync(console, token);
            return value == "<" ? Answer.Back : Answer.Of(value);
        }
        catch (OperationCanceledException) { return Answer.Cancel; }
    }
}

// Program: route prompts to stderr and turn Ctrl-C into cancellation
var console = AnsiConsole.Create(new AnsiConsoleSettings { Out = new AnsiConsoleOutput(Console.Error) });
var cts = new CancellationTokenSource();   // lives for the whole process; not disposed mid-run
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };
// after the flow: exit 130 when cts.IsCancellationRequested
```

If the project caps constructor parameters or avoids primary constructors, use a normal constructor;
the shape is what matters.

## Terminal check

Prompt only when `--no-input` is absent and `!Console.IsInputRedirected && !Console.IsErrorRedirected`.
(`Capabilities.Interactive` alone isn't enough: check stderr explicitly.) With System.CommandLine, return exit code 2 from the handler and write the
flags to stderr.

## Tests

- The engine is plain C#: xUnit/NUnit with a scripted prompter.
- Adapter smoke test: [Spectre.Console.Testing](https://www.nuget.org/packages/Spectre.Console.Testing)'s
  `TestConsole` with `console.Input.PushTextWithEnter("demo")` or `PushKey(ConsoleKey.DownArrow)`,
  and `console.Interactive()` to mark it as a terminal.
- The no-terminal path: run the built app with redirected stdin (`Process` with
  `RedirectStandardInput = true`, closed at once) and assert exit code 2.

## Pitfalls

- The static `AnsiConsole` writes to stdout (its default output is `Console.Out`: see
  [`AnsiConsoleFactory`](https://github.com/spectreconsole/spectre.console/blob/0.57.2/src/Spectre.Console/AnsiConsoleFactory.cs)); use the stderr console everywhere in the wizard.
- Without a `CancelKeyPress` handler, Ctrl-C terminates the process mid-flow: no cancel message
  and no cleanup, and on Windows the exit code is not 130.
- A `SelectionPrompt` with a converter still returns the value, not the label; compare with the
  back value, not the display text, when you use `UseConverter`.
