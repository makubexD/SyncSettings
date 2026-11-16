import type {
  ConfigError,
  ConfigV2,
  ConfigV2Entry,
  Result,
} from "./types.ts";

/** A profile file: the modules one kind of machine gets, plus what's personal
 * to that job, per the design's "Modules and profiles". */
export interface Profile {
  readonly name: string;
  readonly modules: readonly string[];
  readonly values: Readonly<Record<string, string>>;
  readonly destinations: Readonly<Record<string, string>>;
  readonly retired: boolean;
  /** Linked folders answered "this profile" (contract "Linked folders"),
   * absent when the file hasn't an `entries` list. */
  readonly entries?: readonly ConfigV2Entry[];
}

const FIELDS: readonly string[] = [
  "modules",
  "values",
  "destinations",
  "retired",
  "entries",
];

const NOT_VALID_JSON = "not valid JSON";

/** The layer slots a new setting can go to: the four layers, `base` included
 * for an answer of "all machines". Every other value is refused. */
const DESTINATION_LAYERS: readonly string[] = [
  "base",
  "os",
  "profile",
  "machine",
];

/** A linked-folder answer: `linked: <localPath>` → `no`. */
const LINKED_DESTINATION_PREFIX = "linked: ";

const LINKED_DESTINATION_VALUE = "no";

/** A linked entry's `file` sits under its layer's `linked/` folder, so the
 * repo path is `profiles/<p>/linked/<folder>` or `machines/<m>/linked/<folder>`. */
const LINKED_FOLDER = "linked/";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(name: string, reason: string): Result<Profile, ConfigError> {
  return {
    ok: false,
    error: { message: `ERROR: profile ${name}: ${reason}.`, code: 2 },
  };
}

function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.every((item) => typeof item === "string")
    ? (value as readonly string[])
    : undefined;
}

function stringRecord(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries: [string, string][] = [];
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      return undefined;
    }
    entries.push([key, item]);
  }
  // Object.fromEntries makes each key an own data property, so a `__proto__`
  // key in the file stays plain data.
  return Object.fromEntries(entries);
}

/** One `dir` entry for a linked folder: the fields config v2 needs, with its
 * `file` under the layer's `linked/` folder. */
function linkedEntry(
  value: unknown,
  config: ConfigV2,
): Result<ConfigV2Entry, string> {
  if (!isRecord(value)) {
    return {
      ok: false,
      error: "entry none needs file and localPath as strings",
    };
  }
  const file = value.file;
  const shownFile = typeof file === "string" ? file : "none";
  if (typeof file !== "string" || typeof value.localPath !== "string") {
    return {
      ok: false,
      error: `entry ${shownFile} needs file and localPath as strings`,
    };
  }
  if (!file.startsWith(LINKED_FOLDER) || file.length === LINKED_FOLDER.length) {
    return { ok: false, error: `entry ${file} is outside linked/` };
  }
  const moduleName = value.module;
  if (
    typeof moduleName !== "string" ||
    !Object.hasOwn(config.modules, moduleName)
  ) {
    const shownModule =
      typeof moduleName === "string" ? moduleName : "none";
    return {
      ok: false,
      error: `entry ${file} names unknown module ${shownModule}`,
    };
  }
  if (value.merge !== "dir") {
    return { ok: false, error: `entry ${file} is not a dir` };
  }
  return { ok: true, value: value as unknown as ConfigV2Entry };
}

/**
 * An `entries` list on a profile or a machine record: only `dir` entries,
 * each with `file` under the layer's `linked/` folder and a module config v2
 * knows (contract "Linked folders"). The reasons are config v2's entry
 * messages; the profile and record parsers put their own `ERROR:` line in
 * front of them.
 */
export function parseLinkedEntries(
  value: unknown,
  config: ConfigV2,
): Result<readonly ConfigV2Entry[], string> {
  if (!Array.isArray(value)) {
    return { ok: false, error: "entries has the wrong type" };
  }
  const entries: ConfigV2Entry[] = [];
  for (const item of value) {
    const parsed = linkedEntry(item, config);
    if (!parsed.ok) {
      return parsed;
    }
    entries.push(parsed.value);
  }
  return { ok: true, value: entries };
}

/** Every destination must name one of the four layer slots, or be a linked
 * folder's `no`; the reason names the key, since `destinations has the wrong
 * type` would hide which. */
function destinationRecord(
  value: unknown,
): Result<Readonly<Record<string, string>>, string> {
  if (!isRecord(value)) {
    return { ok: false, error: "destinations has the wrong type" };
  }
  const entries: [string, string][] = [];
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith(LINKED_DESTINATION_PREFIX)) {
      if (item !== LINKED_DESTINATION_VALUE) {
        return { ok: false, error: `destination ${key} is not no` };
      }
      entries.push([key, item]);
      continue;
    }
    if (typeof item !== "string" || !DESTINATION_LAYERS.includes(item)) {
      return { ok: false, error: `destination ${key} is not a layer` };
    }
    entries.push([key, item]);
  }
  return { ok: true, value: Object.fromEntries(entries) };
}

/**
 * Parses a profile file. All errors are exit code 2: the text isn't JSON or
 * isn't an object (`not valid JSON`), a top-level key other than the five
 * (`unknown field <f>`), a known field of the wrong type (`<f> has the wrong
 * type`), a module name config v2 doesn't know (`unknown module <m>`), a
 * destination that isn't `base`, `os`, `profile`, `machine` or
 * `linked: <path>` → `no` (`destination <key> is not a layer`, or
 * `destination <key> is not no`), and a linked entry that isn't a `dir` entry
 * under `linked/` (`entry <file> ...`).
 * Missing fields default to no modules, no values, no destinations, not
 * retired and no entries.
 */
export function parseProfile(
  name: string,
  text: string,
  config: ConfigV2,
): Result<Profile, ConfigError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failure(name, NOT_VALID_JSON);
  }
  if (!isRecord(parsed)) {
    return failure(name, NOT_VALID_JSON);
  }

  for (const key of Object.keys(parsed)) {
    if (!FIELDS.includes(key)) {
      return failure(name, `unknown field ${key}`);
    }
  }

  const modules =
    parsed.modules === undefined ? [] : stringList(parsed.modules);
  if (modules === undefined) {
    return failure(name, "modules has the wrong type");
  }

  const values =
    parsed.values === undefined ? {} : stringRecord(parsed.values);
  if (values === undefined) {
    return failure(name, "values has the wrong type");
  }

  const destinations =
    parsed.destinations === undefined
      ? { ok: true as const, value: {} }
      : destinationRecord(parsed.destinations);
  if (!destinations.ok) {
    return failure(name, destinations.error);
  }

  const retired = parsed.retired === undefined ? false : parsed.retired;
  if (typeof retired !== "boolean") {
    return failure(name, "retired has the wrong type");
  }

  const entries =
    parsed.entries === undefined
      ? undefined
      : parseLinkedEntries(parsed.entries, config);
  if (entries !== undefined && !entries.ok) {
    return failure(name, entries.error);
  }

  for (const module of modules) {
    if (!Object.hasOwn(config.modules, module)) {
      return failure(name, `unknown module ${module}`);
    }
  }

  const profile: Profile = {
    name,
    modules,
    values,
    destinations: destinations.value,
    retired,
  };
  return {
    ok: true,
    value:
      entries === undefined ? profile : { ...profile, entries: entries.value },
  };
}
