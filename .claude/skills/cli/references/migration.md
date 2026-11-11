# Migration: changing a CLI people already use

## Before a syntax change

Search the repository for the old command and every subcommand and option string you will
touch: scripts, CI, Makefiles and task runners, Docker/Podman entrypoints, docs, examples,
completion files, tests, and other packages in a monorepo. List each hit with file and line.
If callers outside the repository may exist and cannot be checked, the change is `BREAKING`.

## Principles

- Preserve domain behavior. Change the interface layer: parsing, dispatch, help, output.
- Work incrementally, one approved finding at a time, with the suite green after each.
  Avoid rewrites; a new parser is justified only by a `MAINTAINABILITY` finding the user
  approved.
- Update every in-repo caller in the same change as the syntax it uses.

## Deprecation path

Keep the old syntax working, route it to the new command, and print exactly this on stderr:

```
warning: '<old>' is deprecated and will be removed. Use '<new>'.
```

- The old form produces the same stdout and exit code as the new one.
- The warning goes to stderr only, so pipelines keep working.
- Record each alias in a table the code reads, not in scattered conditionals:

| Old | New | Deprecated in | Remove in |
|---|---|---|---|
| `app users show-all` | `app users list` | 0.4.0 | 1.0.0 |

- Hide deprecated forms from help; keep them in the changelog.
- Remove them in the version the table names, as its own `BREAKING` change.

## Hard breaks

Keep a deprecation path when it is cheap. Break without one when the old behavior is
dangerous (a flag that silently triggers a destructive action) or cannot coexist with the new
grammar. Do not keep a bad structure forever because removing it is inconvenient: name the
break, the callers, and the reason, and wait for the user to approve that finding id.

## Changelog

Every syntax change gets a changelog entry under the version that ships it, grouped as
Added, Changed, Deprecated, Removed, with the CURRENT → TARGET line and the migration.
