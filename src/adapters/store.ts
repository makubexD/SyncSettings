import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
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

/** Where a store keeps its record and profiles, and where a write goes. */
export interface StoreLocation {
  /** The record file: `<state>/machine.json`, or the repo's
   * `machines/<name>.json` while the local record is a pointer. */
  readonly recordFile: string;
  /** The folder holding this store's profiles. */
  readonly profilesFolder: string;
  /** True for the state folder, whose files only the user may read; repo
   * files keep the mode the clone gives them. */
  readonly privateFiles: boolean;
}

/** What a run reads from the record store: contract "Where records are kept". */
export interface Store {
  readonly record?: MachineRecord;
  readonly profile?: Profile;
  readonly profiles: readonly Profile[];
  /** The records "used by" a profile checks: this machine's record; every
   * record in the repo's `machines/` while the local record is a pointer and
   * the read asks for it with `StoreOptions.usedBy`. */
  readonly records: readonly MachineRecord[];
  /** Where a write of a retired record or profile goes. */
  readonly location: StoreLocation;
}

/** What a store read asks for beyond the run's own record. */
export interface StoreOptions {
  /** Read every record under the repo's `machines/`, as `profile retire`'s
   * "used by" check needs. Every other run reads only this machine's record,
   * so another machine's broken record doesn't stop it. */
  readonly usedBy?: boolean;
}

/** What a repo-home store holds: records other machines could take over, and
 * every profile in the clone. */
export interface RepoStore {
  readonly records: readonly MachineRecord[];
  readonly profiles: readonly Profile[];
}

/** The local store's paths, under the state folder. */
function stateLocation(stateFolder: string): StoreLocation {
  return {
    recordFile: join(stateFolder, MACHINE_FILE),
    profilesFolder: join(stateFolder, PROFILES_FOLDER),
    privateFiles: true,
  };
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
  | { readonly kind: "unreadable"; readonly reason: string };

/** Why a file that is there can't be read, in the contract's words; never the
 * raw error text, which names the absolute path. */
function unreadableReason(error: unknown): string {
  const code: unknown =
    error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  switch (code) {
    case "EISDIR":
      return "a folder in its place";
    case "EACCES":
    case "EPERM":
      return "no read permission";
    default:
      return typeof code === "string" ? code : "unknown error";
  }
}

/**
 * Read a record or profile file for the store. Only a missing file is
 * "missing"; a file that is there but can't be read (a folder in its place,
 * no read permission) is "can't be read", never "no record yet".
 */
function readFileText(path: string): FileText {
  try {
    return { kind: "text", text: readFileSync(path, "utf8") };
  } catch (error) {
    return isMissingError(error)
      ? { kind: "missing" }
      : { kind: "unreadable", reason: unreadableReason(error) };
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

/** `profiles/<name>.json`, a profile's path in the repo. */
function repoProfilePath(name: string): string {
  return `${PROFILES_FOLDER}/${name}${PROFILE_EXTENSION}`;
}

/** The contract's line for a repo record or profile that can't be read,
 * "Retire" and "The repo store". */
function unreadableRepoError(
  relativePath: string,
  reason: string,
): ConfigError {
  return {
    message: `ERROR: ${relativePath} can't be read: ${reason}.`,
    code: 2,
  };
}

/**
 * How a profile read reports its errors: the state folder's lines, or the
 * repo's `<repo path> can't be read: <reason>.` line.
 */
interface ProfileErrorLines {
  readonly unreadable: (name: string, reason: string) => ConfigError;
  readonly missing: (name: string, path: string) => ConfigError;
  readonly parse: (name: string, error: ConfigError) => ConfigError;
}

/** The state folder's profile errors, from contract "The record". */
const STATE_PROFILE_ERRORS: ProfileErrorLines = {
  unreadable: unreadableProfileError,
  missing: (name, path) => ({
    message: `ERROR: profile ${name} not found: ${path}`,
    code: 2,
  }),
  parse: (_name, error) => error,
};

/**
 * The reason in an `ERROR: profile <name>: <reason>.` line.
 * shortcut: `parseProfile` reports only that whole line, so the repo's
 * `<repo path> can't be read: <reason>.` line has to take the reason back out
 * of it rather than have its own.
 */
function profileReason(name: string, error: ConfigError): string {
  const prefix = `ERROR: profile ${name}: `;
  const body = error.message.startsWith(prefix)
    ? error.message.slice(prefix.length)
    : error.message;
  return body.endsWith(".") ? body.slice(0, -1) : body;
}

/** The repo's profile errors, from contract "Retire", "The repo store". */
const REPO_PROFILE_ERRORS: ProfileErrorLines = {
  unreadable: (name, reason) =>
    unreadableRepoError(repoProfilePath(name), reason),
  missing: (name) => ({
    message: `ERROR: profile ${name} not found: ${repoProfilePath(name)}`,
    code: 2,
  }),
  parse: (name, error) =>
    unreadableRepoError(repoProfilePath(name), profileReason(name, error)),
};

/** How a repo store read reports the files it can't read. */
interface RepoErrorLines {
  readonly record: (relativePath: string, reason: string) => ConfigError;
  readonly unreadableRecord: (
    relativePath: string,
    reason: string,
  ) => ConfigError;
  readonly profiles: ProfileErrorLines;
}

/** The state folder's lines, kept for `setup --replace` reading it as a store. */
const STATE_REPO_ERROR_LINES: RepoErrorLines = {
  record: (_relativePath, reason) => ({
    message: recordMessage(reason),
    code: 2,
  }),
  unreadableRecord: () => unreadableRecordError(),
  profiles: STATE_PROFILE_ERRORS,
};

/** The repo's lines, from contract "Retire", "The repo store". */
const REPO_STORE_ERROR_LINES: RepoErrorLines = {
  record: unreadableRepoError,
  unreadableRecord: unreadableRepoError,
  profiles: REPO_PROFILE_ERRORS,
};

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
  lines: ProfileErrorLines = STATE_PROFILE_ERRORS,
): LoadResult<Profile, ConfigError> {
  const path = join(folder, `${name}${PROFILE_EXTENSION}`);
  const read = readFileText(path);
  if (read.kind === "unreadable") {
    return { ok: false, error: lines.unreadable(name, read.reason) };
  }
  if (read.kind === "missing") {
    return { ok: false, error: lines.missing(name, path) };
  }
  const parsed = parseProfile(name, read.text, config);
  if (!parsed.ok) {
    return { ok: false, error: lines.parse(name, parsed.error) };
  }
  return parsed;
}

/** Every profile in a profiles folder, sorted by name, with its parse result. */
function readProfiles(
  folder: string,
  config: ConfigV2,
  lines: ProfileErrorLines = STATE_PROFILE_ERRORS,
): LoadResult<readonly Profile[], ConfigError> {
  const profiles: Profile[] = [];
  for (const name of jsonNames(folder)) {
    const parsed = readProfileFile(folder, name, config, lines);
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
  readonly records: readonly MachineRecord[];
  readonly location: StoreLocation;
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
      records: files.records,
      location: files.location,
    },
  };
}

/**
 * Contract "Where records are kept": the record, its profile and every profile
 * in the same store, read from local state, or from the repo's `machines/` and
 * `profiles/` when the record is a `{"name", "home": "repo"}` pointer. A
 * pointer reads only `machines/<name>.json` and its own profile for the run;
 * only `profile retire`'s "used by" check asks for every record. No record file
 * means no record and only local profiles: a machine reads before `setup`
 * writes one. A bad record, a missing profile and a pointer whose machine file
 * isn't in the clone stop with exit code 2.
 */
export function readStore(
  stateFolder: string,
  repoRoot: string,
  config: ConfigV2,
  options: StoreOptions = {},
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
    return {
      ok: true,
      value: {
        profiles: profiles.value,
        records: [],
        location: stateLocation(stateFolder),
      },
    };
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
        records: [record.value],
        location: stateLocation(stateFolder),
      },
      config,
    );
  }

  const own = readRepoRecord(repoRoot, repoName, config);
  if (!own.ok) {
    return own;
  }
  const record = own.value;
  if (record === undefined) {
    const machineFile = `${MACHINES_FOLDER}/${repoName}${PROFILE_EXTENSION}`;
    return {
      ok: false,
      error: {
        message: `ERROR: machine ${repoName} not found: ${machineFile}`,
        code: 2,
      },
    };
  }
  let records: readonly MachineRecord[] = [record];
  if (options.usedBy === true) {
    const all = readRepoRecords(repoRoot, config);
    if (!all.ok) {
      return all;
    }
    records = all.value;
  }
  const profiles = readProfiles(
    join(repoRoot, PROFILES_FOLDER),
    config,
    REPO_PROFILE_ERRORS,
  );
  if (!profiles.ok) {
    return profiles;
  }
  const profile = profiles.value.find((item) => item.name === record.profile);
  if (profile === undefined) {
    return {
      ok: false,
      error: {
        message:
          `ERROR: profile ${record.profile} not found: ` +
          repoProfilePath(record.profile),
        code: 2,
      },
    };
  }
  return {
    ok: true,
    value: {
      record,
      profile,
      profiles: profiles.value,
      records,
      location: {
        recordFile: join(
          repoRoot,
          MACHINES_FOLDER,
          `${repoName}${PROFILE_EXTENSION}`,
        ),
        profilesFolder: join(repoRoot, PROFILES_FOLDER),
        privateFiles: false,
      },
    },
  };
}

/** One record from the repo's `machines/`, or `undefined` when the clone
 * doesn't hold it. */
function readRepoRecord(
  repoRoot: string,
  name: string,
  config: ConfigV2,
  lines: RepoErrorLines = REPO_STORE_ERROR_LINES,
): LoadResult<MachineRecord | undefined, ConfigError> {
  const relativePath = `${MACHINES_FOLDER}/${name}${PROFILE_EXTENSION}`;
  const read = readFileText(
    join(repoRoot, MACHINES_FOLDER, `${name}${PROFILE_EXTENSION}`),
  );
  if (read.kind === "unreadable") {
    return {
      ok: false,
      error: lines.unreadableRecord(relativePath, read.reason),
    };
  }
  if (read.kind === "missing") {
    return { ok: true, value: undefined };
  }
  const record = parseRecord(read.text, config);
  if (!record.ok) {
    return {
      ok: false,
      error: lines.record(relativePath, record.error),
    };
  }
  return { ok: true, value: record.value };
}

/** Every record under `machines/`, sorted by name, with the given error lines. */
function readRepoRecords(
  repoRoot: string,
  config: ConfigV2,
  lines: RepoErrorLines = REPO_STORE_ERROR_LINES,
): LoadResult<readonly MachineRecord[], ConfigError> {
  const records: MachineRecord[] = [];
  for (const name of jsonNames(join(repoRoot, MACHINES_FOLDER))) {
    const record = readRepoRecord(repoRoot, name, config, lines);
    if (!record.ok) {
      return record;
    }
    if (record.value !== undefined) {
      records.push(record.value);
    }
  }
  return { ok: true, value: records };
}

/** Every record under `machines/` and every profile under `profiles/`, sorted
 * by name, with the given error lines. */
function readRepoEntries(
  repoRoot: string,
  config: ConfigV2,
  lines: RepoErrorLines,
): LoadResult<RepoStore, ConfigError> {
  const records = readRepoRecords(repoRoot, config, lines);
  if (!records.ok) {
    return records;
  }
  const profiles = readProfiles(
    join(repoRoot, PROFILES_FOLDER),
    config,
    lines.profiles,
  );
  if (!profiles.ok) {
    return profiles;
  }
  return {
    ok: true,
    value: { records: records.value, profiles: profiles.value },
  };
}

/**
 * Contract "Where records are kept": the repo store, every machine record in
 * the clone's `machines/` and every profile in its `profiles/`, sorted by
 * name. `setup` reads it when the repo is private. Errors keep the lines the
 * state folder uses, since `setup --replace` also reads a state folder this
 * way; a pointer record's reads use the repo's own lines.
 */
export function readRepoStore(
  repoRoot: string,
  config: ConfigV2,
): LoadResult<RepoStore, ConfigError> {
  return readRepoEntries(repoRoot, config, STATE_REPO_ERROR_LINES);
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

/** Write a store's file: private in the state folder, unchanged in the repo. */
function writeStoreFile(
  location: StoreLocation,
  path: string,
  text: string,
): void {
  if (location.privateFiles) {
    writePrivateFile(path, text);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Write a record to the store's record file. */
export function writeStoreRecord(
  location: StoreLocation,
  record: MachineRecord,
): void {
  writeStoreFile(location, location.recordFile, recordText(record));
}

/** Write a profile to the store's profiles folder. */
export function writeStoreProfile(
  location: StoreLocation,
  profile: Profile,
): void {
  writeStoreFile(
    location,
    join(location.profilesFolder, `${profile.name}${PROFILE_EXTENSION}`),
    profileText(profile),
  );
}

/** Write this machine's record to `<state>/machine.json`. */
export function writeRecord(stateFolder: string, record: MachineRecord): void {
  writeStoreRecord(stateLocation(stateFolder), record);
}

/** Write a profile to `<state>/profiles/<name>.json`. */
export function writeProfile(stateFolder: string, profile: Profile): void {
  writeStoreProfile(stateLocation(stateFolder), profile);
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

/** Why the first backup refuses a target that runs through a symlink. */
const SYMLINK_REASON = "a symlink";

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
        repoProfile.value === undefined ? {} : { profile: repoProfile.value },
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
 * Whether a first backup target runs through a symlink anywhere from the repo
 * root down to the file itself. Missing components are fine: the write creates
 * them below the clone.
 */
function runsThroughSymlink(repoRoot: string, relativePath: string): boolean {
  const parts = relativePath.split("/");
  for (let index = 1; index <= parts.length; index += 1) {
    const component = join(repoRoot, ...parts.slice(0, index));
    try {
      if (lstatSync(component).isSymbolicLink()) {
        return true;
      }
    } catch (error) {
      if (isMissingError(error)) {
        return false;
      }
      throw error;
    }
  }
  return false;
}

/** A file this first backup wrote, with the bytes it held before it. */
interface WrittenBackupFile {
  readonly path: string;
  readonly earlier: Buffer | undefined;
}

/** The bytes a first backup target held before the write, if it existed. */
function readEarlierBytes(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch (error) {
    if (isMissingError(error)) {
      return undefined;
    }
    throw error;
  }
}

/** Undo a failed first backup in reverse, so the repo is as it was. */
function undoFirstBackup(written: readonly WrittenBackupFile[]): void {
  for (let index = written.length - 1; index >= 0; index -= 1) {
    const file = written[index];
    if (file === undefined) {
      continue;
    }
    try {
      if (file.earlier === undefined) {
        unlinkSync(file.path);
      } else {
        writeFileSync(file.path, file.earlier);
      }
    } catch {
      // Best effort: the write error is the line the contract reports, so a
      // failed undo must not replace it.
    }
  }
}

/**
 * Contract "The first backup": write the files into the repo, then make
 * `<state>/machine.json` the pointer. A failed write stops before the pointer
 * and undoes the files already written, so the record stays local and the next
 * export tries again.
 */
export function writeFirstBackup(
  stateFolder: string,
  repoRoot: string,
  name: string,
  files: readonly FirstBackupFile[],
): LoadResult<undefined, ConfigError> {
  for (const file of files) {
    let symlink: boolean;
    try {
      symlink = runsThroughSymlink(repoRoot, file.path);
    } catch (error) {
      return {
        ok: false,
        error: { message: firstBackupStopped(file.path, error), code: 1 },
      };
    }
    if (symlink) {
      return {
        ok: false,
        error: {
          message: firstBackupStopped(file.path, new Error(SYMLINK_REASON)),
          code: 1,
        },
      };
    }
  }
  const written: WrittenBackupFile[] = [];
  for (const file of files) {
    const target = join(repoRoot, ...file.path.split("/"));
    try {
      const earlier = readEarlierBytes(target);
      mkdirSync(dirname(target), { recursive: true });
      written.push({ path: target, earlier });
      writeFileSync(target, file.text);
    } catch (error) {
      undoFirstBackup(written);
      return {
        ok: false,
        error: { message: firstBackupStopped(file.path, error), code: 1 },
      };
    }
  }
  try {
    writePrivateFile(join(stateFolder, MACHINE_FILE), pointerText(name));
  } catch (error) {
    undoFirstBackup(written);
    return {
      ok: false,
      error: { message: firstBackupStopped(MACHINE_FILE, error), code: 1 },
    };
  }
  return { ok: true, value: undefined };
}
