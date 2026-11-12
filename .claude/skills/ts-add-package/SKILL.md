---
name: ts-add-package
description: "Vet and wire a new npm package — CVEs, types, license, ESM/CJS compatibility (TypeScript)"
when_to_use: "Use any time a new npm package needs adding — \"add <package>\", \"install <package>\", \"I need a library for X\". Confirms before adding if vetting flags risk. Scoped to bringing in a package that is not yet installed — not for bumping an existing package to a newer release, which needs no vetting workflow."
allowed-tools: Read, Bash, Grep, Glob, Edit, Write
argument-hint: "<package-id> [version] [--dev]"
---

# Add Package

**Package:** $ARGUMENTS

Parse `$ARGUMENTS`:
- First token → `<package-id>`
- If a second token looks like a version (e.g. `4.2.0`) → `<version>`; else auto-discover.
- If `--dev` is present → `devDependencies` (also add `@types/<pkg>` if needed).

The project uses Bun as its package manager (`.claude/rules/typescript-ts-npm.md`): every command below is `bun`,
never `npm`, and the lockfile is `bun.lock`.

## Step 1 — Discover repo layout

Locate the project root and target `package.json` (ask which workspace member, if more than one).
Check whether the package is already referenced (`grep -r "\"<package-id>\"" . --include="package.json"`);
if found, report the current version and ask whether to **update** instead of add.

## Step 2 — Vet the package

```bash
bun info <package-id> version 2>&1
bun audit 2>&1 || true                              # baseline before the add
bun add <package-id>@<version> --dry-run 2>&1       # previews transitive footprint
```

Check https://www.npmjs.com/package/<package-id> for:

1. **Maintenance** — last publish date, download trend, open issues; flag if last release > 12mo ago.
2. **License** — MIT/Apache/BSD/ISC typically fine; GPL/AGPL needs legal review; unlicensed is a risk.
3. **Types** — ✅ bundled (`"types"`/`"typings"` field) / ✅ `@types/<package-id>` exists / ⚠ none
   (forces `any` casts or ambient declarations — flag as a risk).
4. **ESM/CJS compatibility** — does `exports` include the condition the project's module system needs?
5. **Node built-in alternative** — could `node:fs`/`node:crypto`/`fetch`/`structuredClone`/etc. cover
   this need instead? If yes, recommend the built-in and stop.
6. **Source** — recognized author/organization, download counts, provenance.

**If vetting flags a risk:** present the finding and ask for explicit confirmation before proceeding.

## Step 3 — Determine version

Use `<version>` if provided; otherwise `bun info <package-id> dist-tags.latest` and use the latest
stable release (avoid pre-release unless explicitly requested).

## Step 4 — Add the package

`bun add <package-id>@<version>` (`bun add -d` for `--dev`). If types aren't bundled and
`@types/<package-id>` exists, add it too: `bun add -d @types/<package-id>`.

Lifecycle scripts stay blocked: `trustedDependencies` in `package.json` stays `[]`. Run `bun pm untrusted`; if the
package's scripts were blocked, check that it works without them, and if it doesn't, treat that as a vetting risk
(read the script, ask before `bun pm trust`).

## Step 5 — Verify the install

### Lock file

`git diff bun.lock | head -40` — an unchanged lockfile means the install didn't take. Then
`bun install --frozen-lockfile` must pass, as it will in CI, and `bun audit` must show no new finding.

### Quality gate

Discover the gate from `package.json` scripts (`check`/`validate`/`ci`/`prepublishOnly`) and run
that. Only if none exists, fall back to the type checker, linter, and `scripts.test` separately —
never hardcode a specific runner. If the gate fails, **undo** (`bun remove <package-id>`) and
report the failure.

## Step 6 — Report

```
## Add Package Report

Package: <package-id>@<version>
Added to: <target package.json>
Category: <dependencies / devDependencies>

### Vetting
- CVEs: <none detected / ⚠ flagged — detail>
- License: <MIT / Apache-2.0 / ⚠ flagged — detail>
- Maintenance: <active / ⚠ last release: <date>>
- Types: <bundled / @types/<pkg> added / ⚠ no types available>
- ESM/CJS: <compatible / ⚠ mismatch — detail>
- Transitive additions: <N new packages>
- Lifecycle scripts: <none / blocked, works without / ⚠ needs trust — detail>
- Built-in alternative: <none / ⚠ node:X can replace — recommendation>

### Gate
✅ <gate command> passed  /  ❌ <failure detail>

### Next steps
<recommended follow-up, if any>
```
