---
name: ts-generate-tests
description: "Generate a test suite for a source file or module, in whatever runner the project already uses (TypeScript)"
when_to_use: "Use when a source file has no tests, when new exported functions were added without coverage, or the user says \"write tests for\", \"add test coverage\", \"generate tests\", or \"this file isn't tested\". Not for fixing an existing failing test (that's debugging, not generation) or for reconciling tests with source that already has partial coverage (see ts-sync-tests for that)."
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
argument-hint: "[file-or-module] (optional)"
---

# Generate Tests

**Target:** $ARGUMENTS

## Step 1 — Resolve target

If `$ARGUMENTS` is provided, use it as the target source file or module. If empty, discover the
source root from `package.json` (`"main"`, `"exports"`, or the `src/` convention). Scan for source
files that have no corresponding test file; present the top candidates and ask the user to choose
before proceeding.

## Step 2 — Discover the runner and layout

Never assume Vitest, Jest, or any other runner — read what the project actually uses:
- `package.json` `scripts.test` and the `devDependencies` — the runner is whichever of
  `vitest`/`jest`/`node:test`/`ava`/`tap` actually appears there.
- The matching config file if one exists (`vitest.config.*`, `jest.config.*`) for `include`,
  `exclude`, and `root`.
- 2–3 existing test files — they show the real import style and assertion syntax more reliably
  than any config file.

Layout, likewise determined from existing tests, not assumed:
- Co-located: `src/calendar/parser.ts` → `src/calendar/parser.test.ts`
- Separate test dir: `src/calendar/parser.ts` → `test/calendar/parser.test.ts`
- Flat test dir: `src/calendar/parser.ts` → `test/parser.test.ts`

If no tests exist yet, default to co-located (`<source-path>.test.ts`) and document the choice in
the report.

## Step 3 — Read the target

Identify every exported function/class/method (test subjects), external dependencies (HTTP,
filesystem, clock, env vars — the mock boundaries), and the branching/edge cases/error paths that
need coverage. `ts-testing` (loaded natively for `**/*.test.ts`) covers AAA structure, naming,
mocking discipline, and `it.each` — write to that convention rather than repeating it here.

## Step 4 — Write tests

Match whatever the discovered runner's import and assertion style actually is — do not default to
one runner's syntax if the repo uses another:

```typescript
// Example shown with Vitest — mirror whatever the repo actually uses (Step 2 determines this).
import { describe, it, expect, vi } from "vitest";
import { parseIcs } from "./parser.js";

describe("parseIcs", () => {
  it("should return an empty array when the calendar has no events", () => {
    // Arrange / Act / Assert — see ts-testing for the full convention
    expect(parseIcs(EMPTY_ICS)).toHaveLength(0);
  });
});
```

Create the containing directory if it does not exist.

## Step 5 — Run and report

Run the test command discovered in Step 2 (never hardcode `vitest run` — use the project's actual
`package.json` script or the runner's own CLI for the specific file). If a new test fails, decide whether the test or the code is wrong: fix a wrong test, but never weaken an assertion to make it pass; report a suspected bug instead.
Then emit:

```
## Test Generation Report

Target: <source file>
Tests written to: <test file>
Runner: <discovered in Step 2>
Tests written: <N>
Result: ✅ <N> passed  /  ❌ <detail>
Coverage delta: <if available>
```
