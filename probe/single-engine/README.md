Phase 1 research probe for `docs/plan-single-engine.md`; it is not part of the engine.
It prints the entry count and SHA256 of `<repo>/sync-config.json`, a CRLF fold check, the first `git --version` line and the OS, or `ERROR: <message>` and exit 1 when the config cannot be read.
Run with Bun: `bun run probe/single-engine/main.ts <repo>`; build with `bun build --compile probe/single-engine/main.ts --outfile <path>`.
Run with Deno: `deno run -A probe/single-engine/main.ts <repo>`; build with `deno compile -A --output <path> probe/single-engine/main.ts`.
Only `node:` imports are used, so both runtimes build the file unchanged.
