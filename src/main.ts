import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { appendShadowLog, engineShadow } from "./adapters/engine.ts";
import type { EngineHost } from "./adapters/engine.ts";
import { runPlan } from "./adapters/fs.ts";
import type { RunContext } from "./adapters/fs.ts";
import { readOrigin } from "./adapters/git.ts";
import { homeFolder, stateFolder } from "./adapters/paths.ts";
import { readIdentity, readScan } from "./adapters/scan.ts";
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
import {
  readBackupSides,
  readRepoStore,
  readStore,
  readText,
  writeProfile,
  writeRecord,
  writeStoreProfile,
  writeStoreRecord,
} from "./adapters/store.ts";
import type { BackupSides } from "./adapters/store.ts";
import { readVisibility } from "./adapters/visibility.ts";
import { executeCommit } from "./app/commit.ts";
import { diffExport } from "./app/diff.ts";
import { executeStatus } from "./app/status.ts";
import {
  CANNOT_LIST_TRACKED,
  ensureUpToDate,
  executeExport,
  exportGuard,
  setupTerminal,
  writeLines,
} from "./app/export.ts";
import type {
  AppliedPlan,
  ExportGuard,
  FirstBackupRun,
  Result,
} from "./app/export.ts";
import { parseArgs, USAGE } from "./cli/parse.ts";
import type {
  CommitCommand,
  MachineShowCommand,
  RetireCommand,
  RunCommand,
  SetupCommand,
  ShadowCommand,
  StatusCommand,
  StatuslineCommand,
} from "./cli/parse.ts";
import type { Profile } from "./core/config/profile.ts";
import type { ConfigV2, Os } from "./core/config/types.ts";
import { PROFILES_FOLDER } from "./core/guard.ts";
import { pickOs } from "./core/layers/select.ts";
import { planFirstBackup } from "./core/machine/backup.ts";
import { checkRecord } from "./core/machine/check.ts";
import type { CheckMode } from "./core/machine/check.ts";
import { RECORD_ERROR_PREFIX } from "./core/machine/record.ts";
import type { MachineRecord } from "./core/machine/record.ts";
import {
  isYes,
  machineRetireQuestion,
  NOTHING_RETIRED,
  profileRetireQuestion,
  retireMachine,
  retireProfile,
} from "./core/machine/retire.ts";
import type { RetireResult } from "./core/machine/retire.ts";
import { machineScope } from "./core/machine/scope.ts";
import { renderMachineShow } from "./core/machine/show.ts";
import type { ValuePlace } from "./core/machine/values.ts";
import { moveUserValues, placeValue } from "./core/machine/values.ts";
import { planCheck } from "./core/plan/check.ts";
import { planImport } from "./core/plan/import.ts";
import { planPreview } from "./core/plan/preview.ts";
import { renderRun } from "./core/plan/run.ts";
import type { Plan, RunPlan, Snapshot } from "./core/plan/types.ts";
import { compareShadow, programShadow, renderShadow } from "./core/shadow.ts";
import { parseValuesFile } from "./core/values/file.ts";
import type { Values } from "./core/values/sanitize.ts";
import type { SetupFlags, SetupIo } from "./wizard/setup.ts";
import { runSetup } from "./wizard/setup.ts";

export { USAGE };

export type { Result } from "./app/export.ts";

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
  resetValues: false,
  yes: false,
  only: [],
};

/** The host whose old-engine scripts shadow runs, from the real platform. */
function hostOf(platform: string): EngineHost {
  return platform === "win32" ? "windows" : "posix";
}

/** Decision 8: the record check a command makes. */
function checkMode(command: RunCommand): CheckMode {
  if (command.command !== "export") {
    return "pull";
  }
  return command.preview ? "preview" : "push";
}

function failure(message: string, code = 1): Result {
  return { code, stdout: "", stderr: `${message}\n` };
}

type Resolved =
  | Result
  | RunCommand
  | ShadowCommand
  | StatusCommand
  | MachineShowCommand
  | RetireCommand
  | CommitCommand
  | SetupCommand
  | StatuslineCommand;

type ExecutableCommand =
  | RunCommand
  | ShadowCommand
  | StatusCommand
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

const VALUES_FILE = ".user-values.json";

/** Today as `YYYY-MM-DD` in the machine's own time zone. */
function localDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Decision 4: where a placeholder `.user-values.json` holds outside the table
 * goes. Only `--yes` skips the questions — a piped stdin asks them too, taking
 * the suggestion, the profile, at end of input; otherwise each is asked once.
 */
async function valueAnswers(
  values: Values,
  profile: Profile,
  record: MachineRecord,
  flags: SetupFlags,
  io: SetupIo,
): Promise<Readonly<Record<string, ValuePlace>>> {
  const answers: Record<string, ValuePlace> = {};
  if (flags.yes === true) {
    return answers;
  }
  for (const placeholder of Object.keys(values)) {
    if (placeValue(placeholder) !== "ask") {
      continue;
    }
    if (
      Object.hasOwn(profile.values, placeholder) ||
      Object.hasOwn(record.values, placeholder)
    ) {
      continue;
    }
    io.write(`${placeholder}: kept on 1) this profile 2) this machine [1] `);
    const line = await io.readLine();
    answers[placeholder] = line?.trim() === "2" ? "machine" : "profile";
  }
  return answers;
}

/**
 * Contract "Replace": each machine value is asked again with the old one as
 * the suggestion whenever the flow took over a record (`replaced`). An empty
 * answer, end of input or `--yes` keeps the old value; any other answer
 * replaces it. Nothing is asked when no record was taken over.
 */
async function replaceValues(
  record: MachineRecord,
  replaced: boolean,
  command: SetupCommand,
  io: SetupIo,
): Promise<Readonly<Record<string, string>>> {
  const values: Record<string, string> = { ...record.values };
  if (!replaced || command.yes === true) {
    return values;
  }
  for (const [key, old] of Object.entries(record.values)) {
    io.write(`${key} [${old}] `);
    const answer = (await io.readLine())?.trim();
    if (answer !== undefined && answer !== "") {
      values[key] = answer;
    }
  }
  return values;
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

/** True for the contract's bad-record line, the one `setup --replace` reads past. */
function isBadRecord(message: string): boolean {
  return message.startsWith(RECORD_ERROR_PREFIX);
}

/**
 * Run `mksync setup` end to end: read the store and the scan, run the flow,
 * move `.user-values.json`, write the record and profile, then act on the
 * fourth answer (decision 9).
 */
async function executeSetup(
  repoRoot: string,
  config: ConfigV2,
  os: Os,
  home: string,
  state: string,
  command: SetupCommand,
): Promise<Result> {
  const store = readStore(state, repoRoot, config);
  let own: MachineRecord | undefined;
  let localProfiles: readonly Profile[];
  if (store.ok) {
    own = store.value.record;
    localProfiles = store.value.profiles;
  } else if (
    command.replace !== undefined &&
    isBadRecord(store.error.message)
  ) {
    // Contract "The record": `setup --replace` reads past a bad local record
    // and goes on as if this machine had none. The state folder keeps its
    // profiles where the repo store's live, so read them while ignoring the
    // record; a bad profile file still stops.
    const local = readRepoStore(state, config);
    if (!local.ok) {
      return failure(local.error.message, local.error.code);
    }
    localProfiles = local.value.profiles;
  } else {
    return failure(store.error.message, store.error.code);
  }
  const origins = await readOrigin(repoRoot);
  const isPrivate = (await readVisibility(origins, process.env)) === "private";
  const repoStore = isPrivate ? readRepoStore(repoRoot, config) : undefined;
  if (repoStore !== undefined && !repoStore.ok) {
    return failure(repoStore.error.message, repoStore.error.code);
  }
  const profiles = repoStore?.value.profiles ?? localProfiles;
  const records = new Map<string, MachineRecord>();
  if (own !== undefined) {
    records.set(own.name, own);
  }
  for (const record of repoStore?.value.records ?? []) {
    records.set(record.name, record);
  }

  const scan = await readScan(process.env, os, home, config);
  const terminal = setupTerminal();
  const outcome = await runSetup(
    {
      scan,
      config,
      profiles,
      records: [...records.values()],
      ...(own !== undefined ? { own } : {}),
      isPrivate,
      today: localDate(new Date()),
      flags: command,
    },
    terminal.io,
  );
  if (!outcome.ok) {
    terminal.close();
    return failure(outcome.message, outcome.code);
  }

  const values = parseValuesFile(readText(join(repoRoot, VALUES_FILE)));
  const answers = await valueAnswers(
    values,
    outcome.profile,
    outcome.record,
    command,
    terminal.io,
  );
  const machineValues = await replaceValues(
    outcome.record,
    outcome.replaced,
    command,
    terminal.io,
  );
  terminal.close();
  const moved = moveUserValues(values, answers);
  const record: MachineRecord = {
    ...outcome.record,
    values: { ...moved.machine, ...machineValues },
  };
  const profile: Profile = {
    ...outcome.profile,
    values: { ...moved.profile, ...outcome.profile.values },
  };
  try {
    writeProfile(state, profile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(
      `ERROR: cannot write the profile ${profile.name}: ${message}`,
    );
  }
  try {
    writeRecord(state, record);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(`ERROR: cannot write the machine record: ${message}`);
  }

  if (outcome.action === "stop") {
    return {
      code: 0,
      stdout: "Stopped: the record is written, no file was changed.\n",
      stderr: "",
    };
  }
  const importCommand: RunCommand = {
    kind: "run",
    command: "import",
    force: true,
    preview: false,
    check: false,
    resetValues: false,
    yes: false,
    only: [],
  };
  if (outcome.action === "backup") {
    return execute(importCommand);
  }
  const exportCommand: RunCommand = {
    kind: "run",
    command: "export",
    force: false,
    preview: false,
    check: false,
    resetValues: false,
    yes: false,
    only: [],
  };
  const exported = await execute(exportCommand);
  if (exported.code !== 0) {
    // The local files weren't saved, so importing now would overwrite them.
    return exported;
  }
  const imported = await execute(importCommand);
  return {
    code: imported.code,
    stdout:
      exported.stdout +
      "Pushed into the repo folder; commit it with mksync push.\n" +
      imported.stdout,
    stderr: `${exported.stderr}${imported.stderr}`,
  };
}

/**
 * Finish a retire: a refusal on stderr, exit 1; a value already retired prints
 * its line; otherwise the question is asked unless `--yes`, and a yes writes
 * the value. The question and the answer line share one stdout line.
 */
async function askRetire<T>(
  command: RetireCommand,
  question: string,
  retired: RetireResult<T>,
  write: (value: T) => void,
): Promise<Result> {
  if (!retired.ok) {
    return failure(retired.line, retired.code);
  }
  if (retired.value === undefined) {
    return { code: retired.code, stdout: `${retired.line}\n`, stderr: "" };
  }
  if (!command.yes) {
    const terminal = setupTerminal();
    // The question is written as it is asked, so its line and the answer's
    // share one stdout line; the result carries only the answer.
    terminal.io.write(question);
    const answer = await terminal.io.readLine();
    terminal.close();
    if (!isYes(answer)) {
      return { code: 1, stdout: `${NOTHING_RETIRED}\n`, stderr: "" };
    }
  }
  try {
    write(retired.value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const noun = command.kind === "machine-retire" ? "record" : "profile";
    return failure(`ERROR: cannot write the retired ${noun}: ${message}`);
  }
  return { code: 0, stdout: `${retired.line}\n`, stderr: "" };
}

/**
 * `machine retire` and `profile retire` (contract "Retire"): run the rule
 * against the store, then ask and write. A profile's records are the store's
 * own record when it has one, or every repo record for a pointer.
 */
async function executeRetire(
  repoRoot: string,
  config: ConfigV2,
  state: string,
  command: RetireCommand,
): Promise<Result> {
  const store = readStore(state, repoRoot, config, {
    usedBy: command.kind === "profile-retire",
  });
  if (!store.ok) {
    return failure(store.error.message, store.error.code);
  }
  if (command.kind === "machine-retire") {
    return askRetire(
      command,
      machineRetireQuestion(command.target),
      retireMachine(store.value.record, command.target),
      (record) => {
        writeStoreRecord(store.value.location, record);
      },
    );
  }
  const records = store.value.records;
  return askRetire(
    command,
    profileRetireQuestion(command.target),
    retireProfile(
      store.value.profiles.find((profile) => profile.name === command.target),
      command.target,
      records,
      join(state, PROFILES_FOLDER, `${command.target}.json`),
    ),
    (profile) => {
      writeStoreProfile(store.value.location, profile);
    },
  );
}

/** Run the hidden shadow comparisons against the repo found from here. */
async function executeShadow(
  repoRoot: string,
  config: ConfigV2,
  os: Os,
  home: string,
  state: string,
  layers: Layers,
): Promise<Result> {
  try {
    const snapshot = await buildSnapshot(
      repoRoot,
      config,
      os,
      home,
      SHADOW_SNAPSHOT_COMMAND,
      process.cwd(),
      process.env,
      layers,
    );
    const program = programShadow(snapshot);
    const engine = await engineShadow(
      repoRoot,
      hostOf(process.platform),
      process.env,
    );
    const rendered = renderShadow(
      compareShadow(program, engine),
      new Date().toISOString(),
    );
    let stderr = "";
    try {
      appendShadowLog(state, rendered.logText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr = `WARNING: cannot write the shadow log: ${message}\n`;
    }
    return { code: rendered.code, stdout: rendered.stdout, stderr };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(`ERROR: ${message}`);
  }
}

/** Run the command against the repo found from the working folder. */
async function execute(command: ExecutableCommand): Promise<Result> {
  const repoRoot = findRepoRoot(process.cwd());
  if (repoRoot === undefined) {
    return failure(
      `ERROR: no ${V1_CONFIG} or ${V2_CONFIG} in this folder or its parents.`,
    );
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
  if (command.kind === "setup") {
    return executeSetup(repoRoot, config.value, os.value, home, state, command);
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
      result = await executeExport(snapshot, command, context, firstBackup);
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
