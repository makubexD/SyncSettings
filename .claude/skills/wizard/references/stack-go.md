# Go: huh (charmbracelet)

Recommended library: [huh](https://pkg.go.dev/charm.land/huh/v2) (module `charm.land/huh/v2`,
checked against v2.0.x; v1 is `github.com/charmbracelet/huh`). If the project already uses
survey or promptui, keep it and write the same adapter.

## What the library gives you, and what it doesn't

| Need | huh | Source |
|---|---|---|
| step kinds | `NewInput`, `NewText`, `NewSelect[T]`, `NewMultiSelect[T]`, `NewConfirm`, `NewNote`, in `NewGroup`s inside a `NewForm` | [README](https://github.com/charmbracelet/huh#readme) |
| validation | `.Validate(func(T) error)` on fields; the form marks the field and shows the error | [README](https://github.com/charmbracelet/huh#readme) (the validation example) |
| cancel | `form.Run()` returns `huh.ErrUserAborted` when the user quits (Ctrl-C) | [ErrUserAborted](https://pkg.go.dev/charm.land/huh/v2#pkg-variables) |
| back | **inside one form**: `shift+tab` moves to the previous field or group | [keymap.go](https://github.com/charmbracelet/huh/blob/main/keymap.go) |
| streams | `form.WithOutput(w)`; the default is **stderr**, but **stdout in accessible mode** | [Form.WithOutput](https://pkg.go.dev/charm.land/huh/v2#Form.WithOutput) |
| plain mode | `form.WithAccessible(true)`: line prompts for screen readers, no redraws | [Form.WithAccessible](https://pkg.go.dev/charm.land/huh/v2#Form.WithAccessible) |
| hints | `.Description("...")` on fields; `huh.NewOption(label, value)` | [README](https://github.com/charmbracelet/huh#readme) |

huh is the one library with native back, but only between fields of the same form, and the form's
field list is fixed when it's built ([`Group.WithHideFunc`](https://pkg.go.dev/charm.land/huh/v2#Group.WithHideFunc) can hide whole groups, but validation after an edit is
not re-run across groups).

### Two ways to use it, pick one

1. **One field per form, driven by the engine (default).** The adapter builds a one-field form for
   each `ask`, adds a `← Back` option to selects, and maps `ErrUserAborted` to `CANCEL`. The behaviour
   matches every other stack, and branching and revalidation stay in the engine. Shift+tab does nothing
   here (there is only one field), so say "choose ← Back" in the hint.
2. **One form per flow segment.** A segment without branching (for example "project details") becomes one
   form with native shift+tab back; the engine runs segments and handles branching between them. Use
   this only when the segments are truly static.

## Adapter sketch

This sketches option 1 and is partial: an input step; the other kinds follow the same shape.

```go
func (a HuhPrompter) Ask(step Step, initial any) (any, error) {
	var value string
	if s, ok := initial.(string); ok { value = s }
	field := huh.NewInput().Title(step.Message).Description(step.Hint).Value(&value).
		Validate(func(v string) error {
			if v == "<" || step.Validate == nil { return nil }
			if msg := step.Validate(v); msg != "" { return errors.New(msg) }
			return nil
		})
	form := huh.NewForm(huh.NewGroup(field)).WithOutput(os.Stderr).WithAccessible(a.Accessible)
	if err := form.Run(); err != nil {
		if errors.Is(err, huh.ErrUserAborted) { return Cancel, nil }
		return nil, err
	}
	if value == "<" { return Back, nil }
	return value, nil
}
```

Always call `WithOutput(os.Stderr)` explicitly: in accessible mode the default switches to stdout.

## Terminal check

Prompt only when `--no-input` is absent and both streams are terminals (`golang.org/x/term`):
`term.IsTerminal(int(os.Stdin.Fd())) && term.IsTerminal(int(os.Stderr.Fd()))`.
With cobra, return a usage error from `RunE` and have `main` map it to exit 2 (the usual
`main` exits 1 for any error `Execute` returns), naming the flags.

## Tests

- The engine is plain Go: table-driven tests with a scripted prompter.
- The no-terminal path: run the command through `cmd.SetIn(strings.NewReader(""))` / `SetErr(&buf)`
  with the terminal check injected, or build the binary in `TestMain` and `exec.Command` it with stdin set to
  an empty `bytes.Reader` and assert on the exit code.
- huh itself is not unit-tested in the flow; one optional smoke test can run a form in accessible mode
  with `WithInput(strings.NewReader("demo\n"))`.

## Pitfalls

- Accessible mode writes to **stdout** by default. Pass `WithOutput(os.Stderr)`.
- `ErrUserAborted` must become exit 130, not 1 and not 0.
- `WithTimeout` doesn't work in accessible mode ([`ErrTimeoutUnsupported`](https://pkg.go.dev/charm.land/huh/v2#pkg-variables)).
- Offer accessible mode via an environment variable (the README uses `ACCESSIBLE`), and use it
  automatically when `TERM=dumb`.
