/**
 * `mksync setup` (contract "First run"): run the doctor, read the store and the
 * scan, run the flow, move `.user-values.json`, write the record and profile,
 * offer the Ubuntu bootstrap, then act on the fourth answer (decision 9). The
 * export and import the flow ends with run through the caller's `execute`, so
 * this module never imports `main.ts`. A repository still on the version-1
 * config takes the old front door's flow instead: doctor, the import check, the
 * Ubuntu bootstrap and the apply.
 */

import {
  accessSync,
  constants as fsConstants,
  existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { SymlinkRefusal } from "../adapters/atomic.ts";
import { readOrigin } from "../adapters/git.ts";
import { readOsId } from "../adapters/osname.ts";
import { run } from "../adapters/process.ts";
import { readScan } from "../adapters/scan.ts";
import { loadLayers, V2_CONFIG } from "../adapters/snapshot.ts";
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
import { trimAnswer } from "../core/answer.ts";
import { executeDoctor } from "./doctor.ts";
import { failure, setupTerminal } from "./export.ts";
import type { Result, SetupTerminal } from "./export.ts";
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
import type { SetupFlags, SetupIo } from "../wizard/setup.ts";

const VALUES_FILE = ".user-values.json";

/** The os-release ID whose machines offer the Ubuntu bootstrap. */
const UBUNTU = "ubuntu";

/** `bootstrap/linux.sh`, under the repo root. */
const BOOTSTRAP_SCRIPT = ["bootstrap", "linux.sh"] as const;

/** `setup --bootstrap` on macOS, before doctor runs. */
const BOOTSTRAP_ONLY_MACOS = "ERROR: --bootstrap is Ubuntu only.";

/** The bootstrap question, exactly as `front_setup` prints it. */
const BOOTSTRAP_QUESTION =
  "  Also restore apps and packages from packages/linux (uses sudo)? [y/N] ";

/** The apply question, exactly as `front_setup` prints it. */
const APPLY_QUESTION = "  Apply these changes? [Y/n] ";

const NOTHING_APPLIED = "  Nothing applied.\n";

const SETUP_DONE =
  "  Setup done. Run mksync any time to see where this machine stands.\n";

/** The import check's "changes found" code, the other one setup goes on with. */
const CHECK_DIFFERS = 3;

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

/** The import the version-1 setup runs: the read-only check, or the apply. */
function v1ImportCommand(check: boolean): RunCommand {
  return {
    kind: "run",
    command: "import",
    force: !check,
    preview: false,
    check,
    resetValues: false,
    yes: false,
    only: [],
  };
}

/** True for an answer bash's `[Yy]*` matches. */
function isYes(answer: string): boolean {
  return answer.startsWith("y") || answer.startsWith("Y");
}

/**
 * Contract "Front door": on Ubuntu with an executable `bootstrap/linux.sh`,
 * `--bootstrap` runs it; otherwise setup asks and runs it for an answer
 * starting with y or Y. The script owns the terminal (it may prompt for sudo),
 * so our answer reader is closed first and setup ends with its exit code.
 * `undefined` when no script runs.
 */
async function runBootstrap(
  repoRoot: string,
  os: Os,
  command: SetupCommand,
  terminal: SetupTerminal,
): Promise<Result | undefined> {
  if (os !== "linux" || readOsId(process.env) !== UBUNTU) {
    return undefined;
  }
  const script = join(repoRoot, ...BOOTSTRAP_SCRIPT);
  if (!isExecutableFile(script)) {
    return undefined;
  }
  if (command.bootstrap !== true) {
    terminal.io.write(BOOTSTRAP_QUESTION);
    const answer = trimAnswer((await terminal.io.readLine()) ?? "");
    if (!isYes(answer)) {
      return undefined;
    }
  }
  terminal.close();
  const bootstrapped = await run([script], { inherit: true });
  return { code: bootstrapped.code, stdout: "", stderr: "" };
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
 * The version-1 first run, `front_setup` ported: doctor first, a MISSING line
 * stops setup before the import check or any question; then the read-only
 * import check; then the Ubuntu bootstrap question; then the apply, unless
 * declined. Each part goes to stdout as it is produced, because a question and
 * the bootstrap script share this terminal.
 */
async function executeV1Setup(
  repoRoot: string,
  config: ConfigV2,
  os: Os,
  home: string,
  state: string,
  command: SetupCommand,
  execute: (command: RunCommand) => Promise<Result>,
): Promise<Result> {
  const layers = loadLayers(state, repoRoot, config);
  if (!layers.ok) {
    return failure(layers.error.message, layers.error.code);
  }
  const stopped = await doctorFirst(repoRoot, config, os, home, layers.value);
  if (stopped !== undefined) {
    return stopped;
  }

  const check = await execute(v1ImportCommand(true));
  process.stdout.write(check.stdout);
  process.stderr.write(check.stderr);
  if (check.code !== 0 && check.code !== CHECK_DIFFERS) {
    return { code: 1, stdout: "", stderr: "" };
  }

  const terminal = setupTerminal();
  let applied: Result | undefined;
  try {
    const bootstrapped = await runBootstrap(repoRoot, os, command, terminal);
    if (bootstrapped !== undefined) {
      return bootstrapped;
    }
    if (check.code === CHECK_DIFFERS) {
      let apply = true;
      if (command.yes !== true) {
        terminal.io.write(APPLY_QUESTION);
        const answer = trimAnswer((await terminal.io.readLine()) ?? "");
        if (answer !== "" && !isYes(answer)) {
          terminal.io.write(NOTHING_APPLIED);
          apply = false;
        }
      }
      if (apply) {
        applied = await execute(v1ImportCommand(false));
      }
    }
  } finally {
    terminal.close();
  }
  if (applied !== undefined) {
    process.stdout.write(applied.stdout);
    process.stderr.write(applied.stderr);
    if (applied.code !== 0) {
      return { code: applied.code, stdout: "", stderr: "" };
    }
  }
  process.stdout.write(SETUP_DONE);
  return { code: 0, stdout: "", stderr: "" };
}

/**
 * Run `mksync setup` end to end: run the doctor, read the store and the scan,
 * run the flow, move `.user-values.json`, write the record and profile, offer
 * the Ubuntu bootstrap, then act on the fourth answer (decision 9).
 */
export async function executeSetup(
  repoRoot: string,
  config: ConfigV2,
  os: Os,
  home: string,
  state: string,
  command: SetupCommand,
  execute: (command: RunCommand) => Promise<Result>,
): Promise<Result> {
  // Contract "mksync setup": `--bootstrap` is Ubuntu only, refused before the
  // doctor asks or prints anything on any repo version.
  if (command.bootstrap === true && os === "macos") {
    return failure(BOOTSTRAP_ONLY_MACOS);
  }
  // `loadConfig` reads `sync-config.v2.json` when it is there and converts the
  // version-1 file otherwise, so its absence means this repo is still v1 and
  // setup follows the old engine's rules.
  if (!existsSync(join(repoRoot, V2_CONFIG))) {
    return executeV1Setup(repoRoot, config, os, home, state, command, execute);
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
      linkedFolders: (profile, record) =>
        readLinkedFolders(home, os, config, profile, record),
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
  // The record and the profile are written first, then the bootstrap question
  // is asked on the same reader: it stays open so a piped answer still reaches
  // it, and `runBootstrap` closes it before the script gets the terminal.
  let bootstrapped: Result | undefined;
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

    if (outcome.action === "stop") {
      return {
        code: 0,
        stdout: "Stopped: the record is written, no file was changed.\n",
        stderr: "",
      };
    }
    bootstrapped = await runBootstrap(repoRoot, os, command, terminal);
  } finally {
    terminal.close();
  }
  if (bootstrapped !== undefined) {
    return bootstrapped;
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
