# Smart first run: guess every answer, then sync without questions (roadmap)

Asked 2026-11-27 after work #1 and work #2 went through `v1.1.10`. The user's goal: **"always auto guess names, don't
ask me to type; this only happens the first time, then sync and push should be easier."** Plus two tools for
reconciling the layers once every machine has its profile: a report of what each profile overrides, and a way to move
a setting between the base and a profile.

The model stays as designed (`docs/design-layers.md`, "Layers"). A machine's first sync keeps everything it does
differently in its profile (`p`, `v1.1.10`), so it never changes the shared layers and can't conflict. Deciding what
is generic is a separate, later step (phase 3), done once with every profile in front of you.

Two audits on 2026-11-27 (the project's `wizard-auditor` and `cli-auditor`) listed every question the program asks
and the command tree. Their findings are numbered `WIZ-n` and `CLI-n` below.

## What the audits found

After the first pull or push, saved values and the saved public name are not asked again: the record works as
intended. The gaps are in the first run itself:

| Question                                                     | Guess today                                    | Gap                                                              |
| ------------------------------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------------- |
| `<YOUR_GH_OWNER>` (WIZ-4)                                    | none                                           | the clone's `origin` names it                                    |
| `<YOUR_NAME>`, `<YOUR_GH_USERNAME>` (WIZ-5)                  | `git config --global`, `gh api user` (network) | empty on a fresh machine; `gh` keeps the login locally           |
| `<GH_CLI_PATH>` (WIZ-6)                                      | fixed default, never asked                     | wrong for a per-user `gh` install; PATH knows                    |
| first-sync picker for `dconf`, `dir`, `import` files (WIZ-8) | none: `[s/r/k]`                                | 17 entries need a typed answer                                   |
| public name for push branches (WIZ-2)                        | the login name                                 | a work account name in a public branch name                      |
| profile at `setup` (WIZ-1)                                   | none while the repo is public                  | `setup --yes` exits 2                                            |
| `setup --yes` (WIZ-7)                                        | still asks bootstrap and values                | contract says it asks nothing                                    |
| profile-value search (WIZ-9)                                 | substring match                                | a short value (`A4`) matches `#90a4ae`; refusal names "change 0" |
| `Open a PR?`, `Apply these changes?` (WIZ-10)                | No                                             | a typed `y` on every run                                         |
| `--help` (CLI-1), unknown verb (CLI-2)                       | `Unknown option: --help`, exit 2               | no help at any level                                             |

## Phases

1. **Guess every value and picker answer** (`docs/plan-smart-first-run-1.md`, `v1.2.0`). WIZ-4, 5, 6, 8, 9, and
   WIZ-2's guess. **Done 2026-11-27.** No breaking change: every new guess is a suggestion shown in brackets, Enter takes it.
2. **Setup asks once, up front, with everything guessed.** WIZ-1 (profile from OS and domain: `personal` on a
   personal Linux machine, a new `work-<n>` on a domain-joined or non-Linux one, never from the domain's name), the
   public name asked at setup with `--alias`, `--value KEY=...` and `--no-bootstrap` so `Same as:` reproduces a run,
   the review showing every guessed value and its source before anything is written, WIZ-7, WIZ-11, and an optional
   profile label (asked 2026-11-27). Plan: `docs/plan-smart-first-run-2.md` (`v1.3.0`). **Done 2026-11-27.**
   Breaking: the profile is guessed (`work<n>`, no dash), values are asked before the confirm, and `setup --yes`
   takes guesses within decision 7's limits.
3. **Reconcile the layers.** `mksync setting list` (what a profile or OS layer sets above the base, side by side) and
   `mksync setting move <path> [<key>] --to base|os|profile|machine` (preview, question, `--dry-run`, `--yes`), with
   the profile-value search, the leak scan and the `$HOME` check on the base-bound text, and never a write to
   `master`: the change waits for `mksync push`. Plan: `docs/plan-smart-first-run-3.md` (`v1.4.0`).
4. **Help and messages.** WIZ-10 (decided 2026-11-27: pull's `Apply these changes?` defaults to yes except under
   `--force`; push's PR question stays `[y/N]`; end of input is no), CLI-1 (`--help` at every level, exit 0), CLI-2 (`ERROR: unknown command ...`), CLI-3 (four
   contract lines that say exit 1 where the code exits 2), CLI-4 (`mksync profile show` in
   `docs/plan-work-machines.md`).

## Decided (proposed, for review)

1. **Phase 1 first.** It removes most typing, changes no command or flag, and ships on its own.
2. **Public name guess: `<profile>-<os>`** (`work2-windows`, `personal-linux`), not a hash. It is readable, names no
   person or host, and the branch's time stamp keeps two machines of the same profile apart. Today's login-based
   guess goes.
3. **Picker default by profile:** a file that offers no `p` suggests `s` on `personal` and `k` on a work profile. `k`
   sends nothing, so a work machine's desktop or tool folders never reach the shared layers by an Enter.
4. **A rule can list several `suggest` sources;** the first that answers is the suggestion. New sources:
   `origin-owner` (the owner in the clone's `github.com` origin), `gh-hosts-login` (`gh config get -h github.com
user`, no network), `passwd-name` (Linux: the full-name field of this user's passwd entry), `gh-path` (`gh` on
   `PATH`).
5. **`<GH_CLI_PATH>`** takes `gh-path` when it answers and saves it as a machine value, so export sanitizes it (the
   path can hold the user name); the fixed default stays the fallback. It is never asked.
6. **Profile-value search matches whole tokens** (a value is a hit only when the characters on both sides are not
   letters or digits; `-` and `_` end a token, changed at review), and its refusal names the change's number as printed in the block above it.

Needs the user's yes before its phase starts (breaking or naming):

- **Phase 2:** guessing the profile (WIZ-1) reverses the design's "no suggestion" rule, and `setup --yes` without
  `--profile` starts succeeding.
- **Phase 3:** the noun `setting` and the verbs `list` and `move` (over `promote`/`demote`, which the program
  already calls a move); `--to` required.
- **Phase 4:** `--help` exits 0 and the unknown-verb message changes; both are contract lines today.

## Open (not in any phase)

- `<YOUR_WORK_MARKETPLACE>` sits in the common VS Code settings (Linux and macOS only), so a fresh personal machine
  is asked a value it has no answer for. Moving the line to a profile needs phase 3's `setting move`.
- A shared alias list rendered as native bash and PowerShell, if the list of aliases wanted on every OS grows.
- Who else overrides a key is unknown while the repo is public (each machine keeps its profile in local state):
  phase 3 prints "unknown", never "none", until the private switch.
