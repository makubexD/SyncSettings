import { readdirSync, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import type { Profile } from "../core/config/profile.ts";
import { parseProfile } from "../core/config/profile.ts";
import type {
  ConfigError,
  ConfigV2,
  Result as LoadResult,
} from "../core/config/types.ts";
import { LAYER_NAME } from "../core/layers/names.ts";
import type { MachineRecord } from "../core/machine/record.ts";
import { parseRecord, recordMessage } from "../core/machine/record.ts";
import { MACHINES_FOLDER, PROFILES_FOLDER } from "./fs.ts";

/** The state folder's record file; contract "The record". */
const MACHINE_FILE = "machine.json";

/** The keys of the pointer a record becomes once it lives in the repo. */
const POINTER_FIELDS: readonly string[] = ["name", "home"];

const REPO_HOME = "repo";

const PROFILE_EXTENSION = ".json";

/** What a run reads from the record store: contract "Where records are kept". */
export interface Store {
  readonly record?: MachineRecord;
  readonly profile?: Profile;
  readonly profiles: readonly Profile[];
}

/**
 * Read a text file, or `undefined` when it cannot be read. A missing record
 * file is "no record yet"; a missing profile file is reported by the caller.
 */
export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The name in a `{"name": <name>, "home": "repo"}` pointer, or `undefined`
 * when the text is anything else. Exactly the two keys, with `name` a layer
 * name, make a pointer; every other text is read as a full record.
 */
function repoHomeName(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const fields = parsed as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (
    keys.length !== POINTER_FIELDS.length ||
    !POINTER_FIELDS.every((field) => Object.hasOwn(fields, field))
  ) {
    return undefined;
  }
  const name = fields.name;
  const home = fields.home;
  if (
    typeof name !== "string" ||
    home !== REPO_HOME ||
    !LAYER_NAME.test(name)
  ) {
    return undefined;
  }
  return name;
}

/** Parse a record, adding the contract's line and exit code to its reason. */
function readRecord(
  text: string,
  config: ConfigV2,
): LoadResult<MachineRecord, ConfigError> {
  const parsed = parseRecord(text, config);
  if (parsed.ok) {
    return parsed;
  }
  return {
    ok: false,
    error: { message: recordMessage(parsed.error), code: 2 },
  };
}

/** The `.json` files in a profiles folder, without their extension, sorted by name. */
function profileNames(folder: string): readonly string[] {
  let entries: readonly Dirent[];
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    // No profiles folder means no profiles made on this machine yet.
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(PROFILE_EXTENSION))
    .map((entry) => entry.name.slice(0, -PROFILE_EXTENSION.length))
    .sort((a, b) => a.localeCompare(b));
}

/** Read one profile file, or the contract's not-found line with its path. */
function readProfileFile(
  folder: string,
  name: string,
  config: ConfigV2,
): LoadResult<Profile, ConfigError> {
  const path = join(folder, `${name}${PROFILE_EXTENSION}`);
  const text = readText(path);
  if (text === undefined) {
    return {
      ok: false,
      error: { message: `ERROR: profile ${name} not found: ${path}`, code: 2 },
    };
  }
  return parseProfile(name, text, config);
}

/** Every profile in a profiles folder, sorted by name, with its parse result. */
function readProfiles(
  folder: string,
  config: ConfigV2,
): LoadResult<readonly Profile[], ConfigError> {
  const profiles: Profile[] = [];
  for (const name of profileNames(folder)) {
    const parsed = readProfileFile(folder, name, config);
    if (!parsed.ok) {
      return parsed;
    }
    profiles.push(parsed.value);
  }
  return { ok: true, value: profiles };
}

/** The record's profile and every profile in the same store's folder. */
interface StoreFiles {
  readonly record: MachineRecord;
  readonly profilesFolder: string;
}

function storeValue(
  files: StoreFiles,
  config: ConfigV2,
): LoadResult<Store, ConfigError> {
  const profile = readProfileFile(
    files.profilesFolder,
    files.record.profile,
    config,
  );
  if (!profile.ok) {
    return profile;
  }
  const profiles = readProfiles(files.profilesFolder, config);
  if (!profiles.ok) {
    return profiles;
  }
  return {
    ok: true,
    value: {
      record: files.record,
      profile: profile.value,
      profiles: profiles.value,
    },
  };
}

/**
 * Contract "Where records are kept": the record, its profile and every profile
 * in the same store, read from local state, or from the repo's `machines/` and
 * `profiles/` when the record is a `{"name", "home": "repo"}` pointer. No
 * record file means no record and only local profiles: a machine reads before
 * `setup` writes one. A bad record, a missing profile and a pointer whose
 * machine file isn't in the clone stop with exit code 2.
 */
export function readStore(
  stateFolder: string,
  repoRoot: string,
  config: ConfigV2,
): LoadResult<Store, ConfigError> {
  const recordText = readText(join(stateFolder, MACHINE_FILE));
  if (recordText === undefined) {
    const profiles = readProfiles(join(stateFolder, PROFILES_FOLDER), config);
    if (!profiles.ok) {
      return profiles;
    }
    return { ok: true, value: { profiles: profiles.value } };
  }

  const repoName = repoHomeName(recordText);
  if (repoName === undefined) {
    const record = readRecord(recordText, config);
    if (!record.ok) {
      return record;
    }
    return storeValue(
      {
        record: record.value,
        profilesFolder: join(stateFolder, PROFILES_FOLDER),
      },
      config,
    );
  }

  const machineFile = `${MACHINES_FOLDER}/${repoName}${PROFILE_EXTENSION}`;
  const repoRecordText = readText(
    join(repoRoot, MACHINES_FOLDER, `${repoName}${PROFILE_EXTENSION}`),
  );
  if (repoRecordText === undefined) {
    return {
      ok: false,
      error: {
        message: `ERROR: machine ${repoName} not found: ${machineFile}`,
        code: 2,
      },
    };
  }
  // shortcut: the contract's record line names machine.json in the state
  // folder, but a repo-home record's file is machines/<name>.json; both use
  // the same line until the contract names one.
  const record = readRecord(repoRecordText, config);
  if (!record.ok) {
    return record;
  }
  return storeValue(
    { record: record.value, profilesFolder: join(repoRoot, PROFILES_FOLDER) },
    config,
  );
}
