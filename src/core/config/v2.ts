import { hasDotDotSegment, isValidDconfPath } from "./dconf-path.ts";
import type { ConfigError, ConfigV2, MergeType, Os, Result } from "./types.ts";

const CONFIG_FILE = "sync-config.v2.json";

const MERGE_TYPES: readonly MergeType[] = ["whole", "json", "import", "dconf", "dir"];

const OSES: readonly Os[] = ["windows", "linux", "macos"];

const LAYER_PLACEHOLDER = "{layer}";

const BACKSLASH = "\\";

const DRIVE_LETTER_RE = /^[A-Za-z]:/;

const INVALID_JSON_MESSAGE = `ERROR: ${CONFIG_FILE}: invalid JSON.`;

// Fields a merge can not use, in the order the first present one is named.
const DISALLOWED_FIELDS: Readonly<Record<MergeType, readonly string[]>> = {
  dir: ["sanitize", "scanLinks", "dconfPath", "keys"],
  dconf: ["localPath", "sanitize", "scanLinks"],
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

function unsafePathMessage(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} has an unsafe path.`;
}

function unknownModuleMessage(file: string, module: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} names unknown module ${module}.`;
}

function unknownMergeMessage(file: string, merge: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} has an unknown merge ${merge}.`;
}

function escapeBackslashesMessage(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} can not use escapeBackslashes with merge json.`;
}

function elevateMessage(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} has elevate other than false.`;
}

function linkedMessage(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} has linked other than true.`;
}

function importNameMessage(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} needs {layer} in importName.`;
}

function dconfPathMessage(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} needs a dconfPath like /org/gnome/shell/.`;
}

function backslashMessage(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} has a backslash in localPath.`;
}

function osMessage(file: string, os: string, module: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} lists os ${os} outside module ${module}.`;
}

function entryShapeMessage(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} needs file and localPath as strings.`;
}

function entryOsMessage(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} has an os that is not a list of linux, macos or windows.`;
}

function moduleOsMessage(module: string): string {
  return `ERROR: ${CONFIG_FILE}: module ${module} has an os that is not a list of linux, macos or windows.`;
}

function canNotUseMessage(file: string, field: string, merge: MergeType): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} can not use ${field} with merge ${merge}.`;
}

function insideDirMessage(file: string, dir: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} is inside dir entry ${dir}.`;
}

function trailingSlashMessage(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} has a trailing / in file.`;
}

function keysMessage(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} needs keys as a non-empty list of strings.`;
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

export function parseV2(text: string): Result<ConfigV2, ConfigError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failure(INVALID_JSON_MESSAGE, 1);
  }
  if (!isRecord(parsed)) {
    return failure(INVALID_JSON_MESSAGE, 1);
  }

  const schemaVersion = parsed.schemaVersion;
  if (
    Object.hasOwn(parsed, "schemaVersion") &&
    typeof schemaVersion === "number" &&
    schemaVersion > 2
  ) {
    return failure(
      `ERROR: ${CONFIG_FILE}: this config needs a newer mksync: run mksync update.`,
      2,
    );
  }
  if (!Object.hasOwn(parsed, "schemaVersion") || schemaVersion !== 2) {
    const version = Object.hasOwn(parsed, "schemaVersion")
      ? JSON.stringify(schemaVersion)
      : "none";
    return failure(`ERROR: ${CONFIG_FILE}: unsupported config schemaVersion ${version}.`, 2);
  }

  if (!isRecord(parsed.modules) || !Array.isArray(parsed.entries)) {
    return failure(INVALID_JSON_MESSAGE, 1);
  }
  const modules = parsed.modules;
  const entries: readonly unknown[] = parsed.entries;

  for (const [name, definition] of Object.entries(modules)) {
    if (isRecord(definition) && Object.hasOwn(definition, "os") && !isOsList(definition.os)) {
      return failure(moduleOsMessage(name), 1);
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
      return failure(entryShapeMessage(file), 1);
    }

    if (isUnsafeFile(file)) {
      return failure(unsafePathMessage(file), 1);
    }

    const moduleName = record.module;
    if (typeof moduleName !== "string" || !Object.hasOwn(modules, moduleName)) {
      return failure(unknownModuleMessage(file, shown(moduleName)), 1);
    }

    const merge = record.merge;
    if (!isMergeType(merge)) {
      return failure(unknownMergeMessage(file, shown(merge)), 1);
    }

    if (merge === "dconf" && (typeof record.dconfPath !== "string" || !isValidDconfPath(record.dconfPath))) {
      return failure(dconfPathMessage(file), 1);
    }

    // A dconf entry has no local path: the dconf folder is its destination.
    if (merge !== "dconf" && typeof record.localPath !== "string") {
      return failure(entryShapeMessage(file), 1);
    }

    if (Object.hasOwn(record, "os") && !isOsList(record.os)) {
      return failure(entryOsMessage(file), 1);
    }

    if (merge === "json" && hasEscapeBackslashes(record.sanitize)) {
      return failure(escapeBackslashesMessage(file), 1);
    }

    if (Object.hasOwn(record, "elevate") && record.elevate !== false) {
      return failure(elevateMessage(file), 1);
    }

    if (Object.hasOwn(record, "linked") && record.linked !== true) {
      return failure(linkedMessage(file), 1);
    }

    if (
      merge === "import" &&
      (typeof record.importName !== "string" || !record.importName.includes(LAYER_PLACEHOLDER))
    ) {
      return failure(importNameMessage(file), 1);
    }

    if (hasBackslash(record.localPath) || localPathsHaveBackslash(record.localPaths)) {
      return failure(backslashMessage(file), 1);
    }

    const moduleDef = modules[moduleName];
    const moduleOs = isRecord(moduleDef) ? moduleDef.os : undefined;
    if (Array.isArray(moduleOs) && Array.isArray(record.os)) {
      const outside = record.os.find((os) => !moduleOs.includes(os));
      if (outside !== undefined) {
        return failure(osMessage(file, shown(outside), moduleName), 1);
      }
    }

    const field = disallowedField(record, merge);
    if (field !== undefined) {
      return failure(canNotUseMessage(file, field, merge), 1);
    }

    if (file.endsWith("/")) {
      return failure(trailingSlashMessage(file), 1);
    }

    if (merge === "dconf" && Object.hasOwn(record, "keys") && !isKeyList(record.keys)) {
      return failure(keysMessage(file), 1);
    }

    parsedEntries.push({ file, merge });
  }

  const dirFiles = parsedEntries
    .filter((entry) => entry.merge === "dir")
    .map((entry) => entry.file);
  for (const entry of parsedEntries) {
    const dir = dirFiles.find((candidate) => entry.file.startsWith(`${candidate}/`));
    if (dir !== undefined) {
      return failure(insideDirMessage(entry.file, dir), 1);
    }
  }

  return { ok: true, value: parsed as unknown as ConfigV2 };
}
