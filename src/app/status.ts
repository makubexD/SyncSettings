/**
 * `mksync status` (contract "Front door", the status table): gather what the
 * lines read and print them. Mirrors `scripts/linux/front.sh` `front_status`:
 * the OS name, the origin fetch, the unsent files, the import check and, with
 * a sync point, the diff. Writes nothing in the repo or home and never runs
 * the up-to-date check.
 */

import { readSyncPoint, runGitResult } from "../adapters/git.ts";
import { readOsName } from "../adapters/osname.ts";
import { buildSnapshot } from "../adapters/snapshot.ts";
import type { Layers } from "../adapters/snapshot.ts";
import type { RunCommand } from "../cli/parse.ts";
import type { ConfigV2, Os } from "../core/config/types.ts";
import type {
  DiffSplit,
  MachineFact,
  OriginFact,
  StatusFacts,
} from "../core/front/status.ts";
import { statusLines } from "../core/front/status.ts";
import { planCheck } from "../core/plan/check.ts";
import type { Snapshot } from "../core/plan/types.ts";
import { diffExport } from "./diff.ts";
import { writeLines } from "./export.ts";
import type { Result } from "./export.ts";

/** What `mksync status` reads from the run. */
export interface StatusInput {
  readonly repoRoot: string;
  readonly config: ConfigV2;
  readonly os: Os;
  readonly home: string;
  readonly state: string;
  readonly layers: Layers;
}

/** Every git call in the status runs as `front_git` does: no prompt. */
const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
};

/** The fetch limit in seconds, `front_status`'s `SYNC_FETCH_TIMEOUT`. */
const DEFAULT_FETCH_SECONDS = 15;

const MILLISECONDS_PER_SECOND = 1000;

/** The sync paths the unsent count reads, as the bash status does. */
const UNSENT_PATHS = ["dotfiles", "packages", "sync-config.json"] as const;

/** The import check the machine line runs, as `import --check` runs it. */
const CHECK_COMMAND: RunCommand = {
  kind: "run",
  command: "import",
  force: false,
  preview: false,
  check: true,
  resetValues: false,
  yes: false,
  only: [],
};

/** The check's summary line: `<n> file(s) would change.` */
const CHANGES_LINE = /^ {2}(\d+) file\(s\) would change\./;

/** The diff's summary line: `<n> file(s) differ: <i> in, <o> out, <b> both.` */
const DIFF_LINE =
  /^ {2}(\d+ file\(s\) differ: (\d+) in, (\d+) out, (\d+) both)\.$/m;

/** `SYNC_FETCH_TIMEOUT` in seconds; `undefined` when bash's `timeout` would
 * reject it and the fetch therefore fail. `0` means no limit, as GNU timeout. */
function fetchSeconds(
  env: Readonly<Record<string, string | undefined>>,
): number | undefined {
  const configured = env.SYNC_FETCH_TIMEOUT;
  const text =
    configured === undefined || configured === ""
      ? String(DEFAULT_FETCH_SECONDS)
      : configured;
  const seconds = Number(text);
  if (!Number.isInteger(seconds) || seconds < 0) {
    return undefined;
  }
  return seconds;
}

/**
 * `git fetch -q origin master` under the status fetch limit. A failed or
 * timed-out fetch is `false`, which the status reports as offline.
 */
async function fetchOrigin(
  repoRoot: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  const seconds = fetchSeconds(env);
  if (seconds === undefined) {
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline =
    seconds === 0
      ? undefined
      : new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), seconds * MILLISECONDS_PER_SECOND);
        });
  try {
    const child = Bun.spawn(["git", "fetch", "-q", "origin", "master"], {
      cwd: repoRoot,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, ...GIT_ENV },
    });
    const outcome =
      deadline === undefined
        ? await child.exited
        : await Promise.race([child.exited, deadline]);
    if (outcome === "timeout") {
      // Kill and reap it; its own pipes are ignored, so nothing waits on them.
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
      return false;
    }
    return outcome === 0;
  } catch {
    // A missing git or an unreadable folder is a failed fetch.
    return false;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function countUpdate(text: string): number {
  const updates = Number(text.trim());
  return Number.isInteger(updates) && updates > 0 ? updates : 0;
}

/** What the origin line reads, once the repo is known to be a git clone. */
async function originFromRepo(
  repoRoot: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<OriginFact> {
  const remote = await runGitResult(
    repoRoot,
    ["remote", "get-url", "origin"],
    GIT_ENV,
  );
  if (!remote.ok) {
    return { kind: "no-origin" };
  }
  const symbolic = await runGitResult(
    repoRoot,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    GIT_ENV,
  );
  const branch = symbolic.ok ? symbolic.stdout.trim() : "unknown";
  if (branch !== "master") {
    return { kind: "branch", branch };
  }
  if (!(await fetchOrigin(repoRoot, env))) {
    return { kind: "offline" };
  }
  const counted = await runGitResult(
    repoRoot,
    ["rev-list", "--count", "HEAD..origin/master"],
    GIT_ENV,
  );
  const updates = counted.ok ? countUpdate(counted.stdout) : 0;
  return { kind: "fetched", updates };
}

/** Changed files under the sync paths; `null` when the folder isn't a clone. */
async function unsentCount(repoRoot: string): Promise<number | null> {
  const status = await runGitResult(
    repoRoot,
    [
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      ...UNSENT_PATHS,
    ],
    GIT_ENV,
  );
  // A failed status prints nothing, so `wc -l` reads it as no changes.
  if (!status.ok) {
    return 0;
  }
  return status.stdout.split("\n").filter((line) => line !== "").length;
}

/** The git side of the status: the origin line and the unsent count. */
async function gitFacts(
  repoRoot: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ readonly origin: OriginFact; readonly unsent: number | null }> {
  const repo = await runGitResult(
    repoRoot,
    ["rev-parse", "--is-inside-work-tree"],
    GIT_ENV,
  );
  if (!repo.ok) {
    return { origin: { kind: "not-git" }, unsent: null };
  }
  const origin = await originFromRepo(repoRoot, env);
  return { origin, unsent: await unsentCount(repoRoot) };
}

/** The file count the check printed, or `undefined` when it printed none. */
function changedCount(lines: readonly string[]): number | undefined {
  for (const line of lines) {
    const match = CHANGES_LINE.exec(line);
    if (match !== null) {
      const count = Number(match[1]);
      return Number.isInteger(count) ? count : undefined;
    }
  }
  return undefined;
}

/** The diff summary the status line shows, or `null` when it has none. */
function parseDiffSummary(stdout: string): DiffSplit | null {
  const match = DIFF_LINE.exec(stdout);
  if (match === null) {
    return null;
  }
  const summary = match[1];
  const inCount = match[2];
  const outCount = match[3];
  const bothCount = match[4];
  if (
    summary === undefined ||
    inCount === undefined ||
    outCount === undefined ||
    bothCount === undefined
  ) {
    return null;
  }
  return {
    summary,
    in: Number(inCount),
    out: Number(outCount),
    both: Number(bothCount),
  };
}

/**
 * The diff's split of a differing machine, when a sync point is recorded and
 * the diff exits 3 with its summary line. Anything else is no split.
 */
async function diffSplit(
  repoRoot: string,
  state: string,
  snapshot: Snapshot,
): Promise<DiffSplit | null> {
  if ((await readSyncPoint(repoRoot, state)) === undefined) {
    return null;
  }
  try {
    const result: Result = await diffExport(repoRoot, state, snapshot);
    return result.code === 3 ? parseDiffSummary(result.stdout) : null;
  } catch {
    // A failed diff keeps the plain machine line.
    return null;
  }
}

/** The import check's verdict on this machine, and the snapshot it read. */
async function machineFacts(
  input: StatusInput,
): Promise<{ readonly machine: MachineFact; readonly snapshot?: Snapshot }> {
  let snapshot: Snapshot;
  let plan: ReturnType<typeof planCheck>;
  try {
    snapshot = await buildSnapshot(
      input.repoRoot,
      input.config,
      input.os,
      input.home,
      CHECK_COMMAND,
      process.cwd(),
      process.env,
      input.layers,
    );
    plan = planCheck(snapshot);
  } catch {
    return { machine: { kind: "unknown" } };
  }
  if (plan.code === 0) {
    return { machine: { kind: "match" }, snapshot };
  }
  if (plan.code !== 3) {
    return { machine: { kind: "unknown" }, snapshot };
  }
  const count = changedCount(plan.lines);
  if (count === undefined) {
    return { machine: { kind: "unknown" }, snapshot };
  }
  return {
    machine: {
      kind: "differ",
      count,
      diff: await diffSplit(input.repoRoot, input.state, snapshot),
    },
    snapshot,
  };
}

/**
 * Run `mksync status` end to end: gather the facts and print the lines
 * `statusLines` returns, exit 0. Nothing is written.
 */
export async function executeStatus(input: StatusInput): Promise<Result> {
  const osName = readOsName(input.os, process.env);
  const git = await gitFacts(input.repoRoot, process.env);
  const checked = await machineFacts(input);
  const facts: StatusFacts = {
    os: input.os,
    osName,
    repo: input.repoRoot,
    origin: git.origin,
    unsent: git.unsent,
    machine: checked.machine,
    pullOnly: input.layers.record?.pullOnly === true,
    linked: [],
  };
  return { code: 0, stdout: writeLines(statusLines(facts)), stderr: "" };
}
