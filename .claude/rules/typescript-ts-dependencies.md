---
paths:
  - "**/package.json"
  - "**/*.ts"
  - "**/*.tsx"
---

# Dependencies (TypeScript)

## Commit the Lockfile

Commit `package-lock.json` (or the project's lock file) to version control. It is the reproducibility
guarantee: everyone on the team and every CI run installs the exact same transitive graph. Use
`npm ci` in CI — it installs from the lockfile and fails if `package.json` and `package-lock.json`
are out of sync.

Never hand-edit the lockfile. If a transitive dependency needs to be pinned, use `overrides` in
`package.json`:

```json
{
  "overrides": {
    "vulnerable-transitive-dep": ">=2.1.0"
  }
}
```

See `ts-npm` for the full lockfile + security workflow.

## Separate `dependencies` from `devDependencies`

| Category | Location | Installed in production? |
|---|---|---|
| Runtime libraries | `dependencies` | Yes |
| Type declarations (`@types/*`) | `devDependencies` | No |
| Test runners, linters, compilers, build tools | `devDependencies` | No |
| Optional peer deps | `peerDependencies` / `optionalDependencies` | As declared |

Never install dev tools in a production image or bundle. A runtime package that leaks into
`devDependencies` will cause missing-module errors in production.

## Prefer Node Built-Ins

Check whether the Node.js standard library already provides what you need before reaching for an npm
package. Common built-in replacements:

| Need | Built-in |
|---|---|
| File I/O | `node:fs`, `node:fs/promises` |
| Paths | `node:path` |
| Crypto / random | `node:crypto` |
| HTTP client | global `fetch` (Node 18+) |
| Streams | `node:stream`, `node:stream/promises` |
| Deep clone | `structuredClone` |
| Cancellation | `AbortController` / `AbortSignal` |
| URL parsing | `URL` / `URLSearchParams` |
| Assertions | `node:assert` |

If a built-in covers ≥ 80% of the use case, prefer it. Adding a dependency for a single utility
function is usually not worth the maintenance, security, and bundle cost.

## Vet Before Adding

Before adding any package, confirm:

1. **Actively maintained** — recent releases, issues addressed, not archived.
2. **CVEs** — run `npm audit` after adding; check the advisory database.
3. **Types** — does the package bundle `.d.ts` declarations? If not, does `@types/<pkg>` exist? If
   neither exists, adding the package requires ambient declarations or `any` casts.
4. **ESM / CJS compatibility** — does the package's `exports` map support your module system?
5. **Transitive footprint** — `npm install <pkg> --dry-run` to preview what else gets added.
6. **License** — MIT/Apache/BSD are typically acceptable; GPL/AGPL require legal review for
   commercial projects; unlicensed packages are a risk.

See `/ts-add-package` to run the vet-and-wire flow interactively.

## Remove Unused Dependencies

Audit with `depcheck` or `knip` after deleting code that used an import. Remove the package from
`package.json` and run `npm install` to update the lockfile. Dead entries in `package.json` add
install time, audit surface, and signal-to-noise ratio problems in reviews.

## Dependency Updates

Keep dependencies current. Automated update PRs (Dependabot, Renovate) that run the full test suite
are the lowest-friction path. Never merge a dependency update without running the project's full
quality gate — discover it from `package.json` scripts (`check`/`validate`/`ci`), or fall back to
type-check + lint + `scripts.test` (whatever runner that resolves to; never assume Vitest
specifically). A major-version bump is a code-change opportunity, not just a version bump — read
the migration guide before merging.
