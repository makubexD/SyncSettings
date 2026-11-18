/**
 * `machine retire` and `profile retire` (contract "Retire"): run the rule
 * against the store, then ask and write. A profile's records are the store's
 * own record when it has one, or every repo record for a pointer.
 */

import { join } from "node:path";
import { SymlinkRefusal } from "../adapters/atomic.ts";
import {
  readStore,
  writeStoreProfile,
  writeStoreRecord,
} from "../adapters/store.ts";
import { failure, setupTerminal } from "./export.ts";
import type { Result } from "./export.ts";
import type { RetireCommand } from "../cli/parse.ts";
import type { ConfigV2 } from "../core/config/types.ts";
import { PROFILES_FOLDER } from "../core/guard.ts";
import {
  isYes,
  machineRetireQuestion,
  NOTHING_RETIRED,
  profileRetireQuestion,
  retireMachine,
  retireProfile,
} from "../core/machine/retire.ts";
import type { RetireResult } from "../core/machine/retire.ts";

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
    if (error instanceof SymlinkRefusal) {
      return failure(error.message);
    }
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
export async function executeRetire(
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
