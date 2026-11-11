---
paths:
  - "**/*.ts"
  - "**/*.tsx"
---

# Security (TypeScript)

## Secrets and Credentials

Never embed secrets, API keys, tokens, passwords, or connection strings in source code, config files
committed to the repo, log messages, exceptions, or `toString()` / `JSON.stringify()` output.

Read secrets from environment variables or a secrets manager at startup:

```typescript
// Correct — read from env, fail fast with a clear message
const apiToken = process.env.API_TOKEN;
if (!apiToken) throw new Error("API_TOKEN environment variable is required");

// Avoid — hardcoded fallback makes the "missing" state silently use a real secret
const apiToken = process.env.API_TOKEN ?? "dev-token-1234";
```

Document required environment variables in `.env.example` with placeholder values only (never real
values). Never commit `.env` files — add them to `.gitignore`. See `ts-git` for the full history
hygiene invariant.

## Shell Injection

Never build shell commands by concatenating or interpolating untrusted input. Use
`child_process.execFile` or `child_process.spawn` with an argument array — they do not invoke a shell:

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

// Correct — argument array, no shell
const { stdout } = await execFileAsync("git", ["log", "--oneline", branch]);

// Avoid — shell interpolation, command injection
const { stdout } = await exec(`git log --oneline ${branch}`);  // branch could be "; touch /tmp/pwned"
```

Avoid `child_process.exec` and `child_process.execSync` with any untrusted input, and never pass
`shell: true` to `spawn` with dynamic arguments.

## Path Traversal

Validate user-supplied paths against an allowed root before using them. Resolve the path first —
relative components (`../`) are expanded — then assert it starts with the allowed prefix:

```typescript
import path from "node:path";

function safeReadFile(userPath: string, allowedRoot: string): string {
  const resolved = path.resolve(allowedRoot, userPath);
  if (!resolved.startsWith(path.resolve(allowedRoot) + path.sep)) {
    throw new Error(`Path traversal attempt: ${userPath}`);
  }
  return fs.readFileSync(resolved, "utf8");
}
```

## Unsafe Deserialization and Untrusted Input

Never use `eval`, `new Function(code)`, or `vm.runInNewContext` on data from external sources.
`JSON.parse` is safe for data, but validate the parsed shape with a schema library (zod, valibot,
arktype) before consuming it as a typed object — `JSON.parse` returns `any` and bypasses all
compile-time checks:

```typescript
import { z } from "zod";

const EventSchema = z.object({ id: z.string(), start: z.string() });

const parsed = EventSchema.parse(JSON.parse(rawBody)); // throws ZodError on invalid shape
```

Never deserialize untrusted YAML with a schema that constructs JavaScript types (functions,
regexps). `js-yaml` 4+ `yaml.load(input)` is safe by default; on 3.x the default `load` is not, so
upgrade. Pass `{ schema: yaml.JSON_SCHEMA }` when only JSON-compatible values are expected.

## Prototype Pollution

Guard object-merging and property-setting operations against `__proto__`, `constructor`, and
`prototype` key injection — these can poison the prototype chain and affect all objects in the
process:

```typescript
// Correct — Object.create(null) gives a prototype-free map; or check for forbidden keys
function safeMerge<T extends object>(target: T, source: Record<string, unknown>): T {
  for (const key of Object.keys(source)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    (target as Record<string, unknown>)[key] = source[key];
  }
  return target;
}
```

When building lookup maps from external data, use `Object.create(null)` rather than `{}` to avoid
inheriting `Object.prototype` properties.

## Secure Randomness

Use `crypto.randomBytes` / `crypto.randomUUID` (Node built-in) for security-sensitive values:
session IDs, CSRF tokens, API keys, nonces. `Math.random()` is not cryptographically secure and
must not be used for any secret or identifier.

```typescript
import { randomBytes, randomUUID } from "node:crypto";

const sessionId = randomUUID();                   // 128-bit random UUID
const token = randomBytes(32).toString("hex");    // 256-bit hex token
```

## Timing-Safe Comparison

Compare secrets, HMACs, and tokens with `crypto.timingSafeEqual` — a byte-by-byte constant-time
comparison. Normal `===` short-circuits on the first differing byte, leaking timing information
that can be used to reconstruct secrets:

```typescript
import { timingSafeEqual, createHmac } from "node:crypto";

function verifyHmac(payload: Buffer, receivedSig: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(payload).digest();
  const received = Buffer.from(receivedSig, "hex");
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}
```

## Network I/O

Always set a request timeout. Use `AbortSignal.timeout(ms)` (Node 18+) or an `AbortController`
with `clearTimeout` to prevent requests from hanging indefinitely:

```typescript
const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
```

Never disable TLS certificate verification (`rejectUnauthorized: false`) outside of local test
environments, and never leave it in production code without a documented justification guarded by
an environment variable.

Allowlist redirect targets and outbound URLs when a service makes requests on behalf of user input
(SSRF). Where a block list is unavoidable, check the resolved address, not the hostname, and connect
to that address so a re-resolution cannot swap it. Reject private IP ranges: loopback, `10.x`,
`172.16-31.x`, `192.168.x`, link-local `169.254.x` (cloud metadata), `0.0.0.0`, and their IPv6
equivalents. Reject non-HTTP/HTTPS schemes unless explicitly required.
