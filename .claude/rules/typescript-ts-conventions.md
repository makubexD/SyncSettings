---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.mts"
  - "**/*.cts"
---

# Conventions (TypeScript)

## `unknown` over `any`

Annotate every exported function's parameters and return type. Avoid `any` — it disables type
checking for everything it touches. Use `unknown` when the type is not yet known, and narrow it
before use:

```typescript
// Correct — unknown, narrowed before use
function process(input: unknown): string {
  if (typeof input !== "string") throw new TypeError(`Expected string, got ${typeof input}`);
  return input.trim();
}

// Avoid — any, bypasses all checks
function process(input: any): any {
  return input.trim();
}
```

When a third-party library ships no types and no `@types/*` package exists, declare a narrow ambient
module with only the members you actually use rather than widening to `any`.

`@ts-expect-error` is preferred over `@ts-ignore` — it fails the build when the suppressed error
disappears (stale suppression). Both require an inline reason:

```typescript
// @ts-expect-error - legacy SDK lacks overload for callback form; tracked in #4512
legacySdk.call(opts, callback);
```

Never use a blanket `// @ts-nocheck` to silence a file.

## Explicit Optionals

Model absence with `T | undefined` — never a sentinel string (`""`, `"N/A"`), magic number (`-1`),
or undocumented `null`. Prefer `undefined` over `null` for optional values; use `null` only when
interoperating with APIs that return it.

Enable `strict` mode in `tsconfig.json` (covers `strictNullChecks`, `strictFunctionTypes`, etc.);
additionally consider `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` for maximum
precision.

## Naming

| Symbol | Style | Example |
|---|---|---|
| Classes, enums, type aliases, interfaces | `PascalCase` | `CalendarEvent`, `RowKind`, `ICalendarParser` → `CalendarParser` |
| Interfaces | `PascalCase` (no `I`-prefix) | `CalendarParser`, `Reporter` |
| Functions, methods, variables, parameters | `camelCase` | `parseIcs`, `dailyCapHours`, `calendarRows` |
| Module-level constants | `UPPER_SNAKE` | `MAX_RETRY_COUNT`, `DEFAULT_TIMEZONE` |
| Type parameters | `T` or `TPurpose` | `T`, `TResult`, `TEntity` |
| Private class fields | `#camelCase` or `_camelCase` | `#logger`, `_config` |
| Files | match project convention (discover from repo) | `calendarParser.ts` or `CalendarParser.ts` |

One cohesive concern per file; the filename reflects the primary export. Avoid barrel `index.ts` files
that re-export unrelated symbols.

## Interfaces and Structural Types

Prefer `interface` for object shapes that describe a contract — it is open for merging, renders
better in error messages, and is the natural contract mechanism. Use `type` for unions, intersections,
mapped types, and conditional types.

Do not use the `I`-prefix on interfaces (e.g. `ICalendarParser` → `CalendarParser`). The
type system's structural nature makes the distinction unnecessary.

Keep interfaces narrow (Interface Segregation). A caller should not depend on members it does not use.
Split a large interface before a caller is forced to stub irrelevant members.

## Immutability and Value Objects

Use `readonly` properties for value objects and DTOs. Prefer `ReadonlyArray<T>` / `Readonly<T>` to
communicate that a function does not mutate its inputs.

```typescript
// Value object — all properties readonly
interface TimesheetRow {
  readonly date: string;
  readonly start: string;
  readonly end: string;
  readonly summary: string;
}

// Factory function validates invariants; type carries the guarantee
function makeTimesheetRow(date: string, start: string, end: string, summary: string): TimesheetRow {
  if (!date || !start || !end) throw new RangeError("date, start, and end are required");
  return Object.freeze({ date, start, end, summary });
}
```

For closed sets of named constants, prefer a discriminated union or an `as const` object over `enum`:

```typescript
// Prefer — as const, discriminated union
const RowKind = { NORMAL: "normal", HOLIDAY: "holiday", PTO: "pto" } as const;
type RowKind = (typeof RowKind)[keyof typeof RowKind];

// Note: numeric enum members have a reverse-mapping footprint; string enums are safer but
// still add a runtime object. Use as const + type alias for the lightest-weight approach.
```

Always add an **exhaustiveness check** when switching over a discriminated union:

```typescript
function renderKind(kind: RowKind): string {
  switch (kind) {
    case "normal":  return "✅";
    case "holiday": return "🏖";
    case "pto":     return "🌴";
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unhandled RowKind: ${_exhaustive}`);
    }
  }
}
```

## Composition over Inheritance

Prefer composing objects over inheriting from base classes. Inheritance couples a subclass to its
parent's implementation and creates fragile hierarchies. Use it only when a genuine IS-A relationship
exists and the Liskov Substitution Principle holds.

- **Inheritance depth**: ≤ 2 levels; anything deeper is a design smell — extract a collaborator.
- Pure utility logic belongs in module-level functions, not static-only classes. A `class` with only
  `static` methods is a namespace pretending to be a class — use a plain module export instead.
- Ban: static mutable fields (hidden shared state), Service Locator, and singletons that cannot be
  substituted in tests.

## Control Flow and Pattern Matching

**Guard clauses over nesting.** Return or throw early at the top of a function for invalid or trivial
cases. Deep nesting (> 2–3 levels) is a readability smell — flatten with early returns or extracted
helpers.

Prefer `switch` with an exhaustiveness check over long `if`/`else if` chains when branching on shape
or value. Use discriminated unions to give TypeScript enough information to narrow exhaustively.

## Imports

Order: external packages → project-internal (`@/…`, `../…`, `./…`). Enforce via `import/order` ESLint
rule. Use `import type` for type-only imports (`import type { Foo } from "./foo"`) — it is erased at
compile time and prevents accidental runtime imports:

```typescript
import { createServer } from "node:http";      // Node built-in
import express from "express";                  // external package
import type { CalendarEvent } from "@/core/models"; // type-only internal
import { parseIcs } from "./parser.js";         // value internal
```

Prefer named exports over default exports — they are easier to search, refactor, and re-export.

## State and Side Effects

Module-level mutable state is banned (only `UPPER_SNAKE` constants at module scope). Prefer pure
functions. Apply Command-Query Separation: a function named `getX` must not mutate.

## Constants and Strings

Declare compile-time constants as `const` at module scope in `UPPER_SNAKE`. Use template literals
for string formatting — no manual concatenation for new code. Use `node:path` for filesystem paths.

## Never

- `any` without an inline comment giving the reason — prefer `unknown` and narrow.
- Non-null assertion `!` on a value that could realistically be `null`/`undefined` at runtime.
- `var` — use `const` (default) or `let`; never `var`.
- Empty `catch {}` or `catch (e) { /* ignored */ }` — silent lies.
- `catch (e) { throw e; }` — a catch that only rethrows adds nothing; remove it, or wrap with `cause`.
- Mutable module-level state (hidden shared state, obstructs testing and concurrency).
- Using exceptions for expected control flow (return a typed result instead).
- `eval`, `new Function(code)`, or `vm.runInNewContext` on non-constant input.

For a code review in this repo, use the `ts-code-reviewer` agent when it is installed, not a general-purpose
reviewer: it reviews against these rules.
