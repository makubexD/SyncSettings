# Python: questionary (prompt_toolkit)

Recommended library: [questionary](https://questionary.readthedocs.io/) (checked against 2.1),
which is built on [prompt_toolkit](https://python-prompt-toolkit.readthedocs.io/). Use
prompt_toolkit directly only for something questionary can't express. If the project already
uses InquirerPy or `click.prompt`, keep it and write the same adapter.

## What the library gives you, and what it doesn't

| Need | questionary | Source |
|---|---|---|
| step kinds | `text`, `password`, `select`, `checkbox` (multi-select), `confirm`, `autocomplete`, `path` | [Question Types](https://questionary.readthedocs.io/en/stable/pages/types.html) |
| validation | `validate=` a callable returning `True` or an error message string, or a prompt_toolkit `Validator` | [Advanced: Validation](https://questionary.readthedocs.io/en/stable/pages/advanced.html#validation) |
| cancel | `.ask()` catches Ctrl-C, **prints "Cancelled by user" to stdout**, and returns `None`; `.unsafe_ask()` raises `KeyboardInterrupt` | [Advanced: Keyboard Interrupts](https://questionary.readthedocs.io/en/stable/pages/advanced.html#keyboard-interrupts); [question.py](https://github.com/tmbo/questionary/blob/2.1.1/questionary/question.py) |
| back | **none**: no prompt documents a back option, and `prompt()`/`form()` ask in order | [Question Types](https://questionary.readthedocs.io/en/stable/pages/types.html), [Advanced](https://questionary.readthedocs.io/en/stable/pages/advanced.html) |
| streams | extra keyword arguments reach prompt_toolkit, so `input=` and `output=` are accepted | `**kwargs` passed to `PromptSession` in [prompts/text.py](https://github.com/tmbo/questionary/blob/2.1.1/questionary/prompts/text.py) (and `Application` in the other prompts); run and checked with pipe input |
| hints | `instruction=` on prompts; `Choice(title, value, description=...)` | [Question Types](https://questionary.readthedocs.io/en/stable/pages/types.html) |

Consequences: use `unsafe_ask()` and map `KeyboardInterrupt` to `CANCEL` (the command then exits 130; with typer, `raise typer.Exit(130)`) (plain `.ask()` writes to
stdout, and `None` can't be told apart from a real `None` answer); send output to stderr; and let the engine own back.

## Adapter sketch

```python
import sys
import questionary
from prompt_toolkit.output import create_output
from .engine import BACK, CANCEL, Step

BACK_CHOICE = questionary.Choice("← Back", value=BACK)

def _io() -> dict:
    return {"output": create_output(stdout=sys.stderr)}

def _validator(step: Step):
    def check(value):
        if value == "<":
            return True
        problem = step.validate(value) if step.validate else None
        return True if problem is None else problem
    return check

def ask(step: Step, initial):
    message = step.message
    try:
        if step.kind == "text":
            value = questionary.text(message, default=initial or "", instruction=step.hint,
                                     validate=_validator(step), **_io()).unsafe_ask()
            return BACK if value == "<" else value
        if step.kind == "select":
            choices = [questionary.Choice(c.label, value=c.value, description=c.hint) for c in step.choices]
            values = {c.value for c in step.choices}
            return questionary.select(message, choices=[*choices, BACK_CHOICE],
                                      default=initial if initial in values else None,
                                      instruction=step.hint, **_io()).unsafe_ask()
        if step.kind == "confirm":
            return questionary.select(message, choices=[questionary.Choice("Yes", True),
                                      questionary.Choice("No", False), BACK_CHOICE], **_io()).unsafe_ask()
        # password → questionary.password; multiselect → questionary.checkbox (back via the review)
        raise NotImplementedError(step.kind)
    except KeyboardInterrupt:
        return CANCEL
```

`default=` on `select` must be one of the choices' values (or `None`). Pass `None` when
the previous answer isn't in the current choices.

## Terminal check

```python
def is_interactive(no_input: bool) -> bool:
    return sys.stdin.isatty() and sys.stderr.isatty() and not no_input
```

With click/typer, check it in the `init` command and raise `click.UsageError` (exit 2) when it's
false, naming the flags. typer is built on click, so the same exception works there.

## Tests

- The engine is plain Python: drive it with a scripted prompter under pytest.
- For the no-terminal path, use click's/typer's `CliRunner` (its stdin is not a terminal) and assert
  `exit_code == 2`, the flags named in the output, and no prompt text.
- An adapter smoke test can drive questionary without a terminal:
  `with create_pipe_input() as inp: inp.send_text("demo\r")`, then pass `input=inp` and `output=DummyOutput()`
  (both from prompt_toolkit). Ctrl-C is `"\x03"` and raises `KeyboardInterrupt` from `unsafe_ask()`.

## Pitfalls

- Plain `.ask()` prints "Cancelled by user" to **stdout** and returns `None`. Use `unsafe_ask()`.
- On Windows, prompt_toolkit's default output raises `NoConsoleScreenBufferError` when the output isn't a real
  console (in some IDE terminals, or under CI). That's another reason to check for a terminal first and
  use `DummyOutput` in tests.
- `questionary.prompt([...])` with `when=` gives branching but no back and no revalidation after
  an edit; use the engine instead.
- Don't mix `print()` into the flow; route notes through the prompter to stderr.
