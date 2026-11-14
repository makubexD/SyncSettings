/**
 * The leak scan `commit.sh` runs before anything is committed: the bash
 * script `scripts/ci/leak-scan.sh`, kept in bash by decision 4 of the phase 8
 * plan. The program runs it the same way and keeps its three outcomes apart.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** The repo-relative scan script, run through `bash` (never executed). */
const SCAN_SCRIPT = join("scripts", "ci", "leak-scan.sh");

/** A command that could not start has no exit code; report it as -1. */
const FAILED_TO_START = -1;

/** How the scan ended: clean, hits to report, or it could not run. */
export type LeakScanKind = "clean" | "hits" | "could-not-run";

/** What one leak scan returned: its kind, exit code and output. */
export interface LeakScanResult {
  readonly kind: LeakScanKind;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The kind a scan's exit code names; any other code could not run. */
function kindOf(code: number): LeakScanKind {
  if (code === 0) {
    return "clean";
  }
  return code === 1 ? "hits" : "could-not-run";
}

/**
 * Run `bash scripts/ci/leak-scan.sh <paths>` in the repo root, as
 * `commit.sh`'s `run_leak_scan` does: repo-relative paths, the scan's own
 * output left to the caller. Exit 0 is clean, exit 1 is hits (its stdout is
 * the `<file>:<line>: <rule>` lines), and a missing script, a missing bash or
 * any other exit is could-not-run. Never throws.
 */
export async function runLeakScan(
  repoRoot: string,
  paths: readonly string[],
): Promise<LeakScanResult> {
  if (!existsSync(join(repoRoot, SCAN_SCRIPT))) {
    return {
      kind: "could-not-run",
      code: FAILED_TO_START,
      stdout: "",
      stderr: "",
    };
  }
  try {
    const child = Bun.spawn(["bash", SCAN_SCRIPT, ...paths], {
      cwd: repoRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { kind: kindOf(code), code, stdout, stderr };
  } catch {
    // No bash on PATH (a Windows machine without Git Bash) is "could not run".
    return {
      kind: "could-not-run",
      code: FAILED_TO_START,
      stdout: "",
      stderr: "",
    };
  }
}
