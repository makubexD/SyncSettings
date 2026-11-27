import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RepoFiles } from "../core/plan/types.ts";
import { decode, run } from "./process.ts";
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
 * the process's stdin; `env`, when given, overrides those variables on top of
 * the caller's environment.
 */
async function runGit(
  repoRoot: string,
  args: readonly string[],
  input?: Uint8Array,
  env?: Readonly<Record<string, string>>,
): Promise<GitOutput | undefined> {
  const result = await run(["git", ...args], {
    cwd: repoRoot,
    ...(input === undefined ? {} : { input }),
    stdout: "pipe",
    stderr: "ignore",
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });
  if (result.notStarted === true) {
    // A missing git or an unreadable folder is reported as "cannot tell".
    return undefined;
  }
  return { code: result.code, stdout: result.stdout };
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** A command that could not start has no exit code; report it as -1, as
 * `visibility.ts` does. */
const FAILED_TO_START = -1;

/**
 * What one git command returned: its exit code, stdout and stderr as text,
 * and whether it exited 0. A git failure is this value, never an exception;
 * `code` is -1 when git could not start at all.
 */
export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly ok: boolean;
}

/**
 * Run git in the repo root with an argument array and no shell, reporting its
 * stdout and stderr as text. Never throws: a missing git or an unreadable
 * folder is `code: -1`. stdin is closed, so no command waits for a prompt.
 * `env` overrides single variables on top of the caller's environment.
 */
export async function runGitResult(
  repoRoot: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): Promise<GitResult> {
  const result = await run(["git", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });
  if (result.notStarted === true) {
    // A missing git or an unreadable folder is "git cannot tell".
    return { code: FAILED_TO_START, stdout: "", stderr: "", ok: false };
  }
  return {
    code: result.code,
    stdout: decode(result.stdout),
    stderr: decode(result.stderr),
    ok: result.code === 0,
  };
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

/**
 * Raw `git status --porcelain` for `pathspecs`, or for the whole tree when
 * none are given, for the core's `outsidePaths` and the changed-file list.
 * `commit.sh` runs it twice: once for `dotfiles sync-config.json` and, for the
 * outside check, once as `-- . :!dotfiles …`. `ok` is false when git cannot
 * tell (no repo, or git missing).
 */
export async function statusPorcelain(
  repoRoot: string,
  pathspecs: readonly string[] = [],
): Promise<GitResult> {
  return await runGitResult(repoRoot, [
    "status",
    "--porcelain",
    ...(pathspecs.length === 0 ? [] : ["--", ...pathspecs]),
  ]);
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
  if (
    short === undefined ||
    short === "" ||
    date === undefined ||
    date === ""
  ) {
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
  const result = await runGitResult(repoRoot, args);
  return result.code === FAILED_TO_START
    ? undefined
    : { code: result.code, stdout: result.stdout };
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

/** The non-empty records of a NUL-separated (`-z`) output, in git's order. */
function splitNulRecords(output: string): readonly string[] {
  return output.split("\u0000").filter((record) => record !== "");
}

/** A git run that returns repo paths. */
export interface GitPathsResult extends GitResult {
  readonly paths: readonly string[];
}

/**
 * The sync files `commit.sh` checks for cached values: the paths under
 * `paths` that differ from `HEAD` plus the untracked, non-ignored ones
 * (`git diff --name-only -z HEAD` and `git ls-files --others
 * --exclude-standard -z`), one list without repeats in git's order. A deleted
 * path appears too; `commit.sh` skips a path that no longer exists, so the
 * caller checks that as it reads them. `paths` is empty when either command
 * fails.
 */
export async function changedSyncPaths(
  repoRoot: string,
  paths: readonly string[],
): Promise<GitPathsResult> {
  const diff = await runGitResult(repoRoot, [
    "diff",
    "--name-only",
    "-z",
    "HEAD",
    "--",
    ...paths,
  ]);
  if (!diff.ok) {
    return { ...diff, paths: [] };
  }
  const untracked = await runGitResult(repoRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...paths,
  ]);
  if (!untracked.ok) {
    return { ...untracked, paths: [] };
  }
  return {
    code: 0,
    stdout: diff.stdout + untracked.stdout,
    stderr: diff.stderr + untracked.stderr,
    ok: true,
    paths: [
      ...new Set([
        ...splitNulRecords(diff.stdout),
        ...splitNulRecords(untracked.stdout),
      ]),
    ],
  };
}

/** The range `commit.sh` and the guard read: commits after upstream master. */
const UNPUSHED_RANGE = "origin/master..HEAD";

/** A git run returning the paths of each unpushed commit. */
export interface GitHistoryResult extends GitResult {
  readonly commits: readonly (readonly string[])[];
}

/**
 * The marker `git log -z --name-only --format=%x00` puts before each commit's
 * path list: the two NULs of the `%x00` format and its `-z` terminator, then
 * the newline that still separates the commit from its paths. A path cannot
 * contain NUL, and paths in a list are separated by a single NUL, so this
 * sequence never occurs inside a path or between two paths.
 */
const HISTORY_COMMIT_MARKER = "\u0000\u0000\n";

/**
 * The paths each commit in `range` adds or changes, from
 * `git log -z --name-only`, one list per commit in git's order (newest first),
 * for the core's `historyRefusals`. `-z` prints raw paths, so a non-ASCII or
 * spaced path is not quoted (`"profiles/jos\303\251.json"`) and reads as the
 * path the guard checks; `HISTORY_COMMIT_MARKER` starts each commit and a
 * commit with no such path (a deletion only, say) is not printed at all.
 * `commits` is empty when git cannot tell.
 */
export async function readUnpushedHistory(
  repoRoot: string,
  range: string = UNPUSHED_RANGE,
): Promise<GitHistoryResult> {
  const result = await runGitResult(repoRoot, [
    "log",
    "-z",
    "--name-only",
    "--diff-filter=ACMRT",
    "--format=%x00",
    range,
  ]);
  if (!result.ok) {
    return { ...result, commits: [] };
  }
  const commits: string[][] = [];
  for (const chunk of result.stdout.split(HISTORY_COMMIT_MARKER).slice(1)) {
    commits.push([...splitNulRecords(chunk)]);
  }
  return { ...result, commits };
}

/** A git run returning counts; both are 0 when git cannot tell. */
export interface GitCountsResult extends GitResult {
  readonly ahead: number;
  readonly behind: number;
}

/**
 * How many commits local `HEAD` is ahead of and behind `upstream`,
 * `commit.sh`'s `git rev-list --left-right --count HEAD...origin/master`.
 * `ok` is false when git cannot tell or prints something unreadable, and the
 * counts are then 0.
 */
export async function readAheadBehind(
  repoRoot: string,
  upstream: string = "origin/master",
): Promise<GitCountsResult> {
  const result = await runGitResult(repoRoot, [
    "rev-list",
    "--left-right",
    "--count",
    `HEAD...${upstream}`,
  ]);
  if (!result.ok) {
    return { ...result, ahead: 0, behind: 0 };
  }
  const [aheadText, behindText] = result.stdout.trim().split(/\s+/);
  const ahead = Number(aheadText);
  const behind = Number(behindText);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) {
    return { ...result, ok: false, ahead: 0, behind: 0 };
  }
  return { ...result, ahead, behind };
}

/** The environment the up-to-date check's git runs share with `sync.sh`: a
 * terminal prompt would hang a fetch or pull, so git must fail instead. */
const GIT_NO_PROMPT: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
};

/** What the up-to-date check reads from git, before its rules apply. */
export interface UpstreamFacts {
  readonly isRepo: boolean;
  readonly hasOrigin: boolean;
  readonly branch: string | undefined;
  readonly fetchOk: boolean;
  readonly behind: number;
}

/**
 * The facts behind the up-to-date check, gathered as `sync.sh`'s
 * `check_upstream` gathers them: a work tree, an `origin` remote and the
 * `master` branch first; then `git fetch -q origin master` and the count of
 * commits local `HEAD` lacks. A failed count reads as 0, so the check stays
 * silent, as the script does.
 */
export async function readUpstreamFacts(
  repoRoot: string,
): Promise<UpstreamFacts> {
  const repo = await runGitResult(
    repoRoot,
    ["rev-parse", "--is-inside-work-tree"],
    GIT_NO_PROMPT,
  );
  if (!repo.ok) {
    return {
      isRepo: false,
      hasOrigin: false,
      branch: undefined,
      fetchOk: false,
      behind: 0,
    };
  }
  const origin = await runGitResult(
    repoRoot,
    ["remote", "get-url", "origin"],
    GIT_NO_PROMPT,
  );
  if (!origin.ok) {
    return {
      isRepo: true,
      hasOrigin: false,
      branch: undefined,
      fetchOk: false,
      behind: 0,
    };
  }
  const symbolic = await runGitResult(
    repoRoot,
    ["symbolic-ref", "--short", "-q", "HEAD"],
    GIT_NO_PROMPT,
  );
  const branch = symbolic.ok ? symbolic.stdout.trim() : undefined;
  if (branch !== "master") {
    return {
      isRepo: true,
      hasOrigin: true,
      branch,
      fetchOk: false,
      behind: 0,
    };
  }
  const fetched = await runGitResult(
    repoRoot,
    ["fetch", "-q", "origin", "master"],
    GIT_NO_PROMPT,
  );
  if (!fetched.ok) {
    return {
      isRepo: true,
      hasOrigin: true,
      branch,
      fetchOk: false,
      behind: 0,
    };
  }
  const counts = await readAheadBehind(repoRoot);
  return {
    isRepo: true,
    hasOrigin: true,
    branch,
    fetchOk: true,
    behind: counts.behind,
  };
}

/** `git pull --ff-only -q`, the up-to-date check's one write: the fast-forward
 * it offers when the answer is yes. */
export function pullFastForward(repoRoot: string): Promise<GitResult> {
  return runGitResult(repoRoot, ["pull", "--ff-only", "-q"], GIT_NO_PROMPT);
}

/** The git config key `commit.sh` reads the machine alias from. */
const MACHINE_ALIAS_KEY = "syncsettings.machine";

/** A git run returning the machine alias, when one is set. */
export interface GitAliasResult extends GitResult {
  readonly alias: string | undefined;
}

/**
 * The machine alias `commit.sh` reads from `git config syncsettings.machine`.
 * `alias` is `undefined` when the key is unset, empty or git cannot tell; the
 * value is returned as stored, so the caller validates it against the alias
 * rule before it names a branch.
 */
export async function readMachineAlias(
  repoRoot: string,
): Promise<GitAliasResult> {
  const result = await runGitResult(repoRoot, [
    "config",
    "--get",
    MACHINE_ALIAS_KEY,
  ]);
  if (!result.ok) {
    return { ...result, alias: undefined };
  }
  const alias = result.stdout.trim();
  return { ...result, alias: alias === "" ? undefined : alias };
}

/**
 * Create and switch to `branch`, `commit.sh`'s `git switch -c`. `ok` is false
 * when git cannot tell or the branch already exists.
 */
export async function switchToNewBranch(
  repoRoot: string,
  branch: string,
): Promise<GitResult> {
  return await runGitResult(repoRoot, ["switch", "-c", branch]);
}

/**
 * Stage `paths` only, `commit.sh`'s `git add -- <paths>`. `ok` is false when
 * git cannot tell or a path does not exist.
 */
export async function stagePaths(
  repoRoot: string,
  paths: readonly string[],
): Promise<GitResult> {
  return await runGitResult(repoRoot, ["add", "--", ...paths]);
}

/**
 * Commit what is staged with `message`, `commit.sh`'s
 * `git commit -m <message>`. `ok` is false when git cannot tell or there is
 * nothing to commit.
 */
export async function commitStaged(
  repoRoot: string,
  message: string,
): Promise<GitResult> {
  return await runGitResult(repoRoot, ["commit", "-m", message]);
}

/**
 * Push `branch` to `remote` and set its upstream, `commit.sh`'s
 * `git push -u origin <branch>`. `ok` is false when git cannot tell or the
 * push is refused.
 */
export async function pushBranch(
  repoRoot: string,
  branch: string,
  remote: string = "origin",
): Promise<GitResult> {
  return await runGitResult(repoRoot, ["push", "-u", remote, branch]);
}

/**
 * Switch back to `master`, `commit.sh`'s `git switch master`. `ok` is false
 * when git cannot tell or the switch would lose changes.
 */
export async function switchToMaster(repoRoot: string): Promise<GitResult> {
  return await runGitResult(repoRoot, ["switch", "master"]);
}

/**
 * Delete the local `branch`, even when it is unmerged (`git branch -D`), for
 * the cleanup after a failure before the PR. `ok` is false when git cannot
 * tell or the branch is checked out.
 */
export async function deleteBranch(
  repoRoot: string,
  branch: string,
): Promise<GitResult> {
  return await runGitResult(repoRoot, ["branch", "-D", branch]);
}

/** A git run returning a commit SHA, when one could be read. */
export interface GitShaResult extends GitResult {
  readonly sha: string | undefined;
}

/**
 * The sync point `commit.sh` records: `git rev-parse HEAD^`, the branch's
 * parent, accepted only as the full lowercase SHA the state file holds.
 * `sha` is `undefined` when git cannot tell, there is no parent, or the output
 * is no SHA.
 */
export async function readParentSha(repoRoot: string): Promise<GitShaResult> {
  const result = await runGitResult(repoRoot, ["rev-parse", "HEAD^"]);
  if (!result.ok) {
    return { ...result, sha: undefined };
  }
  const sha = result.stdout.trim();
  return { ...result, sha: SYNC_POINT_PATTERN.test(sha) ? sha : undefined };
}

/** The repo path of the sync config, which the preview diffs like a dotfile. */
const CONFIG_FILE = "sync-config.json";

/** The pathspecs that scope the preview diff to the exported repo state. */
const PREVIEW_PATHSPECS = [DOTFILES_FOLDER, CONFIG_FILE] as const;

/** The temp folder prefix `previewDiff` makes, removed again on every path. */
const PREVIEW_TMP_PREFIX = "mksync-preview-";

/** The index file name inside the preview's temp folder. */
const PREVIEW_INDEX_FILE = "index";

/** The folder the preview writes each exported file's bytes into. */
const PREVIEW_BLOBS_FOLDER = "blobs";

/** What the preview's `git diff` run returned, as text. */
export interface PreviewDiff {
  readonly stat: string;
  readonly diff: string;
}

/** One tracked path's mode and blob SHA, from `ls-files -s -z`. */
interface IndexEntry {
  readonly mode: string;
  readonly sha: string;
  readonly path: string;
}

/** `ls-files -s -z` records, `<mode> <sha> <stage>\t<path>` split by NULs. */
function parseIndexEntries(output: Uint8Array): Map<string, IndexEntry> {
  const entries = new Map<string, IndexEntry>();
  for (const record of decodeText(output).split("\u0000")) {
    if (record === "") {
      continue;
    }
    const tab = record.indexOf("\t");
    if (tab === -1) {
      continue;
    }
    const fields = record.slice(0, tab).split(" ");
    const mode = fields[0];
    const sha = fields[1];
    const path = record.slice(tab + 1);
    if (mode === undefined || sha === undefined || path === "") {
      continue;
    }
    entries.set(path, { mode, sha, path });
  }
  return entries;
}

/**
 * Git's `--stat` and full diff of the exported tree in `files` against `HEAD`,
 * for the preview. The tree is built in a throwaway index, so the working
 * tree, any ref and the real index are never touched. `files` holds the
 * exported repo state — paths under `dotfiles/` and `sync-config.json` (any
 * other key is ignored); a tracked path missing from `files` is a deletion.
 * Both halves are `""` when the tree matches `HEAD`; `undefined` when git
 * cannot tell (no repo, no commit, or git missing).
 */
export async function previewDiff(
  repoRoot: string,
  files: ReadonlyMap<string, Uint8Array>,
): Promise<PreviewDiff | undefined> {
  const tmp = mkdtempSync(join(tmpdir(), PREVIEW_TMP_PREFIX));
  const index = join(tmp, PREVIEW_INDEX_FILE);
  const indexEnv: Readonly<Record<string, string>> = { GIT_INDEX_FILE: index };
  try {
    // Seed the throwaway index with HEAD's tree, so every index command below
    // and the cached diff read it instead of the real index.
    const seeded = await runGit(
      repoRoot,
      ["read-tree", "HEAD"],
      undefined,
      indexEnv,
    );
    if (seeded === undefined || seeded.code !== 0) {
      return undefined;
    }

    const listing = await runGit(
      repoRoot,
      ["ls-files", "-s", "-z", "--", ...PREVIEW_PATHSPECS],
      undefined,
      indexEnv,
    );
    if (listing === undefined || listing.code !== 0) {
      return undefined;
    }
    const tracked = parseIndexEntries(listing.stdout);

    // Write each exported file's bytes to temp and hash them in one run, so no
    // process starts per file and `--no-filters` keeps the bytes exact.
    const blobsFolder = join(tmp, PREVIEW_BLOBS_FOLDER);
    mkdirSync(blobsFolder);
    const pending: { path: string; blobPath: string }[] = [];
    for (const [path, bytes] of files) {
      if (path !== CONFIG_FILE && !path.startsWith(`${DOTFILES_FOLDER}/`)) {
        continue;
      }
      const blobPath = join(blobsFolder, String(pending.length));
      writeFileSync(blobPath, bytes);
      pending.push({ path, blobPath });
    }
    const shaByPath = new Map<string, string>();
    if (pending.length > 0) {
      const request = new TextEncoder().encode(
        `${pending.map((item) => item.blobPath).join("\n")}\n`,
      );
      const hashed = await runGit(
        repoRoot,
        ["hash-object", "-w", "--no-filters", "--stdin-paths"],
        request,
      );
      if (hashed === undefined || hashed.code !== 0) {
        return undefined;
      }
      const shas = decodeText(hashed.stdout)
        .split("\n")
        .filter((line) => line !== "");
      if (shas.length !== pending.length) {
        return undefined;
      }
      for (let i = 0; i < pending.length; i++) {
        const item = pending[i];
        const sha = shas[i];
        if (item === undefined || sha === undefined) {
          return undefined;
        }
        shaByPath.set(item.path, sha);
      }
    }

    // One `update-index --index-info` applies every add, change and removal to
    // the throwaway index, reusing a tracked path's mode and 100644 for new.
    const lines: string[] = [];
    for (const [path, entry] of tracked) {
      const bytes = files.get(path);
      if (bytes === undefined) {
        // The removal form takes an all-zero name as long as the repo's own
        // (SHA-1 or SHA-256) object names.
        lines.push(`0 ${"0".repeat(entry.sha.length)}\t${path}`);
        continue;
      }
      const sha = shaByPath.get(path);
      if (sha === undefined || sha === entry.sha) {
        continue;
      }
      lines.push(`${entry.mode} ${sha}\t${path}`);
    }
    for (const { path } of pending) {
      if (tracked.has(path)) {
        continue;
      }
      const sha = shaByPath.get(path);
      if (sha === undefined) {
        continue;
      }
      lines.push(`100644 ${sha}\t${path}`);
    }
    if (lines.length > 0) {
      const update = await runGit(
        repoRoot,
        ["update-index", "--index-info"],
        new TextEncoder().encode(`${lines.join("\n")}\n`),
        indexEnv,
      );
      if (update === undefined || update.code !== 0) {
        return undefined;
      }
    }

    const statResult = await runGit(
      repoRoot,
      [
        "-c",
        "core.quotepath=false",
        "diff",
        "--cached",
        "--no-color",
        "--no-ext-diff",
        "--no-renames",
        "--stat",
        "HEAD",
        "--",
        ...PREVIEW_PATHSPECS,
      ],
      undefined,
      indexEnv,
    );
    if (statResult === undefined || statResult.code !== 0) {
      return undefined;
    }
    const diffResult = await runGit(
      repoRoot,
      [
        "-c",
        "core.quotepath=false",
        "diff",
        "--cached",
        "--no-color",
        "--no-ext-diff",
        "--no-renames",
        "HEAD",
        "--",
        ...PREVIEW_PATHSPECS,
      ],
      undefined,
      indexEnv,
    );
    if (diffResult === undefined || diffResult.code !== 0) {
      return undefined;
    }
    return {
      stat: decodeText(statResult.stdout),
      diff: decodeText(diffResult.stdout),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The temp folder prefix `textDiff` makes, removed again on every path. */
const TEXT_DIFF_TMP_PREFIX = "mksync-conflict-";

/** `git diff --no-index` exits 1 when the files differ; above is a failure. */
const MAX_DIFF_EXIT = 1;

/** No user, system or attribute setting may change the diff's lines. */
const TEXT_DIFF_ARGS = [
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.autocrlf=false",
  "diff",
  "--no-index",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--unified=3",
  "--",
] as const;

/**
 * Git's unified diff from `before` to `after`, header included, with the user's
 * git settings left out. A missing side diffs as an empty file. The bytes go
 * through a private temp folder, removed on failure too. `undefined` when git
 * cannot tell.
 */
export async function textDiff(
  before: Uint8Array | undefined,
  after: Uint8Array | undefined,
): Promise<string | undefined> {
  const tmp = mkdtempSync(join(tmpdir(), TEXT_DIFF_TMP_PREFIX));
  try {
    const missing = new Uint8Array(0);
    writeFileSync(join(tmp, "theirs"), before ?? missing);
    writeFileSync(join(tmp, "mine"), after ?? missing);
    const output = await runGit(
      tmp,
      [...TEXT_DIFF_ARGS, "theirs", "mine"],
      undefined,
      {
        GIT_ATTR_NOSYSTEM: "1",
        GIT_CEILING_DIRECTORIES: dirname(tmp),
        // A git hook's own settings must not reach this diff.
        GIT_CONFIG_COUNT: "0",
        GIT_CONFIG_PARAMETERS: "",
        GIT_DIR: join(tmp, "none"),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        // Git lets this one win over `--unified`.
        GIT_DIFF_OPTS: "",
      },
    );
    return output === undefined ||
      output.code < 0 ||
      output.code > MAX_DIFF_EXIT
      ? undefined
      : decodeText(output.stdout);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The files under some pathspecs that differ from `HEAD`, relative to the
 * folder git ran in. */
export interface ChangedFiles {
  readonly tracked: readonly string[];
  /** Never an ignored file. */
  readonly untracked: readonly string[];
}

/** Whether nothing under `pathspecs` differs from `HEAD`, untracked files
 * included whatever the user's git settings show; false when git can't tell. */
export async function pathsClean(
  repoRoot: string,
  pathspecs: readonly string[],
): Promise<boolean> {
  const status = await runGitResult(repoRoot, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    ...pathspecs,
  ]);
  return status.ok && status.stdout === "";
}

/**
 * The tracked files changed or deleted in the work tree under `pathspecs`, and
 * the untracked ones that aren't ignored. `ls-files` prints paths relative to
 * `repoRoot`, where `status -z` prints them relative to the top of the clone.
 * `undefined` when git can't tell.
 */
export async function changedFiles(
  repoRoot: string,
  pathspecs: readonly string[],
): Promise<ChangedFiles | undefined> {
  const list = (flags: readonly string[]): Promise<GitResult> =>
    runGitResult(repoRoot, ["ls-files", "-z", ...flags, "--", ...pathspecs]);
  const [tracked, untracked] = await Promise.all([
    list(["--modified", "--deleted"]),
    list(["--others", "--exclude-standard"]),
  ]);
  if (!tracked.ok || !untracked.ok) {
    return undefined;
  }
  return {
    tracked: [...new Set(splitNulRecords(tracked.stdout))],
    untracked: splitNulRecords(untracked.stdout),
  };
}

/** What `restoreFiles` says when something under the paths still differs. */
const STILL_CHANGED = "ERROR: the repo folder still has changes.\n";

/** Remove the empty folders above a removed file, `path`'s top folder kept. */
function removeEmptyParents(repoRoot: string, path: string): void {
  let parent = dirname(path);
  while (parent.includes("/")) {
    try {
      rmdirSync(join(repoRoot, parent));
    } catch {
      // Not empty, or already gone: a folder git doesn't track changes nothing.
      return;
    }
    parent = dirname(parent);
  }
}

/**
 * Put `files` back as `HEAD` has them: restore the tracked ones and remove the
 * untracked ones, nothing else. `undefined` when everything under `pathspecs`
 * is clean again, else the error text to print.
 */
export async function restoreFiles(
  repoRoot: string,
  files: ChangedFiles,
  pathspecs: readonly string[],
): Promise<string | undefined> {
  if (files.tracked.length > 0) {
    // Literal paths on stdin: no glob, and no command line length limit.
    const restored = await run(
      [
        "git",
        "--literal-pathspecs",
        "restore",
        "--worktree",
        "--pathspec-from-file=-",
        "--pathspec-file-nul",
      ],
      { cwd: repoRoot, input: files.tracked.join("\u0000") },
    );
    if (restored.code !== 0) {
      return decode(restored.stderr);
    }
  }
  for (const path of files.untracked) {
    if (path.endsWith("/")) {
      // A clone inside the repo folder: no export wrote it.
      continue;
    }
    try {
      unlinkSync(join(repoRoot, path));
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      const code = "code" in error ? error.code : undefined;
      if (code === "ENOENT" || code === "ENOTDIR") {
        // Already gone: git put a file back where its folder was.
        continue;
      }
      return `ERROR: ${error.message}\n`;
    }
    removeEmptyParents(repoRoot, path);
  }
  return (await pathsClean(repoRoot, pathspecs)) ? undefined : STILL_CHANGED;
}

/**
 * The clone's `HEAD` when it is where a push that sent nothing may record the
 * sync point (contract "Sync point"): nothing under `pathspecs` differs from
 * `HEAD` and `HEAD` is `origin/master`. `undefined` otherwise, or when git
 * can't tell.
 */
export async function cleanHeadAtOrigin(
  repoRoot: string,
  pathspecs: readonly string[],
): Promise<string | undefined> {
  if (!(await pathsClean(repoRoot, pathspecs))) {
    return undefined;
  }
  const heads = await runGitResult(repoRoot, [
    "rev-parse",
    "HEAD",
    "origin/master",
  ]);
  if (!heads.ok) {
    return undefined;
  }
  const [head, origin] = heads.stdout.trim().split("\n");
  return head !== undefined && head !== "" && head === origin
    ? head
    : undefined;
}
