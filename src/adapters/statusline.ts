/**
 * The statusline's reads: the clock, `/proc`, git, the project folder, the
 * environment and the context-window file. Ported from
 * `dotfiles/linux/claude/statusline.sh`; the text is
 * `src/core/statusline/format.ts`. Every read fails to `undefined`, so a
 * section that cannot be read is left out of the line, never thrown. Contract
 * "Statusline (program only)".
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parsePayload, statusLine } from "../core/statusline/format.ts";
import type {
  GitFacts,
  StatusFacts,
  StatusPayload,
} from "../core/statusline/format.ts";

const PROC_LOADAVG = "/proc/loadavg";
const PROC_MEMINFO = "/proc/meminfo";

/** `/proc/loadavg`'s first field: the one-minute load average. */
const LOADAVG_FIELD = 0;

const WIN32 = "win32";

const KIBIBYTES_PER_MEBIBYTE = 1024;
const MEBIBYTES_PER_GIBIBYTE = 1024;

/** One `SYNC_MEM` side: a number, in MiB with no suffix or GiB with `G`. */
const MEMORY_TEXT = /^([0-9]+(?:\.[0-9]+)?)([GgMm])?$/;

const MEMINFO_TOTAL = /^MemTotal:\s+([0-9]+)/m;
const MEMINFO_AVAILABLE = /^MemAvailable:\s+([0-9]+)/m;

const DIGITS = /^[0-9]+$/;
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

/** `git status --porcelain`'s prefix for an untracked file. */
const UNTRACKED_PREFIX = "??";

/** `git diff --numstat`'s marker for a binary file, which has no count. */
const BINARY_MARK = "-";

const GIT_FLAGS = "--no-optional-locks";

const CTX_WINDOW_PATH = ".claude/state/ctx-window";
const WORKER_MODE_PATH = ".claude/state/worker-mode";

/** The line `statusLine` prints when no section has data, for `main`'s last
 * resort. */
export const STATUSLINE_UNAVAILABLE = "Statusline data unavailable\n";

/** What the adapter reads besides the machine: the clock and the variables,
 * so tests can fix both. */
export interface StatuslineDeps {
  /** The variables the line and git read; `process.env` by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The local clock; `new Date()` by default. */
  readonly now?: () => Date;
}

/** One `git` run: its exit code and stdout text. */
interface GitRun {
  readonly code: number;
  readonly stdout: string;
}

/** The line for Claude Code's payload, ending with the newline the script
 * prints. Never throws: a failed context-window write and every failed section
 * are left out. */
export function renderStatusline(
  input: string,
  deps: StatuslineDeps = {},
): string {
  const env = deps.env ?? process.env;
  const payload = parsePayload(input);
  writeContextWindow(payload, env);
  return statusLine(payload, gatherFacts(payload, env, deps.now));
}

function gatherFacts(
  payload: StatusPayload,
  env: Readonly<Record<string, string | undefined>>,
  now: (() => Date) | undefined,
): StatusFacts {
  const project = readProject(payload.projectDir);
  const git = readGit(payload.directory, env);
  const load = readLoad(env);
  const mem = readMemory(env);
  const virtualEnv = textOrUndefined(env.VIRTUAL_ENV);
  const condaEnv = textOrUndefined(env.CONDA_DEFAULT_ENV);
  const clearAt = readClearAt(env);
  const workerMode = readWorkerMode(env);

  return {
    time: env.SYNC_NOW ?? clockText(now),
    ...(project.projectFiles === undefined
      ? {}
      : { projectFiles: project.projectFiles }),
    ...(project.hasVenvDir === undefined
      ? {}
      : { hasVenvDir: project.hasVenvDir }),
    ...(virtualEnv === undefined ? {} : { virtualEnv }),
    ...(condaEnv === undefined ? {} : { condaEnv }),
    ...(git === undefined ? {} : { git }),
    ...(load === undefined ? {} : { load }),
    ...(mem === undefined ? {} : { mem }),
    ...(workerMode ? { workerMode: true } : {}),
    ...(clearAt === undefined ? {} : { clearAt }),
  };
}

function clockText(now: (() => Date) | undefined): string {
  try {
    const date = (now ?? (() => new Date()))();
    return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
  } catch {
    // Contract: a failed clock read leaves the time section out.
    return "";
  }
}

function twoDigits(value: number): string {
  return value.toString().padStart(2, "0");
}

/** The project folder's file names and `.venv` folder, as the script's
 * `[[ -d ]]` and `compgen -G` see them. */
interface ProjectFacts {
  readonly projectFiles?: readonly string[];
  readonly hasVenvDir?: boolean;
}

function readProject(projectDir: string): ProjectFacts {
  if (projectDir === "") {
    return {};
  }
  let projectFiles: readonly string[];
  try {
    projectFiles = readdirSync(projectDir);
  } catch {
    // Not a readable folder: the script's `[[ -d ]]` is false too.
    return {};
  }
  let hasVenvDir: boolean | undefined;
  try {
    hasVenvDir = statSync(join(projectDir, ".venv")).isDirectory();
  } catch {
    // No `.venv`: the virtual-env section falls back to the environment.
    hasVenvDir = undefined;
  }
  return {
    projectFiles,
    ...(hasVenvDir === undefined ? {} : { hasVenvDir }),
  };
}

/** Git in the payload's directory, or the working folder when it has none, as
 * `gitdir=${cwd:-$PWD}` does. */
function readGit(
  directory: string,
  env: Readonly<Record<string, string | undefined>>,
): GitFacts | undefined {
  if (env.SYNC_GIT === "none") {
    return undefined;
  }
  const cwd = directory === "" ? process.cwd() : directory;
  const branchRun = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], env);
  if (branchRun === undefined || branchRun.code !== 0) {
    return undefined;
  }
  const branch = branchRun.stdout.trim();
  if (branch === "") {
    return undefined;
  }

  const porcelain = gitText(cwd, ["status", "--porcelain"], env);
  const upstream = readAheadBehind(cwd, env);
  const age = readAge(cwd, env);
  const changes = readChanges(cwd, env);
  return {
    branch,
    dirty: porcelain !== "",
    ...(upstream === undefined
      ? {}
      : { ahead: upstream.ahead, behind: upstream.behind }),
    ...(age === undefined ? {} : { age }),
    insertions: changes.insertions,
    deletions: changes.deletions,
    untracked: porcelain
      .split("\n")
      .filter((line) => line.startsWith(UNTRACKED_PREFIX)).length,
  };
}

function readAheadBehind(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): { readonly ahead: number; readonly behind: number } | undefined {
  const run = runGit(
    cwd,
    ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    env,
  );
  if (run === undefined || run.code !== 0) {
    return undefined;
  }
  const match = /^\s*([0-9]+)\s+([0-9]+)\s*$/.exec(run.stdout);
  const ahead = match?.[1];
  const behind = match?.[2];
  if (ahead === undefined || behind === undefined) {
    return undefined;
  }
  return { ahead: Number(ahead), behind: Number(behind) };
}

function readAge(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const run = runGit(cwd, ["log", "-1", "--format=%cr"], env);
  if (run === undefined || run.code !== 0) {
    return undefined;
  }
  const age = run.stdout.trim();
  return age === "" ? undefined : age;
}

/** Insertions and deletions across staged and unstaged changes, binary files
 * skipped, as the script's two `--numstat` runs sum them. */
function readChanges(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): { readonly insertions: number; readonly deletions: number } {
  let insertions = 0;
  let deletions = 0;
  const runs: readonly (readonly string[])[] = [
    ["diff", "--numstat"],
    ["diff", "--cached", "--numstat"],
  ];
  for (const args of runs) {
    const run = runGit(cwd, args, env);
    if (run === undefined || run.code !== 0) {
      continue;
    }
    for (const line of run.stdout.split("\n")) {
      const [added, removed] = line.split("\t");
      if (added === undefined || removed === undefined) {
        continue;
      }
      if (added === BINARY_MARK) {
        continue;
      }
      const plus = Number(added);
      const minus = Number(removed);
      if (Number.isFinite(plus)) {
        insertions += plus;
      }
      if (Number.isFinite(minus)) {
        deletions += minus;
      }
    }
  }
  return { insertions, deletions };
}

function gitText(
  cwd: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string {
  const run = runGit(cwd, args, env);
  return run === undefined || run.code !== 0 ? "" : run.stdout;
}

/** One git run with no shell. `undefined` when git cannot start (no binary,
 * unreadable folder), which the git sections treat as "nothing to show". */
function runGit(
  cwd: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): GitRun | undefined {
  try {
    const result = Bun.spawnSync({
      cmd: ["git", GIT_FLAGS, "-C", cwd, ...args],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: spawnEnv(env),
    });
    if (result.exitCode === null) {
      return undefined;
    }
    return {
      code: result.exitCode,
      stdout: new TextDecoder().decode(result.stdout),
    };
  } catch {
    // No git binary: the git sections are left out.
    return undefined;
  }
}

/** The process's variables with the injected ones over them, so a test's
 * `PATH` or `HOME` reaches git too. */
function spawnEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

function readLoad(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (process.platform === WIN32) {
    return undefined;
  }
  if (env.SYNC_LOAD !== undefined) {
    return textOrUndefined(env.SYNC_LOAD);
  }
  try {
    const text = readFileSync(PROC_LOADAVG, "utf8").trim();
    return textOrUndefined(text.split(/\s+/)[LOADAVG_FIELD]);
  } catch {
    // No `/proc/loadavg`: the load section is left out.
    return undefined;
  }
}

function readMemory(
  env: Readonly<Record<string, string | undefined>>,
): { readonly usedMiB: number; readonly totalMiB: number } | undefined {
  if (process.platform === WIN32) {
    return undefined;
  }
  if (env.SYNC_MEM !== undefined) {
    return env.SYNC_MEM === "" ? undefined : parseMemoryText(env.SYNC_MEM);
  }
  try {
    const text = readFileSync(PROC_MEMINFO, "utf8");
    const totalKiB = matchNumber(MEMINFO_TOTAL, text);
    if (totalKiB === undefined) {
      return undefined;
    }
    // The script's awk reads a missing MemAvailable as 0.
    const availableKiB = matchNumber(MEMINFO_AVAILABLE, text) ?? 0;
    return {
      usedMiB: (totalKiB - availableKiB) / KIBIBYTES_PER_MEBIBYTE,
      totalMiB: totalKiB / KIBIBYTES_PER_MEBIBYTE,
    };
  } catch {
    // No `/proc/meminfo`: the memory section is left out.
    return undefined;
  }
}

/** `SYNC_MEM` as `<used>/<total>`, in MiB or GiB with a `G` suffix. */
function parseMemoryText(
  text: string,
): { readonly usedMiB: number; readonly totalMiB: number } | undefined {
  const [usedText, totalText] = text.split("/");
  if (usedText === undefined || totalText === undefined) {
    return undefined;
  }
  const usedMiB = parseMebibytes(usedText);
  const totalMiB = parseMebibytes(totalText);
  if (usedMiB === undefined || totalMiB === undefined) {
    return undefined;
  }
  return { usedMiB, totalMiB };
}

function parseMebibytes(text: string): number | undefined {
  const match = MEMORY_TEXT.exec(text.trim());
  if (match === null) {
    return undefined;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return match[2]?.toUpperCase() === "G"
    ? value * MEBIBYTES_PER_GIBIBYTE
    : value;
}

function matchNumber(pattern: RegExp, text: string): number | undefined {
  const match = pattern.exec(text);
  if (match === null) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function readClearAt(
  env: Readonly<Record<string, string | undefined>>,
): number | undefined {
  const text = env.CONTEXT_CLEAR_AT;
  if (text === undefined || !DIGITS.test(text)) {
    return undefined;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}

function readWorkerMode(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const home = homeOf(env);
  if (home === undefined) {
    return false;
  }
  try {
    return existsSync(join(home, WORKER_MODE_PATH));
  } catch {
    // An unreadable home has no worker-mode flag.
    return false;
  }
}

/** The script's `$HOME`, with `%USERPROFILE%` for a Windows session that has
 * none. */
function homeOf(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return textOrUndefined(env.HOME) ?? textOrUndefined(env.USERPROFILE);
}

/** The context-window file, written only for a valid session id and a
 * digits-only window size; a failed write is ignored. */
function writeContextWindow(
  payload: StatusPayload,
  env: Readonly<Record<string, string | undefined>>,
): void {
  if (!SESSION_ID.test(payload.sessionId)) {
    return;
  }
  const size = payload.contextWindowSize;
  if (size === undefined || !Number.isInteger(size) || size < 0) {
    return;
  }
  const folder = contextWindowFolder(env);
  if (folder === undefined) {
    return;
  }
  try {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, payload.sessionId), `${size}\n`);
  } catch {
    // Contract: a failed context-window write is ignored.
  }
}

function contextWindowFolder(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const override = textOrUndefined(env.CTX_WINDOW_DIR);
  if (override !== undefined) {
    return override;
  }
  const home = homeOf(env);
  return home === undefined ? undefined : join(home, CTX_WINDOW_PATH);
}

function textOrUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
