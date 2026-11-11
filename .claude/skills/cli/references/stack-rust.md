# Rust: clap

Sources: [clap docs](https://docs.rs/clap/latest/clap/) ·
[clap::Error::exit_code](https://docs.rs/clap/latest/clap/error/struct.Error.html#method.exit_code)

## Choosing

- **clap derive API** (`features = ["derive"]`): the grammar is a set of annotated structs and
  enums, so declarations, help, and parsing stay in one place. The default choice; the notes
  below use it.
- **clap builder API** (`Command::new`, `Arg::new`): the same parser built at runtime. Use it
  when the command tree is generated or must be assembled dynamically; every point below
  applies to it too.

## Wiring the grammar

- Derive API: `#[derive(Parser)]` for the root, `#[derive(Subcommand)]` enums for noun groups
  and their verbs (nest an enum per noun), `#[derive(Args)]` for shared option sets.
- Doc comments become help text; `#[arg(long, default_value = "staging")]` shows the default;
  `value_parser` / `ValueEnum` restrict values; `ArgAction::SetTrue` for booleans and
  `ArgAction::Append` for repeated options; `conflicts_with` for exclusive options.
- `global = true` on an arg makes it valid at every level.
- Suggestions for mistyped subcommands and options are built in.
- Completion: the `clap_complete` crate generates scripts from the same `Command`.

## Exit codes and streams

- `Cli::parse()` on error prints and exits: `Error::exit_code()` is **2** for errors that
  print to stderr and **0** for help and version (which print to stdout). This matches the
  contract, with one exception.
- `app` with no arguments: with `arg_required_else_help` (or a required subcommand) clap
  reports `ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand` on stderr and exits 2, but the
  grammar wants help on stdout and 0. Make the subcommand optional (`Option<Commands>`) and,
  when it is `None`, print help with `Cli::command().print_help()` and exit 0.
- For operational failures return a `Result` from `main` or map errors yourself: print
  `error: ...` to stderr and `std::process::exit(1)`. A `main` returning `Err` prints the
  Debug form and exits 1; implement a readable message rather than relying on that.

### Streams and color

Payload with `println!` / a locked `stdout`, diagnostics with `eprintln!`. clap colors its
own help and errors when the stream is a terminal (`ColorChoice::Auto`). Its detection
(`anstream`/`anstyle-query`) reads `CLICOLOR`, `CLICOLOR_FORCE` and `NO_COLOR`, with
`NO_COLOR` winning, and does not read `FORCE_COLOR`. Decide color once with the contract's
precedence (`references/contract.md`), then pass it as `ColorChoice::Always`/`Never` to clap
(`#[command(color = ...)]` or `Command::color`) and to your own output.

## Version

`#[command(version)]` adds `--version`, printing `<name> <version>` as the grammar wants. Both
values come from `Cargo.toml` (`CARGO_PKG_NAME` / `CARGO_PKG_VERSION` at compile time), so
bump the version there only.

## Tests

- Parsing: `Cli::try_parse_from(["app", "release", "deploy", "1.4.0"])` returns a `Result`,
  so usage errors are testable without exiting; `err.kind()` identifies the case.
- Real process: the `assert_cmd` crate runs the built binary and asserts on
  `.code(2)`, `.stdout(...)`, `.stderr(...)`; pair with `predicates`.
- `Command::debug_assert()` in a unit test catches declaration mistakes early.

## Packaging

Users install from crates.io with `cargo install <crate>` (the `[[bin]]` name is the command
name). Ship prebuilt release binaries per target as well, for example with cargo-dist, which
builds them in CI and generates installers.
