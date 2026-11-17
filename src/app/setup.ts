/**
 * `mksync setup` (contract "First run"): read the store and the scan, run the
 * flow, move `.user-values.json`, write the record and profile, then act on
 * the fourth answer (decision 9). The export and import the flow ends with run
 * through the caller's `execute`, so this module never imports `main.ts`.
 */

import { join } from "node:path";
import { SymlinkRefusal } from "../adapters/atomic.ts";
import { readOrigin } from "../adapters/git.ts";
import { readScan } from "../adapters/scan.ts";
import {
  readLinkedFolders,
  readRepoStore,
  readStore,
  readText,
  writeProfile,
  writeRecord,
} from "../adapters/store.ts";
import { readVisibility } from "../adapters/visibility.ts";
import { failure, setupTerminal } from "./export.ts";
import type { Result } from "./export.ts";
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

/**
 * Run `mksync setup` end to end: read the store and the scan, run the flow,
 * move `.user-values.json`, write the record and profile, then act on the
 * fourth answer (decision 9).
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
