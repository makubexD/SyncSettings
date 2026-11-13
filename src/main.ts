import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { appendShadowLog, engineShadow } from "./adapters/engine.ts";
import type { EngineHost } from "./adapters/engine.ts";
import { runPlan } from "./adapters/fs.ts";
import type { RunContext } from "./adapters/fs.ts";
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
  readRepoStore,
  readStore,
  readText,
  writeProfile,
  writeRecord,
} from "./adapters/store.ts";
import { readVisibility } from "./adapters/visibility.ts";
import { parseArgs, USAGE } from "./cli/parse.ts";
import type {
  MachineShowCommand,
  RetireCommand,
  RunCommand,
  SetupCommand,
  ShadowCommand,
} from "./cli/parse.ts";
import type { Profile } from "./core/config/profile.ts";
import type { ConfigV2, Os } from "./core/config/types.ts";
import { guard, PROFILES_FOLDER } from "./core/guard.ts";
import type { GuardDecision } from "./core/guard.ts";
import { pickOs } from "./core/layers/select.ts";
import { checkRecord } from "./core/machine/check.ts";
import type { CheckMode } from "./core/machine/check.ts";
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
import { planExport } from "./core/plan/export.ts";
import { planImport } from "./core/plan/import.ts";
import { planPreview } from "./core/plan/preview.ts";
import { renderRun } from "./core/plan/run.ts";
import type { Plan, RunPlan } from "./core/plan/types.ts";
import { compareShadow, programShadow, renderShadow } from "./core/shadow.ts";
import { parseValuesFile } from "./core/values/file.ts";
import type { Values } from "./core/values/sanitize.ts";
import type { SetupFlags, SetupIo } from "./wizard/setup.ts";
import { runSetup } from "./wizard/setup.ts";

export { USAGE };

/** What the front prints and the code it exits with. */
export interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

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

function writeLines(lines: readonly string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** Run one git command in the repo root, its stdout as text and exit code. */
async function runGitText(
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

/** The origin remote's push URL, where a push would go, or `undefined` when
 * there is none. */
async function readOrigin(repoRoot: string): Promise<string | undefined> {
  const output = await runGitText(repoRoot, [
    "remote",
    "get-url",
    "--push",
    "origin",
  ]);
  if (output === undefined || output.code !== 0) {
    return undefined;
  }
  const origin = output.stdout.trim();
  return origin === "" ? undefined : origin;
}

/** The paths the clone tracks, from `git ls-files`, for the public-repo guard. */
async function readTrackedPaths(repoRoot: string): Promise<readonly string[]> {
  const output = await runGitText(repoRoot, ["ls-files", "-z"]);
  if (output === undefined || output.code !== 0) {
    return [];
  }
  return output.stdout.split("\u0000").filter((path) => path !== "");
}

type Resolved =
  | Result
  | RunCommand
  | ShadowCommand
  | MachineShowCommand
  | RetireCommand
  | SetupCommand;

type ExecutableCommand =
  | RunCommand
  | ShadowCommand
  | MachineShowCommand
  | RetireCommand
  | SetupCommand;

function isResolvedCommand(value: Resolved): value is ExecutableCommand {
  return "kind" in value;
}

/** The contract's no-record line, and exit 1. */
const NO_RECORD = "ERROR: no machine record here; run mksync setup.";

/**
 * Read the import's prompt answers as a list, which is what `planImport`
 * takes. End of input counts as yes, so no answers means every file applies.
 */
async function readAnswers(command: RunCommand): Promise<readonly string[]> {
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
  return {
    code: rendered.code,
    stdout: writeLines(rendered.lines),
    stderr: "",
  };
}

const VALUES_FILE = ".user-values.json";

/** The setup flow's terminal: text to stdout, answers from stdin. */
interface SetupTerminal {
  readonly io: SetupIo;
  close(): void;
}

/**
 * `setup`'s io: text goes to stdout at once, so a question shows before its
 * answer is read; `readLine` pulls stdin lines on demand, `undefined` at end
 * of input.
 */
function setupTerminal(): SetupTerminal {
  let reader: Interface | undefined;
  const queued: string[] = [];
  const waiting: ((line: string | undefined) => void)[] = [];
  let ended = false;
  const push = (line: string): void => {
    const resolve = waiting.shift();
    if (resolve === undefined) {
      queued.push(line);
    } else {
      resolve(line);
    }
  };
  const end = (): void => {
    ended = true;
    for (const resolve of waiting.splice(0)) {
      resolve(undefined);
    }
  };
  return {
    io: {
      write: (text) => {
        process.stdout.write(text);
      },
      readLine: async () => {
        if (reader === undefined) {
          reader = createInterface({ input: process.stdin });
          reader.on("line", push);
          reader.on("close", end);
        }
        const line = queued.shift();
        if (line !== undefined) {
          return line;
        }
        if (ended) {
          return undefined;
        }
        return new Promise((resolve) => {
          waiting.push(resolve);
        });
      },
    },
    close: () => {
      reader?.close();
    },
  };
}

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

/**
 * Decision 10: the public-repo guard's decision for an export. A private repo
 * holds and refuses nothing; while public, the local store names the held files
 * and `git ls-files` names the refused paths.
 */
async function exportGuard(
  repoRoot: string,
  state: string,
  config: ConfigV2,
): Promise<GuardDecision> {
  const origin = await readOrigin(repoRoot);
  const visibility = await readVisibility(origin, process.env);
  if (visibility === "private") {
    return { held: [], refused: [] };
  }
  const store = readStore(state, repoRoot, config);
  const localRecords = store.ok ? store.value : { profiles: [] };
  return guard(visibility, await readTrackedPaths(repoRoot), localRecords);
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
  if (!store.ok) {
    return failure(store.error.message, store.error.code);
  }
  const origin = await readOrigin(repoRoot);
  const isPrivate = (await readVisibility(origin, process.env)) === "private";
  const repoStore = isPrivate ? readRepoStore(repoRoot, config) : undefined;
  if (repoStore !== undefined && !repoStore.ok) {
    return failure(repoStore.error.message, repoStore.error.code);
  }
  const profiles = repoStore?.value.profiles ?? store.value.profiles;
  const records = new Map<string, MachineRecord>();
  if (store.value.record !== undefined) {
    records.set(store.value.record.name, store.value.record);
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
      ...(store.value.record !== undefined ? { own: store.value.record } : {}),
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
  const answers = await valueAnswers(values, command, terminal.io);
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
 * own record when it has one.
 */
async function executeRetire(
  repoRoot: string,
  config: ConfigV2,
  state: string,
  command: RetireCommand,
): Promise<Result> {
  const store = readStore(state, repoRoot, config);
  if (!store.ok) {
    return failure(store.error.message, store.error.code);
  }
  if (command.kind === "machine-retire") {
    return askRetire(
      command,
      machineRetireQuestion(command.target),
      retireMachine(store.value.record, command.target),
      (record) => {
        writeRecord(state, record);
      },
    );
  }
  const records = store.value.record === undefined ? [] : [store.value.record];
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
      writeProfile(state, profile);
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
      state,
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

  const check =
    layers.value.record === undefined
      ? undefined
      : checkRecord(
          layers.value.record,
          readIdentity(process.env, os.value),
          checkMode(command),
        );
  if (check !== undefined && check.stop) {
    return { code: 1, stdout: "", stderr: writeLines(check.lines) };
  }

  // The record checks run first, then the public-repo guard's (contract
  // "Public-repo guard (program only)").
  const guardDecision =
    command.command === "export"
      ? await exportGuard(repoRoot, state, config.value)
      : undefined;
  if (
    guardDecision !== undefined &&
    !command.preview &&
    guardDecision.refused.length > 0
  ) {
    return failure(refusedText(guardDecision.refused));
  }

  const answers = await readAnswers(command);
  const snapshot = await buildSnapshot(
    repoRoot,
    config.value,
    os.value,
    home,
    command,
    process.cwd(),
    process.env,
    state,
    layers.value,
  );
  const context: RunContext = {
    repoRoot,
    os: os.value,
    stateFolder: state,
    now: () => new Date(),
    pid: process.pid,
  };

  let result: Result;
  if (command.command === "export") {
    result = command.preview
      ? renderStatic(
          planPreview(
            snapshot,
            previewWorkingTree(repoRoot, snapshot.repoFiles),
          ),
        )
      : applyPlan(planExport(snapshot), context);
    if (
      command.preview &&
      result.code === 0 &&
      guardDecision !== undefined &&
      guardDecision.held.length > 0
    ) {
      result = {
        ...result,
        stdout: result.stdout + heldText(guardDecision.held),
      };
    }
  } else {
    result = command.check
      ? renderStatic(planCheck(snapshot))
      : applyPlan(planImport(snapshot, answers), context);
  }
  if (check === undefined || check.lines.length === 0) {
    return result;
  }
  return { ...result, stderr: writeLines(check.lines) + result.stderr };
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
    case "machine-show":
      return parsed;
    case "setup":
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
