/**
 * The GitHub CLI adapter: `gh pr create`, run with an argument array and no
 * shell, under a time limit. A missing `gh`, a timeout or a failing call is a
 * result, never an exception.
 */

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
 * `timeoutMs` passes. Never throws: a missing gh, a timeout, or output still
 * held open when the limit passes is `code: -1`.
 *
 * `adapters/visibility.ts` has the same runner for its own gh call, but its
 * result is stdout-only and its abort handling is tied to `VisibilityDeps`;
 * moving it would change that file's public surface, so the minimal runner is
 * repeated here rather than shared.
 */
async function runGh(
  repoRoot: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<GhResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const child = Bun.spawn([ghBinary(), ...args], {
      cwd: repoRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutPromise = new Response(child.stdout).text();
    const stderrPromise = new Response(child.stderr).text();
    const outcome = await Promise.race([child.exited, deadline]);
    if (outcome === "timeout") {
      // Kill and reap it, but don't wait on its pipes: a process gh started
      // may still hold them open, which is the hang the limit exists for.
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
      void stdoutPromise.catch(() => "");
      void stderrPromise.catch(() => "");
      return { code: FAILED_TO_START, stdout: "", stderr: "", ok: false };
    }
    // gh exited, but a process it started may still hold the pipes: the same
    // limit bounds the read.
    const read = await Promise.race([
      Promise.all([stdoutPromise, stderrPromise]),
      deadline.then(() => undefined),
    ]);
    if (read === undefined) {
      void stdoutPromise.catch(() => "");
      void stderrPromise.catch(() => "");
      return { code: FAILED_TO_START, stdout: "", stderr: "", ok: false };
    }
    const [stdout, stderr] = read;
    return { code: outcome, stdout, stderr, ok: outcome === 0 };
  } catch {
    // A missing gh is a failure result, so the caller reports it and stops.
    return { code: FAILED_TO_START, stdout: "", stderr: "", ok: false };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
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
