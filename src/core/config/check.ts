import { convertV1 } from "./convert.ts";
import type {
  ConfigV1,
  ConfigV1Entry,
  ConfigV2,
  ConfigV2Entry,
  ConfigV2Module,
  MergeType,
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

const RULE_FIELDS = ["prompt", "default", "defaultEnv", "escapeBackslashes"] as const;

interface Dconf {
  readonly path: string;
  readonly keys: readonly string[];
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

function ruleValues(
  rules: readonly SanitizeRule[],
  field: keyof SanitizeRule,
): readonly string[] {
  return rules.map((rule) => {
    const value = rule[field];
    return value === undefined ? "none" : String(value);
  });
}

function rewritten(path: string | undefined): string | undefined {
  return path === undefined ? undefined : path.replaceAll(BACKSLASH, SLASH);
}

function localPathOf(entry: ConfigV2Entry, os: Os): string | undefined {
  const localPath =
    entry.merge === "dconf" ? undefined : (entry.localPaths?.[os] ?? entry.localPath);
  return rewritten(localPath);
}

function dconfOf(entry: ConfigV2Entry): Dconf | undefined {
  return entry.dconfPath === undefined
    ? undefined
    : { path: entry.dconfPath, keys: entry.keys ?? [] };
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

// v2 may hand-set json or import on an entry v1 can only call a plain file.
function sameMerge(left: MergeType, right: MergeType): boolean {
  return left === right || (left === "whole" && (right === "json" || right === "import"));
}

function listed(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

function shown(value: unknown): string {
  if (value === undefined) {
    return "none";
  }
  return typeof value === "string" ? value : String(value);
}

function fieldLines(
  v1: ConfigV2Entry,
  v2: ConfigV2Entry,
  os: Os,
  label: string,
): string[] {
  const lines: string[] = [];
  const v1LocalPath = localPathOf(v1, os);
  const v2LocalPath = localPathOf(v2, os);
  if (v1LocalPath !== v2LocalPath) {
    lines.push(
      `${label}: local path on ${os} differs from v2 (${shown(v1LocalPath)} vs ${shown(v2LocalPath)})`,
    );
  }
  if (!sameMerge(v1.merge, v2.merge)) {
    lines.push(`${label}: merge on ${os} differs from v2 (${v1.merge} vs ${v2.merge})`);
  }

  const v1Rules = v1.sanitize ?? [];
  const v2Rules = v2.sanitize ?? [];
  const v1Placeholders = ruleValues(v1Rules, "placeholder");
  const v2Placeholders = ruleValues(v2Rules, "placeholder");
  if (!sameStrings(v1Placeholders, v2Placeholders)) {
    lines.push(
      `${label}: placeholders on ${os} differ from v2 (${listed(v1Placeholders)} vs ${listed(v2Placeholders)})`,
    );
  }
  for (const field of RULE_FIELDS) {
    const v1Values = ruleValues(v1Rules, field);
    const v2Values = ruleValues(v2Rules, field);
    if (!sameStrings(v1Values, v2Values)) {
      lines.push(
        `${label}: sanitize ${field} on ${os} differs from v2 (${listed(v1Values)} vs ${listed(v2Values)})`,
      );
    }
  }

  const v1ScanLinks = v1.scanLinks ?? false;
  const v2ScanLinks = v2.scanLinks ?? false;
  if (v1ScanLinks !== v2ScanLinks) {
    lines.push(
      `${label}: scanLinks on ${os} differs from v2 (${shown(v1ScanLinks)} vs ${shown(v2ScanLinks)})`,
    );
  }

  const v1LocalOnlyKeys = v1.localOnlyKeys ?? [];
  const v2LocalOnlyKeys = v2.localOnlyKeys ?? [];
  if (!sameStrings(v1LocalOnlyKeys, v2LocalOnlyKeys)) {
    lines.push(
      `${label}: localOnlyKeys on ${os} differ from v2 (${listed(v1LocalOnlyKeys)} vs ${listed(v2LocalOnlyKeys)})`,
    );
  }

  if (!sameDconf(dconfOf(v1), dconfOf(v2))) {
    lines.push(`${label}: dconf path or keys on ${os} differ from v2`);
  }
  return lines;
}

// v1 is the file the old engines still read, so its entries drive the report.
// v2 entries are compared through the converter, so v1's OS folders and
// per-OS local paths collapse exactly as the program collapses them.
export function checkV1V2(v1: ConfigV1, v2: ConfigV2): string[] {
  const lines: string[] = [];

  const v1Patterns = v1.excludePatterns ?? [];
  const v2Patterns = v2.excludePatterns ?? [];
  if (!sameStrings(v1Patterns, v2Patterns)) {
    lines.push(
      `excludePatterns differ from v2 (${listed(v1Patterns)} vs ${listed(v2Patterns)})`,
    );
  }

  const labels = new Map<string, string>();
  const v1Files = new Set<string>();
  const v1Keys = new Set<string>();
  for (const entry of v1.files) {
    const root = rootOf(entry.repoPath);
    if (root === undefined) {
      lines.push(`${entry.repoPath}: no v2 layer root matches this path`);
      continue;
    }
    const file = entry.repoPath.slice(root.length);
    v1Files.add(file);
    for (const os of orderedOs(platformOs(entry.platform))) {
      const key = keyOf(file, os);
      v1Keys.add(key);
      if (labels.has(key)) {
        lines.push(`${entry.repoPath}: duplicate entry for ${os}`);
      } else {
        labels.set(key, entry.repoPath);
      }
    }
  }

  const converted = convertV1({
    ...v1,
    files: v1.files.filter((entry: ConfigV1Entry) => rootOf(entry.repoPath) !== undefined),
  });
  if (!converted.ok) {
    lines.push(converted.error.message);
  } else {
    const v2ByKey = new Map<string, ConfigV2Entry>();
    for (const entry of v2.entries) {
      for (const os of v2Os(entry, v2.modules)) {
        const key = keyOf(entry.file, os);
        if (!v2ByKey.has(key)) {
          v2ByKey.set(key, entry);
        }
      }
    }

    const seenConverted = new Set<string>();
    for (const entry of converted.value.entries) {
      for (const os of orderedOs(v2Os(entry, converted.value.modules))) {
        const key = keyOf(entry.file, os);
        if (seenConverted.has(key)) {
          continue;
        }
        seenConverted.add(key);
        const label = labels.get(key) ?? entry.file;
        const other = v2ByKey.get(key);
        if (other === undefined) {
          lines.push(`${label}: no v2 entry for ${entry.file} on ${os}`);
          continue;
        }
        lines.push(...fieldLines(entry, other, os, label));
      }
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
