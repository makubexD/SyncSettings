import pkg from "../package.json" with { type: "json" };
import { runPlan } from "./adapters/fs.ts";
import type { RunContext } from "./adapters/fs.ts";
import {
  readAheadBehind,
  readSyncPoint,
  runGitResult,
  statusPorcelain,
} from "./adapters/git.ts";
import { homeFolder, stateFolder } from "./adapters/paths.ts";
import { readIdentity } from "./adapters/scan.ts";
import {
  buildSnapshot,
  findRepoRoot,
  loadConfig,
  loadLayers,
  previewWorkingTree,
  V1_CONFIG,
  V2_CONFIG,
} from "./adapters/snapshot.ts";
import type { Layers } from "./adapters/snapshot.ts";
import {
  renderStatusline,
  STATUSLINE_UNAVAILABLE,
} from "./adapters/statusline.ts";
import { readBackupSides } from "./adapters/store.ts";
import type { BackupSides } from "./adapters/store.ts";
import { readVisibility } from "./adapters/visibility.ts";
import { executeCommit } from "./app/commit.ts";
import { diffExport } from "./app/diff.ts";
import { executeDoctor } from "./app/doctor.ts";
import { executePull } from "./app/pull.ts";
import type { FetchResult } from "./app/pull.ts";
import { executePush } from "./app/push.ts";
import { executeRetire } from "./app/retire.ts";
import { executeSetup } from "./app/setup.ts";
import { executeShadow } from "./app/shadow.ts";
import { executeStatus, fetchOrigin, unsentCount } from "./app/status.ts";
import {
  CANNOT_LIST_TRACKED,
  ensureUpToDate,
  executeExport,
  exportGuard,
  failure,
  setupTerminal,
  writeLines,
} from "./app/export.ts";
import type {
  AppliedPlan,
  ExportGuard,
  FirstBackupRun,
  Result,
  SetupTerminal,
} from "./app/export.ts";
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
} from "./cli/parse.ts";
import { pickOs } from "./core/layers/select.ts";
import { planFirstBackup } from "./core/machine/backup.ts";
import { checkRecord } from "./core/machine/check.ts";
import type { CheckMode } from "./core/machine/check.ts";
import { machineScope } from "./core/machine/scope.ts";
import { renderMachineShow } from "./core/machine/show.ts";
import { planCheck } from "./core/plan/check.ts";
import { planImport } from "./core/plan/import.ts";
import { planPreview } from "./core/plan/preview.ts";
import { renderRun } from "./core/plan/run.ts";
import type { Plan, RunPlan, Snapshot } from "./core/plan/types.ts";
import type { SetupIo } from "./wizard/setup.ts";

export { USAGE };

export type { Result } from "./app/export.ts";

/** Decision 8: the record check a command makes. */
function checkMode(command: RunCommand): CheckMode {
  if (command.command !== "export") {
    return "pull";
  }
  return command.preview ? "preview" : "push";
}

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
  const given = answer?.trim() ?? "";
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

/** A pull question: the prompt goes out before its answer is read. */
async function askPullQuestion(
  question: string,
  defaultYes: boolean,
): Promise<boolean> {
  const terminal = setupTerminal();
  try {
    return await askTerminalQuestion(terminal.io, question, defaultYes);
  } finally {
    terminal.close();
  }
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
  | StatuslineCommand;

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
  return "kind" in value && value.kind !== "statusline";
}

function isStatuslineCommand(value: Resolved): value is StatuslineCommand {
  return "kind" in value && value.kind === "statusline";
}

/** `statusline`'s whole body: stdin in, one line out, 0 whatever fails. */
async function statuslineOutput(): Promise<string> {
  try {
    return renderStatusline(await Bun.stdin.text());
  } catch {
    // Contract: the command prints one line and exits 0 whatever fails.
    return STATUSLINE_UNAVAILABLE;
  }
}

/** The contract's no-record line, and exit 1. */
const NO_RECORD = "ERROR: no machine record here; run mksync setup.";

/**
 * Read the import's prompt answers as a list, which is what `planImport`
 * takes. End of input counts as yes, so no answers means every file applies.
 */
async function readAnswers(command: RunCommand): Promise<readonly string[]> {
  if (
    command.command !== "import" ||
    command.check ||
    (command.force && !command.resetValues)
  ) {
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

/** Apply a plan's steps and render what the run printed, keeping the run's
 * dated backup folder. */
function applyPlanAndBackup(plan: RunPlan, context: RunContext): AppliedPlan {
  const outcome = runPlan(plan, context);
  const rendered = renderRun(plan, outcome);
  return {
    result: {
      code: rendered.code,
      stdout: (plan.prompt ?? "") + writeLines(rendered.lines),
      stderr: "",
    },
    backups: outcome.backups,
  };
}

/** Apply a plan's steps and render what the run printed. */
function applyPlan(plan: RunPlan, context: RunContext): Result {
  return applyPlanAndBackup(plan, context).result;
}

/** Contract "Public-repo guard (program only)", Refused: two lines per path. */
function refusedText(paths: readonly string[]): string {
  return paths
    .flatMap((path) => [
      `refused: the repo is public, so ${path} can't be pushed.`,
      "It is kept on this machine and goes in with the first push after the repo is private.",
    ])
    .join("\n");
}

/** Contract "Public-repo guard (program only)", Held: the line and the paths. */
function heldText(paths: readonly string[]): string {
  return writeLines([
    `held until the repo is private: ${paths.length} file(s)`,
    ...paths.map((path) => `  ${path}`),
  ]);
}

/** What a child run adds to its command: the push turns the "Move a change"
 * questions on, and shares its terminal so the answers left for its PR
 * question aren't lost when the export's reader closes. */
interface ExecuteOptions {
  readonly moves?: boolean;
  readonly terminal?: SetupTerminal;
}

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
  if (command.kind === "pull") {
    // Decision 7: each child reads the config again, so a fast-forward's new
    // config and code are the ones this pull goes on with.
    return executePull(
      { yes: command.yes, force: command.force, paths: command.paths },
      {
        runCheck: (only) => execute(pullImportCommand(true, false, only)),
        runDiff: (only) => execute(diffCommand(only)),
        runImport: (only) => execute(pullImportCommand(false, true, only)),
        unsent: async () => (await unsentCount(repoRoot)) ?? 0,
        fetchAndFastForward: () => fetchAndFastForward(repoRoot),
        hasSyncPoint: async () =>
          (await readSyncPoint(repoRoot, state)) !== undefined,
        ask: askPullQuestion,
        print: (shown) => {
          process.stdout.write(shown.stdout);
          process.stderr.write(shown.stderr);
        },
        cloneReady: () => cloneReady(repoRoot),
      },
    );
  }
  if (command.kind === "push") {
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
        },
      );
    } finally {
      terminal.close();
    }
  }
  if (command.kind === "setup") {
    return executeSetup(
      repoRoot,
      config.value,
      os.value,
      home,
      state,
      command,
      execute,
    );
  }
  if (command.kind === "machine-retire" || command.kind === "profile-retire") {
    return executeRetire(repoRoot, config.value, state, command);
  }
  const layers = loadLayers(state, repoRoot, config.value);
  if (!layers.ok) {
    return failure(layers.error.message, layers.error.code);
  }
  if (command.kind === "commit") {
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
  }
  if (command.kind === "shadow") {
    return executeShadow(
      repoRoot,
      config.value,
      os.value,
      home,
      state,
      layers.value,
    );
  }
  if (command.kind === "status") {
    return executeStatus({
      repoRoot,
      config: config.value,
      os: os.value,
      home,
      state,
      layers: layers.value,
    });
  }
  if (command.kind === "doctor") {
    return executeDoctor({
      repoRoot,
      config: config.value,
      os: os.value,
      home,
      layers: layers.value,
    });
  }
  if (command.kind === "machine-show") {
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

  // Contract "Up-to-date check": export and import start by checking the
  // repo, not check, preview or diff. The lines print before everything else
  // this run writes.
  const upToDate =
    (command.command === "export" && command.preview) ||
    (command.command === "import" && command.check)
      ? undefined
      : await ensureUpToDate(repoRoot);
  if (upToDate !== undefined && upToDate.stop) {
    return {
      code: upToDate.code,
      stdout: upToDate.stdout,
      stderr: upToDate.stderr,
      stopped: true,
    };
  }
  const upToDatePrefix = upToDate?.stdout ?? "";
  const finish = (result: Result): Result =>
    upToDatePrefix === ""
      ? result
      : { ...result, stdout: upToDatePrefix + result.stdout };

  const check =
    layers.value.record === undefined
      ? undefined
      : checkRecord(
          layers.value.record,
          readIdentity(process.env, os.value),
          checkMode(command),
        );
  if (check !== undefined && check.stop) {
    return finish({ code: 1, stdout: "", stderr: writeLines(check.lines) });
  }

  // The record checks run first, then the public-repo guard's (contract
  // "Public-repo guard (program only)").
  let exportGuardResult: ExportGuard | undefined;
  if (command.command === "export") {
    exportGuardResult = await exportGuard(repoRoot, state, config.value);
    if (exportGuardResult === undefined) {
      return finish(failure(CANNOT_LIST_TRACKED));
    }
  }
  if (
    exportGuardResult !== undefined &&
    !command.preview &&
    exportGuardResult.decision.refused.length > 0
  ) {
    return finish(failure(refusedText(exportGuardResult.decision.refused)));
  }
  // Contract "The first backup": a private repo and a record not yet the
  // pointer read both sides before the run.
  let backupSides: BackupSides | undefined;
  if (
    command.command === "export" &&
    exportGuardResult?.visibility === "private"
  ) {
    const sides = readBackupSides(state, repoRoot, config.value);
    if (!sides.ok) {
      return finish(failure(sides.error.message, sides.error.code));
    }
    backupSides = sides.value;
  }

  const answers = await readAnswers(command);
  const built = await buildSnapshot(
    repoRoot,
    config.value,
    os.value,
    home,
    command,
    process.cwd(),
    process.env,
    layers.value,
  );
  const snapshot: Snapshot = command.resetValues
    ? { ...built, resetValues: true }
    : built;
  const context: RunContext = {
    repoRoot,
    os: os.value,
    stateFolder: state,
    location: layers.value.location,
    env: snapshot.env,
    now: () => new Date(),
    pid: process.pid,
  };

  let result: Result;
  if (command.command === "export") {
    if (command.preview) {
      const firstBackup =
        backupSides === undefined
          ? undefined
          : planFirstBackup(backupSides.local, backupSides.repo).paths;
      result = renderStatic(
        planPreview(
          snapshot,
          previewWorkingTree(repoRoot, snapshot.repoFiles),
          firstBackup,
        ),
      );
    } else {
      const firstBackup: FirstBackupRun | undefined =
        backupSides === undefined
          ? undefined
          : {
              stateFolder: state,
              repoRoot,
              config: config.value,
              local: backupSides.local,
              repo: backupSides.repo,
              yes: command.yes,
            };
      result = await executeExport(
        snapshot,
        command,
        context,
        firstBackup,
        options?.moves ?? false,
        options?.terminal,
      );
    }
    if (
      command.preview &&
      result.code === 0 &&
      exportGuardResult !== undefined &&
      exportGuardResult.decision.held.length > 0
    ) {
      result = {
        ...result,
        stdout: result.stdout + heldText(exportGuardResult.decision.held),
      };
    }
  } else {
    result = command.check
      ? renderStatic(planCheck(snapshot))
      : applyPlan(planImport(snapshot, answers), context);
  }
  if (check === undefined || check.lines.length === 0) {
    return finish(result);
  }
  return finish({
    ...result,
    stderr: writeLines(check.lines) + result.stderr,
  });
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
    case "machine-retire":
    case "profile-retire":
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
  if (isStatuslineCommand(resolved)) {
    process.stdout.write(await statuslineOutput());
    return 0;
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
