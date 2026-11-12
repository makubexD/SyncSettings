---
paths:
  - "**/package.json"
  - "**/bun.lock"
  - "**/bunfig.toml"
  - "**/.npmrc"
---

# Packages with Bun (TypeScript)

The engine is built and tested with Bun (`docs/design-layers.md`, "Runtime"). Bun is a build-time tool only: target
machines get one compiled program and need neither Bun nor Node. Use `bun` for every package operation; never mix in
another package manager, which would write a second lockfile.

## Lockfile Integrity

Commit `bun.lock` (the text lockfile) in every project. It records the exact version, resolved URL, and integrity hash
of every transitive dependency — the only guarantee that all environments install the same graph.

- **CI must use `bun install --frozen-lockfile`** — it installs from the lockfile and exits non-zero if `package.json`
  and `bun.lock` are out of sync.
- Add packages with `bun add <pkg>` (`bun add -d <pkg>` for dev tools); remove them with `bun remove <pkg>`.
- Never hand-edit the lockfile. Regenerate it with `bun install`.
- Never commit a binary `bun.lockb`, a `package-lock.json` or a `yarn.lock`. Do not add `bun.lock` to `.gitignore`. If
  you see it there, remove the entry.

## Vulnerability Scanning

Run `bun audit` as part of the CI quality gate, after `bun install --frozen-lockfile`:

```bash
bun audit                       # fail on any severity in runtime deps
bun audit --audit-level=high    # acceptable bar for dev-only tools; triage the rest
```

Triage findings before marking them as acceptable. An audited-and-ignored vulnerability is preferable to an unaudited
one — document the justification in `SECURITY.md` or the PR description.

For additional coverage, run `osv-scanner` (Google's open-source OSV scanner) against `bun.lock` — it cross-references
multiple advisory databases and catches findings that `bun audit` misses.

## Transitive Pinning with `overrides`

When a transitive dependency has a known vulnerability but the direct dependency has not yet released a fix, use
`overrides` (Bun also reads `resolutions`) to force a safe version:

```json
{
  "overrides": {
    "vulnerable-dep": ">=2.0.1"
  }
}
```

JSON does not allow comments — put the justification in `SECURITY.md` or the PR description, and remove the override
once the direct dependency ships the fix.

## Bun Version

Pin one Bun version for the repo, so local builds and CI produce the same program:

```json
{
  "packageManager": "bun@1.4.4"
}
```

CI installs exactly that version (`oven-sh/setup-bun` with `bun-version`). Bumping Bun is its own change, with the
build and the shared cases rerun on every target.

## Lifecycle-Script Risk

`postinstall`, `prepare`, and other lifecycle scripts can exfiltrate environment variables, install backdoors, or run
arbitrary code. Bun does not run a dependency's lifecycle scripts unless the package is listed in
`trustedDependencies`. Keep that list explicitly empty, which also turns off Bun's built-in allow-list of popular
packages:

```json
{
  "trustedDependencies": []
}
```

- `bun pm untrusted` lists the scripts that were blocked. Check it after every `bun add`.
- Trusting a package (`bun pm trust <pkg>`) needs a reason: read the script first (`bun pm pack` or the published
  tarball), check whether the package works without it, and flag it for review in the PR.
- Never install with `--trust` or a blanket allow-list.

## Registry Token Hygiene

This project uses the public registry only. If a private scope is ever needed, never commit authentication tokens to
`bunfig.toml` or `.npmrc`. Use environment-variable substitution:

```toml
# bunfig.toml (committed)
[install.scopes]
myorg = { url = "https://npm.pkg.github.com", token = "$NPM_TOKEN" }
```

The `$NPM_TOKEN` placeholder is expanded at install time from the environment — the literal token never appears in the
file. Scope registries narrowly — only packages under that scope go to the private registry; everything else resolves
from the public registry. This prevents dependency-confusion attacks where a private package name could be hijacked on
the public registry.

## Not Published to npm

The engine ships as compiled programs (`bun build --compile`) attached to releases, never as an npm package. Keep
`"private": true` in `package.json` so nothing can be published by accident.

## Never

- API keys or tokens as plain text in `bunfig.toml` or `.npmrc` committed to the repo.
- `"*"` or `latest` as a version specifier.
- A plain `bun install` in CI (use `bun install --frozen-lockfile`).
- A second package manager's lockfile next to `bun.lock`.
- A non-empty `trustedDependencies` without a recorded reason.
