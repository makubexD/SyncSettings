---
paths:
  - "**/tsconfig*.json"
  - "**/package.json"
  - "**/eslint.config.*"
  - "**/*.code-workspace"
---

# Project Layout (TypeScript)

## One Concern Per File

Each file exports one primary type, class, or logical unit. The filename reflects the primary export.
Avoid catch-all files (`utils.ts`, `helpers.ts`) — they become coupling magnets. When a file starts
serving two unrelated purposes, split it.

## Source and Test Layout

The canonical layout separates source from tests:

```
<package-root>/
  src/
    index.ts              ← public barrel (export only what consumers need)
    core/
      models.ts
      config.ts
    calendar/
      parser.ts
      normalizer.ts
  test/                   ← or src/**/*.test.ts co-located; discover from existing tests
    calendar/
      parser.test.ts
      normalizer.test.ts
  tsconfig.json
  package.json
```

Discover whether the project uses co-located tests (`src/foo/bar.test.ts`) or a separate `test/`
directory before creating new test files — follow the existing pattern.

## `tsconfig` as the Strictness Control Plane

Every project should have a `tsconfig.json` (or extend a root `tsconfig.base.json`) with at minimum:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "moduleResolution": "bundler",
    "target": "ES2022",
    "module": "ESNext",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

In a monorepo, put shared compiler options in a root `tsconfig.base.json` and extend it in each
package. Never silently disable a strict check without a documented reason in a comment.

`verbatimModuleSyntax` enforces `import type` for type-only imports at the module level, preventing
accidentally importing runtime values as types.

## ESM / CJS and the `exports` Map

Set `"type": "module"` in `package.json` for new projects (ESM-first). In NodeNext resolution mode,
relative imports in `.ts` source files must use the **`.js` extension** (TypeScript resolves `.ts`
at compile time; Node resolves `.js` at runtime):

```typescript
import { parseIcs } from "./parser.js";  // correct in NodeNext ESM
```

Declare an explicit `exports` map for any published package. It controls what consumers can import
and prevents accidental access to internal paths:

```json
{
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts"
}
```

For dual ESM/CJS packages, add a `"require"` condition alongside `"import"`. Validate resolution
correctness with `publint` and `@arethetypesright/cli` before publishing.

## Path Aliases

If the project uses path aliases (e.g. `@/core` → `src/core`), configure them consistently across
three places:
1. `tsconfig.json` `paths`
2. ESLint `import/resolver` settings
3. The test runner's own alias resolution (e.g. Vitest's `resolve.alias`, Jest's
   `moduleNameMapper` — whichever runner the project actually uses)

Inconsistency between these three causes build-passes-but-tests-fail or tests-pass-but-build-fails
scenarios.

## Workspaces and Project References

For monorepos, use npm workspaces:

```json
{
  "private": true,
  "workspaces": ["packages/*"]
}
```

Enable TypeScript project references for incremental builds — each package's `tsconfig.json`
declares `references` to its workspace dependencies:

```json
{
  "references": [{ "path": "../core" }]
}
```

Use `tsc --build` (or `tsc -b`) for incremental compilation; it respects the reference graph and
only rebuilds changed packages.

## Build Tooling

- **Type declarations + source maps**: `tsc` (the TypeScript compiler) is the canonical tool.
- **Bundling**: `tsup` (esbuild-based), `esbuild` directly, or `rollup` with `@rollup/plugin-typescript`
  for libraries; `vite` for browser applications.
- **Watch mode**: `tsc --watch` or the bundler's watch mode for development.
- Never commit `dist/` or `build/` to version control — add them to `.gitignore`. The published
  tarball is separate from the committed source.

## ESLint Flat Config as the Lint Control Plane

The ESLint flat config (`eslint.config.ts` or `eslint.config.js`) is the single source of truth
for lint rule severities across the project. Prefer it over legacy `.eslintrc.*` for new projects.

For TypeScript projects, extend `@typescript-eslint/recommended` and tune from there. Add
project-specific overrides in separate config objects rather than disabling rules globally:

```typescript
// eslint.config.ts
import tseslint from "typescript-eslint";

export default tseslint.config(
  tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);
```

The formatter (Prettier / Biome) is **optional and separate** — gates run `eslint .` always,
and add a format `--check` step only when a formatter config file is present.
