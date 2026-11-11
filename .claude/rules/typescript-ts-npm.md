---
paths:
  - "**/package.json"
  - "**/package-lock.json"
  - "**/.npmrc"
---

# npm (TypeScript)

## Lockfile Integrity

Commit `package-lock.json` in every project. It records the exact version, resolved URL, and
integrity hash of every transitive dependency — the only guarantee that all environments install the
same graph.

- **CI must use `npm ci`**, not `npm install` — it installs from the lockfile and exits non-zero if
  `package.json` and `package-lock.json` are out of sync.
- Never hand-edit the lockfile. Regenerate it by running `npm install`.
- Do not add `package-lock.json` to `.gitignore`. If you see it there, remove the entry.

## Vulnerability Scanning

Run `npm audit` as part of the CI quality gate:

```bash
npm audit --omit=dev   # audit runtime deps only; fail on any severity
npm audit              # include devDeps; acceptable to warn-only on High/Critical in dev tools
```

Triage findings before marking them as acceptable. An audited-and-ignored vulnerability is preferable
to an unaudited one — document the justification in `package.json` under `"overrides"` with a comment
or in a dedicated `SECURITY.md` entry.

For additional coverage, run `osv-scanner` (Google's open-source OSV scanner) against the lockfile —
it cross-references multiple advisory databases and catches findings that `npm audit` misses.

## Transitive Pinning with `overrides`

When a transitive dependency has a known vulnerability but the direct dependency has not yet released
a fix, use `overrides` to force a safe version:

```json
{
  "overrides": {
    "vulnerable-dep": ">=2.0.1"
  }
}
```

Document why in a comment in `package.json` (JSON does not allow comments — put the justification in
`SECURITY.md` or a PR description), and remove the override once the direct dependency ships the fix.

## Node Version Constraint

Specify the minimum supported Node.js version in `package.json` under `"engines"`:

```json
{
  "engines": {
    "node": ">=20.0.0"
  }
}
```

Use `nvm` / `fnm` with a `.nvmrc` or `.node-version` file for local version pinning. CI should
enforce `engines.node` via `npm install --engine-strict` or a `check-engines` pre-step.

## Lifecycle-Script Risk

`postinstall`, `prepare`, and other npm lifecycle scripts run automatically during `npm install`.
A malicious or compromised package can use these to exfiltrate environment variables, install
backdoors, or run arbitrary code.

Before adding any package with lifecycle scripts:
1. Read the script — `npm pack <pkg>` and inspect `scripts` in the extracted `package.json`.
2. Evaluate whether the script is necessary for the package to function.
3. For CI or automated installs where scripts are not needed, use:
   ```bash
   npm install --ignore-scripts
   ```
   and run required build scripts explicitly.

Flag any new devDependency that adds a `postinstall` script for team review.

## `.npmrc` Token Hygiene

Never commit authentication tokens to `.npmrc`. Use environment-variable substitution:

```ini
# .npmrc (committed)
@myorg:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NPM_TOKEN}
```

The `${NPM_TOKEN}` placeholder is expanded at install time from the environment — the literal token
never appears in the file. Add `.npmrc.local` (with actual tokens) to `.gitignore`.

Scope registries narrowly — only packages under the `@myorg` scope go to the private registry;
everything else resolves from the public registry. This prevents dependency-confusion attacks where
a private package name could be hijacked on the public registry.

## Publishing Hygiene

Before publishing a package:

1. **Declare `files`** — only ship what consumers need:
   ```json
   { "files": ["dist", "README.md", "LICENSE"] }
   ```
2. **Declare `exports`** — an explicit exports map prevents consumers from importing internal paths:
   ```json
   {
     "exports": {
       ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
       "./utils": { "import": "./dist/utils.js", "types": "./dist/utils.d.ts" }
     }
   }
   ```
3. **Validate before publishing:**
   ```bash
   npm pack --dry-run              # inspect what would be uploaded
   npx publint                    # check exports map correctness
   npx @arethetypesright/cli      # verify ESM/CJS type resolution is correct
   ```
4. **Run `prepublishOnly` gate** — add to `package.json` scripts, chaining the type checker, the
   linter, and the project's own `test` script (never hardcode a specific runner):
   ```json
   { "prepublishOnly": "tsc --noEmit && eslint . && npm test" }
   ```
5. **Publish with provenance** (npm 9.5+, GitHub Actions):
   ```bash
   npm publish --provenance
   ```
   Provenance links the published package to the specific CI workflow run and source commit —
   consumers can verify the package was built from your repo.

## Never

- API keys or tokens as plain text in `.npmrc` committed to the repo.
- `"*"` in version specifiers for published packages (use exact versions in `dependencies`).
- Publishing without a `prepublishOnly` gate.
- `npm install` in CI (use `npm ci`).
