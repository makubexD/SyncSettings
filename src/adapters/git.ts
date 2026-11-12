/** What one `git` run returned: its exit code and raw stdout bytes. */
interface GitOutput {
  readonly code: number;
  readonly stdout: Uint8Array;
}

/**
 * Run git in the repo root with an argument array and no shell. `undefined`
 * means git could not start (no binary, unreadable folder), so callers treat
 * it as "git cannot tell" rather than an error.
 */
async function runGit(
  repoRoot: string,
  args: readonly string[],
): Promise<GitOutput | undefined> {
  try {
    const child = Bun.spawn(["git", ...args], {
      cwd: repoRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdout = new Uint8Array(await new Response(child.stdout).arrayBuffer());
    const code = await child.exited;
    return { code, stdout };
  } catch {
    // A missing git or an unreadable folder is reported as "cannot tell".
    return undefined;
  }
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * The repo's `HEAD` SHA, for `Snapshot.head`. An empty repo and a folder that
 * is not a git repo both give `undefined`, never an exception.
 */
export async function readHead(repoRoot: string): Promise<string | undefined> {
  const output = await runGit(repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    "HEAD",
  ]);
  if (output === undefined || output.code !== 0) {
    return undefined;
  }
  const sha = decodeText(output.stdout).trim();
  return sha === "" ? undefined : sha;
}

/**
 * Raw `git status --porcelain -- dotfiles sync-config.json`, for
 * `Snapshot.porcelain`. An empty string is a clean tree; `undefined` means git
 * could not tell (no repo).
 */
export async function readPorcelain(
  repoRoot: string,
): Promise<string | undefined> {
  const output = await runGit(repoRoot, [
    "status",
    "--porcelain",
    "--",
    "dotfiles",
    "sync-config.json",
  ]);
  if (output === undefined || output.code !== 0) {
    return undefined;
  }
  return decodeText(output.stdout);
}

/**
 * The bytes of a repo path at `HEAD`, for `Snapshot.headFiles`. Kept byte for
 * byte (no decoding or newline folding); `undefined` when the path is not in
 * `HEAD` or there is no commit yet.
 */
export async function readFileAtHead(
  repoRoot: string,
  repoPath: string,
): Promise<Uint8Array | undefined> {
  const output = await runGit(repoRoot, [
    "cat-file",
    "blob",
    "--",
    `HEAD:${repoPath}`,
  ]);
  if (output === undefined || output.code !== 0) {
    return undefined;
  }
  return output.stdout;
}

/**
 * Whether `sha` names an existing commit, for the sync point's check. A
 * missing repo or an unknown SHA is `false`.
 */
export async function commitExists(
  repoRoot: string,
  sha: string,
): Promise<boolean> {
  const output = await runGit(repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${sha}^{commit}`,
  ]);
  return output !== undefined && output.code === 0;
}
