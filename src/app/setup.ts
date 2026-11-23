/**
 * `mksync setup` (contract "First run"): run the doctor, read the store and the
 * scan, run the flow (the bootstrap question and the confirm included), move
 * `.user-values.json`, write the record and profile, run the Ubuntu bootstrap
 * when chosen, then act on the fourth answer (decision 9). The export and
 * import the flow ends with run through the caller's `execute`, so this module
 * never imports `main.ts`.
 */

import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { join } from "node:path";
import { SymlinkRefusal } from "../adapters/atomic.ts";
import { readOrigin, readSyncPoint } from "../adapters/git.ts";
import { readOsId } from "../adapters/osname.ts";
import { run } from "../adapters/process.ts";
import { readScan } from "../adapters/scan.ts";
import { loadLayers } from "../adapters/snapshot.ts";
import type { Layers } from "../adapters/snapshot.ts";
import {
  readLinkedFolders,
  readRepoStore,
  readStore,
  readText,
  writeProfile,
  writeRecord,
  stateLocation,
} from "../adapters/store.ts";
import { readVisibility } from "../adapters/visibility.ts";
import { executeDoctor } from "./doctor.ts";
import { failure, setupTerminal } from "./export.ts";
import { blockedLines, diffCounts } from "./guard.ts";
import { isInstalledProgram } from "./update.ts";
import type { ExecuteOptions, Result, SetupTerminal } from "./export.ts";
import type { RunCommand, SetupCommand } from "../cli/parse.ts";
import type { Profile } from "../core/config/profile.ts";
import type { ConfigV2, Os } from "../core/config/types.ts";
import { RECORD_ERROR_PREFIX } from "../core/machine/record.ts";
import type { MachineRecord } from "../core/machine/record.ts";
import { moveUserValues, placeValue } from "../core/machine/values.ts";
import type { ValuePlace } from "../core/machine/values.ts";
import { parseValuesFile } from "../core/values/file.ts";
import type { Values } from "../core/values/sanitize.ts";
import { runSetup } from "../wizard/setup.ts";
import type {
  ExistingAction,
  SetupDiffer,
  SetupFlags,
  SetupIo,
} from "../wizard/setup.ts";

const VALUES_FILE = ".user-values.json";

/** The os-release ID whose machines offer the Ubuntu bootstrap. */
const UBUNTU = "ubuntu";

/** `bootstrap/linux.sh`, under the repo root. */
const BOOTSTRAP_SCRIPT = ["bootstrap", "linux.sh"] as const;

/** `setup --bootstrap` off Ubuntu, before doctor runs. */
const BOOTSTRAP_ONLY_UBUNTU = "ERROR: --bootstrap is Ubuntu only.";

/** `import --check`, as pull's check runs it, for question 4's differ line. */
const IMPORT_CHECK: RunCommand = {
  kind: "run",
  command: "import",
  force: false,
  preview: false,
  check: true,
  resetValues: false,
  yes: false,
  only: [],
};

/** `export --diff`, as pull's diff runs it, for the guard block. */
const DIFF: RunCommand = {
  kind: "run",
  command: "export",
  force: false,
  preview: false,
  check: false,
  resetValues: false,
  yes: false,
  diff: true,
  only: [],
};

/** A check line an import would overwrite: `UPDATE`, never `CREATE`. */
const UPDATE_LINE = /^ {2}UPDATE /;

/** The check's `UPDATE` count; a `CREATE` never counts. */
function updateCount(check: Result): number {
  return `${check.stdout}${check.stderr}`
    .split("\n")
    .filter((line) => UPDATE_LINE.test(line)).length;
}

/**
 * The facts question 4 and the guard read: the import check's `UPDATE` count,
 * whether a sync point is recorded, and, with changes and a sync point, the
 * diff's counts and `OUT` / `BOTH` lines (or that it failed). Nothing prints
 * here; the wizard renders the lines.
 */
async function readDiffer(
  repoRoot: string,
  state: string,
  execute: (command: RunCommand, options?: ExecuteOptions) => Promise<Result>,
): Promise<SetupDiffer> {
  const check = await execute(IMPORT_CHECK);
  const updates = updateCount(check);
  const hasSyncPoint = (await readSyncPoint(repoRoot, state)) !== undefined;
  if (check.code !== 3 || !hasSyncPoint) {
    return { updates, hasSyncPoint };
  }
  const diff = await execute(DIFF);
  if (diff.code !== 0 && diff.code !== 3) {
    return { updates, hasSyncPoint, diff: { ok: false } };
  }
  return {
    updates,
    hasSyncPoint,
    diff: { ok: true, ...diffCounts(diff), blocked: blockedLines(diff) },
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

/** True for the contract's bad-record line, the one `setup --replace` reads past. */
function isBadRecord(message: string): boolean {
  return message.startsWith(RECORD_ERROR_PREFIX);
}

/** `[[ -x path ]]` on a regular file, as the bash front door tests the script. */
function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Contract "mksync setup": `bootstrap/linux.sh`, when this machine offers it
 * (Ubuntu, with an executable script); `undefined` otherwise. The flow asks
 * about it before the summary and returns the answer.
 */
function bootstrapScript(repoRoot: string, os: Os): string | undefined {
  if (os !== "linux" || readOsId(process.env) !== UBUNTU) {
    return undefined;
  }
  const script = join(repoRoot, ...BOOTSTRAP_SCRIPT);
  return isExecutableFile(script) ? script : undefined;
}

/**
 * Contract "mksync setup": runs the script the flow chose, after the record
 * and profile are written. The script owns the terminal (it may prompt for
 * sudo), so our answer reader is closed first and setup ends with its exit
 * code. `undefined` when no script runs.
 */
async function runBootstrap(
  repoRoot: string,
  os: Os,
  terminal: SetupTerminal,
): Promise<Result | undefined> {
  const script = bootstrapScript(repoRoot, os);
  if (script === undefined) {
    return undefined;
  }
  terminal.close();
  const bootstrapped = await run([script], {
    inherit: true,
    env: bootstrapEnv(process.env, process.execPath),
  });
  return { code: bootstrapped.code, stdout: "", stderr: "" };
}

/**
 * The bootstrap's environment: this one, plus `MKSYNC_PROGRAM` naming this
 * binary when it is the installed program. On a fresh machine the installer's
 * bin folder is not on PATH yet, and the clone's launcher needs Bun or Node, so
 * the bootstrap's import and preview run this binary instead.
 */
export function bootstrapEnv(
  env: Readonly<Record<string, string | undefined>>,
  execPath: string,
): Readonly<Record<string, string | undefined>> {
  if (env.MKSYNC_LAUNCHER === "1" || !isInstalledProgram(execPath)) {
    return env;
  }
  return { ...env, MKSYNC_PROGRAM: execPath };
}

/**
 * Contract "mksync setup": both first runs start with the doctor. Its output
 * goes straight to the terminal so it comes before the scan and the questions,
 * and a non-zero code stops setup before anything is asked or written.
 * `undefined` when the doctor is green.
 */
async function doctorFirst(
  repoRoot: string,
  config: ConfigV2,
  os: Os,
  home: string,
  layers: Layers,
): Promise<Result | undefined> {
  const doctor = await executeDoctor({ repoRoot, config, os, home, layers });
  process.stdout.write(doctor.stdout);
  process.stderr.write(doctor.stderr);
  return doctor.code === 0 ? undefined : { code: 1, stdout: "", stderr: "" };
}

/**
 * The layers the doctor reads when `setup --replace` reads past a bad local
 * record: no record, so it reports `no machine record` as the flow goes on as
 * if this machine had none. The store's location is for its writes and the
 * doctor never reads it.
 */
function noRecordLayers(state: string): Layers {
  return { location: stateLocation(state) };
}

/**
 * Contract "mksync setup": `--bootstrap` is Ubuntu only. On macOS and Windows
 * it is refused before the doctor asks or prints anything; `undefined` when
 * setup may go on.
 */
export function bootstrapRefusal(
  os: Os,
  command: SetupCommand,
): Result | undefined {
  return command.bootstrap === true && os !== "linux"
    ? failure(BOOTSTRAP_ONLY_UBUNTU)
    : undefined;
}

/**
 * Run `mksync setup` end to end: run the doctor, read the store and the scan,
 * run the flow, move `.user-values.json`, write the record and profile, run
 * the Ubuntu bootstrap when the flow chose it, then act on the fourth answer
 * (decision 9).
 */
export async function executeSetup(
  repoRoot: string,
  config: ConfigV2,
  os: Os,
  home: string,
  state: string,
  command: SetupCommand,
  execute: (command: RunCommand, options?: ExecuteOptions) => Promise<Result>,
): Promise<Result> {
  // Contract "mksync setup": `--bootstrap` is Ubuntu only, refused before the
  // doctor asks or prints anything.
  const refusal = bootstrapRefusal(os, command);
  if (refusal !== undefined) {
    return refusal;
  }
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
  // Contract "mksync setup": the doctor runs after the store is read and
  // before the scan and any question. `--replace` reads past a bad record and
  // goes on as if there were none, so the doctor sees no record either.
  const layers = loadLayers(state, repoRoot, config);
  let doctorLayers: Layers;
  if (layers.ok) {
    doctorLayers = layers.value;
  } else if (
    command.replace !== undefined &&
    isBadRecord(layers.error.message)
  ) {
    doctorLayers = noRecordLayers(state);
  } else {
    return failure(layers.error.message, layers.error.code);
  }
  const stopped = await doctorFirst(repoRoot, config, os, home, doctorLayers);
  if (stopped !== undefined) {
    return stopped;
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
  const differ = await readDiffer(repoRoot, state, execute);
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
      differ,
      bootstrapOffered: bootstrapScript(repoRoot, os) !== undefined,
      linkedFolders: (profile, record) =>
        readLinkedFolders(home, os, config, profile, record),
    },
    terminal.io,
  );
  if (!outcome.ok) {
    terminal.close();
    if ("declined" in outcome) {
      return { code: 0, stdout: "Stopped: nothing was written.\n", stderr: "" };
    }
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
  // The confirm was answered yes, so the record and the profile are written
  // after the value questions, which use the same reader as the flow: a piped
  // answer left after the confirm reaches them, and `runBootstrap` closes the
  // reader before the script gets the terminal.
  try {
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
      if (error instanceof SymlinkRefusal) {
        return failure(error.message);
      }
      const message = error instanceof Error ? error.message : String(error);
      return failure(
        `ERROR: cannot write the profile ${profile.name}: ${message}`,
      );
    }
    try {
      writeRecord(state, record);
    } catch (error) {
      if (error instanceof SymlinkRefusal) {
        return failure(error.message);
      }
      const message = error instanceof Error ? error.message : String(error);
      return failure(`ERROR: cannot write the machine record: ${message}`);
    }

    // Contract "Then": only a confirm's yes reaches here, so the record and
    // profile are written, then the chosen bootstrap runs and ends setup with
    // its exit code, and only then does setup act on question 4.
    if (outcome.bootstrap) {
      const bootstrapped = await runBootstrap(repoRoot, os, terminal);
      if (bootstrapped !== undefined) {
        return bootstrapped;
      }
    }
    if (outcome.action === "stop") {
      return {
        code: 0,
        stdout: "Stopped: the record is written, no file was changed.\n",
        stderr: "",
      };
    }
    return await importAfterSetup(outcome.action, execute, { terminal });
  } finally {
    terminal.close();
  }
}

/**
 * Decision 9's last move: `backup` imports at once; `keep` exports the local
 * files into the repo folder first, then imports. The import reads its value
 * answers from setup's own reader (`options.terminal`), so piped answers left
 * after the four questions still reach it.
 */
async function importAfterSetup(
  action: Exclude<ExistingAction, "stop">,
  execute: (command: RunCommand, options?: ExecuteOptions) => Promise<Result>,
  options: ExecuteOptions,
): Promise<Result> {
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
  if (action === "backup") {
    return execute(importCommand, options);
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
  const exported = await execute(exportCommand, options);
  if (exported.code !== 0) {
    // The local files weren't saved, so importing now would overwrite them.
    return exported;
  }
  const imported = await execute(importCommand, options);
  return {
    code: imported.code,
    stdout:
      exported.stdout +
      "Pushed into the repo folder; commit it with mksync push.\n" +
      imported.stdout,
    stderr: `${exported.stderr}${imported.stderr}`,
  };
}
