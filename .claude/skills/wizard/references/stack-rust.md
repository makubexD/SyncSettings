# Rust: inquire

Recommended library: [inquire](https://docs.rs/inquire) (checked against 0.9). If the project
already uses dialoguer or cliclack, keep it and write the same adapter.

## What the library gives you, and what it doesn't

| Need | inquire | Source |
|---|---|---|
| step kinds | `Text`, `Password`, `Select`, `MultiSelect`, `Confirm`, `CustomType`, `DateSelect`, `Editor` | [README](https://github.com/mikaelmello/inquire#readme) |
| validation | `.with_validator(...)` returning `Validation::Valid` / `Validation::Invalid(msg.into())` | [README: Validation](https://github.com/mikaelmello/inquire#readme) |
| cancel | `Err(InquireError::OperationCanceled)` on **Esc**; `Err(InquireError::OperationInterrupted)` on **Ctrl-C** (crossterm/termion backends; with the `console` backend, Ctrl-C raises SIGINT) | [InquireError](https://docs.rs/inquire/latest/inquire/error/enum.InquireError.html) |
| back | **none** | [README](https://github.com/mikaelmello/inquire#readme) |
| streams | renders to **stderr** (the crossterm backend writes to `std::io::stderr()`) | [terminal/crossterm.rs](https://github.com/mikaelmello/inquire/blob/main/inquire/src/terminal/crossterm.rs) |
| not a terminal | `Err(InquireError::NotTTY)` | [README: errors](https://github.com/mikaelmello/inquire#readme) |
| hints | `.with_help_message(...)`, `.with_placeholder(...)`, `.with_default(...)`, `.with_initial_value(...)` | [README](https://github.com/mikaelmello/inquire#readme) |

Consequences: the engine owns back; map both `OperationCanceled` and `OperationInterrupted`
to `CANCEL` (exit 130), as references/contract.md requires for Ctrl-C and Esc. Check for a terminal before prompting instead of relying on `NotTTY`.

## Adapter sketch

This sketch is partial: text and select; the other kinds follow the same shape.

```rust
fn ask(step: &Step, initial: Option<&str>) -> Result<Answer, InquireError> {
    let result = match step.kind {
        Kind::Text => {
            let validate = step.validate;
            let mut prompt = Text::new(&step.message).with_help_message(&step.hint)
                .with_validator(move |v: &str| Ok(match (v, validate) {
                    ("<", _) | (_, None) => Validation::Valid,
                    (v, Some(f)) => f(v).map_or(Validation::Valid, |m| Validation::Invalid(m.into())),
                }));
            if let Some(i) = initial { prompt = prompt.with_initial_value(i); }
            prompt.prompt().map(|v| if v == "<" { Answer::Back } else { Answer::Value(v) })
        }
        Kind::Select => {
            let mut labels: Vec<String> = step.choices.iter().map(|c| c.label.clone()).collect();
            labels.push("← Back".into());
            Select::new(&step.message, labels).with_help_message(&step.hint).prompt()
                .map(|l| step.value_for(&l).map_or(Answer::Back, Answer::Value))
        }
        _ => todo!("password, multiselect, confirm follow the same shape"),
    };
    match result {
        Err(InquireError::OperationCanceled | InquireError::OperationInterrupted) => Ok(Answer::Cancel),
        other => other,
    }
}
```

## Terminal check

Prompt only when `--no-input` is absent and both streams are terminals (`std::io::IsTerminal`,
stable since Rust 1.70): `std::io::stdin().is_terminal() && std::io::stderr().is_terminal()`.
With clap, emit a usage error on failure: `Command::error(ErrorKind::MissingRequiredArgument, "...").exit()`
exits 2.

## Tests

- The engine is plain Rust: unit tests with a scripted prompter (a `VecDeque<Answer>`).
- The no-terminal path: an integration test with `std::process::Command::new(env!("CARGO_BIN_EXE_<name>"))`,
  `stdin(Stdio::piped())` closed immediately, and assertions on status code 2 and stderr naming the flags.

## Pitfalls

- Ctrl-C and Esc produce different errors; handling only `OperationCanceled` lets Ctrl-C through
  as a generic error (exit 1).
- The `console` backend turns Ctrl-C into SIGINT instead of an error ([InquireError](https://docs.rs/inquire/latest/inquire/error/enum.InquireError.html)); install a handler or stay on crossterm.
- Don't `unwrap()` a prompt result: it turns a cancel into a panic.
