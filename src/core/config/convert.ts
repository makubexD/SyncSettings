import type {
  ConfigError,
  ConfigV1,
  ConfigV1Entry,
  ConfigV2,
  ConfigV2Entry,
  MergeType,
  Os,
  Platform,
  Result,
  SanitizeRule,
} from "./types.ts";

const MODULE_NAME = "unsorted";

const MODULE_DESCRIPTION = "Entries converted from v1, not sorted yet.";

const BASE_ROOT = "dotfiles/common/";

const ALL_OS: readonly Os[] = ["windows", "linux", "macos"];

const ROOTS: readonly string[] = [
  BASE_ROOT,
  "dotfiles/windows/",
  "dotfiles/linux/",
  "dotfiles/macos/",
];

const BACKSLASH = "\\";

const SLASH = "/";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
    );
  }
  return false;
}

function rootOf(repoPath: string): string | undefined {
  return ROOTS.find((root) => repoPath.startsWith(root));
}

function rootForOs(os: Os): string {
  return `dotfiles/${os}/`;
}

// A one-item list is a single system, like the bare name; common and a list of
// two or more systems are not.
function singleSystem(platform: Platform): Os | undefined {
  if (typeof platform === "string") {
    return platform === "common" ? undefined : platform;
  }
  return platform.length === 1 ? platform[0] : undefined;
}

// Decision 3: the base root for common or a list of two or more systems, else
// the OS root of the single system.
function expectedRoot(platform: Platform): string {
  const system = singleSystem(platform);
  return system === undefined ? BASE_ROOT : rootForOs(system);
}

function platformOs(platform: Platform): readonly Os[] | undefined {
  if (typeof platform === "string") {
    return platform === "common" ? undefined : [platform];
  }
  return platform;
}

function rewritePath(path: string): string {
  return path.replaceAll(BACKSLASH, SLASH);
}

function rewriteLocalPaths(
  localPaths: Readonly<Partial<Record<Os, string>>>,
): Partial<Record<Os, string>> {
  const rewritten: Partial<Record<Os, string>> = {};
  for (const [os, path] of Object.entries(localPaths)) {
    if (typeof path === "string") {
      rewritten[os as Os] = rewritePath(path);
    }
  }
  return rewritten;
}

function mergeOf(type: ConfigV1Entry["type"]): MergeType {
  if (type === "dir") {
    return "dir";
  }
  if (type === "dconf") {
    return "dconf";
  }
  return "whole";
}

interface Converted {
  readonly file: string;
  readonly merge: MergeType;
  readonly localPath?: string;
  readonly localPaths?: Readonly<Partial<Record<Os, string>>>;
  readonly sanitize?: readonly SanitizeRule[];
  readonly dconfPath?: string;
  readonly keys?: readonly string[];
  readonly scanLinks?: true;
  readonly description?: string;
}

function convertEntry(entry: ConfigV1Entry, file: string): Converted {
  return {
    file,
    merge: mergeOf(entry.type),
    ...(entry.localPath !== undefined ? { localPath: rewritePath(entry.localPath) } : {}),
    ...(entry.localPaths !== undefined
      ? { localPaths: rewriteLocalPaths(entry.localPaths) }
      : {}),
    ...(entry.sanitizeRules !== undefined ? { sanitize: [...entry.sanitizeRules] } : {}),
    ...(entry.path !== undefined ? { dconfPath: entry.path } : {}),
    ...(entry.keys !== undefined ? { keys: [...entry.keys] } : {}),
    ...(entry.detectLinkedPaths === true ? { scanLinks: true as const } : {}),
    ...(entry.description !== undefined ? { description: entry.description } : {}),
  };
}

interface Item {
  readonly converted: Converted;
  readonly system: Os | undefined;
  readonly os: readonly Os[] | undefined;
}

// Everything except the layer root and platform, compared to decide merging.
function comparable(entry: Converted): readonly unknown[] {
  return [
    entry.file,
    entry.merge,
    entry.localPath,
    entry.localPaths,
    entry.sanitize,
    entry.dconfPath,
    entry.keys,
    entry.scanLinks,
    entry.description,
  ];
}

interface Group {
  readonly converted: Converted;
  readonly systems: Os[];
  readonly fixedOs: readonly Os[] | undefined;
}

function osOf(group: Group): readonly Os[] | undefined {
  if (group.systems.length === 0) {
    return group.fixedOs;
  }
  const coversEveryOs = ALL_OS.every((os) => group.systems.includes(os));
  return coversEveryOs ? undefined : group.systems;
}

// Key order is the design's "An entry" list.
function toV2Entry(group: Group): ConfigV2Entry {
  const entry = group.converted;
  const os = osOf(group);
  return {
    file: entry.file,
    module: MODULE_NAME,
    merge: entry.merge,
    ...(entry.localPath !== undefined ? { localPath: entry.localPath } : {}),
    ...(entry.localPaths !== undefined ? { localPaths: entry.localPaths } : {}),
    ...(os !== undefined ? { os } : {}),
    ...(entry.sanitize !== undefined ? { sanitize: entry.sanitize } : {}),
    ...(entry.dconfPath !== undefined ? { dconfPath: entry.dconfPath } : {}),
    ...(entry.keys !== undefined ? { keys: entry.keys } : {}),
    ...(entry.scanLinks !== undefined ? { scanLinks: entry.scanLinks } : {}),
    ...(entry.description !== undefined ? { description: entry.description } : {}),
  };
}

function noRootMessage(repoPath: string): string {
  return `ERROR: ${repoPath}: no v2 layer root matches this path`;
}

export function convertV1(config: ConfigV1): Result<ConfigV2, ConfigError> {
  const items: Item[] = [];
  for (const entry of config.files) {
    const root = rootOf(entry.repoPath);
    if (root === undefined || root !== expectedRoot(entry.platform)) {
      return { ok: false, error: { message: noRootMessage(entry.repoPath), code: 1 } };
    }
    items.push({
      converted: convertEntry(entry, entry.repoPath.slice(root.length)),
      system: singleSystem(entry.platform),
      os: platformOs(entry.platform),
    });
  }

  const groups: Group[] = [];
  for (const item of items) {
    if (item.system !== undefined) {
      const match = groups.find(
        (group) =>
          group.systems.length > 0 &&
          deepEqual(comparable(group.converted), comparable(item.converted)),
      );
      if (match !== undefined) {
        if (!match.systems.includes(item.system)) {
          match.systems.push(item.system);
        }
        continue;
      }
      groups.push({ converted: item.converted, systems: [item.system], fixedOs: undefined });
    } else {
      groups.push({ converted: item.converted, systems: [], fixedOs: item.os });
    }
  }

  const value: ConfigV2 = {
    schemaVersion: 2,
    ...(config.excludePatterns !== undefined
      ? { excludePatterns: config.excludePatterns }
      : {}),
    modules: { [MODULE_NAME]: { description: MODULE_DESCRIPTION } },
    entries: groups.map(toV2Entry),
  };
  return { ok: true, value };
}
