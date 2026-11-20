/**
 * `mksync commit` (contract "Checks before pushing" and "Sync point"), in
 * `commit.sh`'s order and with its lines: the banner, the presence checks, the
 * changes outside the sync paths, the public-repo guard (tracked paths and the
 * unpushed history), the leak scan, the cached values, then the branch, the
 * commit, the push, the PR, the switch back to `master` and the sync point.
 * Every check runs before the branch exists, so a refused run leaves no branch.
 */

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { runPlan } from "../adapters/fs.ts";
import type { RunContext } from "../adapters/fs.ts";
import type { GitResult } from "../adapters/git.ts";
import { prCreate } from "../adapters/gh.ts";
import {
  changedSyncPaths,
  commitStaged,
  deleteBranch,
  pushBranch,
  readAheadBehind,
  readMachineAlias,
  readParentSha,
  readUnpushedHistory,
  runGitResult,
  stagePaths,
  statusPorcelain,
  switchToMaster,
  switchToNewBranch,
} from "../adapters/git.ts";
import { runLeakScan } from "../adapters/leakscan.ts";
import { which } from "../adapters/process.ts";
import { readText } from "../adapters/store.ts";
import type { StoreLocation } from "../adapters/store.ts";
import type { CommitCommand } from "../cli/parse.ts";
import type { ConfigV2, Os } from "../core/config/types.ts";
import { historyRefusals } from "../core/guard.ts";
import type { Values } from "../core/values/sanitize.ts";
import { machineValues } from "../core/machine/scope.ts";
import type { MachineRecord } from "../core/machine/record.ts";
import type { Profile } from "../core/config/profile.ts";
import {
  branchName,
  cachedValueHits,
  commitMessage,
  outsidePaths,
  prBody,
} from "../core/plan/commit.ts";
import type { RunPlan } from "../core/plan/types.ts";
import { parseValuesFile } from "../core/values/file.ts";
import { CANNOT_LIST_TRACKED, exportGuard } from "./export.ts";
import type { Result } from "./export.ts";

const BANNER =
  "\n" +
  "  +==========================================+\n" +
  "  |        SyncSettings -- COMMIT           |\n" +
  "  +==========================================+\n" +
  "\n";

const GIT_MISSING =
  "ERROR: git is not found in PATH. Please install Git and try again.";

const GH_MISSING =
  "ERROR: gh is not found in PATH. Install the GitHub CLI and run gh auth login.";

const STATUS_FAILED = "ERROR: git status failed.";

const OUTSIDE_HEADING = "  Changes outside sync paths:";

const OUTSIDE_ERROR =
  "ERROR: commit or stash changes outside dotfiles/ first.";

const NOTHING_TO_COMMIT = "  Nothing to commit -- dotfiles/ is clean.";

const LEAK_HIT_ERROR =
  "ERROR: the leak scan found the lines above; nothing was committed.";

const LEAK_CANNOT_RUN =
  "ERROR: leak scan could not run; nothing was committed.";

const CACHED_SEARCH_FAILED =
  "ERROR: could not search for cached values; nothing was committed.";

const NO_ALIAS =
  "ERROR: no machine alias set. Run: git config syncsettings.machine <alias>";

const ALIAS_PROMPT =
  "  Machine alias for branch names (e.g. laptop, desktop): ";

const CONFIG_FAILED = "ERROR: git config failed.";

const NOT_MASTER_PREFIX = "ERROR: run mksync commit from master (current: ";

const BEHIND_ERROR = "ERROR: master is behind origin; pull first.";

const AHEAD_ERROR =
  "ERROR: local master has unpushed commits; push or move them to a branch first.";

const ADD_FAILED = "ERROR: git add failed.";

const COMMIT_FAILED = "ERROR: git commit failed.";

const PUSH_FAILED_PREFIX = "ERROR: push failed; you are on ";

const PR_FAILED_PREFIX = "ERROR: PR creation failed; branch ";

const REVIEW_LINE =
  "  Review it, add the 'reviewed' label, merge, then: git pull";

const SYNC_PATHS = ["dotfiles", "sync-config.json"] as const;

const PACKAGES_ROOT = "packages";

const VALUES_FILE = ".user-values.json";

const MACHINE_ALIAS = /^[a-z0-9][a-z0-9-]{0,23}$/;

const MACHINE_ALIAS_KEY = "syncsettings.machine";

/** The sync point file under the state folder (contract "Sync point"). */
const SYNC_POINT_FILE = "last-sync";

/** The base the PR merges into, as `commit.sh` passes it. */
const BASE_BRANCH = "master";

/** `commit.sh`'s two lines per refused path (contract "Public-repo guard"). */
function refusedText(paths: readonly string[]): string {
  return paths
    .flatMap((path) => [
      `refused: the repo is public, so ${path} can't be pushed.`,
      "It is kept on this machine and goes in with the first push after the repo is private.",
    ])
    .join("\n");
}

/** The `refused` paths of the tracked and unpushed-history checks, one per
 * path, folded case-insensitively, sorted as the contract shows them. */
function mergeRefusals(...lists: readonly (readonly string[])[]): string[] {
  const byFolded = new Map<string, string>();
  for (const path of lists.flat()) {
    const folded = path.toLowerCase();
    if (!byFolded.has(folded)) {
      byFolded.set(folded, path);
    }
  }
  return [...byFolded.values()].sort();
}

/** Today's `date +%Y%m%d-%H%M`, in the machine's own time zone. */
function localStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`
  );
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The gh binary: `GH` names another, as `commit.sh` allows. */
function ghBinary(): string {
  const value = process.env.GH;
  return value === undefined || value === "" ? "gh" : value;
}

/** The paths `commit.sh` owns, with `packages/` only when the folder exists. */
function syncPaths(repoRoot: string): readonly string[] {
  return [
    ...SYNC_PATHS,
    ...(isDirectory(join(repoRoot, PACKAGES_ROOT)) ? [PACKAGES_ROOT] : []),
  ];
}

/**
 * The machine named in the branch, per decision 3: the record's name when
 * there is one, else `commit.sh`'s `git config syncsettings.machine`, asked
 * for on a terminal and saved there, or the contract's error without one.
 */
async function resolveMachineAlias(
  repoRoot: string,
  record: MachineRecord | undefined,
): Promise<{ readonly alias?: string; readonly error?: string }> {
  if (record !== undefined) {
    if (!MACHINE_ALIAS.test(record.name)) {
      return {
        error: `ERROR: invalid machine alias '${record.name}' (use a-z, 0-9, -).`,
      };
    }
    return { alias: record.name };
  }

  const configured = await readMachineAlias(repoRoot);
  if (configured.alias !== undefined) {
    if (!MACHINE_ALIAS.test(configured.alias)) {
      return {
        error: `ERROR: invalid machine alias '${configured.alias}' in git config ${MACHINE_ALIAS_KEY} (use a-z, 0-9, -).`,
      };
    }
    return { alias: configured.alias };
  }

  if (process.stdin.isTTY !== true) {
    return { error: NO_ALIAS };
  }
  const reader = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  let answer: string;
  try {
    answer = (await reader.question(ALIAS_PROMPT)).trim();
  } finally {
    reader.close();
  }
  if (!MACHINE_ALIAS.test(answer)) {
    return {
      error: `ERROR: invalid machine alias '${answer}' (use a-z, 0-9, -).`,
    };
  }
  const saved = await runGitResult(repoRoot, [
    "config",
    MACHINE_ALIAS_KEY,
    answer,
  ]);
  if (!saved.ok) {
    return { error: CONFIG_FAILED };
  }
  process.stderr.write(`  Saved machine alias: ${answer}\n`);
  return { alias: answer };
}

/** The values cached for this machine: a record's and its profile's, else
 * `.user-values.json`'s (decision 3). */
function cachedValues(
  repoRoot: string,
  profile: Profile | undefined,
  record: MachineRecord | undefined,
): Values {
  if (record !== undefined) {
    return machineValues(profile, record);
  }
  return parseValuesFile(readText(join(repoRoot, VALUES_FILE)));
}

/** The bytes of each changed sync file that still exists, for the cached-value
 * search; a deleted or unreadable path is left out, as `commit.sh` skips it. */
function readChangedFiles(
  repoRoot: string,
  paths: readonly string[],
): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const path of paths) {
    try {
      const absolute = join(repoRoot, path);
      if (statSync(absolute).isFile()) {
        files.set(path, readFileSync(absolute));
      }
    } catch {
      // A path no longer on disk is not searched; the commit doesn't remove it.
    }
  }
  return files;
}

/** Switch back to `master` and drop `branch`, after `git add` or `git commit`
 * failed, so no commit is lost. Both failures are ignored: the error that
 * stopped the run is the one to report. */
async function cleanupBranch(
  repoRoot: string,
  branch: string,
): Promise<void> {
  await switchToMaster(repoRoot);
  await deleteBranch(repoRoot, branch);
}

/** What writing the sync point printed: the contract's warning when it only
 * failed, or the line a refused symlink stopped the run with. */
interface SyncPointWrite {
  readonly warning: string;
  readonly refused: string | undefined;
}

/** Record an opened PR's parent as the sync point, and warn when the write
 * fails, as `write_last_sync` does. A symlinked sync point is refused. */
function writeSyncPoint(
  context: RunContext,
  state: string,
  parent: string,
): SyncPointWrite {
  const path = join(state, SYNC_POINT_FILE);
  const text = `${parent}\n`;
  const plan: RunPlan = {
    steps: [],
    finish: [{ kind: "writeState", path, text }],
    lines: [],
    summary: { kind: "none" },
    code: 0,
  };
  const outcome = runPlan(plan, context);
  if (outcome.refused !== undefined) {
    return { warning: "", refused: outcome.refused };
  }
  let written: string | undefined;
  try {
    written = readFileSync(path, "utf8");
  } catch {
    written = undefined;
  }
  return {
    warning:
      written === text
        ? ""
        : `  WARNING: could not record the sync point in ${path}.\n`,
    refused: undefined,
  };
}

/**
 * Contract "Checks before pushing", Git failures: a failed git step's own
 * error lines, with trailing whitespace trimmed and one newline. A run that
 * printed nothing on stderr gets the contract's fallback, naming the step.
 */
function gitErrorText(result: GitResult, step: string): string {
  const text = result.stderr.trim();
  return text === "" ? `ERROR: git ${step} failed.\n` : `${text}\n`;
}

/** What `mksync commit` reads from the run. */
export interface CommitInput {
  readonly repoRoot: string;
  readonly config: ConfigV2;
  readonly state: string;
  readonly os: Os;
  readonly location: StoreLocation;
  readonly command: CommitCommand;
  readonly record?: MachineRecord;
  readonly profile?: Profile;
}

/**
 * Run `mksync commit` end to end. `commit.sh`'s order and lines; a check that
 * refuses exits 1 before any branch exists. A failed git step prints git's own
 * error lines and exits 1. A failed add or commit switches back to `master` and
 * drops the branch; a failed read of the new commit keeps the branch and its
 * commit checked out, since the commit already succeeded, and so do a failed
 * push or PR, as `commit.sh` does.
 */
export async function executeCommit(input: CommitInput): Promise<Result> {
  const { repoRoot, config, state, os, location, command, record, profile } =
    input;
  let stdout = BANNER;
  const done = (code: number, stderr: string): Result => ({
    code,
    stdout,
    stderr,
  });
  const fail = (message: string): Result => done(1, `${message}\n`);

  if (which("git") === null) {
    return fail(GIT_MISSING);
  }
  if (which(ghBinary()) === null) {
    return fail(GH_MISSING);
  }

  const paths = syncPaths(repoRoot);

  // Contract "Checks before pushing", Changes outside the sync paths.
  const porcelain = await statusPorcelain(repoRoot);
  if (!porcelain.ok) {
    return fail(STATUS_FAILED);
  }
  const outside = outsidePaths(porcelain.stdout, paths.includes(PACKAGES_ROOT));
  if (outside.length > 0) {
    return fail(
      [
        OUTSIDE_HEADING,
        ...outside.map((line) => `    ${line}`),
        OUTSIDE_ERROR,
      ].join("\n"),
    );
  }

  const status = await statusPorcelain(repoRoot, paths);
  if (!status.ok) {
    return fail(STATUS_FAILED);
  }
  const statusLines = status.stdout.split("\n").filter((line) => line !== "");
  if (statusLines.length === 0) {
    stdout += `${NOTHING_TO_COMMIT}\n\n`;
    return done(0, "");
  }

  // Contract "Checks before pushing", program: the public-repo guard on the
  // tracked paths and on every commit in origin/master..HEAD.
  const guardResult = await exportGuard(repoRoot, state, config);
  if (guardResult === undefined) {
    return fail(CANNOT_LIST_TRACKED);
  }
  const history = await readUnpushedHistory(repoRoot);
  if (!history.ok) {
    // The guard can't read the unpushed commits, so it can't clear them.
    return fail(CANNOT_LIST_TRACKED);
  }
  const refused = mergeRefusals(
    guardResult.decision.refused,
    historyRefusals(guardResult.visibility, history.commits),
  );
  if (refused.length > 0) {
    return fail(refusedText(refused));
  }

  // Contract "Checks before pushing", Leak scan.
  const scan = await runLeakScan(repoRoot, paths);
  stdout += scan.stdout;
  if (scan.kind === "hits") {
    return done(1, `${scan.stderr}${LEAK_HIT_ERROR}\n`);
  }
  if (scan.kind === "could-not-run") {
    return done(1, `${scan.stderr}${LEAK_CANNOT_RUN}\n`);
  }

  // Contract "Checks before pushing", Cached values.
  const changed = await changedSyncPaths(repoRoot, paths);
  if (!changed.ok) {
    return fail(CACHED_SEARCH_FAILED);
  }
  const hits = cachedValueHits(
    readChangedFiles(repoRoot, changed.paths),
    cachedValues(repoRoot, profile, record),
  );
  const [hit] = hits;
  if (hit !== undefined) {
    return fail(
      `ERROR: a cached value for ${hit.placeholder} is in ${hit.file}; nothing was committed.`,
    );
  }

  const machine = await resolveMachineAlias(repoRoot, record);
  if (machine.alias === undefined) {
    return fail(machine.error ?? NO_ALIAS);
  }
  const machineAlias = machine.alias;

  stdout += "  Changed files:\n";
  for (const line of statusLines) {
    stdout += `    ${line}\n`;
  }
  stdout += "\n";

  const message = commitMessage(command.message, statusLines);
  stdout += `  Commit message: ${message}\n\n`;

  const current = await runGitResult(repoRoot, [
    "symbolic-ref",
    "--short",
    "HEAD",
  ]);
  if (!current.ok) {
    return done(1, gitErrorText(current, "symbolic-ref"));
  }
  const branchCurrent = current.stdout.trim();
  if (branchCurrent !== BASE_BRANCH) {
    return fail(`${NOT_MASTER_PREFIX}${branchCurrent}).`);
  }

  const fetched = await runGitResult(repoRoot, [
    "fetch",
    "origin",
    BASE_BRANCH,
  ]);
  if (!fetched.ok) {
    return done(1, gitErrorText(fetched, "fetch"));
  }
  const counts = await readAheadBehind(repoRoot);
  if (!counts.ok) {
    return done(1, gitErrorText(counts, "rev-list"));
  }
  if (counts.behind > 0) {
    const merged = await runGitResult(repoRoot, [
      "merge",
      "--ff-only",
      `origin/${BASE_BRANCH}`,
    ]);
    if (!merged.ok) {
      return fail(BEHIND_ERROR);
    }
  }
  if (counts.ahead > 0) {
    return fail(AHEAD_ERROR);
  }

  const branch = branchName(os, machineAlias, localStamp(new Date()));
  const switched = await switchToNewBranch(repoRoot, branch);
  if (!switched.ok) {
    return done(1, gitErrorText(switched, "switch"));
  }

  const added = await stagePaths(repoRoot, paths);
  if (!added.ok) {
    await cleanupBranch(repoRoot, branch);
    return fail(ADD_FAILED);
  }
  const committed = await commitStaged(repoRoot, message);
  if (!committed.ok) {
    await cleanupBranch(repoRoot, branch);
    return fail(COMMIT_FAILED);
  }
  const parent = await readParentSha(repoRoot);
  if (parent.sha === undefined) {
    // The commit succeeded, so the branch and its commit stay checked out.
    return done(1, gitErrorText(parent, "rev-parse"));
  }

  const pushed = await pushBranch(repoRoot, branch);
  // From here the branch holds the only commit of the changes: a failure
  // leaves it checked out, as commit.sh does, so its message can say how to
  // finish.
  if (!pushed.ok) {
    return fail(
      `${PUSH_FAILED_PREFIX}${branch}. Fix and run: git push -u origin ${branch}`,
    );
  }

  const bodyFolder = mkdtempSync(join(tmpdir(), "mksync-pr-"));
  const bodyFile = join(bodyFolder, "body");
  writeFileSync(
    bodyFile,
    prBody(
      statusLines,
      os,
      machineAlias,
      record === undefined ? undefined : profile?.name,
    ),
  );
  let prUrl = "";
  try {
    const pr = await prCreate(repoRoot, {
      base: BASE_BRANCH,
      head: branch,
      title: message,
      bodyFile,
    });
    if (!pr.ok) {
      return fail(
        `${PR_FAILED_PREFIX}${branch} is pushed. Run: gh pr create --base ${BASE_BRANCH} --head ${branch}`,
      );
    }
    prUrl = pr.stdout.trim();
  } finally {
    rmSync(bodyFolder, { recursive: true, force: true });
  }

  const back = await switchToMaster(repoRoot);
  if (!back.ok) {
    return done(1, gitErrorText(back, "switch"));
  }

  if (!command.partial) {
    const syncPoint = writeSyncPoint(
      {
        repoRoot,
        os,
        stateFolder: state,
        location,
        now: () => new Date(),
        pid: process.pid,
        env: process.env,
      },
      state,
      parent.sha,
    );
    if (syncPoint.refused !== undefined) {
      return done(1, `${syncPoint.refused}\n`);
    }
    stdout += syncPoint.warning;
  }

  stdout += `  PR opened: ${prUrl}\n`;
  stdout += `${REVIEW_LINE}\n\n`;
  return done(0, "");
}
