# Changelog

Newest first. Each release is a `v<x.y.z>` tag on `master`; update a machine with `mksync update`.

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
