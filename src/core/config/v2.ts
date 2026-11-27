import { hasDotDotSegment, isValidDconfPath } from "./dconf-path.ts";
import type { ConfigError, ConfigV2, MergeType, Os, Result, SuggestSource } from "./types.ts";
import { SUGGEST_SOURCES } from "./types.ts";

const CONFIG_FILE = "sync-config.json";

const MERGE_TYPES: readonly MergeType[] = ["whole", "json", "import", "dconf", "dir"];

const OSES: readonly Os[] = ["windows", "linux", "macos"];

/** A `defaultEnv` names an environment variable, so it has to be a valid name. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const LAYER_PLACEHOLDER = "{layer}";

const BACKSLASH = "\\";

const DRIVE_LETTER_RE = /^[A-Za-z]:/;

// Fields a merge can not use, in the order the first present one is named.
const DISALLOWED_FIELDS: Readonly<Record<MergeType, readonly string[]>> = {
  dir: ["sanitize", "dconfPath", "keys"],
  dconf: ["localPath", "sanitize"],
  whole: ["dconfPath", "keys"],
  json: ["dconfPath", "keys"],
  import: ["dconfPath", "keys"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMergeType(value: unknown): value is MergeType {
  return typeof value === "string" && (MERGE_TYPES as readonly string[]).includes(value);
}

function isOsList(value: unknown): value is readonly Os[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && (OSES as readonly string[]).includes(item))
  );
}

/** The first `localPaths` key that is not an OS name, if any. */
function unknownLocalPathsKey(localPaths: unknown): string | undefined {
  if (!isRecord(localPaths)) {
    return undefined;
  }
  return Object.keys(localPaths).find((key) => !(OSES as readonly string[]).includes(key));
}

function hasInvalidDefaultEnv(sanitize: unknown): boolean {
  return (
    Array.isArray(sanitize) &&
    sanitize.some(
      (rule) =>
        isRecord(rule) &&
        Object.hasOwn(rule, "defaultEnv") &&
        (typeof rule.defaultEnv !== "string" || !ENV_NAME_RE.test(rule.defaultEnv)),
    )
  );
}

function isSuggestSource(value: unknown): value is SuggestSource {
  return (SUGGEST_SOURCES as readonly unknown[]).includes(value);
}

/**
 * A rule's `suggest` as a list: one source, or a non-empty list of distinct
 * sources. Undefined when it is neither.
 */
function suggestList(value: unknown): readonly SuggestSource[] | undefined {
  if (isSuggestSource(value)) {
    return [value];
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(isSuggestSource) ||
    new Set(value).size !== value.length
  ) {
    return undefined;
  }
  return value;
}

/**
 * A rule's `suggest` names as strings when its shape is right (one string, or
 * a non-empty list of distinct strings), whether or not this program knows
 * them. Undefined for a wrong shape.
 */
function suggestNames(value: unknown): readonly string[] | undefined {
  if (typeof value === "string") {
    return [value];
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((name) => typeof name === "string") ||
    new Set(value).size !== value.length
  ) {
    return undefined;
  }
  return value;
}

/**
 * The first source name the entry's rules hold that this program doesn't
 * know: a newer config may name a source a newer mksync has. Undefined when
 * every name is known, or when any rule's `suggest` has a wrong shape, which
 * keeps the invalid-suggest line.
 */
function unknownSuggestSource(sanitize: unknown): string | undefined {
  if (!Array.isArray(sanitize)) {
    return undefined;
  }
  const lists: (readonly string[] | undefined)[] = sanitize
    .filter((rule) => isRecord(rule) && Object.hasOwn(rule, "suggest"))
    .map((rule) => suggestNames((rule as Record<string, unknown>).suggest));
  if (lists.some((names) => names === undefined)) {
    return undefined;
  }
  return lists.flatMap((names) => names ?? []).find((name) => !isSuggestSource(name));
}

function hasInvalidSuggest(sanitize: unknown): boolean {
  return (
    Array.isArray(sanitize) &&
    sanitize.some(
      (rule) =>
        isRecord(rule) &&
        Object.hasOwn(rule, "suggest") &&
        suggestList(rule.suggest) === undefined,
    )
  );
}

/** An entry with each rule's `suggest` kept as a list, once the entry is valid. */
function withSuggestLists(entry: unknown): unknown {
  if (!isRecord(entry) || !Array.isArray(entry.sanitize)) {
    return entry;
  }
  const sanitize: readonly unknown[] = entry.sanitize;
  return {
    ...entry,
    sanitize: sanitize.map((rule) =>
      isRecord(rule) && Object.hasOwn(rule, "suggest")
        ? { ...rule, suggest: suggestList(rule.suggest) }
        : rule,
    ),
  };
}

function shown(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

function hasBackslash(value: unknown): boolean {
  return typeof value === "string" && value.includes(BACKSLASH);
}

function localPathsHaveBackslash(localPaths: unknown): boolean {
  return isRecord(localPaths) && Object.values(localPaths).some(hasBackslash);
}

function hasEscapeBackslashes(sanitize: unknown): boolean {
  return (
    Array.isArray(sanitize) &&
    sanitize.some((rule) => isRecord(rule) && rule.escapeBackslashes === true)
  );
}

interface ConfigMessages {
  readonly invalidJson: string;
  readonly newerMksync: string;
  readonly unsupportedVersion: (version: string) => string;
  readonly unsafePath: (file: string) => string;
  readonly unknownModule: (file: string, module: string) => string;
  readonly unknownMerge: (file: string, merge: string) => string;
  readonly escapeBackslashes: (file: string) => string;
  readonly elevate: (file: string) => string;
  readonly linked: (file: string) => string;
  readonly importName: (file: string) => string;
  readonly dconfPath: (file: string) => string;
  readonly backslash: (file: string) => string;
  readonly os: (file: string, os: string, module: string) => string;
  readonly entryShape: (file: string) => string;
  readonly entryOs: (file: string) => string;
  readonly moduleOs: (module: string) => string;
  readonly canNotUse: (file: string, field: string, merge: MergeType) => string;
  readonly insideDir: (file: string, dir: string) => string;
  readonly trailingSlash: (file: string) => string;
  readonly keys: (file: string) => string;
  readonly localPathsKey: (file: string, key: string) => string;
  readonly defaultEnv: (file: string) => string;
  readonly suggest: (file: string) => string;
  readonly suggestSource: (file: string, source: string) => string;
}

/** Every error line names the config file the text came from. */
function configMessages(configFile: string): ConfigMessages {
  const prefix = `ERROR: ${configFile}`;
  return {
    invalidJson: `${prefix}: invalid JSON.`,
    newerMksync: `${prefix}: this config needs a newer mksync: run mksync update.`,
    unsupportedVersion: (version) => `${prefix}: unsupported config schemaVersion ${version}.`,
    unsafePath: (file) => `${prefix}: entry ${file} has an unsafe path.`,
    unknownModule: (file, module) => `${prefix}: entry ${file} names unknown module ${module}.`,
    unknownMerge: (file, merge) => `${prefix}: entry ${file} has an unknown merge ${merge}.`,
    escapeBackslashes: (file) =>
      `${prefix}: entry ${file} can not use escapeBackslashes with merge json.`,
    elevate: (file) => `${prefix}: entry ${file} has elevate other than false.`,
    linked: (file) => `${prefix}: entry ${file} has linked other than true.`,
    importName: (file) => `${prefix}: entry ${file} needs {layer} in importName.`,
    dconfPath: (file) => `${prefix}: entry ${file} needs a dconfPath like /org/gnome/shell/.`,
    backslash: (file) => `${prefix}: entry ${file} has a backslash in localPath.`,
    os: (file, os, module) =>
      `${prefix}: entry ${file} lists os ${os} outside module ${module}.`,
    entryShape: (file) => `${prefix}: entry ${file} needs file and localPath as strings.`,
    entryOs: (file) =>
      `${prefix}: entry ${file} has an os that is not a list of linux, macos or windows.`,
    moduleOs: (module) =>
      `${prefix}: module ${module} has an os that is not a list of linux, macos or windows.`,
    canNotUse: (file, field, merge) =>
      `${prefix}: entry ${file} can not use ${field} with merge ${merge}.`,
    insideDir: (file, dir) => `${prefix}: entry ${file} is inside dir entry ${dir}.`,
    trailingSlash: (file) => `${prefix}: entry ${file} has a trailing / in file.`,
    keys: (file) => `${prefix}: entry ${file} needs keys as a non-empty list of strings.`,
    localPathsKey: (file, key) => `${prefix}: entry ${file} has an unknown localPaths key ${key}.`,
    defaultEnv: (file) => `${prefix}: entry ${file} has an invalid defaultEnv.`,
    suggest: (file) => `${prefix}: entry ${file} has an invalid suggest.`,
    suggestSource: (file, source) =>
      `${prefix}: entry ${file} has an unknown suggest source ${source}; if the config is newer, run mksync update.`,
  };
}

function disallowedField(record: Record<string, unknown>, merge: MergeType): string | undefined {
  return DISALLOWED_FIELDS[merge].find((field) => Object.hasOwn(record, field));
}

function isUnsafeFile(file: string): boolean {
  return (
    file === "" ||
    file.startsWith("/") ||
    DRIVE_LETTER_RE.test(file) ||
    hasDotDotSegment(file) ||
    file.includes(BACKSLASH)
  );
}

function isKeyList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string")
  );
}

function failure(message: string, code: 1 | 2): Result<ConfigV2, ConfigError> {
  return { ok: false, error: { message, code } };
}

export function parseV2(
  text: string,
  file: string = CONFIG_FILE,
): Result<ConfigV2, ConfigError> {
  const messages = configMessages(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failure(messages.invalidJson, 1);
  }
  if (!isRecord(parsed)) {
    return failure(messages.invalidJson, 1);
  }

  const schemaVersion = parsed.schemaVersion;
  if (
    Object.hasOwn(parsed, "schemaVersion") &&
    typeof schemaVersion === "number" &&
    schemaVersion > 2
  ) {
    return failure(messages.newerMksync, 2);
  }
  if (!Object.hasOwn(parsed, "schemaVersion") || schemaVersion !== 2) {
    const version = Object.hasOwn(parsed, "schemaVersion")
      ? JSON.stringify(schemaVersion)
      : "none";
    return failure(messages.unsupportedVersion(version), 2);
  }

  if (!isRecord(parsed.modules) || !Array.isArray(parsed.entries)) {
    return failure(messages.invalidJson, 1);
  }
  const modules = parsed.modules;
  const entries: readonly unknown[] = parsed.entries;

  for (const [name, definition] of Object.entries(modules)) {
    if (isRecord(definition) && Object.hasOwn(definition, "os") && !isOsList(definition.os)) {
      return failure(messages.moduleOs(name), 1);
    }
  }

  const parsedEntries: { readonly file: string; readonly merge: MergeType }[] = [];

  for (const entry of entries) {
    const record = isRecord(entry) ? entry : {};
    const entryValue = isRecord(entry) ? record.file : entry;
    const file =
      typeof entryValue === "string"
        ? entryValue
        : entryValue === undefined
          ? "none"
          : shown(entryValue);
    if (!isRecord(entry) || typeof record.file !== "string") {
      return failure(messages.entryShape(file), 1);
    }

    if (isUnsafeFile(file)) {
      return failure(messages.unsafePath(file), 1);
    }

    const moduleName = record.module;
    if (typeof moduleName !== "string" || !Object.hasOwn(modules, moduleName)) {
      return failure(messages.unknownModule(file, shown(moduleName)), 1);
    }

    const merge = record.merge;
    if (!isMergeType(merge)) {
      return failure(messages.unknownMerge(file, shown(merge)), 1);
    }

    if (merge === "dconf" && (typeof record.dconfPath !== "string" || !isValidDconfPath(record.dconfPath))) {
      return failure(messages.dconfPath(file), 1);
    }

    // A dconf entry has no local path: the dconf folder is its destination.
    if (merge !== "dconf" && typeof record.localPath !== "string") {
      return failure(messages.entryShape(file), 1);
    }

    if (Object.hasOwn(record, "os") && !isOsList(record.os)) {
      return failure(messages.entryOs(file), 1);
    }

    if (merge === "json" && hasEscapeBackslashes(record.sanitize)) {
      return failure(messages.escapeBackslashes(file), 1);
    }

    if (Object.hasOwn(record, "elevate") && record.elevate !== false) {
      return failure(messages.elevate(file), 1);
    }

    if (Object.hasOwn(record, "linked") && record.linked !== true) {
      return failure(messages.linked(file), 1);
    }

    if (
      merge === "import" &&
      (typeof record.importName !== "string" || !record.importName.includes(LAYER_PLACEHOLDER))
    ) {
      return failure(messages.importName(file), 1);
    }

    if (hasBackslash(record.localPath) || localPathsHaveBackslash(record.localPaths)) {
      return failure(messages.backslash(file), 1);
    }

    const unknownKey = unknownLocalPathsKey(record.localPaths);
    if (unknownKey !== undefined) {
      return failure(messages.localPathsKey(file, unknownKey), 1);
    }

    if (hasInvalidDefaultEnv(record.sanitize)) {
      return failure(messages.defaultEnv(file), 1);
    }

    const unknownSource = unknownSuggestSource(record.sanitize);
    if (unknownSource !== undefined) {
      return failure(messages.suggestSource(file, unknownSource), 2);
    }

    if (hasInvalidSuggest(record.sanitize)) {
      return failure(messages.suggest(file), 1);
    }

    const moduleDef = modules[moduleName];
    const moduleOs = isRecord(moduleDef) ? moduleDef.os : undefined;
    if (Array.isArray(moduleOs) && Array.isArray(record.os)) {
      const outside = record.os.find((os) => !moduleOs.includes(os));
      if (outside !== undefined) {
        return failure(messages.os(file, shown(outside), moduleName), 1);
      }
    }

    const field = disallowedField(record, merge);
    if (field !== undefined) {
      return failure(messages.canNotUse(file, field, merge), 1);
    }

    if (file.endsWith("/")) {
      return failure(messages.trailingSlash(file), 1);
    }

    if (merge === "dconf" && Object.hasOwn(record, "keys") && !isKeyList(record.keys)) {
      return failure(messages.keys(file), 1);
    }

    parsedEntries.push({ file, merge });
  }

  const dirFiles = parsedEntries
    .filter((entry) => entry.merge === "dir")
    .map((entry) => entry.file);
  for (const entry of parsedEntries) {
    const dir = dirFiles.find((candidate) => entry.file.startsWith(`${candidate}/`));
    if (dir !== undefined) {
      return failure(messages.insideDir(entry.file, dir), 1);
    }
  }

  const normalized = { ...parsed, entries: entries.map(withSuggestLists) };
  return { ok: true, value: normalized as unknown as ConfigV2 };
}
