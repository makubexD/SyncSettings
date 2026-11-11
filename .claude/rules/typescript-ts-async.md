---
paths:
  - "**/*.ts"
  - "**/*.tsx"
---

# Async (TypeScript)

## No Floating Promises

Every `Promise` must be `await`ed, `return`ed, or explicitly handled. An unawaited Promise is a
"floating" Promise — its rejection is unobservable and its completion timing is unpredictable:

```typescript
// Correct — awaited
await sendNotification(event);

// Correct — returned to caller
return sendNotification(event);

// Correct — explicit fire-and-forget with rejection handling
void sendNotification(event).catch((err) => logger.error({ err }, "Notification failed"));

// Avoid — unhandled rejection, lost result
sendNotification(event);
```

Enable the `@typescript-eslint/no-floating-promises` ESLint rule to catch these at lint time.
Use `void` only when fire-and-forget is genuinely intentional and the rejection is handled via
`.catch()` or a global `unhandledRejection` handler.

## Independent Work: `Promise.all` / `Promise.allSettled`

When multiple async operations are **independent** of each other, run them concurrently with
`Promise.all`. Sequential `await` for independent operations is a needless latency multiplier:

```typescript
// Correct — concurrent; total time ≈ max(t1, t2)
const [calendarRows, devRows] = await Promise.all([
  fetchCalendar(config),
  fetchDevActivity(config),
]);

// Avoid — sequential; total time = t1 + t2
const calendarRows = await fetchCalendar(config);
const devRows = await fetchDevActivity(config);
```

`Promise.all` rejects on the first failure but cancels nothing: the other operations keep running
unless they share an `AbortSignal` you abort. Use `Promise.allSettled` when partial failure is
acceptable and you want to inspect each result individually.

Never `await` inside a `for` loop for independent items — collect the Promises and `await
Promise.all`. When the list can be large or unbounded, cap the concurrency (a small worker pool, or
a limiter the project already has):

```typescript
// Correct — all fetch calls in flight simultaneously (a short, bounded list)
const results = await Promise.all(items.map((item) => fetchItem(item.id)));

// Avoid — serial loop, each fetch waits for the previous
const results: Result[] = [];
for (const item of items) {
  results.push(await fetchItem(item.id));  // forces sequential execution
}
```

## Rejection Handling

Always handle rejections explicitly. Every `await` expression should be inside a `try/catch`, or
the rejection should be forwarded to the caller via the returned `Promise`:

```typescript
async function loadConfig(path: string): Promise<Config> {
  try {
    const raw = await fs.readFile(path, "utf8");
    return parseConfig(raw);
  } catch (e) {
    throw new ConfigError(`Failed to load config from ${path}`, { cause: e });
  }
}
```

With `Promise.allSettled`, check each `.status` before using `.value`:

```typescript
const results = await Promise.allSettled(operations.map(op => op.run()));
const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
if (errors.length > 0) logger.warn({ count: errors.length }, "Some operations failed");
```

## No `async` Promise Executor

Never pass an `async` function as the executor to `new Promise()` — rejections inside an async
executor are silently swallowed:

```typescript
// Avoid — rejection inside the async executor is lost
new Promise(async (resolve, reject) => {
  const data = await fetch(url).then(r => r.json()); // if this throws, it is swallowed
  resolve(data);
});

// Correct — promisify or async/await directly
const data = await fetch(url).then(r => r.json());
```

## Cancellation with `AbortController`

Long-running or externally-triggered async operations should accept an `AbortSignal` and honor it.
Use `AbortSignal.timeout(ms)` (Node 18+) for deadline-based cancellation:

```typescript
async function fetchWithTimeout(url: string, signal?: AbortSignal): Promise<Response> {
  const combined = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(5_000)])
    : AbortSignal.timeout(5_000);
  return fetch(url, { signal: combined });
}
```

Check `signal.aborted` at natural checkpoints in long loops, and call `signal.throwIfAborted()` to
surface cancellation as an `AbortError`:

```typescript
for (const item of items) {
  signal?.throwIfAborted();
  await processItem(item);
}
```

Propagate `AbortSignal` through the call chain — never start a new, unrelated fetch without passing
the signal down.

## Preserve Error Context

When re-throwing inside an async function, always attach the original error as `cause` so the full
async stack is preserved:

```typescript
catch (e) {
  throw new PipelineError("ADO fetch failed", { cause: e });
}
```

Never `throw new Error(e.message)` — this drops the original stack trace and `cause` chain.

## No Unobserved Fire-and-Forget

Launching a background async operation without any rejection handler is a reliability hazard.
If fire-and-forget is genuinely required, attach at minimum a logging `.catch()`:

```typescript
// Acceptable fire-and-forget pattern
void warmCache(key).catch((err) => logger.warn({ err }, "Cache warm failed — continuing"));
```

Register a global `process.on("unhandledRejection", …)` handler in the application entry point to
catch any that slip through.

## Blocking the Event Loop

Never call synchronous I/O in an async context if there is an async alternative:

```typescript
// Avoid — fs.readFileSync blocks the event loop on every call
const content = fs.readFileSync(path, "utf8");

// Correct — yields during I/O
const content = await fs.promises.readFile(path, "utf8");
```

Similarly, avoid CPU-intensive synchronous work (large JSON parsing, heavy computation) on the main
event loop thread without offloading to a `Worker` or a compute-optimized worker pool.

See `ts-performance-profiler` for detection of event-loop blocking patterns.

## Async Iteration

Use `for await…of` for consuming async iterables (streams, async generators, paginated APIs):

```typescript
for await (const chunk of readableStream) {
  process(chunk);
  signal?.throwIfAborted();
}
```

Prefer async generators over accumulating all results into an array when the dataset is large —
they keep memory bounded and allow backpressure.
