import type {
  ConfigV1,
  ConfigV1Entry,
  ConfigV2,
  ConfigV2Entry,
  ConfigV2Module,
  Os,
  Platform,
  SanitizeRule,
} from "./types.ts";

const OSES: readonly Os[] = ["windows", "linux", "macos"];

const ALL_OS: readonly Os[] = OSES;

const ROOTS: readonly string[] = [
  "dotfiles/common/",
  "dotfiles/windows/",
  "dotfiles/linux/",
  "dotfiles/macos/",
];

const BACKSLASH = "\\";

const SLASH = "/";

const KEY_SEPARATOR = "\u0000";

interface Dconf {
  readonly path: string;
  readonly keys: readonly string[];
}

interface Snapshot {
  readonly localPath: string | undefined;
  readonly placeholders: readonly string[];
  readonly dconf: Dconf | undefined;
}

function rootOf(repoPath: string): string | undefined {
  return ROOTS.find((root) => repoPath.startsWith(root));
}

function keyOf(file: string, os: Os): string {
  return `${file}${KEY_SEPARATOR}${os}`;
}

function orderedOs(os: readonly Os[]): readonly Os[] {
  return OSES.filter((name) => os.includes(name));
}

function platformOs(platform: Platform): readonly Os[] {
  return typeof platform === "string" ? (platform === "common" ? ALL_OS : [platform]) : platform;
}

function v2Os(entry: ConfigV2Entry, modules: ConfigV2["modules"]): readonly Os[] {
  if (entry.os !== undefined) {
    return entry.os;
  }
  const module: ConfigV2Module | undefined = modules[entry.module];
  return module?.os ?? ALL_OS;
}

function placeholdersOf(rules: readonly SanitizeRule[] | undefined): readonly string[] {
  if (rules === undefined) {
    return [];
  }
  return [...new Set(rules.map((rule) => rule.placeholder))].sort();
}

function rewritten(path: string | undefined): string | undefined {
  return path === undefined ? undefined : path.replaceAll(BACKSLASH, SLASH);
}

function v1Snapshot(entry: ConfigV1Entry, os: Os): Snapshot {
  const localPath = entry.type === "dconf" ? undefined : (entry.localPaths?.[os] ?? entry.localPath);
  return {
    localPath: rewritten(localPath),
    placeholders: placeholdersOf(entry.sanitizeRules),
    dconf: entry.path === undefined ? undefined : { path: entry.path, keys: entry.keys ?? [] },
  };
}

function v2Snapshot(entry: ConfigV2Entry, os: Os): Snapshot {
  const localPath = entry.merge === "dconf" ? undefined : (entry.localPaths?.[os] ?? entry.localPath);
  return {
    localPath: rewritten(localPath),
    placeholders: placeholdersOf(entry.sanitize),
    dconf:
      entry.dconfPath === undefined
        ? undefined
        : { path: entry.dconfPath, keys: entry.keys ?? [] },
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameDconf(left: Dconf | undefined, right: Dconf | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return left.path === right.path && sameStrings(left.keys, right.keys);
}

function shown(value: string | undefined): string {
  return value === undefined ? "none" : value;
}

function listed(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

function forwardLines(
  entry: ConfigV1Entry,
  os: Os,
  other: ConfigV2Entry,
): string[] {
  const v1 = v1Snapshot(entry, os);
  const v2 = v2Snapshot(other, os);
  const lines: string[] = [];
  if (v1.localPath !== v2.localPath) {
    lines.push(
      `${entry.repoPath}: local path on ${os} differs from v2 (${shown(v1.localPath)} vs ${shown(v2.localPath)})`,
    );
  }
  if (!sameStrings(v1.placeholders, v2.placeholders)) {
    lines.push(
      `${entry.repoPath}: placeholders on ${os} differ from v2 (${listed(v1.placeholders)} vs ${listed(v2.placeholders)})`,
    );
  }
  if (!sameDconf(v1.dconf, v2.dconf)) {
    lines.push(`${entry.repoPath}: dconf path or keys on ${os} differ from v2`);
  }
  return lines;
}

// v1 is the file the old engines still read, so its entries drive the report.
// A v2 entry is reported only when it adds an OS for a file v1 already covers.
export function checkV1V2(v1: ConfigV1, v2: ConfigV2): string[] {
  const lines: string[] = [];
  const v2ByKey = new Map<string, ConfigV2Entry>();
  for (const entry of v2.entries) {
    for (const os of v2Os(entry, v2.modules)) {
      const key = keyOf(entry.file, os);
      if (!v2ByKey.has(key)) {
        v2ByKey.set(key, entry);
      }
    }
  }

  const v1Files = new Set<string>();
  const v1Keys = new Set<string>();
  for (const entry of v1.files) {
    const root = rootOf(entry.repoPath);
    if (root === undefined) {
      continue;
    }
    const file = entry.repoPath.slice(root.length);
    v1Files.add(file);
    for (const os of platformOs(entry.platform)) {
      v1Keys.add(keyOf(file, os));
    }
  }

  const seenV1 = new Set<string>();
  for (const entry of v1.files) {
    const root = rootOf(entry.repoPath);
    if (root === undefined) {
      lines.push(`${entry.repoPath}: no v2 layer root matches this path`);
      continue;
    }
    const file = entry.repoPath.slice(root.length);
    for (const os of orderedOs(platformOs(entry.platform))) {
      const key = keyOf(file, os);
      if (seenV1.has(key)) {
        lines.push(`${entry.repoPath}: duplicate entry for ${os}`);
        continue;
      }
      seenV1.add(key);
      const other = v2ByKey.get(key);
      if (other === undefined) {
        lines.push(`${entry.repoPath}: no v2 entry for ${file} on ${os}`);
        continue;
      }
      lines.push(...forwardLines(entry, os, other));
    }
  }

  const seenV2 = new Set<string>();
  for (const entry of v2.entries) {
    for (const os of orderedOs(v2Os(entry, v2.modules))) {
      const key = keyOf(entry.file, os);
      if (seenV2.has(key)) {
        lines.push(`${entry.file}: duplicate entry for ${os}`);
        continue;
      }
      seenV2.add(key);
      if (!v1Files.has(entry.file)) {
        continue;
      }
      if (!v1Keys.has(key)) {
        lines.push(`${entry.file}: v2 covers ${os}, v1 does not`);
      }
    }
  }

  return lines;
}
