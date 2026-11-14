import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoFiles } from "../core/plan/types.ts";
import { originUrls } from "./visibility.ts";

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

/** The tree the diff's `base` and `theirs` read: every dotfile. */
const DOTFILES_FOLDER = "dotfiles";

/** The repo paths `readHeadTree` covers: every dotfile and the config. */
const HEAD_TREE_PATHS = [DOTFILES_FOLDER, "sync-config.json"] as const;

/** The sync point file under the state folder (contract "Sync point"). */
const SYNC_POINT_FILE = "last-sync";

/** A sync point is a full lowercase SHA, as the contract's state file holds it. */
const SYNC_POINT_PATTERN = /^[0-9a-f]{40}$/;

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
 * Every blob under `paths` at `ref`. One `ls-tree` names the blobs and one
 * `cat-file --batch` reads them all, so no process runs per file. Kept byte
 * for byte; `undefined` when git cannot tell (no repo or no such ref).
 */
async function readTreePaths(
  repoRoot: string,
  ref: string,
  paths: readonly string[],
): Promise<RepoFiles | undefined> {
  const listing = await runGit(repoRoot, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    ref,
    "--",
    ...paths,
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
 * Every blob under `dotfiles/` at `ref`, for the diff's `base` and `theirs`
 * trees. `undefined` when git cannot tell (no repo or no such ref).
 */
export async function readTreeAt(
  repoRoot: string,
  ref: string,
): Promise<RepoFiles | undefined> {
  return readTreePaths(repoRoot, ref, [DOTFILES_FOLDER]);
}

/**
 * Every blob under `dotfiles/` and `sync-config.json` at `HEAD`, for
 * `Snapshot.headFiles`. Kept byte for byte; `undefined` when git cannot tell
 * (no repo or no commit).
 */
export async function readHeadTree(
  repoRoot: string,
): Promise<RepoFiles | undefined> {
  return readTreePaths(repoRoot, "HEAD", HEAD_TREE_PATHS);
}

/**
 * The engine's sync point for the diff: the first line of the state folder's
 * `last-sync`, accepted only when it is a full lowercase SHA that names a
 * commit here. Any other file or missing file means no sync point.
 */
export async function readSyncPoint(
  repoRoot: string,
  stateFolder: string,
): Promise<string | undefined> {
  let text: string;
  try {
    text = readFileSync(join(stateFolder, SYNC_POINT_FILE), "utf8");
  } catch {
    // No state file or one that cannot be read is no recorded sync point.
    return undefined;
  }
  const sha = text.split(/\r?\n/, 1)[0] ?? "";
  if (!SYNC_POINT_PATTERN.test(sha)) {
    return undefined;
  }
  return (await commitExists(repoRoot, sha)) ? sha : undefined;
}

/** One commit's short SHA and commit date, `%h` and `%cs`. */
export interface CommitStamp {
  readonly short: string;
  readonly date: string;
}

/**
 * A ref's short SHA and commit date, for the diff's header. `undefined` when
 * git cannot tell (no repo or no such ref).
 */
export async function readCommitStamp(
  repoRoot: string,
  ref: string,
): Promise<CommitStamp | undefined> {
  const output = await runGitText(repoRoot, [
    "log",
    "-1",
    "--format=%h%x00%cs",
    "--end-of-options",
    ref,
  ]);
  if (output === undefined || output.code !== 0) {
    return undefined;
  }
  const [short, date] = output.stdout.trim().split("\u0000");
  if (short === undefined || short === "" || date === undefined || date === "") {
    return undefined;
  }
  return { short, date };
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

/** Run one git command in the repo root, its stdout as text and exit code. */
export async function runGitText(
  repoRoot: string,
  args: readonly string[],
): Promise<{ readonly code: number; readonly stdout: string } | undefined> {
  try {
    const child = Bun.spawn(["git", ...args], {
      cwd: repoRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdout = await new Response(child.stdout).text();
    const code = await child.exited;
    return { code, stdout };
  } catch {
    // A missing git or an unreadable folder is "git cannot tell".
    return undefined;
  }
}

/** Every push URL of the origin remote, where a push would go; empty when
 * there is none, and `undefined` when git fails for any other reason, so the
 * guard reads the visibility as unknown. */
export async function readOrigin(
  repoRoot: string,
): Promise<readonly string[] | undefined> {
  const output = await runGitText(repoRoot, [
    "remote",
    "get-url",
    "--push",
    "--all",
    "origin",
  ]);
  return originUrls(output);
}

/** A clone's git folder, or the file a worktree has in its place. */
const GIT_DIR = ".git";

/**
 * The paths the clone tracks, from `git ls-files`, for the public-repo guard.
 * A folder with no `.git` isn't a clone and tracks nothing. In a clone,
 * `undefined` when git can't list them (it fails or can't start), so the
 * guard fails closed rather than seeing an empty clone.
 */
export async function readTrackedPaths(
  repoRoot: string,
): Promise<readonly string[] | undefined> {
  if (!existsSync(join(repoRoot, GIT_DIR))) {
    return [];
  }
  const output = await runGitText(repoRoot, ["ls-files", "-z"]);
  if (output === undefined || output.code !== 0) {
    return undefined;
  }
  return output.stdout.split("\u0000").filter((path) => path !== "");
}
