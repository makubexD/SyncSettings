import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { readSnapshot, runPlan } from "./adapters/fs.ts";
import type { RunContext } from "./adapters/fs.ts";
import { readFileAtHead, readHead, readPorcelain } from "./adapters/git.ts";
import { homeFolder, stateFolder } from "./adapters/paths.ts";
import { parseArgs, USAGE } from "./cli/parse.ts";
import type { RunCommand, ShadowCommand } from "./cli/parse.ts";
import { engineShadow, programShadow, runShadow } from "./cli/shadow.ts";
import { convertV1 } from "./core/config/convert.ts";
import type {
  ConfigError,
  ConfigV2,
  Os,
  Result as LoadResult,
} from "./core/config/types.ts";
import { parseV1 } from "./core/config/v1.ts";
import { parseV2 } from "./core/config/v2.ts";
import { planCheck } from "./core/plan/check.ts";
import { planExport } from "./core/plan/export.ts";
import { planImport } from "./core/plan/import.ts";
import { planPreview } from "./core/plan/preview.ts";
import { renderRun } from "./core/plan/run.ts";
import type { Plan, RepoFiles, RunPlan, Snapshot } from "./core/plan/types.ts";
import type { Values } from "./core/values/sanitize.ts";

export { USAGE };

/** What the front prints and the code it exits with. */
export interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const V1_CONFIG = "sync-config.json";

const V2_CONFIG = "sync-config.v2.json";

const VALUES_FILE = ".user-values.json";

/**
 * The command whose snapshot shadow reuses: an export preview, which also
 * reads `HEAD`'s bytes. Shadow runs the same plans without printing them.
 */
const SHADOW_SNAPSHOT_COMMAND: RunCommand = {
  kind: "run",
  command: "export",
  force: false,
  preview: true,
  check: false,
  only: [],
};

/** The OSes the program runs for, and the names `SYNC_OS` uses. */
const OS_NAMES: readonly Os[] = ["linux", "macos", "windows"];

/** `process.platform` names mapped to the contract's OS names. */
const PLATFORM_OS: Readonly<Record<string, Os | undefined>> = {
  linux: "linux",
  darwin: "macos",
  win32: "windows",
};

function failure(message: string, code = 1): Result {
  return { code, stdout: "", stderr: `${message}\n` };
}

function writeLines(lines: readonly string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

type Resolved = Result | RunCommand | ShadowCommand;

function isResolvedCommand(
  value: Resolved,
): value is RunCommand | ShadowCommand {
  return "kind" in value;
}

function isOs(value: string): value is Os {
  return (OS_NAMES as readonly string[]).includes(value);
}

function unsupportedOs(name: string): string {
  return `ERROR: SyncSettings runs on Linux, macOS and Windows; this is ${name}.`;
}

/**
 * The contract's "Which system": `SYNC_OS` when set, else the platform this
 * program was compiled for. Any other name stops the run.
 */
function resolveOs(
  env: Readonly<Record<string, string | undefined>>,
): LoadResult<Os, string> {
  const override = env.SYNC_OS;
  if (override !== undefined && override !== "") {
    return isOs(override)
      ? { ok: true, value: override }
      : { ok: false, error: unsupportedOs(override) };
  }
  const platform = PLATFORM_OS[process.platform];
  return platform === undefined
    ? { ok: false, error: unsupportedOs(process.platform) }
    : { ok: true, value: platform };
}

/** The folder holding a config, starting at `start` and walking up. */
function findRepoRoot(start: string): string | undefined {
  let folder = start;
  for (;;) {
    if (
      existsSync(join(folder, V2_CONFIG)) ||
      existsSync(join(folder, V1_CONFIG))
    ) {
      return folder;
    }
    const parent = dirname(folder);
    if (parent === folder) {
      return undefined;
    }
    folder = parent;
  }
}

/** Read a text file, or `undefined` when it cannot be read. */
function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    // Unreadable here means a broken clone, reported as an error by the caller.
    return undefined;
  }
}

/**
 * Decision 2: `sync-config.v2.json` when it exists, else `sync-config.json`
 * converted in memory by the same converter that writes the v2 file.
 */
function loadConfig(repoRoot: string): LoadResult<ConfigV2, ConfigError> {
  const unreadable = (file: string): LoadResult<ConfigV2, ConfigError> => ({
    ok: false,
    error: { message: `ERROR: cannot read ${file}.`, code: 1 },
  });

  const v2Path = join(repoRoot, V2_CONFIG);
  if (existsSync(v2Path)) {
    const text = readText(v2Path);
    return text === undefined ? unreadable(V2_CONFIG) : parseV2(text);
  }

  const text = readText(join(repoRoot, V1_CONFIG));
  if (text === undefined) {
    return unreadable(V1_CONFIG);
  }
  const v1 = parseV1(text);
  return v1.ok ? convertV1(v1.value) : v1;
}

/** `.user-values.json` next to the config, keyed by placeholder. */
function readValues(repoRoot: string): Values {
  const text = readText(join(repoRoot, VALUES_FILE));
  if (text === undefined) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A broken values file must not stop the run; a missing value stops it later.
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const values: Record<string, string> = {};
  for (const [placeholder, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      values[placeholder] = value;
    }
  }
  return values;
}

/** The bytes of every working-tree repo file at `HEAD`, for an export preview. */
async function readHeadFiles(
  repoRoot: string,
  repoFiles: RepoFiles,
): Promise<RepoFiles> {
  const paths = [...repoFiles.keys()].sort();
  const read = await Promise.all(
    paths.map(async (path) => {
      const bytes = await readFileAtHead(repoRoot, path);
      return bytes === undefined ? undefined : { path, bytes };
    }),
  );
  const files = new Map<string, Uint8Array>();
  for (const entry of read) {
    if (entry !== undefined) {
      files.set(entry.path, entry.bytes);
    }
  }
  return files;
}

/**
 * Build the snapshot the plan reads: the disk through `readSnapshot`, plus
 * `HEAD` and the porcelain status for the import's sync point, and `HEAD`'s
 * bytes for an export preview.
 */
async function buildSnapshot(
  repoRoot: string,
  config: ConfigV2,
  os: Os,
  home: string,
  command: RunCommand,
): Promise<Snapshot> {
  const snapshot = readSnapshot({
    repoRoot,
    config,
    os,
    home,
    cwd: process.cwd(),
    values: readValues(repoRoot),
    env: process.env,
    only: command.only,
    force: command.force,
  });
  if (command.command === "export" && !command.preview) {
    return snapshot;
  }

  const [head, porcelain] = await Promise.all([
    readHead(repoRoot),
    readPorcelain(repoRoot),
  ]);
  const git: { head?: string; porcelain?: string; headFiles?: RepoFiles } = {};
  if (head !== undefined) {
    git.head = head;
  }
  if (porcelain !== undefined) {
    git.porcelain = porcelain;
  }
  if (command.command === "export" && command.preview && head !== undefined) {
    git.headFiles = await readHeadFiles(repoRoot, snapshot.repoFiles);
  }
  return { ...snapshot, ...git };
}

/**
 * Read the import's prompt answers as a list, which is what `planImport`
 * takes. End of input counts as yes, so no answers means every file applies.
 */
async function readAnswers(
  command: RunCommand,
): Promise<readonly string[]> {
  if (command.command !== "import" || command.force || command.check) {
    return [];
  }
  // shortcut: a terminal user does not see the Overwrite prompt yet. The whole
  // of stdin is read up front because the planner takes answers as a list; with
  // no piped input this waits for end of input before anything is applied.
  const text = await Bun.stdin.text();
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** Print a plan that writes nothing: the import check and the export preview. */
function renderStatic(plan: Plan): Result {
  return { code: plan.code, stdout: writeLines(plan.lines), stderr: "" };
}

/** Apply a plan's steps and render what the run printed. */
function applyPlan(plan: RunPlan, context: RunContext): Result {
  const rendered = renderRun(plan, runPlan(plan, context));
  return { code: rendered.code, stdout: writeLines(rendered.lines), stderr: "" };
}

/** Run the hidden shadow comparisons against the repo found from here. */
async function executeShadow(
  repoRoot: string,
  config: ConfigV2,
  os: Os,
  home: string,
  state: string,
): Promise<Result> {
  try {
    const snapshot = await buildSnapshot(
      repoRoot,
      config,
      os,
      home,
      SHADOW_SNAPSHOT_COMMAND,
    );
    return await runShadow({
      stateFolder: state,
      program: () => programShadow(snapshot),
      engine: () => engineShadow(repoRoot, os),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(`ERROR: ${message}`);
  }
}

/** Run the command against the repo found from the working folder. */
async function execute(command: RunCommand | ShadowCommand): Promise<Result> {
  const repoRoot = findRepoRoot(process.cwd());
  if (repoRoot === undefined) {
    return failure(
      `ERROR: no ${V1_CONFIG} or ${V2_CONFIG} in this folder or its parents.`,
    );
  }

  const os = resolveOs(process.env);
  if (!os.ok) {
    return failure(os.error);
  }
  const config = loadConfig(repoRoot);
  if (!config.ok) {
    return failure(config.error.message, config.error.code);
  }

  const home = homeFolder(os.value, process.env) ?? "";
  const state = stateFolder(os.value, home, process.env);
  if (command.kind === "shadow") {
    return executeShadow(repoRoot, config.value, os.value, home, state);
  }

  const answers = await readAnswers(command);
  const snapshot = await buildSnapshot(
    repoRoot,
    config.value,
    os.value,
    home,
    command,
  );
  const context: RunContext = {
    repoRoot,
    os: os.value,
    stateFolder: state,
    now: () => new Date(),
    pid: process.pid,
  };

  if (command.command === "export") {
    return command.preview
      ? renderStatic(planPreview(snapshot))
      : applyPlan(planExport(snapshot), context);
  }
  return command.check
    ? renderStatic(planCheck(snapshot))
    : applyPlan(planImport(snapshot, answers), context);
}

/**
 * Resolve the arguments that need no repo: the version, the usage line or an
 * unknown option. A command comes back for `main` to execute.
 */
export function run(argv: readonly string[]): Resolved {
  const parsed = parseArgs(argv);
  switch (parsed.kind) {
    case "run":
      return parsed;
    case "shadow":
      return parsed;
    case "version":
      return { code: 0, stdout: `mksync ${pkg.version}\n`, stderr: "" };
    case "usage":
      return { code: 2, stdout: "", stderr: `${USAGE}\n` };
    case "error":
      return { code: 1, stdout: "", stderr: `${parsed.message}\n` };
    default: {
      const unhandled: never = parsed;
      throw new Error(`unhandled command: ${String(unhandled)}`);
    }
  }
}

/** The program: argv in, its output printed, its exit code out. */
export async function main(argv: readonly string[]): Promise<number> {
  const resolved = run(argv);
  const result = isResolvedCommand(resolved)
    ? await execute(resolved)
    : resolved;
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.code;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
