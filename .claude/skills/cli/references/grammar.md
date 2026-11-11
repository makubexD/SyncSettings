# Grammar: the CLI as a small language

A command should read like a sentence a newcomer could guess from help alone:

```
app <noun> <verb> [<object>] [--modifier value]...
app release deploy 1.4.0 --environment production
```

"Fluent" here means that sentence reads naturally and commands compose through pipes and
structured output. Method chaining is inspiration for composition only; do not describe or
build the CLI as a programming-language fluent interface.

## Borrow from Git, reject its accidents

Borrow:

- Noun groups with verb actions (`git remote add`, `git stash list`), plus a few top-level
  verbs for the primary workflow (`git commit`, `git push`). Top-level verbs are for the
  3-7 things users do daily; everything else lives in a noun group.
- Progressive help: `app --help`, `app <group> --help`, `app <group> <verb> --help`, and
  `app help <group> [<verb>]` printing the same text.
- `--` ends options, so a positional may start with `-`. `-` as a file argument means stdin.
- Long options as the stable, documented name: lowercase words joined by hyphens.
- A group may have a default action (`git stash` = `git stash push`), marked in help.

Reject:

- The same idea spelled several ways (`list`, `show-all`, `fetch`, `get-all`, `ls`).
- A short flag whose meaning changes by command (`-f` is force here, format there).
- Commands that switch behavior on argument shape (`git checkout <branch>` vs `<file>`).
- Operations spelled as flags (`app --users --list`).
- A plumbing/porcelain split, unless two real audiences exist.

## Command shape

Prefer:

```
app users list
app users get <id>
app users create --name "Octo Cat"
app release deploy <version> --environment production
```

Reject:

```
app --users --list                          operation as flags
app userAction list                         camelCase, noun+verb fused
app execute --resource users --operation list   generic verb, grammar hidden in options
app deploy production api 3 true            positional pile
```

- **Nouns** name resources. Keep them all singular or all plural across the tree; pick one.
- **Verbs** come from one small vocabulary, used identically everywhere:
  `list`, `get` (or `show`, pick one), `create`, `update`, `delete` (or `remove`, pick one),
  plus domain verbs (`deploy`, `sync`, `rotate`). Use the same verb for the same operation.
- **Depth** is justified only by several verbs on one noun. One verb on a noun is a top-level
  command; three levels (`app a b c`) need a real sub-resource. Siblings share one depth.
- **Names** are lowercase, hyphenated, and whole words (`dry-run`, not `dryrun` or `dr`).

## Positionals

- The positional is the object of the verb: the resource identity (`get <id>`).
- A second positional only when its role is obvious from the verb (`copy <src> <dst>`).
- Everything else is an option: `app deploy 3 --environment production --service api --force`,
  never `app deploy production api 3 true`. A boolean is never a positional.
- Variadic positionals come last and only when every value plays the same role (`rm <file>...`).

## Options

- Accept both `--name value` and `--name=value`.
- Booleans are affirmative flags (`--force`). Offer `--no-<flag>` only when the default is on
  or a config file can turn it on.
- Repeated options collect (`--tag a --tag b`); document that in help.
- A short alias only for options used constantly and interactively (`-h`, `-v` for
  `--verbose` (never `--version`), `-q`, `-n` for dry-run). Never a short alias for a destructive option. One meaning per short flag
  across the whole tree.
- Required options are a smell: required identity belongs in a positional; required
  modifiers need a default or a strong reason.
- Mutually exclusive options fail with a usage error naming both.
- Show every default in help. Unknown options are a usage error, never ignored.
- Global options (`--help`, `--version`, `--format`, `--quiet`, `--verbose`, `--no-color`)
  work at any position and mean the same thing everywhere.

## Aliases

One operation has one command. A second spelling is either a deprecated alias with a
removal path (see references/migration.md) or it does not exist. Hidden aliases for muscle memory are
allowed only if help never shows them and docs never use them.

## Help

Help is progressive and generated from the same declarations the parser uses:

- Top level: one line per command or group, the global options, the environment variables,
  the exit codes, and how to get more help.
- Group: its actions, with the default action marked.
- Command: usage line, positionals, every option with its default and allowed values, and
  one example when usage is not obvious.
- `--help` never has side effects and always exits 0, even alongside other arguments.
- `app` with no arguments prints either the most useful read-only status or short help;
  never a destructive default.
- `--version` prints `<name> <version>` on stdout and exits 0.

## Composition

Commands compose like words in a pipeline, not like chained calls in one invocation:

```
app users list --format json | jq -r '.[].id' | xargs -n1 app users get
app release list --format tsv | awk -F'\t' '$2=="staging"'
```

For this to work: list commands print one record per line or a JSON array; ids appear as
raw values; `get` accepts what `list` prints; anything that reads a file accepts `-` (stdin).
