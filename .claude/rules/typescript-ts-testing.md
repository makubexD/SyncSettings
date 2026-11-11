---
paths:
  - "**/*.test.ts"
  - "**/*.spec.ts"
  - "**/*.test.tsx"
  - "**/*.spec.tsx"
---

# Testing (TypeScript)

> Example shown with Vitest syntax (`vi.fn`, `vi.mock`, `it.each`) — the structural conventions
> below (AAA, naming, fixture discipline, mock-only-at-boundaries) apply regardless of runner;
> translate the syntax to whatever the project's `package.json` actually uses (`node:test`, Jest,
> etc.) — never assume Vitest specifically.

## AAA Pattern

Structure every test as Arrange / Act / Assert with a blank line separating each phase and an
inline comment labeling each:

```typescript
it("should return formatted duration when given whole hours", () => {
  // Arrange
  const minutes = 120;

  // Act
  const result = formatDuration(minutes);

  // Assert
  expect(result).toBe("2h 00m");
});
```

One behavior per test. If a test requires more than one non-trivial assertion, it is likely covering
multiple behaviors — split it.

## Naming

Use `describe` to group tests by subject under test, and `it`/`test` with a description that reads
as a sentence: **`should <behavior> when <condition>`**.

```typescript
describe("formatDuration", () => {
  it("should include minutes when duration is not a whole hour", () => { … });
  it("should omit minutes when duration is exactly an hour", () => { … });
  it("should return zero when given zero minutes", () => { … });
});
```

One `describe` block per subject under test. Keep test files focused: one source module → one test
file.

## No Magic Values

Extract test data to named module-level constants or builder helpers at the top of the file. Name
them to communicate intent, not just structure:

```typescript
const PARIS_TZ = "Europe/Paris";
const FULL_DAY_MINUTES = 480;

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id: "evt-1", start: utc("2026-06-01T09:00Z"), end: utc("2026-06-01T10:00Z"), ...overrides };
}

function utc(iso: string): Date {
  return new Date(iso);
}
```

No inline literal objects in assertions. A reader should understand what a value represents without
tracing back to where it was defined.

## Mock Only I/O Boundaries

Mock at the boundary where your code touches something external: filesystem, network calls, clocks,
environment variables, external services. Test pure logic and data transformations without any mocking.

```typescript
// Correct — mock only the I/O boundary
vi.mock("./githubClient.js", () => ({
  fetchPullRequests: vi.fn().mockResolvedValue([makePr()]),
}));

// Avoid — mocking internal pure helpers defeats the test
vi.mock("./formatDuration.js");
```

Use Vitest's built-in `vi.fn()` / `vi.spyOn()` / `vi.mock()` — do not add a separate mocking
library. Pass mock implementations through constructor injection when the subject has dependencies;
reach for `vi.mock` only for module-level singletons that cannot be injected.

## Fixtures and Setup

Use `beforeEach` to reset shared state and construct fresh instances. Never share mutable state
between test cases inside a `describe` block.

```typescript
describe("CalendarNormalizer", () => {
  let normalizer: CalendarNormalizer;

  beforeEach(() => {
    normalizer = new CalendarNormalizer(DEFAULT_CONFIG);
  });

  it("should …", () => { … });
});
```

For expensive, read-only shared resources (large parsed fixtures, a real DB schema), use
`test.extend` or Vitest's `beforeAll` scoped to that `describe` block. Never put mutable state
in `beforeAll`.

## Parametrize with `it.each`

Use `it.each` / `test.each` when the same behavior needs verification over multiple inputs. Never
use a single-case `it.each` — write a plain `it` instead. Provide readable labels:

```typescript
it.each([
  [60,   "1h 00m"],
  [90,   "1h 30m"],
  [0,    "0h 00m"],
  [1440, "24h 00m"],
])("should format %i minutes as %s", (minutes, expected) => {
  expect(formatDuration(minutes)).toBe(expected);
});
```

## Time and Dates

Never assert against real `Date.now()` or `new Date()`. Inject a deterministic clock or use
`vi.useFakeTimers()` / `vi.setSystemTime()`:

```typescript
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});
```

## Coverage

Discover the project's coverage command first: check `package.json` scripts for a `coverage`,
`test:coverage`, or `check` task. Only if none exists, fall back to the discovered runner's own
coverage flag (e.g. `vitest run --coverage`, `jest --coverage`, or Node's built-in
`node --test --experimental-test-coverage`) — never assume a specific runner.

Hold the project's configured floor (Vitest `coverage.thresholds`, Jest `coverageThreshold`, or
the CI config) — do not assume a number. Gaps on I/O-boundary adapters (network
clients, filesystem wrappers) are acceptable when those boundaries are mocked in tests; gaps on
pure domain logic are not.

## Anti-Patterns

- `setTimeout` / real waits in tests — use fake timers.
- Test-specific flags or branches in production code (`if (process.env.NODE_ENV === "test") { … }`).
- Asserting on private class members when the public API observably covers the behavior.
- Single-case `it.each` — write a plain `it`.
- Asserting on snapshot strings for logic that changes frequently — prefer targeted property assertions.
- `vi.mock` hoisting surprises — place `vi.mock` calls at the top of the file or use `vi.doMock`
  for dynamic mocks inside tests.
