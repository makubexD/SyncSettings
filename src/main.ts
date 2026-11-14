import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { appendShadowLog, engineShadow } from "./adapters/engine.ts";
import type { EngineHost } from "./adapters/engine.ts";
import { backupStateFile, runPlan } from "./adapters/fs.ts";
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
  renderStatusline,
  STATUSLINE_UNAVAILABLE,
} from "./adapters/statusline.ts";
import {
  firstBackupFiles,
  readBackupSides,
  readRepoStore,
  readStore,
  readText,
  writeFirstBackup,
  writeProfile,
  writeRecord,
  writeStoreProfile,
  writeStoreRecord,
} from "./adapters/store.ts";
import type { BackupSides, FirstBackupFile } from "./adapters/store.ts";
import { readVisibility } from "./adapters/visibility.ts";
import { askNewSettings } from "./cli/ask.ts";
import { parseArgs, USAGE } from "./cli/parse.ts";
import type {
  MachineShowCommand,
  RetireCommand,
  RunCommand,
  SetupCommand,
  ShadowCommand,
  StatuslineCommand,
} from "./cli/parse.ts";
import type { Profile } from "./core/config/profile.ts";
import type { ConfigV2, Os } from "./core/config/types.ts";
import { guard, PROFILES_FOLDER } from "./core/guard.ts";
import type { GuardDecision, Visibility } from "./core/guard.ts";
import { pickOs } from "./core/layers/select.ts";
import type { LayerName } from "./core/layers/select.ts";
import { firstBackupWrites, planFirstBackup } from "./core/machine/backup.ts";
import type {
  BackupQuestion,
  BackupSide,
  FirstBackupWrites,
  LocalBackup,
  RepoBackup,
} from "./core/machine/backup.ts";
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
import { changeLines } from "./core/plan/changes.ts";
import { planExport } from "./core/plan/export.ts";
import {
  groupBlock,
  groupedBlock,
  withoutNewSettings,
} from "./core/plan/groups.ts";
import { planImport } from "./core/plan/import.ts";
import {
  newSettingChoices,
  storeDestination,
} from "./core/plan/newsettings.ts";
import type {
  NewSettingChoice,
  NewSettingQuestion,
} from "./core/plan/newsettings.ts";
import { planPreview } from "./core/plan/preview.ts";
import { profileValueHits, refusedLines } from "./core/plan/profilevalues.ts";
import { renderRun } from "./core/plan/run.ts";
import type {
  ChangeLine,
  NewSettingLine,
  Plan,
  RunPlan,
  Snapshot,
} from "./core/plan/types.ts";
import { compareShadow, programShadow, renderShadow } from "./core/shadow.ts";
import { formatLine } from "./core/status.ts";
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

/** A clone's git folder, or the file a worktree has in its place. */
const GIT_DIR = ".git";

/**
 * The paths the clone tracks, from `git ls-files`, for the public-repo guard.
 * A folder with no `.git` isn't a clone and tracks nothing. In a clone,
 * `undefined` when git can't list them (it fails or can't start), so the
 * guard fails closed rather than seeing an empty clone.
 */
async function readTrackedPaths(
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

type Resolved =
  | Result
  | RunCommand
  | ShadowCommand
  | MachineShowCommand
  | RetireCommand
  | SetupCommand
  | StatuslineCommand;

type ExecutableCommand =
  | RunCommand
  | ShadowCommand
  | MachineShowCommand
  | RetireCommand
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

/** What running a plan gave back: its printed result and the run's dated
 * backup folder when a copy landed. */
interface AppliedPlan {
  readonly result: Result;
  readonly backups: string | undefined;
}

/** Apply a plan's steps and render what the run printed, keeping the run's
 * dated backup folder. */
function applyPlanAndBackup(plan: RunPlan, context: RunContext): AppliedPlan {
  const outcome = runPlan(plan, context);
  const rendered = renderRun(plan, outcome);
  return {
    result: {
      code: rendered.code,
      stdout: writeLines(rendered.lines),
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

/** The guard's decision and the visibility it read. */
interface ExportGuard {
  readonly decision: GuardDecision;
  readonly visibility: Visibility;
}

/**
 * Decision 10: the public-repo guard's decision for an export. A private repo
 * holds and refuses nothing and needs no listing; while public, the local store
 * names the held files and `git ls-files` names the refused paths.
 * `undefined` means a public repo whose tracked files can't be listed, so the
 * guard can't check them.
 */
async function exportGuard(
  repoRoot: string,
  state: string,
  config: ConfigV2,
): Promise<ExportGuard | undefined> {
  const origin = await readOrigin(repoRoot);
  const visibility = await readVisibility(origin, process.env);
  if (visibility === "private") {
    return { decision: { held: [], refused: [] }, visibility };
  }
  const tracked = await readTrackedPaths(repoRoot);
  if (tracked === undefined) {
    return undefined;
  }
  const store = readStore(state, repoRoot, config);
  const localRecords = store.ok ? store.value : { profiles: [] };
  return { decision: guard(visibility, tracked, localRecords), visibility };
}

/** Contract "Public-repo guard (program only)": while public, a clone whose
 * tracked files can't be listed stops export: the guard fails closed. */
const CANNOT_LIST_TRACKED =
  "ERROR: can't list the clone's files, so the public-repo guard can't check them.";

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
  const origin = await readOrigin(repoRoot);
  const isPrivate = (await readVisibility(origin, process.env)) === "private";
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

/** The answers a list of choices gives, key path to layer slot. */
function answersOf(
  settings: readonly NewSettingLine[],
  choices: readonly NewSettingChoice[],
): ReadonlyMap<string, LayerName> {
  const answers = new Map<string, LayerName>();
  settings.forEach((setting, index) => {
    const choice = choices[index];
    if (choice !== undefined) {
      answers.set(setting.path, choice.layer);
    }
  });
  return answers;
}

/** Every new setting taking the suggestion, which is what `--yes` answers. */
function suggestionAnswers(
  settings: readonly NewSettingLine[],
  question: NewSettingQuestion,
): ReadonlyMap<string, LayerName> {
  return answersOf(
    settings,
    settings.map(() => question.suggestion),
  );
}

/**
 * Contract "New settings (program only)", Asking: print the block up to the
 * settings and ask each one through the terminal `setup` uses. The head is
 * computed with the suggestion as a provisional answer, since the answered
 * plan isn't known until the questions are through.
 */
async function askSettings(
  snapshot: Snapshot,
  settings: readonly NewSettingLine[],
  question: NewSettingQuestion,
  io: SetupIo,
): Promise<readonly NewSettingChoice[]> {
  const tentative = planExport(snapshot, suggestionAnswers(settings, question));
  const grouped = groupedBlock(
    withoutNewSettings(changeLines(tentative, snapshot), settings),
    snapshot.record,
    snapshot.os,
    "push",
    settings,
  );
  for (const line of grouped.head) {
    io.write(`${line}\n`);
  }
  return await askNewSettings(io, grouped, question);
}

/**
 * Contract "New settings (program only)", The answer is stored: an array
 * item's answer also goes into the profile's `destinations`, with its dated
 * backup before the write. A new key's answer isn't stored, since the key now
 * has a layer. The write prints no status line.
 */
function storeItemDestinations(
  snapshot: Snapshot,
  context: RunContext,
  settings: readonly NewSettingLine[],
  choices: readonly NewSettingChoice[],
  applied: AppliedPlan,
): Result {
  const profile = snapshot.profile;
  const result = applied.result;
  if (profile === undefined || result.code !== 0) {
    return result;
  }
  let updated = profile;
  settings.forEach((setting, index) => {
    const choice = choices[index];
    if (setting.kind === "item" && choice !== undefined) {
      updated = storeDestination(updated, setting.path, choice.layer, "item");
    }
  });
  if (updated === profile) {
    return result;
  }
  const backup = backupStateFile(
    join(context.stateFolder, PROFILES_FOLDER, `${profile.name}.json`),
    `${PROFILES_FOLDER}/${profile.name}.json`,
    context,
    applied.backups,
  );
  try {
    writeProfile(context.stateFolder, updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...result,
      code: 1,
      stderr: `${result.stderr}ERROR: cannot write the profile ${profile.name}: ${message}\n`,
    };
  }
  return backup.warning === undefined
    ? result
    : { ...result, stderr: `${result.stderr}${backup.warning}\n` };
}

/**
 * Contract "Profile values (program only)": the refused lines a final export
 * plan would print after its block, or undefined when no layer text bound for
 * a shared layer holds a profile value. `lines` is the change line list the
 * block is built from.
 */
function exportRefusal(
  plan: RunPlan,
  snapshot: Snapshot,
  lines: readonly ChangeLine[],
): readonly string[] | undefined {
  const hits = profileValueHits(plan, snapshot, lines);
  const profileName = snapshot.record?.profile ?? snapshot.profile?.name;
  if (hits.length === 0 || profileName === undefined) {
    return undefined;
  }
  return refusedLines(hits, profileName, snapshot.os);
}

/**
 * Run an export plan and print its grouped block before its status lines. The
 * answered new settings are listed under `New settings` and never repeated in
 * their layer's group. A profile value bound for a shared layer stops the run
 * before anything is written, with the refused lines after the block.
 */
function runExport(
  plan: RunPlan,
  snapshot: Snapshot,
  context: RunContext,
  settings: readonly NewSettingLine[] = [],
  choices: readonly NewSettingChoice[] = [],
  backup?: FirstBackupRun,
  answers?: ReadonlyMap<string, BackupSide>,
): ExportRun {
  const lines = withoutNewSettings(changeLines(plan, snapshot), settings);
  const refused = exportRefusal(plan, snapshot, lines);
  if (refused !== undefined) {
    const block =
      lines.length === 0 && settings.length === 0
        ? []
        : groupBlock(lines, snapshot.record, snapshot.os, "push", settings);
    return {
      result: {
        code: 1,
        stdout: writeLines(block) + writeLines(refused),
        stderr: "",
      },
      prepared: undefined,
      backups: undefined,
    };
  }
  const applied = applyExportPlan(
    plan,
    snapshot,
    context,
    settings,
    choices,
    backup,
    answers,
  );
  if (lines.length === 0 && settings.length === 0) {
    return applied;
  }
  return {
    ...applied,
    result: {
      ...applied.result,
      stdout:
        writeLines(
          groupBlock(lines, snapshot.record, snapshot.os, "push", settings),
        ) + applied.result.stdout,
    },
  };
}

/** What a first backup needs at export time: both sides and whether to ask. */
interface FirstBackupRun {
  readonly stateFolder: string;
  readonly repoRoot: string;
  readonly config: ConfigV2;
  readonly local: LocalBackup;
  readonly repo: RepoBackup;
  readonly yes: boolean;
}

/** The first backup's writes and the files whose status lines it prints. */
interface FirstBackupPrepared {
  readonly files: readonly FirstBackupFile[];
  readonly writes: FirstBackupWrites;
}

/** An export run and the first backup it planned after its own writes. */
interface ExportRun {
  readonly result: Result;
  readonly prepared: FirstBackupPrepared | undefined;
  readonly backups: string | undefined;
}

/** Contract "The first backup": the question with both sides shown, one space
 * after it and no newline. */
const KEEP_WHICH = "Keep which? 1) the repo's  2) this machine's [1] ";

const BACKUP_PICK_ONE = "Pick 1 to 2.\n";

const REPO_SIDE = "repo";

const MACHINE_SIDE = "machine";

/**
 * Contract "The first backup": ask each differing value or destination in key
 * order, showing the repo's side first. Answers are read as `setup` reads them:
 * an empty answer or end of input keeps the first choice (the repo's), a bad
 * answer prints `Pick 1 to 2.` and asks again.
 */
async function askBackupQuestions(
  io: SetupIo,
  questions: readonly BackupQuestion[],
): Promise<ReadonlyMap<string, BackupSide>> {
  const answers = new Map<string, BackupSide>();
  for (const question of questions) {
    io.write(`${question.key} differs on profile ${question.profile}:\n`);
    io.write(`  repo:         ${question.repo}\n`);
    io.write(`  this machine: ${question.machine}\n`);
    for (;;) {
      io.write(KEEP_WHICH);
      const answer = (await io.readLine())?.trim() ?? "";
      if (answer === "" || answer === "1") {
        answers.set(`${question.kind}:${question.key}`, REPO_SIDE);
        break;
      }
      if (answer === "2") {
        answers.set(`${question.kind}:${question.key}`, MACHINE_SIDE);
        break;
      }
      io.write(BACKUP_PICK_ONE);
    }
  }
  return answers;
}

/** Ask the first backup's questions from the sides read before the export.
 * The backup's files are planned later, from what the export writes. */
async function askFirstBackup(
  run: FirstBackupRun,
  io: SetupIo,
): Promise<ReadonlyMap<string, BackupSide>> {
  const plan = planFirstBackup(run.local, run.repo);
  return run.yes
    ? new Map<string, BackupSide>()
    : await askBackupQuestions(io, plan.questions);
}

/**
 * Contract "The first backup": the backup's status lines come after the
 * entries and count towards the export's total, so they are planned into the
 * run. The backup's own actions are empty: the files are written after the
 * export, by `finishFirstBackup`. A layer file the export wrote to the state
 * folder already has its status line from that write; the backup copies it to
 * the repo without printing its path twice.
 */
function withFirstBackup(
  plan: RunPlan,
  files: readonly FirstBackupFile[],
): RunPlan {
  if (files.length === 0) {
    return plan;
  }
  const lines = [...plan.lines];
  const steps = [...plan.steps];
  const labelled = new Set(steps.map((step) => step.label));
  for (const file of files) {
    if (labelled.has(file.path)) {
      continue;
    }
    lines.push(formatLine(file.status, file.path));
    steps.push({
      label: file.path,
      line: lines.length - 1,
      counted: true,
      actions: [],
    });
  }
  return { ...plan, lines, steps };
}

/**
 * Write the first backup into the repo, then make the record the pointer. A
 * failed write leaves `machine.json` as it was and exits 1 with the contract's
 * line. A refused or failed export writes nothing.
 */
function finishFirstBackup(
  run: FirstBackupRun | undefined,
  prepared: FirstBackupPrepared | undefined,
  result: Result,
): Result {
  if (run === undefined || prepared === undefined || result.code !== 0) {
    return result;
  }
  const written = writeFirstBackup(
    run.stateFolder,
    run.repoRoot,
    run.local.record.name,
    prepared.files,
  );
  if (written.ok) {
    return result;
  }
  return {
    ...result,
    code: 1,
    stderr: `${result.stderr}${written.error.message}\n`,
  };
}

/**
 * Contract "The first backup": run the export's steps, store the item answers
 * in the profile, then read both sides again. The export has just written the
 * layer files and destinations the backup must carry, so its files are
 * planned from that read, and its status lines and count come from them.
 * Nothing is written for the backup here; `finishFirstBackup` writes it.
 */
function applyExportPlan(
  plan: RunPlan,
  snapshot: Snapshot,
  context: RunContext,
  settings: readonly NewSettingLine[],
  choices: readonly NewSettingChoice[],
  backup: FirstBackupRun | undefined,
  answers: ReadonlyMap<string, BackupSide> | undefined,
): ExportRun {
  const outcome = runPlan(plan, context);
  // A failed write fails the export: nothing more is stored or backed up.
  const runCode = renderRun(plan, outcome).code;
  const stored = storeItemDestinations(snapshot, context, settings, choices, {
    result: { code: runCode, stdout: "", stderr: "" },
    backups: outcome.backups,
  });
  let prepared: FirstBackupPrepared | undefined;
  let code = stored.code;
  let stderr = stored.stderr;
  if (backup !== undefined && answers !== undefined && code === 0) {
    const sides = readBackupSides(
      backup.stateFolder,
      backup.repoRoot,
      backup.config,
    );
    if (!sides.ok) {
      code = sides.error.code;
      stderr = `${stderr}${sides.error.message}\n`;
    } else if (sides.value !== undefined) {
      const writes = firstBackupWrites(
        sides.value.local,
        sides.value.repo,
        answers,
      );
      prepared = {
        files: firstBackupFiles(backup.repoRoot, writes),
        writes,
      };
    }
  }
  const planned =
    prepared === undefined ? plan : withFirstBackup(plan, prepared.files);
  const rendered = renderRun(planned, outcome);
  return {
    result: { code, stdout: writeLines(rendered.lines), stderr },
    prepared,
    backups: outcome.backups,
  };
}

/**
 * The push side with a record: ask where each new setting goes, plan with the
 * answers, run, then store an array item's answer in the profile (contract
 * "New settings (program only)"). Without a record, or with no new setting,
 * the export is the plan as it stands.
 */
async function executeExport(
  snapshot: Snapshot,
  command: RunCommand,
  context: RunContext,
  backup?: FirstBackupRun,
): Promise<Result> {
  // One terminal for every question this export asks, so answers read for the
  // new settings stay available to the first backup's questions.
  const terminal = setupTerminal();
  try {
    const planned = planExport(snapshot);
    const settings = planned.newSettings ?? [];
    const question = newSettingChoices(snapshot.record, snapshot.os);
    if (question === undefined || settings.length === 0) {
      // A refused export writes nothing, so its questions are not asked.
      const refused = exportRefusal(
        planned,
        snapshot,
        withoutNewSettings(changeLines(planned, snapshot), settings),
      );
      const answers =
        refused !== undefined || backup === undefined
          ? undefined
          : await askFirstBackup(backup, terminal.io);
      const applied = runExport(
        planned,
        snapshot,
        context,
        [],
        [],
        backup,
        answers,
      );
      return finishFirstBackup(backup, applied.prepared, applied.result);
    }

    if (command.yes) {
      const choices = settings.map(() => question.suggestion);
      const plan = planExport(snapshot, answersOf(settings, choices));
      const refused = exportRefusal(
        plan,
        snapshot,
        withoutNewSettings(changeLines(plan, snapshot), settings),
      );
      const answers =
        refused !== undefined || backup === undefined
          ? undefined
          : await askFirstBackup(backup, terminal.io);
      const applied = runExport(
        plan,
        snapshot,
        context,
        settings,
        choices,
        backup,
        answers,
      );
      return finishFirstBackup(backup, applied.prepared, applied.result);
    }

    const choices = await askSettings(
      snapshot,
      settings,
      question,
      terminal.io,
    );
    const plan = planExport(snapshot, answersOf(settings, choices));
    // The head and the questions are already on the terminal, so only the blank
    // line that ends the last question and the refused lines follow.
    const refused = exportRefusal(
      plan,
      snapshot,
      withoutNewSettings(changeLines(plan, snapshot), settings),
    );
    if (refused !== undefined) {
      return { code: 1, stdout: writeLines(["", ...refused]), stderr: "" };
    }
    const answers =
      backup === undefined
        ? undefined
        : await askFirstBackup(backup, terminal.io);
    const applied = applyExportPlan(
      plan,
      snapshot,
      context,
      settings,
      choices,
      backup,
      answers,
    );
    return finishFirstBackup(backup, applied.prepared, applied.result);
  } finally {
    terminal.close();
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
  let exportGuardResult: ExportGuard | undefined;
  if (command.command === "export") {
    exportGuardResult = await exportGuard(repoRoot, state, config.value);
    if (exportGuardResult === undefined) {
      return failure(CANNOT_LIST_TRACKED);
    }
  }
  if (
    exportGuardResult !== undefined &&
    !command.preview &&
    exportGuardResult.decision.refused.length > 0
  ) {
    return failure(refusedText(exportGuardResult.decision.refused));
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
      return failure(sides.error.message, sides.error.code);
    }
    backupSides = sides.value;
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
