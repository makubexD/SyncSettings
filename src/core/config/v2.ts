import type { ConfigError, ConfigV2, MergeType, Os, Result } from "./types.ts";

const CONFIG_FILE = "sync-config.v2.json";

const MERGE_TYPES: readonly MergeType[] = ["whole", "json", "import", "dconf", "dir"];

const OSES: readonly Os[] = ["windows", "linux", "macos"];

const LAYER_PLACEHOLDER = "{layer}";

const BACKSLASH = "\\";

const INVALID_JSON_MESSAGE = `ERROR: ${CONFIG_FILE}: invalid JSON.`;

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

function importNameMessage(file: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${file} needs {layer} in importName.`;
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

  if (!Object.hasOwn(parsed, "schemaVersion") || parsed.schemaVersion !== 2) {
    const version = Object.hasOwn(parsed, "schemaVersion")
      ? JSON.stringify(parsed.schemaVersion)
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

    const moduleName = record.module;
    if (typeof moduleName !== "string" || !Object.hasOwn(modules, moduleName)) {
      return failure(unknownModuleMessage(file, shown(moduleName)), 1);
    }

    const merge = record.merge;
    if (!isMergeType(merge)) {
      return failure(unknownMergeMessage(file, shown(merge)), 1);
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

    if (
      merge === "import" &&
      Object.hasOwn(record, "importName") &&
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
  }

  return { ok: true, value: parsed as unknown as ConfigV2 };
}
