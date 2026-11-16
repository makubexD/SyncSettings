import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import { join } from "node:path";
import { backupStateFile, runPlan } from "../adapters/fs.ts";
import type { RunContext } from "../adapters/fs.ts";
import {
  pullFastForward,
  readOrigin,
  readTrackedPaths,
  readUpstreamFacts,
} from "../adapters/git.ts";
import {
  firstBackupFiles,
  readBackupSides,
  readStore,
  writeFirstBackup,
  writeStoreProfile,
} from "../adapters/store.ts";
import type { FirstBackupFile } from "../adapters/store.ts";
import { readVisibility } from "../adapters/visibility.ts";
import { askNewSettings } from "../cli/ask.ts";
import type { RunCommand } from "../cli/parse.ts";
import type { ConfigV2, Os } from "../core/config/types.ts";
import { guard, PROFILES_FOLDER } from "../core/guard.ts";
import type { GuardDecision, Visibility } from "../core/guard.ts";
import type { LayerName } from "../core/layers/select.ts";
import { firstBackupWrites, planFirstBackup } from "../core/machine/backup.ts";
import type {
  BackupQuestion,
  BackupSide,
  FirstBackupWrites,
  LocalBackup,
  RepoBackup,
} from "../core/machine/backup.ts";
import { changeLines } from "../core/plan/changes.ts";
import { planExport } from "../core/plan/export.ts";
import {
  changeLineNumbers,
  groupBlock,
  groupedBlock,
  OS_TITLES,
  withoutNewSettings,
} from "../core/plan/groups.ts";
import { applyMove } from "../core/plan/move.ts";
import {
  answersOf,
  newSettingChoices,
  settingGroups,
  settingKey,
  storeDestination,
  suggestionAnswers,
} from "../core/plan/newsettings.ts";
import type {
  NewSettingChoice,
  NewSettingQuestion,
} from "../core/plan/newsettings.ts";
import { profileValueHits, refusedLines } from "../core/plan/profilevalues.ts";
import { renderRun } from "../core/plan/run.ts";
import {
  PULL_FAILED,
  pulledLine,
  upToDateAction,
} from "../core/plan/uptodate.ts";
import type {
  ChangeLine,
  NewSettingLine,
  RunPlan,
  Snapshot,
} from "../core/plan/types.ts";
import { formatLine } from "../core/status.ts";
import type { SetupIo } from "../wizard/setup.ts";
import { askMoves } from "./push.ts";
import type { MoveSession } from "./push.ts";

/** What the front prints and the code it exits with. */
export interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function writeLines(lines: readonly string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** The setup flow's terminal: text to stdout, answers from stdin. */
export interface SetupTerminal {
  readonly io: SetupIo;
  close(): void;
}

/**
 * `setup`'s io: text goes to stdout at once, so a question shows before its
 * answer is read; `readLine` pulls stdin lines on demand, `undefined` at end
 * of input.
 */
export function setupTerminal(): SetupTerminal {
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

/** What running a plan gave back: its printed result and the run's dated
 * backup folder when a copy landed. */
export interface AppliedPlan {
  readonly result: Result;
  readonly backups: string | undefined;
}

/** The guard's decision and the visibility it read. */
export interface ExportGuard {
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
export async function exportGuard(
  repoRoot: string,
  state: string,
  config: ConfigV2,
): Promise<ExportGuard | undefined> {
  const origins = await readOrigin(repoRoot);
  const visibility = await readVisibility(origins, process.env);
  if (visibility === "private") {
    return { decision: { held: [], refused: [] }, visibility };
  }
  const tracked = await readTrackedPaths(repoRoot);
  if (tracked === undefined) {
    return undefined;
  }
  const store = readStore(state, repoRoot, config);
  const localRecords = store.ok ? store.value : { profiles: [] };
  // An unknown visibility fails closed: only a private repo may receive state.
  const guardVisibility = visibility === "unknown" ? "public" : visibility;
  return {
    decision: guard(guardVisibility, tracked, localRecords),
    visibility: guardVisibility,
  };
}

/** Contract "Public-repo guard (program only)": while public, a clone whose
 * tracked files can't be listed stops export: the guard fails closed. */
export const CANNOT_LIST_TRACKED =
  "ERROR: can't list the clone's files, so the public-repo guard can't check them.";

/** What the up-to-date check printed before the run, and whether the run
 * stops: yes pulled (exit 0), or the pull failed (exit 1). */
export interface UpToDateRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly stop: boolean;
}

/**
 * Contract "Up-to-date check": export and import start by checking whether
 * the repo is behind `origin/master`. The question goes out at once, so it
 * shows before its answer is read; an empty answer or end of input pulls, as
 * the bash engine's `read` does. Any other answer goes on without pulling.
 */
export async function ensureUpToDate(repoRoot: string): Promise<UpToDateRun> {
  const terminal =
    process.stdin.isTTY === true && process.stdout.isTTY === true;
  const facts = await readUpstreamFacts(repoRoot);
  const action = upToDateAction({ ...facts, terminal });
  switch (action.kind) {
    case "none":
      return { stdout: "", stderr: "", code: 0, stop: false };
    case "note":
    case "warning":
      return { stdout: `${action.line}\n`, stderr: "", code: 0, stop: false };
    case "ask": {
      const terminalIo = setupTerminal();
      let answer: string | undefined;
      try {
        terminalIo.io.write(action.prompt);
        answer = await terminalIo.io.readLine();
      } finally {
        terminalIo.close();
      }
      const given = answer?.trim() ?? "";
      if (given !== "" && !/^[Yy]/.test(given)) {
        return { stdout: "", stderr: "", code: 0, stop: false };
      }
      const pulled = await pullFastForward(repoRoot);
      if (!pulled.ok) {
        return {
          stdout: "",
          stderr: `${PULL_FAILED}\n`,
          code: 1,
          stop: true,
        };
      }
      return {
        stdout: `${pulledLine(action.behind)}\n`,
        stderr: "",
        code: 0,
        stop: true,
      };
    }
    default: {
      const unhandled: never = action;
      throw new Error(`unhandled up-to-date action: ${String(unhandled)}`);
    }
  }
}

/**
 * Contract "New settings (program only)", Asking: print the block up to the
 * settings and ask each path's question through the terminal `setup` uses.
 * Settings that share a destination key are listed together, and the question
 * comes after the last of them; its answer is the answer for all of them. The
 * head is computed with the suggestion as a provisional answer, since the
 * answered plan isn't known until the questions are through.
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
  const lastOfGroup = new Map<number, readonly number[]>();
  for (const group of settingGroups(settings)) {
    const last = group[group.length - 1];
    if (last !== undefined) {
      lastOfGroup.set(last, group);
    }
  }
  const choices = new Array<NewSettingChoice>(settings.length);
  for (const [index, line] of grouped.settings.entries()) {
    const group = lastOfGroup.get(index);
    if (group === undefined) {
      io.write(`${line}\n`);
      continue;
    }
    const [choice] = await askNewSettings(
      io,
      { settings: [line], indent: grouped.indent },
      question,
    );
    // The question follows the group's last line, and one answer covers the
    // whole group. A terminal with no input falls back to the suggestion.
    for (const member of group) {
      choices[member] = choice ?? question.suggestion;
    }
  }
  return Array.from(choices, (choice) => choice ?? question.suggestion);
}

/** Storing the item answers: the export's result, and the repo profile it
 * wrote when the store is the clone (a pointer), which the export lists and
 * counts as the first backup does. */
interface StoredDestinations {
  readonly result: Result;
  readonly profilePath?: string;
}

/**
 * Contract "New settings (program only)", The answer is stored: an array
 * item's answer also goes into the profile's `destinations`, with its dated
 * backup before the write, at the run's store (contract "Where records are
 * kept"). A new key's answer isn't stored, since the key now has a layer. The
 * write prints no status line, except into the clone: then the export lists
 * the profile it wrote, as the first backup does.
 */
function storeItemDestinations(
  snapshot: Snapshot,
  context: RunContext,
  settings: readonly NewSettingLine[],
  choices: readonly NewSettingChoice[],
  applied: AppliedPlan,
): StoredDestinations {
  const profile = snapshot.profile;
  const result = applied.result;
  if (profile === undefined || result.code !== 0) {
    return { result };
  }
  let updated = profile;
  settings.forEach((setting, index) => {
    const choice = choices[index];
    if (setting.kind === "item" && choice !== undefined) {
      updated = storeDestination(
        updated,
        settingKey(setting),
        choice.layer,
        "item",
      );
    }
  });
  if (updated === profile) {
    return { result };
  }
  const profilePath = `${PROFILES_FOLDER}/${profile.name}.json`;
  const backup = backupStateFile(
    join(context.location.profilesFolder, `${profile.name}.json`),
    profilePath,
    context,
    applied.backups,
  );
  try {
    writeStoreProfile(context.location, updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      result: {
        ...result,
        code: 1,
        stderr: `${result.stderr}ERROR: cannot write the profile ${profile.name}: ${message}\n`,
      },
    };
  }
  const stored =
    backup.warning === undefined
      ? result
      : { ...result, stderr: `${result.stderr}${backup.warning}\n` };
  return context.location.privateFiles
    ? { result: stored }
    : { result: stored, profilePath };
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
 * Print the export's grouped block, unless it holds nothing. Returns whether it
 * printed, so the run that follows can leave it out when the block came first,
 * ahead of the first-backup questions (contract decision 2).
 */
function printBlock(
  io: SetupIo,
  lines: readonly ChangeLine[],
  snapshot: Snapshot,
  settings: readonly NewSettingLine[] = [],
): boolean {
  if (lines.length === 0 && settings.length === 0) {
    return false;
  }
  for (const line of groupBlock(
    lines,
    snapshot.record,
    snapshot.os,
    "push",
    settings,
  )) {
    io.write(`${line}\n`);
  }
  return true;
}

/** The layer a "Move it to?" group names, in the contract's order. */
const MOVE_GROUP_LAYERS: Readonly<Record<1 | 2 | 3 | 4, LayerName>> = {
  1: "base",
  2: "os",
  3: "profile",
  4: "machine",
};

/** The group a change line's layer is in: 1 all machines, 2 this OS, 3 the
 * profile, 4 this machine. */
function moveGroupOf(layer: LayerName): 1 | 2 | 3 | 4 {
  switch (layer) {
    case "base":
      return 1;
    case "os":
      return 2;
    case "profile":
      return 3;
    case "machine":
      return 4;
    default: {
      const unhandled: never = layer;
      throw new Error(`unhandled layer: ${String(unhandled)}`);
    }
  }
}

/** The block's change lines for `plan`, with the answered new settings dropped
 * (they print under `New settings`), and each line's index in `changeLines`,
 * which `applyMove` takes. */
interface ShownChanges {
  readonly lines: readonly ChangeLine[];
  readonly indexes: readonly number[];
}

function shownChanges(
  plan: RunPlan,
  snapshot: Snapshot,
  settings: readonly NewSettingLine[],
): ShownChanges {
  const all = changeLines(plan, snapshot);
  const lines = withoutNewSettings(all, settings);
  return { lines, indexes: lines.map((line) => all.indexOf(line)) };
}

/** One shown change the block numbers `number`: its layer and the index
 * `applyMove` takes. */
interface NumberedChange {
  readonly layer: LayerName;
  readonly index: number;
}

/** The shown change the block numbers `number` (the number the user types,
 * not the input index), or undefined when it prints none. */
function changeForNumber(
  shown: ShownChanges,
  record: { readonly name: string; readonly profile: string },
  os: Os,
  number: number,
): NumberedChange | undefined {
  const at = changeLineNumbers(shown.lines, record, os).indexOf(number);
  const line = at === -1 ? undefined : shown.lines[at];
  const index = at === -1 ? undefined : shown.indexes[at];
  if (line === undefined || index === undefined || index < 0) {
    return undefined;
  }
  return { layer: line.layer, index };
}

/** The plan the "Move a change" questions left, or the move's error. */
type MoveRun =
  | { readonly ok: true; readonly plan: RunPlan }
  | { readonly ok: false; readonly error: string };

/**
 * Contract "Move a change": ask "Move a change?" over the plan's block, from
 * the terminal the export asks its other questions on. The caller has already
 * printed the block. A move replaces the plan and prints the block again; an
 * empty answer or the end of the input goes on, and a move's error ends the
 * export.
 */
async function askMoveQuestions(
  plan: RunPlan,
  snapshot: Snapshot,
  settings: readonly NewSettingLine[],
  io: SetupIo,
): Promise<MoveRun> {
  const record = snapshot.record;
  if (record === undefined) {
    return { ok: true, plan };
  }
  let current = plan;
  const shown = (): ShownChanges => shownChanges(current, snapshot, settings);
  if (shown().lines.length === 0) {
    return { ok: true, plan };
  }
  const session: MoveSession = {
    get lineCount() {
      return shown().lines.length;
    },
    groupOf: (number) => {
      const change = changeForNumber(shown(), record, snapshot.os, number);
      if (change === undefined) {
        throw new Error(`no change on line ${number}`);
      }
      return moveGroupOf(change.layer);
    },
    targets: `1) all machines  2) ${OS_TITLES[snapshot.os]} machines  3) profile ${record.profile}  4) this machine`,
    move: (number, group) => {
      const change = changeForNumber(shown(), record, snapshot.os, number);
      if (change === undefined) {
        return { ok: false, error: `no change on line ${number}` };
      }
      const moved = applyMove(
        current,
        snapshot,
        change.index + 1,
        MOVE_GROUP_LAYERS[group],
      );
      if (!moved.ok) {
        return moved;
      }
      current = moved.value;
      return {
        ok: true,
        value: writeLines(
          groupBlock(shown().lines, record, snapshot.os, "push", settings),
        ),
      };
    },
  };
  const result = await askMoves(
    session,
    () => io.readLine(),
    (text) => io.write(text),
  );
  return result.ok
    ? { ok: true, plan: current }
    : { ok: false, error: result.error };
}

/**
 * Run an export plan and print its grouped block before its status lines. The
 * answered new settings are listed under `New settings` and never repeated in
 * their layer's group. A profile value bound for a shared layer stops the run
 * before anything is written, with the refused lines after the block. With
 * `blockPrinted`, the caller already printed the block, ahead of the
 * first-backup questions.
 */
function runExport(
  plan: RunPlan,
  snapshot: Snapshot,
  context: RunContext,
  settings: readonly NewSettingLine[] = [],
  choices: readonly NewSettingChoice[] = [],
  backup?: FirstBackupRun,
  answers?: ReadonlyMap<string, BackupSide>,
  blockPrinted = false,
): ExportRun {
  const lines = withoutNewSettings(changeLines(plan, snapshot), settings);
  const refused = exportRefusal(plan, snapshot, lines);
  if (refused !== undefined) {
    const block =
      blockPrinted || (lines.length === 0 && settings.length === 0)
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
  if (blockPrinted || (lines.length === 0 && settings.length === 0)) {
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
export interface FirstBackupRun {
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

/** A file the export wrote (or will write) that gets a status line and a count. */
interface WrittenFile {
  readonly path: string;
  readonly status: "ADDED" | "MODIFIED";
}

/**
 * Contract "The first backup": the backup's status lines come after the
 * entries and count towards the export's total, so they are planned into the
 * run. The backup's own actions are empty: the files are written after the
 * export, by `finishFirstBackup`. A layer file the export wrote to the store
 * already has its status line from that write; the backup copies it to the
 * repo without printing its path twice. The profile a pointer export writes
 * into the clone joins them the same way (contract "The answer is stored").
 */
function withWrittenFiles(
  plan: RunPlan,
  files: readonly WrittenFile[],
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
  let code = stored.result.code;
  let stderr = stored.result.stderr;
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
  const written: WrittenFile[] = [
    ...(stored.profilePath === undefined
      ? []
      : [{ path: stored.profilePath, status: "MODIFIED" as const }]),
    ...(prepared?.files ?? []),
  ];
  const planned = withWrittenFiles(plan, written);
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
 *
 * With `moves`, the push also asks "Move a change" after the block and the new
 * setting questions, before the profile-value rule and the guard (contract
 * "Move a change"). `shared` is the push's terminal, so the answers it leaves
 * for the PR question aren't lost when this run's reader closes.
 */
export async function executeExport(
  snapshot: Snapshot,
  command: RunCommand,
  context: RunContext,
  backup?: FirstBackupRun,
  moves = false,
  shared?: SetupTerminal,
): Promise<Result> {
  // One terminal for every question this export asks, so answers read for the
  // new settings stay available to the first backup's questions. The push
  // passes its own, so the answers left for its PR question aren't lost when a
  // reader closes.
  const terminal = shared ?? setupTerminal();
  try {
    const planned = planExport(snapshot);
    const settings = planned.newSettings ?? [];
    const question = newSettingChoices(snapshot.record, snapshot.os);
    if (question === undefined || settings.length === 0) {
      const plannedLines = withoutNewSettings(
        changeLines(planned, snapshot),
        settings,
      );
      let plan = planned;
      let blockPrinted = false;
      // The moves run before the profile-value rule, so a change moved to a
      // group that may hold the value is judged in its new group (contract
      // "Move a change").
      if (moves && !command.yes && snapshot.record !== undefined) {
        if (plannedLines.length > 0) {
          blockPrinted = printBlock(terminal.io, plannedLines, snapshot);
          const loop = await askMoveQuestions(
            plan,
            snapshot,
            settings,
            terminal.io,
          );
          if (!loop.ok) {
            return { code: 1, stdout: "", stderr: `${loop.error}\n` };
          }
          plan = loop.plan;
        }
      }
      // A refused export writes nothing, so its questions are not asked.
      const lines = withoutNewSettings(changeLines(plan, snapshot), settings);
      const refused = exportRefusal(plan, snapshot, lines);
      let answers: ReadonlyMap<string, BackupSide> | undefined;
      if (refused === undefined && backup !== undefined) {
        // The block comes before the first-backup questions (decision 2).
        if (!blockPrinted) {
          blockPrinted = printBlock(terminal.io, lines, snapshot);
        }
        answers = await askFirstBackup(backup, terminal.io);
      }
      const applied = runExport(
        plan,
        snapshot,
        context,
        [],
        [],
        backup,
        answers,
        blockPrinted,
      );
      return finishFirstBackup(backup, applied.prepared, applied.result);
    }

    if (command.yes) {
      const choices = settings.map(() => question.suggestion);
      const plan = planExport(snapshot, answersOf(settings, choices));
      const lines = withoutNewSettings(changeLines(plan, snapshot), settings);
      const refused = exportRefusal(plan, snapshot, lines);
      let blockPrinted = false;
      let answers: ReadonlyMap<string, BackupSide> | undefined;
      if (refused === undefined && backup !== undefined) {
        // The block comes before the first-backup questions (decision 2).
        blockPrinted = printBlock(terminal.io, lines, snapshot, settings);
        answers = await askFirstBackup(backup, terminal.io);
      }
      const applied = runExport(
        plan,
        snapshot,
        context,
        settings,
        choices,
        backup,
        answers,
        blockPrinted,
      );
      return finishFirstBackup(backup, applied.prepared, applied.result);
    }

    const choices = await askSettings(
      snapshot,
      settings,
      question,
      terminal.io,
    );
    let plan = planExport(snapshot, answersOf(settings, choices));
    // The block and the new-setting questions are already on the terminal, so
    // the moves ask next, before the profile-value rule (contract "Move a
    // change").
    if (moves && snapshot.record !== undefined) {
      const loop = await askMoveQuestions(plan, snapshot, settings, terminal.io);
      if (!loop.ok) {
        return { code: 1, stdout: "", stderr: `${loop.error}\n` };
      }
      plan = loop.plan;
    }
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
    if (shared === undefined) {
      terminal.close();
    }
  }
}
