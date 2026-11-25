# Pull and push modes

What `mksync pull` and `mksync push` do with each file, what `--yes`, `--force` and paths change, and how to settle a
conflict. The steps of a normal day are in [daily-workflow.md](daily-workflow.md); the exact rules are in
[sync-contract.md](sync-contract.md#front-door).

## The short version

- **Pull** takes the repo's changes. One file with an edit you haven't sent stops the whole pull.
- **Push** sends this machine's changes through a pull request. It leaves files the repo changed alone, and a file both
  sides changed stops it.
- Both show what they will do and ask. Enter is **No**.
- `mksync diff` says which side changed each file, and changes nothing.

## The four labels

Each machine remembers the repo commit it last agreed with, its **sync point**. Comparing against it tells which side
changed a file since:

| Label  | Meaning                            | `mksync pull`                        | `mksync push`                          |
| ------ | ---------------------------------- | ------------------------------------ | -------------------------------------- |
| `IN`   | Only the repo changed it           | Takes it                             | Leaves it alone and says so            |
| `OUT`  | Only this machine changed it       | Stops the pull                       | Sends it                               |
| `BOTH` | Both changed it, differently       | Stops the pull, shows both sides     | Stops the push, shows both sides       |
| `?`    | This machine has no sync point yet | Warns and asks; refuses with `--yes` | Warns, then sends every differing file |

With some files `IN` and others `OUT`, push first. It sends the `OUT` files and leaves the `IN` ones:

```text
  IN         dotfiles/common/parity/b.conf
  1 file(s) are newer in the repo and were left alone; run mksync pull to take them.
```

Once that PR is merged, `mksync pull` takes the rest. To take an `IN` file sooner, name it: `mksync pull <path>`.

A push that would leave an `IN` file stops when the repo folder has changes not sent yet, since they can hold its older
version. Run `git stash -u` in the clone, then push again; the export writes your settings anew.

A push also stops while the repo on GitHub has commits this clone lacks (`origin has updates; run mksync pull first.`).
That pull brings the clone up to date before it checks any file, so run it even if it then stops on your own edits:
the next push gets past that line.

## The options

| You run               | It asks | It stops on                                | It does                                                                                      |
| --------------------- | ------- | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `mksync pull`         | yes     | `OUT`, `BOTH`, a failed diff               | Applies the repo's version, keeping a `.bak` of each file it overwrites                      |
| `mksync pull --yes`   | no      | the same, and a machine with no sync point | The same, for scripts                                                                        |
| `mksync pull --force` | yes     | nothing above                              | Overwrites `OUT` and `BOTH` files too, each with its `.bak`                                  |
| `mksync pull <path>…` | yes     | the same, for those files only             | Takes only those files                                                                       |
| `mksync push`         | yes     | `BOTH`, a failed diff                      | Opens a PR with the `OUT` files                                                              |
| `mksync push --yes`   | no      | the same                                   | The same, for scripts. It also works with no sync point: a PR is reviewed before it's merged |
| `mksync push --force` | yes     | nothing above                              | Sends `BOTH` files too, as this machine has them. `IN` files are still left alone            |
| `mksync push <path>…` | yes     | the same, for those files only             | Exports only those files. Changes already in the repo folder go out with them                |

- `--force` never answers the question; add `--yes` for that.
- Only an answer starting with `y` or `Y` is yes. Enter, or no input at all, is No.
- When the diff fails, the newer side is unknown. `mksync push --force` then exports every file, `IN` ones included, so
  read its PR with care.

## Look without changing anything

| Command          | Answers                                                         |
| ---------------- | --------------------------------------------------------------- |
| `mksync diff`    | Which side changed each file? It fetches first; paths narrow it |
| `mksync check`   | What would a pull change on this machine? It doesn't fetch      |
| `mksync preview` | What would an export change in the repo, line by line?          |

`check` and `preview` compare in one direction and don't know which side is newer: `preview` also shows an `IN` file,
as a change back to your old version. A push leaves that file alone.

## Settle a conflict

A `BOTH` file stops pull and push, and both print its lines. `-` is the repo's version and `+` is this machine's:

```text
  BOTH       dotfiles/common/parity/b.conf
  --- repo           dotfiles/common/parity/b.conf
  +++ this machine   dotfiles/common/parity/b.conf
  @@ -1 +1 @@
  -repo line
  +machine line
```

Values a `sanitize` rule covers show as placeholders. Over 40 lines, the rest is counted (`… 12 more line(s)`), and a
very long line is cut. Then pick
one:

| You want               | Do this                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| Parts of both          | Edit the file on this machine until it has what you want, then `mksync push --force <path>` |
| This machine's version | `mksync push --force <path>`                                                                |
| The repo's version     | `mksync pull --force <path>`; your version stays in `<file>.bak`                            |

Name the path with `--force`, so it applies to that file only. The file still reads `BOTH` after a hand merge, since it
matches neither side; that is why the push needs `--force`. The PR shows what changes in the repo.

## Saying No

- **Pull:** `Nothing applied.` No file on this machine changed. The clone was already brought up to date, so the next
  pull has nothing to download.
- **Push:** `Nothing sent; the repo folder is as it was.` The export had written your files into the repo folder, and
  No puts them back, and drops the moves between groups you made in that run.
- **Push, when the repo folder already had changes:** `Kept in the repo. Run mksync push again, or git restore dotfiles
to drop them.` Nothing is put back, because mksync can't tell those changes from its own.
- **Push, when the export also changed local state** (the first push after the repo went private, or a move of a setting
  kept on this machine): the same `Kept` line. Don't drop those files: run `mksync push` again, since what moved may
  now be only in the repo folder.

## When the sync point moves

| What ran                                                      | Sync point                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------- |
| A pull of everything, with no error and no file skipped       | Moves to the commit it applied, even if no file had to change |
| A push of everything, once its PR is open                     | Moves to the `master` commit the PR starts from               |
| A push that brought the clone up to date while opening its PR | Stays                                                         |
| A pull or push with paths                                     | Stays                                                         |
| A push that left an `IN` file alone                           | Stays                                                         |
| `mksync push --force` after a failed diff                     | Stays                                                         |
| A No, an error, `diff`, `check` or `preview`                  | Stays                                                         |

A partial run leaves it where it was because the machine agrees with only part of the repo. If a push that left an `IN`
file moved it, that file would read `OUT` next time, and a push would undo the repo's change. Files you pushed read
`OUT` until their PR merges, then drop out of the list.
