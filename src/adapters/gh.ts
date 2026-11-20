/**
 * The GitHub CLI adapter: `gh pr create`, run with an argument array and no
 * shell, under a time limit. A missing `gh`, a timeout or a failing call is a
 * result, never an exception.
 */

import { decode, run } from "./process.ts";

/** How long `gh pr create` may take before it is killed. */
const PR_TIMEOUT_MS = 60_000;

/** A command that could not start (or timed out) has no exit code. */
const FAILED_TO_START = -1;

/** What one gh run returned: its exit code, output as text and success. */
export interface GhResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly ok: boolean;
}

/** What `prCreate` opens: the two branches, the title and the body. */
export interface PrCreateOptions {
  readonly base: string;
  readonly head: string;
  readonly title: string;
  /** The body text; ignored when `bodyFile` is given. */
  readonly body?: string;
  /** A file holding the body, as `commit.sh` passes a temporary one. */
  readonly bodyFile?: string;
  /** Override the 60-second limit; the tests use a short one. */
  readonly timeoutMs?: number;
}

/**
 * The gh binary: `GH` names another, as `commit.sh` allows (`GH=${GH:-gh}`),
 * so the parity runners' stub can answer. Unset or empty means `gh` on PATH.
 */
function ghBinary(): string {
  const override = process.env.GH;
  return override === undefined || override === "" ? "gh" : override;
}

/**
 * Run gh in `repoRoot` with an argument array and no shell, killing it once
 * `timeoutMs` passes. Never throws: a missing gh, a gh that could not start or
 * a run past the limit is `code: -1`.
 *
 * `adapters/visibility.ts` has the same runner for its own gh call, but its
 * result is stdout-only and its abort handling is tied to `VisibilityDeps`;
 * moving it would change that file's public surface, so the minimal runner is
 * repeated here rather than shared. `adapters/release.ts` reuses this runner
 * for `gh release view` and `gh release download`.
 */
export async function runGh(
  repoRoot: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<GhResult> {
  const result = await run([ghBinary(), ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    timeoutMs,
  });
  if (result.timedOut === true || result.notStarted === true) {
    // A missing gh is a failure result, so the caller reports it and stops.
    return { code: FAILED_TO_START, stdout: "", stderr: "", ok: false };
  }
  const stdout = decode(result.stdout);
  const stderr = decode(result.stderr);
  return { code: result.code, stdout, stderr, ok: result.code === 0 };
}

/**
 * Open a pull request with `gh pr create --base <base> --head <head>
 * --title <title>`, then `--body-file <bodyFile>` or `--body <body>` when
 * given, and no body flag otherwise. gh prints the PR URL on stdout; a
 * non-zero exit or a missing gh is a failed result whose stderr names why.
 */
export async function prCreate(
  repoRoot: string,
  options: PrCreateOptions,
): Promise<GhResult> {
  const args = [
    "pr",
    "create",
    "--base",
    options.base,
    "--head",
    options.head,
    "--title",
    options.title,
  ];
  if (options.bodyFile !== undefined) {
    args.push("--body-file", options.bodyFile);
  } else if (options.body !== undefined) {
    args.push("--body", options.body);
  }
  return await runGh(repoRoot, args, options.timeoutMs ?? PR_TIMEOUT_MS);
}
