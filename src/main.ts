import { unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import {
  readAheadBehind,
  readSyncPoint,
  readUpstreamFacts,
  runGitResult,
  statusPorcelain,
} from "./adapters/git.ts";
import { homeFolder, stateFolder } from "./adapters/paths.ts";
import { readAllStdin } from "./adapters/process.ts";
import { readIdentity } from "./adapters/scan.ts";
import {
  buildSnapshot,
  findRepoRoot,
  loadConfig,
  loadLayers,
  V1_CONFIG,
  V2_CONFIG,
} from "./adapters/snapshot.ts";
import type { Layers } from "./adapters/snapshot.ts";
import {
  renderStatusline,
  STATUSLINE_UNAVAILABLE,
} from "./adapters/statusline.ts";
import { readVisibility } from "./adapters/visibility.ts";
import { executeCommit } from "./app/commit.ts";
import { diffExport } from "./app/diff.ts";
import { executeDoctor } from "./app/doctor.ts";
import { runImport } from "./app/import.ts";
import { executePull } from "./app/pull.ts";
import type { FetchResult } from "./app/pull.ts";
import { executePush } from "./app/push.ts";
import { executeRetire } from "./app/retire.ts";
import { executeSetup } from "./app/setup.ts";
import { executeShadow } from "./app/shadow.ts";
import { executeStatus, fetchOrigin, unsentCount } from "./app/status.ts";
import {
  defaultUpdateDeps,
  executeUpdate,
  OLD_PROGRAM_NAME,
} from "./app/update.ts";
import { failure, runExport, setupTerminal, writeLines } from "./app/export.ts";
import type { ExecuteOptions, Result } from "./app/export.ts";
import type { RunEnvironment } from "./app/run.ts";
import { parseArgs, USAGE } from "./cli/parse.ts";
import type {
  CommitCommand,
  DiffCommand,
  DoctorCommand,
  MachineShowCommand,
  PullCommand,
  PushCommand,
  RetireCommand,
  RunCommand,
  SetupCommand,
  ShadowCommand,
  StatusCommand,
  StatuslineCommand,
  UpdateCommand,
} from "./cli/parse.ts";
import { trimAnswer } from "./core/answer.ts";
import { pickOs } from "./core/layers/select.ts";
import { checkRecord } from "./core/machine/check.ts";
import { machineScope } from "./core/machine/scope.ts";
import { renderMachineShow } from "./core/machine/show.ts";
import type { SetupIo } from "./wizard/setup.ts";

export { USAGE };

export type { Result } from "./app/export.ts";

/** Git calls that could ask for credentials get the front door's `front_git`. */
const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
};

/** A pull child's `import`: the check (`--check`) or the forced apply. */
function pullImportCommand(
  check: boolean,
  force: boolean,
  only: readonly string[],
): RunCommand {
  return {
    kind: "run",
    command: "import",
    force,
    preview: false,
    check,
    resetValues: false,
    yes: false,
    only,
  };
}

/** A child's `export --diff`, narrowed to the pulled or picked paths. */
function diffCommand(only: readonly string[]): RunCommand {
  return {
    kind: "run",
    command: "export",
    force: false,
    preview: false,
    check: false,
    resetValues: false,
    yes: false,
    diff: true,
    only,
  };
}

/** A push child's `export`: the picked paths, with `--yes` taking the new
 * settings' suggestions, as the design's "Push and pull" says. */
function pushExportCommand(only: readonly string[], yes: boolean): RunCommand {
  return {
    kind: "run",
    command: "export",
    force: false,
    preview: false,
    check: false,
    resetValues: false,
    yes,
    only,
  };
}

/** A push child's `commit`: `--partial` when the push had picked paths. */
function pushCommitCommand(
  partial: boolean,
  message: string | undefined,
): CommitCommand {
  return {
    kind: "commit",
    partial,
    ...(message === undefined ? {} : { message }),
  };
}

/** The paths the push's `git status --short` reads: `front_push`'s, plus the
 * profile and machine layers, which only the program writes. */
const PUSH_STATUS_PATHS = [
  "dotfiles",
  "packages",
  "sync-config.json",
  "profiles",
  "machines",
] as const;

/** Contract "Front door": pull needs the clone on `master` with an origin. */
async function cloneReady(repoRoot: string): Promise<boolean> {
  const inside = await runGitResult(repoRoot, [
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  if (!inside.ok) {
    return false;
  }
  const remote = await runGitResult(repoRoot, ["remote", "get-url", "origin"]);
  if (!remote.ok) {
    return false;
  }
  const branch = await runGitResult(repoRoot, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  return branch.ok && branch.stdout.trim() === "master";
}

/** `git fetch -q origin master`, then `front_pull`'s counted fast-forward. */
async function fetchAndFastForward(repoRoot: string): Promise<FetchResult> {
  const fetched = await runGitResult(
    repoRoot,
    ["fetch", "-q", "origin", "master"],
    GIT_ENV,
  );
  if (!fetched.ok) {
    return { ok: false, message: "ERROR: could not reach origin." };
  }
  const counts = await readAheadBehind(repoRoot);
  if (!counts.ok) {
    return { ok: false, message: "ERROR: pull failed; resolve it and rerun." };
  }
  if (counts.behind === 0) {
    return { ok: true, pulled: 0 };
  }
  const merged = await runGitResult(
    repoRoot,
    ["merge", "--ff-only", "origin/master"],
    GIT_ENV,
  );
  if (!merged.ok) {
    return { ok: false, message: "ERROR: pull failed; resolve it and rerun." };
  }
  return { ok: true, pulled: counts.behind };
}

/** Contract "Front door": a failed fetch on `mksync diff` still compares the
 * last one it saw. */
const OFFLINE_LINE = "  Offline: comparing with the last fetch.\n";

/**
 * `git fetch -q origin master` as `mksync status` runs it: no prompt, under
 * `SYNC_FETCH_TIMEOUT`. `undefined` when there is no origin (the diff prints
 * nothing then); `false` when an origin exists but the fetch failed.
 */
async function fetchOriginForDiff(
  repoRoot: string,
): Promise<boolean | undefined> {
  const origin = await runGitResult(
    repoRoot,
    ["remote", "get-url", "origin"],
    GIT_ENV,
  );
  if (!origin.ok) {
    return undefined;
  }
  return fetchOrigin(repoRoot, process.env);
}

/** Bash's `read` trims; an empty answer or end of input takes the default. */
function pullAnswer(answer: string | undefined, defaultYes: boolean): boolean {
  const given = answer === undefined ? "" : trimAnswer(answer);
  if (given === "") {
    return defaultYes;
  }
  return /^[Yy]/.test(given);
}

/** A question on a terminal already in use: the prompt goes out before its
 * answer is read. */
async function askTerminalQuestion(
  io: SetupIo,
  question: string,
  defaultYes: boolean,
): Promise<boolean> {
  io.write(question);
  return pullAnswer(await io.readLine(), defaultYes);
}

type Resolved =
  | Result
  | RunCommand
  | ShadowCommand
  | StatusCommand
  | DoctorCommand
  | DiffCommand
  | PullCommand
  | PushCommand
  | MachineShowCommand
  | RetireCommand
  | CommitCommand
  | SetupCommand
  | StatuslineCommand
  | UpdateCommand;

type ExecutableCommand =
  | RunCommand
  | ShadowCommand
  | StatusCommand
  | DoctorCommand
  | DiffCommand
  | PullCommand
  | PushCommand
  | MachineShowCommand
  | RetireCommand
  | CommitCommand
  | SetupCommand;

function isResolvedCommand(value: Resolved): value is ExecutableCommand {
  return (
    "kind" in value && value.kind !== "statusline" && value.kind !== "update"
  );
}

function isStatuslineCommand(value: Resolved): value is StatuslineCommand {
  return "kind" in value && value.kind === "statusline";
}

function isUpdateCommand(value: Resolved): value is UpdateCommand {
  return "kind" in value && value.kind === "update";
}

/** `statusline`'s whole body: stdin in, one line out, 0 whatever fails. */
async function statuslineOutput(): Promise<string> {
  try {
    return renderStatusline(await readAllStdin());
  } catch {
    // Contract: the command prints one line and exits 0 whatever fails.
    return STATUSLINE_UNAVAILABLE;
  }
}

/** The contract's no-record line, and exit 1. */
const NO_RECORD = "ERROR: no machine record here; run mksync setup.";

/** Run the command against the repo found from the working folder. */
async function execute(
  command: ExecutableCommand,
  options?: ExecuteOptions,
): Promise<Result> {
  const repoRoot = findRepoRoot(process.cwd());
  if (repoRoot === undefined) {
    return failure(
      `ERROR: no ${V1_CONFIG} or ${V2_CONFIG} in this folder or its parents.`,
    );
  }

  if (command.kind === "diff") {
    // Contract "Front door": fetch first so the repo side is current; offline
    // still compares with the last fetch. Then exactly `export --diff --only`.
    const fetched = await fetchOriginForDiff(repoRoot);
    const result = await execute(diffCommand(command.paths));
    return fetched === false
      ? { ...result, stdout: OFFLINE_LINE + result.stdout }
      : result;
  }

  const os = pickOs(process.env.SYNC_OS, process.platform);
  if (!os.ok) {
    return failure(os.error.message, os.error.code);
  }
  const home = homeFolder(os.value, process.env);
  if (home === undefined) {
    const variable = os.value === "windows" ? "USERPROFILE" : "HOME";
    return failure(`ERROR: the home folder is not set (${variable}).`);
  }

  const config = loadConfig(repoRoot);
  if (!config.ok) {
    return failure(config.error.message, config.error.code);
  }

  const state = stateFolder(os.value, home, process.env);
  switch (command.kind) {
    case "pull": {
      // Decision 7: each child reads the config again, so a fast-forward's new
      // config and code are the ones this pull goes on with. One reader serves
      // the pull's questions and the import's value questions, so piped
      // answers left after a pull question still reach the import.
      const terminal = setupTerminal();
      try {
        return await executePull(
          { yes: command.yes, force: command.force, paths: command.paths },
          {
            runCheck: (only) => execute(pullImportCommand(true, false, only)),
            runDiff: (only) => execute(diffCommand(only)),
            runImport: (only) =>
              execute(pullImportCommand(false, true, only), { terminal }),
            unsent: async () => (await unsentCount(repoRoot)) ?? 0,
            fetchAndFastForward: () => fetchAndFastForward(repoRoot),
            hasSyncPoint: async () =>
              (await readSyncPoint(repoRoot, state)) !== undefined,
            ask: (question, defaultYes) =>
              askTerminalQuestion(terminal.io, question, defaultYes),
            print: (shown) => {
              process.stdout.write(shown.stdout);
              process.stderr.write(shown.stderr);
            },
            cloneReady: () => cloneReady(repoRoot),
          },
        );
      } finally {
        terminal.close();
      }
    }
    case "push": {
      // One terminal for the whole push: the export's questions and the PR
      // question share it, so an answer piped ahead isn't lost when the export
      // closes its own reader.
      const terminal = setupTerminal();
      try {
        return await executePush(
          {
            yes: command.yes,
            paths: command.paths,
            ...(command.message === undefined
              ? {}
              : { message: command.message }),
          },
          {
            runExport: (only, yes) =>
              execute(pushExportCommand(only, yes), {
                moves: true,
                terminal,
              }),
            statusShort: () => statusPorcelain(repoRoot, PUSH_STATUS_PATHS),
            ask: (question, defaultYes) =>
              askTerminalQuestion(terminal.io, question, defaultYes),
            print: (shown) => {
              process.stdout.write(shown.stdout);
              process.stderr.write(shown.stderr);
            },
            runCommit: (partial, message) =>
              execute(pushCommitCommand(partial, message)),
            cloneReady: () => cloneReady(repoRoot),
            originState: () => readUpstreamFacts(repoRoot),
          },
        );
      } finally {
        terminal.close();
      }
    }
    case "setup":
      return executeSetup(
        repoRoot,
        config.value,
        os.value,
        home,
        state,
        command,
        execute,
      );
    case "machine-retire":
    case "profile-retire":
      return executeRetire(repoRoot, config.value, state, command);
    case "commit":
    case "shadow":
    case "status":
    case "doctor":
    case "machine-show":
    case "run":
      break;
    default: {
      const unhandled: never = command;
      throw new Error(`unhandled command: ${String(unhandled)}`);
    }
  }

  const layers = loadLayers(state, repoRoot, config.value);
  if (!layers.ok) {
    return failure(layers.error.message, layers.error.code);
  }
  const environment: RunEnvironment = {
    repoRoot,
    state,
    home,
    os: os.value,
    config: config.value,
    layers: layers.value,
    options,
  };
  switch (command.kind) {
    case "commit":
      return executeCommit({
        repoRoot,
        config: config.value,
        state,
        os: os.value,
        location: layers.value.location,
        command,
        ...(layers.value.profile !== undefined
          ? { profile: layers.value.profile }
          : {}),
        ...(layers.value.record !== undefined
          ? { record: layers.value.record }
          : {}),
      });
    case "shadow":
      return executeShadow(
        repoRoot,
        config.value,
        os.value,
        home,
        state,
        layers.value,
      );
    case "status":
      return executeStatus({
        repoRoot,
        config: config.value,
        os: os.value,
        home,
        state,
        layers: layers.value,
      });
    case "doctor":
      return executeDoctor({
        repoRoot,
        config: config.value,
        os: os.value,
        home,
        layers: layers.value,
      });
    case "machine-show": {
      const record = layers.value.record;
      if (record === undefined) {
        return failure(NO_RECORD);
      }
      const warnings = checkRecord(
        record,
        readIdentity(process.env, os.value),
        "pull",
      );
      const lines = renderMachineShow(
        record,
        machineScope(config.value, layers.value.profile, record, os.value),
      );
      return {
        code: 0,
        stdout: writeLines(lines),
        stderr: writeLines(warnings.lines),
      };
    }
    case "run": {
      if (command.diff === true) {
        const snapshot = await buildSnapshot(
          repoRoot,
          config.value,
          os.value,
          home,
          command,
          process.cwd(),
          process.env,
          layers.value,
        );
        return diffExport(repoRoot, state, snapshot);
      }
      return command.command === "export"
        ? runExport(environment, command)
        : runImport(environment, command, options?.terminal?.io);
    }
    default: {
      const unhandled: never = command;
      throw new Error(`unhandled command: ${String(unhandled)}`);
    }
  }
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
    case "status":
      return parsed;
    case "doctor":
      return parsed;
    case "diff":
      return parsed;
    case "pull":
      return parsed;
    case "push":
      return parsed;
    case "machine-show":
      return parsed;
    case "commit":
      return parsed;
    case "setup":
      return parsed;
    case "statusline":
      return parsed;
    case "update":
      return parsed;
    case "machine-retire":
    case "profile-retire":
      return parsed;
    case "version":
      return { code: 0, stdout: `mksync ${pkg.version}\n`, stderr: "" };
    case "usage":
      return { code: 2, stdout: "", stderr: `${USAGE}\n` };
    case "error":
      return { code: parsed.code, stdout: "", stderr: `${parsed.message}\n` };
    default: {
      const unhandled: never = parsed;
      throw new Error(`unhandled command: ${String(unhandled)}`);
    }
  }
}

/**
 * Delete the program an earlier Windows update moved aside, so a restart
 * after an update leaves nothing behind. Only Windows has one; any error
 * leaves the file, because a leftover is harmless.
 */
export function removeOldProgram(platform: string, execPath: string): void {
  if (platform !== "win32") {
    return;
  }
  try {
    unlinkSync(join(dirname(execPath), OLD_PROGRAM_NAME));
  } catch {
    // A leftover is harmless: leave it, whatever the error (usually ENOENT).
  }
}

/** The program: argv in, its output printed, its exit code out. */
export async function main(argv: readonly string[]): Promise<number> {
  removeOldProgram(process.platform, process.execPath);
  const resolved = run(argv);
  if (isStatuslineCommand(resolved)) {
    process.stdout.write(await statuslineOutput());
    return 0;
  }
  if (isUpdateCommand(resolved)) {
    const result = await executeUpdate(defaultUpdateDeps(pkg.version));
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return result.code;
  }
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
