---
paths:
  - "**/*.ts"
  - "**/*.tsx"
---

# Code Quality (TypeScript)

- **Clear names over comments.** Name variables, functions, and types to reveal their intent. A comment that re-states the code name is noise; a comment that explains *why* is valuable. A name states the domain role (`retryDelay`, not `value`), a boolean reads as a predicate (`isExpired`), and a quantity carries its unit (`timeoutMs`).
- **No dead code.** Delete commented-out code; use version control to recover it if needed. Dead code obscures the live logic.
- **Avoid magic numbers and strings.** Replace bare literals with named constants or enums so the meaning is clear at the call site.
- **Handle errors explicitly.** Never silently swallow exceptions or return null to signal an error. Make failure visible and actionable.
- **Duplicated knowledge, not duplicated text.** A wrong abstraction costs more than duplication. Tolerate a second copy of similar code; extract on the third, and only when the copies change for the same reason. Duplicated *knowledge* (a business rule, a constant, a schema) is a bug at the second copy: give it one home.
- **Fail fast.** Validate inputs at the boundary (function entry, API surface, config load). Do not let invalid state propagate deep into the system.
- **Consistent formatting.** Use the project's formatter/linter. Never debate formatting in code review — automate it.
- **Legacy code is not a precedent.** New or changed code follows these rules even when the code around it does not. Never copy an existing violation for consistency. If a rule needs something the project lacks, such as logging or configuration, say so in your summary instead of adding infrastructure the task did not ask for.
- **Mark known shortcuts.** When you knowingly leave a simplification or an unhandled case, mark it with a `shortcut:` comment saying what and why, and name it in your summary.

## SEARCH FIRST Protocol
Before creating any class, function, method, or module, search the codebase for similar patterns.
If 80%+ overlap with the same concern exists, extend the existing code — do not create a new one.
If less than 80% overlap or a genuinely different concern, create new. If uncertain whether overlap
is sufficient, ask before proceeding.

## SOLID Principles
- **Single Responsibility**: Each class or module has one reason to change.
- **Open/Closed**: Extend behavior through composition, not modification.
- **Liskov Substitution**: Subtypes must be substitutable for their base types without altering correctness.
- **Interface Segregation**: Prefer narrow, focused interfaces over wide, general-purpose ones.
- **Dependency Inversion**: Depend on abstractions, not concretions.

## Layering
Keep business logic out of I/O, transport, and presentation boundaries — CLI handlers, route
controllers, and middleware should delegate to domain functions, not contain logic themselves. A change
to the delivery mechanism must not require changes to the domain.

**No hardcoded configuration.** Environment-specific values (URLs, timeouts, feature flags, service
addresses, numeric limits) belong in config or environment variables — never as bare literals in logic.
See `ts-security` for the stronger invariant on credentials.

## Circular Dependencies and Coupling
Avoid circular imports — they signal a missing abstraction. Prefer narrow public interfaces; a module
that exports ≥ 10 symbols or imports from ≥ 5 sibling modules is a coupling smell.

- **Detect:** `ts-architecture-reviewer` builds the module graph and flags cycles.
- **Fix:** `ts-refactor-specialist` extracts the shared type or interface into a third module that
  both sides can import without a cycle.

## KISS / YAGNI
- **KISS**: The simplest solution that works is the correct one. Add complexity only when required.
- **YAGNI**: Do not implement functionality until it is actually needed. Speculative generality adds debt.
- **No premature optimization**: write the clear solution first; profile with `ts-performance-profiler`
  before optimizing. Optimize only measured hot paths — complexity bought without evidence is debt.

## Design Patterns
Avoid Singleton (hides dependencies,
obstructs testing) and Service Locator (obscures dependencies, inverts control in the wrong direction).

## Error Handling
Every catch either handles the error (recovers, or returns a typed error result) or rethrows it with
the original attached as the cause. Log and continue only at a top-level boundary (request handler,
command entry point, job runner, UI event handler), where the error stops travelling.

Chain exceptions with cause context using `throw new Error("context", { cause: originalErr })`
(preserves the cause chain and stack for the full trace). For recoverable paths, return an explicit
result — a typed `T | undefined`, a discriminated union `{ ok: true; value: T } | { ok: false; error: string }`,
or a small frozen object — with the contract documented in TSDoc; reserve `throw` for truly exceptional
cases. Never swallow silently: catch the **narrowest** type possible (`e instanceof SpecificError`)
and rethrow anything else unchanged.

```typescript
// Correct — cause preserved, narrowest catch
try {
  await fetchUser(id);
} catch (e) {
  if (e instanceof NetworkError) {
    throw new DataUnavailableError(`User ${id} unreachable`, { cause: e });
  }
  throw e; // rethrow unknown errors unchanged
}

// Anti-pattern — silent swallow
try {
  await fetchUser(id);
} catch {
  // nothing — the caller never knows
}
```

The anti-pattern to avoid: `catch { }` or `catch (e) { /* ignored */ }`.
