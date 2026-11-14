import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, join } from "node:path";
import type { Profile } from "../core/config/profile.ts";
import { parseProfile } from "../core/config/profile.ts";
import type {
  ConfigError,
  ConfigV2,
  Result as LoadResult,
} from "../core/config/types.ts";
import { MACHINES_FOLDER, PROFILES_FOLDER } from "../core/guard.ts";
import type { JsonValue } from "../core/json/value.ts";
import { writeJson } from "../core/json/value.ts";
import { LAYER_NAME } from "../core/layers/names.ts";
import type {
  FirstBackupWrites,
  LayerFile,
  LocalBackup,
  RepoBackup,
} from "../core/machine/backup.ts";
import type { MachineRecord } from "../core/machine/record.ts";
import {
  parseRecord,
  recordMessage,
  recordText,
} from "../core/machine/record.ts";

/** The state folder's record file; contract "The record". */
const MACHINE_FILE = "machine.json";

/** The keys of the pointer a record becomes once it lives in the repo. */
const POINTER_FIELDS: readonly string[] = ["name", "home"];

const REPO_HOME = "repo";

const PROFILE_EXTENSION = ".json";

/** The record and profile hold values; contract "The record" wants them
 * readable by the current user only. */
const PRIVATE_MODE = 0o600;

/** What a run reads from the record store: contract "Where records are kept". */
export interface Store {
  readonly record?: MachineRecord;
  readonly profile?: Profile;
  readonly profiles: readonly Profile[];
}

/** What a repo-home store holds: records other machines could take over, and
 * every profile in the clone. */
export interface RepoStore {
  readonly records: readonly MachineRecord[];
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

/** The error codes that mean the file isn't there, not that it can't be read. */
const MISSING_CODES: readonly string[] = ["ENOENT", "ENOTDIR"];

/** Whether a caught read error is a missing file rather than an unreadable one. */
function isMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code: unknown = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && MISSING_CODES.includes(code);
}

/**
 * What reading a record or profile file tells the caller: the text, that the
 * file is missing, or that it is there but can't be read (contract "The
 * record").
 */
type FileText =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable" };

/**
 * Read a record or profile file for the store. Only a missing file is
 * "missing"; a file that is there but can't be read (a folder in its place,
 * no read permission) is "can't be read", never "no record yet".
 */
function readFileText(path: string): FileText {
  try {
    return { kind: "text", text: readFileSync(path, "utf8") };
  } catch (error) {
    return { kind: isMissingError(error) ? "missing" : "unreadable" };
  }
}

/** The contract's "can't be read" line for the record file. */
function unreadableRecordError(): ConfigError {
  return { message: recordMessage("can't be read"), code: 2 };
}

/** The contract's "can't be read" line for a profile file. */
function unreadableProfileError(name: string): ConfigError {
  const message =
    `ERROR: profile ${name} (profiles/${name}${PROFILE_EXTENSION} in the ` +
    `state folder): can't be read.`;
  return { message, code: 2 };
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

/** The `.json` files in a folder, without their extension, sorted by name. */
function jsonNames(folder: string): readonly string[] {
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
  const read = readFileText(path);
  if (read.kind === "unreadable") {
    return { ok: false, error: unreadableProfileError(name) };
  }
  if (read.kind === "missing") {
    return {
      ok: false,
      error: { message: `ERROR: profile ${name} not found: ${path}`, code: 2 },
    };
  }
  return parseProfile(name, read.text, config);
}

/** Every profile in a profiles folder, sorted by name, with its parse result. */
function readProfiles(
  folder: string,
  config: ConfigV2,
): LoadResult<readonly Profile[], ConfigError> {
  const profiles: Profile[] = [];
  for (const name of jsonNames(folder)) {
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
  const recordRead = readFileText(join(stateFolder, MACHINE_FILE));
  if (recordRead.kind === "unreadable") {
    return { ok: false, error: unreadableRecordError() };
  }
  if (recordRead.kind === "missing") {
    const profiles = readProfiles(join(stateFolder, PROFILES_FOLDER), config);
    if (!profiles.ok) {
      return profiles;
    }
    return { ok: true, value: { profiles: profiles.value } };
  }

  const repoName = repoHomeName(recordRead.text);
  if (repoName === undefined) {
    const record = readRecord(recordRead.text, config);
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
  const repoRecordRead = readFileText(
    join(repoRoot, MACHINES_FOLDER, `${repoName}${PROFILE_EXTENSION}`),
  );
  if (repoRecordRead.kind === "unreadable") {
    // shortcut: the contract's record line names machine.json in the state
    // folder, but a repo-home record's file is machines/<name>.json; both use
    // the same line until the contract names one.
    return { ok: false, error: unreadableRecordError() };
  }
  if (repoRecordRead.kind === "missing") {
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
  const record = readRecord(repoRecordRead.text, config);
  if (!record.ok) {
    return record;
  }
  return storeValue(
    { record: record.value, profilesFolder: join(repoRoot, PROFILES_FOLDER) },
    config,
  );
}

/**
 * Contract "Where records are kept": the repo store, every machine record in
 * the clone's `machines/` and every profile in its `profiles/`, sorted by
 * name. `setup` reads it when the repo is private; a bad record stops with
 * exit code 2.
 */
export function readRepoStore(
  repoRoot: string,
  config: ConfigV2,
): LoadResult<RepoStore, ConfigError> {
  const records: MachineRecord[] = [];
  const machinesFolder = join(repoRoot, MACHINES_FOLDER);
  for (const name of jsonNames(machinesFolder)) {
    const read = readFileText(
      join(machinesFolder, `${name}${PROFILE_EXTENSION}`),
    );
    if (read.kind === "unreadable") {
      return { ok: false, error: unreadableRecordError() };
    }
    if (read.kind === "missing") {
      continue;
    }
    const record = readRecord(read.text, config);
    if (!record.ok) {
      return record;
    }
    records.push(record.value);
  }
  const profiles = readProfiles(join(repoRoot, PROFILES_FOLDER), config);
  if (!profiles.ok) {
    return profiles;
  }
  return { ok: true, value: { records, profiles: profiles.value } };
}

function jsonString(value: string): JsonValue {
  return { kind: "string", value };
}

function jsonStrings(values: readonly string[]): JsonValue {
  return { kind: "array", items: values.map(jsonString) };
}

function jsonStringRecord(values: Readonly<Record<string, string>>): JsonValue {
  const entries: [string, JsonValue][] = Object.entries(values).map(
    ([key, value]) => [key, jsonString(value)],
  );
  return { kind: "object", entries: new Map(entries) };
}

function profileValue(profile: Profile): JsonValue {
  return {
    kind: "object",
    entries: new Map<string, JsonValue>([
      ["modules", jsonStrings(profile.modules)],
      ["values", jsonStringRecord(profile.values)],
      ["destinations", jsonStringRecord(profile.destinations)],
      ["retired", { kind: "bool", value: profile.retired }],
    ]),
  };
}

/** The profile as the contract writes it: the key order above, the `json`
 * entry layout, LF and a trailing newline. */
function profileText(profile: Profile): string {
  return writeJson(profileValue(profile), "\n");
}

/** Write a record or profile file, creating its folder, for the current user
 * only (contract "The record"). */
function writePrivateFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: PRIVATE_MODE });
  // `mode` at creation is masked by the umask; the contract wants 0600.
  chmodSync(path, PRIVATE_MODE);
}

/** Write this machine's record to `<state>/machine.json`. */
export function writeRecord(stateFolder: string, record: MachineRecord): void {
  writePrivateFile(join(stateFolder, MACHINE_FILE), recordText(record));
}

/** Write a profile to `<state>/profiles/<name>.json`. */
export function writeProfile(stateFolder: string, profile: Profile): void {
  writePrivateFile(
    join(stateFolder, PROFILES_FOLDER, `${profile.name}${PROFILE_EXTENSION}`),
    profileText(profile),
  );
}

/** The first backup's two sides, as their stores hold them. */
export interface BackupSides {
  readonly local: LocalBackup;
  readonly repo: RepoBackup;
}

/** One file the first backup writes, with the status line it prints. */
export interface FirstBackupFile {
  readonly path: string;
  readonly text: string;
  readonly status: "ADDED" | "MODIFIED";
}

/** The contract's line when a first backup write fails. */
const FIRST_BACKUP_STOPPED = "ERROR: first backup stopped at";

function byRelativePath(
  a: { readonly path: string },
  b: { readonly path: string },
): number {
  if (a.path < b.path) {
    return -1;
  }
  return a.path > b.path ? 1 : 0;
}

/** Every regular file under a layer folder, sorted, its path relative to the
 * folder and "/"-separated. A missing folder holds no files; any other read
 * error is the caller's to report. */
function readLayerFolder(folder: string): readonly LayerFile[] {
  const files: LayerFile[] = [];
  const walk = (current: string, prefix: string): void => {
    let entries: readonly Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (isMissingError(error)) {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path, relative);
      } else if (entry.isFile()) {
        files.push({ path: relative, text: readFileSync(path, "utf8") });
      }
    }
  };
  walk(folder, "");
  return files.sort(byRelativePath);
}

/** The repo's copy of a profile, or `undefined` when the clone doesn't hold it. */
function readRepoProfile(
  repoRoot: string,
  name: string,
  config: ConfigV2,
): LoadResult<Profile | undefined, ConfigError> {
  const path = join(repoRoot, PROFILES_FOLDER, `${name}${PROFILE_EXTENSION}`);
  const read = readFileText(path);
  if (read.kind === "unreadable") {
    return {
      ok: false,
      error: {
        message:
          `ERROR: profile ${name} (${PROFILES_FOLDER}/${name}` +
          `${PROFILE_EXTENSION} in the repo): can't be read.`,
        code: 2,
      },
    };
  }
  if (read.kind === "missing") {
    return { ok: true, value: undefined };
  }
  return parseProfile(name, read.text, config);
}

/**
 * Contract "The first backup": what this machine holds for its record's profile
 * and what the repo already holds for that profile. `undefined` when there is
 * no first backup: no record, or a record already in the pointer form.
 */
export function readBackupSides(
  stateFolder: string,
  repoRoot: string,
  config: ConfigV2,
): LoadResult<BackupSides | undefined, ConfigError> {
  const recordRead = readFileText(join(stateFolder, MACHINE_FILE));
  if (recordRead.kind === "unreadable") {
    return { ok: false, error: unreadableRecordError() };
  }
  if (recordRead.kind === "missing") {
    return { ok: true, value: undefined };
  }
  if (repoHomeName(recordRead.text) !== undefined) {
    return { ok: true, value: undefined };
  }
  const record = readRecord(recordRead.text, config);
  if (!record.ok) {
    return record;
  }
  const profile = readProfileFile(
    join(stateFolder, PROFILES_FOLDER),
    record.value.profile,
    config,
  );
  if (!profile.ok) {
    return profile;
  }
  let profileLayer: readonly LayerFile[];
  let machineLayer: readonly LayerFile[];
  try {
    profileLayer = readLayerFolder(
      join(stateFolder, PROFILES_FOLDER, record.value.profile),
    );
    machineLayer = readLayerFolder(
      join(stateFolder, MACHINES_FOLDER, record.value.name),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { message: `ERROR: ${reason}`, code: 2 } };
  }
  const repoProfile = readRepoProfile(repoRoot, record.value.profile, config);
  if (!repoProfile.ok) {
    return repoProfile;
  }
  return {
    ok: true,
    value: {
      local: {
        profile: profile.value,
        profileLayer,
        record: record.value,
        machineLayer,
      },
      repo:
        repoProfile.value === undefined
          ? {}
          : { profile: repoProfile.value },
    },
  };
}

/**
 * Contract "The first backup": the files to write, compared by content with
 * the repo. A file the repo already holds identical bytes for is left out, so
 * it prints no status line and isn't counted.
 */
export function firstBackupFiles(
  repoRoot: string,
  writes: FirstBackupWrites,
): readonly FirstBackupFile[] {
  const files: { readonly path: string; readonly text: string }[] = [
    {
      path: `${PROFILES_FOLDER}/${writes.profile.name}${PROFILE_EXTENSION}`,
      text: profileText(writes.profile),
    },
    {
      path: `${MACHINES_FOLDER}/${writes.record.name}${PROFILE_EXTENSION}`,
      text: recordText(writes.record),
    },
    ...writes.files,
  ].sort(byRelativePath);
  const changed: FirstBackupFile[] = [];
  for (const file of files) {
    const current = readText(join(repoRoot, ...file.path.split("/")));
    if (current === file.text) {
      continue;
    }
    changed.push({
      ...file,
      status: current === undefined ? "ADDED" : "MODIFIED",
    });
  }
  return changed;
}

/** The contract's failure line for one first backup write. */
function firstBackupStopped(path: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `${FIRST_BACKUP_STOPPED} ${path}: ${reason}.`;
}

/** The pointer a record becomes once its files live in the repo. */
function pointerText(name: string): string {
  const entries = new Map<string, JsonValue>([
    ["name", jsonString(name)],
    ["home", jsonString(REPO_HOME)],
  ]);
  return writeJson({ kind: "object", entries }, "\n");
}

/**
 * Contract "The first backup": write the files into the repo, then make
 * `<state>/machine.json` the pointer. A failed write stops before the pointer,
 * so the record stays local and the next export tries again.
 */
export function writeFirstBackup(
  stateFolder: string,
  repoRoot: string,
  name: string,
  files: readonly FirstBackupFile[],
): LoadResult<undefined, ConfigError> {
  for (const file of files) {
    try {
      const target = join(repoRoot, ...file.path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.text);
    } catch (error) {
      return {
        ok: false,
        error: { message: firstBackupStopped(file.path, error), code: 1 },
      };
    }
  }
  try {
    writePrivateFile(join(stateFolder, MACHINE_FILE), pointerText(name));
  } catch (error) {
    return {
      ok: false,
      error: { message: firstBackupStopped(MACHINE_FILE, error), code: 1 },
    };
  }
  return { ok: true, value: undefined };
}
