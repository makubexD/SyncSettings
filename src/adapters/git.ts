import type { RepoFiles } from "../core/plan/types.ts";

/** What one `git` run returned: its exit code and raw stdout bytes. */
interface GitOutput {
  readonly code: number;
  readonly stdout: Uint8Array;
}

/**
 * Run git in the repo root with an argument array and no shell. `undefined`
 * means git could not start (no binary, unreadable folder), so callers treat
 * it as "git cannot tell" rather than an error. `input`, when given, is fed to
 * the process's stdin.
 */
async function runGit(
  repoRoot: string,
  args: readonly string[],
  input?: Uint8Array,
): Promise<GitOutput | undefined> {
  try {
    const child = Bun.spawn(["git", ...args], {
      cwd: repoRoot,
      stdin: input === undefined ? "ignore" : input,
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
 * Raw `git status --porcelain -- dotfiles sync-config.json
 * sync-config.v2.json`, for
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
    "sync-config.v2.json",
  ]);
  if (output === undefined || output.code !== 0) {
    return undefined;
  }
  return decodeText(output.stdout);
}

/** The repo paths `readHeadTree` covers: every dotfile and the config. */
const HEAD_TREE_PATHS = ["dotfiles", "sync-config.json"] as const;

/** The newline that closes each `cat-file --batch` header and object. */
const LF = 0x0a;

/** One `git ls-tree` line: the blob's object name and its repo path. */
interface TreeEntry {
  readonly oid: string;
  readonly path: string;
}

/** `ls-tree -r -z` records, `<mode> <type> <oid>\t<path>` separated by NULs. */
function parseTreeEntries(output: Uint8Array): readonly TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of decodeText(output).split("\u0000")) {
    if (record === "") {
      continue;
    }
    const tab = record.indexOf("\t");
    if (tab === -1) {
      continue;
    }
    const fields = record.slice(0, tab).split(" ");
    const oid = fields[2];
    if (oid === undefined) {
      continue;
    }
    entries.push({ oid, path: record.slice(tab + 1) });
  }
  return entries;
}

/**
 * The blob bytes `cat-file --batch` printed for `entries`, in its order: each
 * header is `<oid> blob <size>` then exactly `<size>` bytes and a newline. A
 * non-blob or missing object contributes no file. Bytes are never decoded.
 */
function parseBatchOutput(
  output: Uint8Array,
  entries: readonly TreeEntry[],
): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let index = 0;
  while (offset < output.length && index < entries.length) {
    const headerEnd = output.indexOf(LF, offset);
    if (headerEnd === -1) {
      break;
    }
    const fields = decodeText(output.subarray(offset, headerEnd)).split(" ");
    const entry = entries[index];
    index++;
    offset = headerEnd + 1;
    if (fields[1] !== "blob" || entry === undefined) {
      continue;
    }
    const size = Number(fields[2]);
    if (!Number.isFinite(size) || offset + size > output.length) {
      break;
    }
    files.set(entry.path, output.slice(offset, offset + size));
    offset += size + 1;
  }
  return files;
}

/**
 * Every blob under `dotfiles/` and `sync-config.json` at `HEAD`, for
 * `Snapshot.headFiles`. One `ls-tree` names the blobs and one
 * `cat-file --batch` reads them all, so no process runs per file. Kept byte
 * for byte; `undefined` when git cannot tell (no repo or no commit).
 */
export async function readHeadTree(
  repoRoot: string,
): Promise<RepoFiles | undefined> {
  const listing = await runGit(repoRoot, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    "HEAD",
    "--",
    ...HEAD_TREE_PATHS,
  ]);
  if (listing === undefined || listing.code !== 0) {
    return undefined;
  }
  const entries = parseTreeEntries(listing.stdout);
  if (entries.length === 0) {
    return new Map();
  }
  const request = new TextEncoder().encode(
    `${entries.map((entry) => entry.oid).join("\n")}\n`,
  );
  const batch = await runGit(repoRoot, ["cat-file", "--batch"], request);
  if (batch === undefined || batch.code !== 0) {
    return undefined;
  }
  return parseBatchOutput(batch.stdout, entries);
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
