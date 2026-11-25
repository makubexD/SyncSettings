# Changelog

Newest first. Each release is a `v<x.y.z>` tag on `master`; update a machine with `mksync update`.

## v1.1.2 (2026-11-25)

- `mksync diff` sees every layer of a JSON file (common, OS, profile and machine), not only the last one. Before, it
  could say `This machine and the repo agree.` when `mksync check` said a pull would drop a new item, and the pull
  guard, setup's "keep mine" and the status line agreed with it. They now stop, or keep the item.
- Such a file still prints one line. A change in the repo and one on this machine in different layers is `BOTH`.
- `--only` accepts the path the diff prints when the file also has a profile or machine layer.
- The `ctx-print-guard` hook is synced for Linux.

## v1.1.1 (2026-11-23)

- "Keep mine" in `mksync setup` no longer undoes the repo's newer files. After a first sync it sends only the files
  changed on this machine (`OUT` and `BOTH`) into the repo folder, then imports, so files changed only in the repo
  still arrive. Before a first sync it still sends everything. With the bootstrap, setup does this before the script,
  whose import step then only imports.
- `mksync setup` with nobody to answer (no terminal, such as Claude Code's `!`) no longer applies: end of input at
  `Write the record and apply? [Y/n]` stops with `Stopped: nothing was written.` An empty answer is still yes, piped
  answers still work, and `--yes` still applies.
- New shared cases prove `mksync pull` stops before overwriting a JSON file that holds an item only this machine has
  (a hook, say). The contract explains why an import drops such an item and that `mksync push` keeps it.

## v1.1.0 (2026-11-23)

- `mksync setup` keeps this machine's changes. It asks every question first, the bootstrap one included, then shows
  the summary and asks `Write the record and apply?`; a no writes nothing.
- Above question 4 a line says how many files the import would overwrite and, after a first sync, which side changed
  them. With `OUT` or `BOTH` files it suggests "keep mine"; "back up and replace" lists them and needs a `[y/N]`
  confirm, and `--yes` refuses, as `mksync pull --yes` does.
- A yes to the bootstrap no longer drops answer 4: setup hands it to `bootstrap/linux.sh`, whose import step backs up
  and replaces, keeps this machine's files (export, then import), or stops, before the links, plugins and preview.
- A pull-only `--yes` refusal no longer suggests `--existing keep`, which pull-only can't use.

## v1.0.2 (2026-11-20)

- Installs and `mksync update` check the program against `SHA256SUMS` only. The attestation check is gone, since
  GitHub makes no attestation for a private repo on the Free plan.
- Both files come from the same release: through a signed-in `gh`, or over HTTPS while the repo is public.
- The docs describe the finished program: finished plans and research moved to `docs/archive/`, the README has a
  "Develop" section, and this changelog starts.

## v1.0.1 (2026-11-20)

- Private-repo prep: the installers and `mksync update` work through `gh`, so they keep working once the repo is
  private.

## v1.0.0 (2026-11-20)

- One engine: `mksync`, the TypeScript program, is the only engine. The bash and PowerShell engines are deleted.
- `sync-config.json` is config v2; a v1 config stops with exit 2.
- The Claude layout is live, and a fresh Ubuntu bootstrap runs the installed program.
- Update from `v0.9.0` with `mksync update`.

## v0.9.0 (2026-11-18)

- Cut-over part 1: the config is read by `schemaVersion`, and the layout's personal keys are in place.
