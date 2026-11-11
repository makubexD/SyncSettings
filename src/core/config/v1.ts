import type { ConfigError, ConfigV1, Result } from "./types.ts";

const CONFIG_FILE = "sync-config.json";

const OS_NAMES: readonly string[] = ["windows", "linux", "macos"];

const PLATFORM_NAMES: readonly string[] = ["common", ...OS_NAMES];

const DCONF_PATH_RE = /^(\/[A-Za-z0-9._-]+)+\/$/;

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const DOTDOT = "..";

const PATH_SEPARATOR_RE = /[\\/]/;

const INVALID_JSON_MESSAGE = `ERROR: ${CONFIG_FILE}: invalid JSON.`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function repoPathOf(entry: unknown): string {
  if (isRecord(entry) && typeof entry.repoPath === "string") {
    return entry.repoPath;
  }
  return "";
}

function hasDotDotSegment(path: string): boolean {
  return path.split(PATH_SEPARATOR_RE).includes(DOTDOT);
}

function isSafeRepoPath(path: string): boolean {
  return path.startsWith("dotfiles/") && !hasDotDotSegment(path);
}

function isSafeLocalPath(path: string): boolean {
  return (path.startsWith("~/") || path.startsWith("~\\")) && !hasDotDotSegment(path);
}

function isValidPlatform(platform: unknown): boolean {
  if (typeof platform === "string") {
    return PLATFORM_NAMES.includes(platform);
  }
  if (!Array.isArray(platform) || platform.length === 0) {
    return false;
  }
  if (new Set(platform).size !== platform.length) {
    return false;
  }
  return platform.every((name) => typeof name === "string" && OS_NAMES.includes(name));
}

function isValidDconfPath(path: string): boolean {
  return DCONF_PATH_RE.test(path) && !hasDotDotSegment(path);
}

function platformMessage(repoPath: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${repoPath} needs "platform": "common", "windows", "linux", "macos" or a list of the last three.`;
}

function unsafePathMessage(repoPath: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${repoPath} has an unsafe path.`;
}

function unknownLocalPathsKeyMessage(repoPath: string, key: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${repoPath} has an unknown localPaths key ${key}.`;
}

function dconfPathMessage(repoPath: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${repoPath} needs "platform": "linux" and a dconf path like /org/gnome/shell/.`;
}

function defaultEnvMessage(repoPath: string): string {
  return `ERROR: ${CONFIG_FILE}: entry ${repoPath} has an invalid defaultEnv.`;
}

function failure(message: string): Result<ConfigV1, ConfigError> {
  return { ok: false, error: { message, code: 1 } };
}

// Platform is checked across every entry first, then the path rules, as the
// contract orders them ("right after the platform check").
export function parseV1(text: string): Result<ConfigV1, ConfigError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failure(INVALID_JSON_MESSAGE);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.files)) {
    return failure(INVALID_JSON_MESSAGE);
  }
  const entries: readonly unknown[] = parsed.files;

  for (const entry of entries) {
    if (!isRecord(entry) || !isValidPlatform(entry.platform)) {
      return failure(platformMessage(repoPathOf(entry)));
    }
  }

  for (const entry of entries) {
    if (!isRecord(entry) || entry.type === "dconf") {
      continue;
    }
    const repoPath = repoPathOf(entry);
    if (typeof entry.repoPath !== "string" || !isSafeRepoPath(entry.repoPath)) {
      return failure(unsafePathMessage(repoPath));
    }
    if (typeof entry.localPath !== "string" || !isSafeLocalPath(entry.localPath)) {
      return failure(unsafePathMessage(repoPath));
    }
  }

  for (const entry of entries) {
    if (!isRecord(entry) || !("localPaths" in entry)) {
      continue;
    }
    const repoPath = repoPathOf(entry);
    const localPaths = entry.localPaths;
    if (!isRecord(localPaths)) {
      return failure(unsafePathMessage(repoPath));
    }
    for (const [key, value] of Object.entries(localPaths)) {
      if (!OS_NAMES.includes(key)) {
        return failure(unknownLocalPathsKeyMessage(repoPath, key));
      }
      if (typeof value !== "string" || !isSafeLocalPath(value)) {
        return failure(unsafePathMessage(repoPath));
      }
    }
  }

  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "dconf") {
      continue;
    }
    const repoPath = repoPathOf(entry);
    if (typeof entry.repoPath !== "string" || !isSafeRepoPath(entry.repoPath)) {
      return failure(unsafePathMessage(repoPath));
    }
    if (entry.platform !== "linux" || typeof entry.path !== "string" || !isValidDconfPath(entry.path)) {
      return failure(dconfPathMessage(repoPath));
    }
  }

  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }
    const rules = entry.sanitizeRules;
    if (!Array.isArray(rules)) {
      continue;
    }
    for (const rule of rules) {
      if (!isRecord(rule) || rule.defaultEnv === undefined || rule.defaultEnv === null) {
        continue;
      }
      if (typeof rule.defaultEnv !== "string" || !ENV_NAME_RE.test(rule.defaultEnv)) {
        return failure(defaultEnvMessage(repoPathOf(entry)));
      }
    }
  }

  return { ok: true, value: parsed as unknown as ConfigV1 };
}

// --only values are runtime input, so their path rule is validated apart from
// the config. Only a repo path with a .. segment is refused; local paths fold
// their segments (contract, "Picking files").
export function validateOnlyPath(path: string): Result<string, ConfigError> {
  if (path.startsWith("dotfiles/") && hasDotDotSegment(path)) {
    return {
      ok: false,
      error: { message: `ERROR: ${path} is not synced on this machine.`, code: 1 },
    };
  }
  return { ok: true, value: path };
}
