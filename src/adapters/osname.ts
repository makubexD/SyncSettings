/**
 * The pretty OS name `mksync status` shows, read as `front_status` and
 * `Get-OsName` read it: `SYNC_OS_RELEASE`'s `PRETTY_NAME` on Linux, `sw_vers`
 * on macOS, `SYNC_OS_NAME` or the Windows caption on Windows. `unknown` when
 * nothing can be read. `readOsId` answers the same file's `ID`, which `setup`
 * uses to tell Ubuntu apart.
 */

import { readFileSync } from "node:fs";
import type { Os } from "../core/config/types.ts";
import { decode, runSync } from "./process.ts";

const UNKNOWN = "unknown";

/** The file the release values are read from, unless `SYNC_OS_RELEASE` names one. */
const DEFAULT_OS_RELEASE = "/etc/os-release";

const NAME_KEY = "PRETTY_NAME=";

const ID_KEY = "ID=";

/** The caption PowerShell prints on Windows. */
const CAPTION_COMMAND = "(Get-CimInstance Win32_OperatingSystem).Caption";

/** The quote pair `front_os_release_value` strips when it wraps the value. */
function stripQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * One os-release value: the last matching line wins, a trailing carriage
 * return and one wrapping quote pair come off, and an empty value is
 * `unknown`, as `front_os_release_value` reads it.
 */
function releaseValue(text: string, key: string): string {
  let value = "";
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith(key)) {
      value = line.slice(key.length);
    }
  }
  value = stripQuotes(value);
  return value === "" ? UNKNOWN : value;
}

/**
 * A key's value from the file `SYNC_OS_RELEASE` names, or the default
 * os-release. A relative name is resolved from the working folder, as a plain
 * file read is.
 */
function releaseFileValue(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const configured = env.SYNC_OS_RELEASE;
  const file =
    configured === undefined || configured === ""
      ? DEFAULT_OS_RELEASE
      : configured;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return UNKNOWN;
  }
  return releaseValue(text, key);
}

function linuxName(env: Readonly<Record<string, string | undefined>>): string {
  return releaseFileValue(env, NAME_KEY);
}

/**
 * One command's trimmed stdout, or `undefined` when it cannot start or exits
 * non-zero (the bash `… 2>/dev/null || printf 'unknown'`).
 */
function commandLine(cmd: readonly string[]): string | undefined {
  const result = runSync([...cmd], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.notStarted === true || result.code !== 0) {
    return undefined;
  }
  return decode(result.stdout).trim();
}

function macosName(): string {
  const version = commandLine(["sw_vers", "-productVersion"]);
  return version === undefined ? UNKNOWN : version;
}

function windowsName(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const configured = env.SYNC_OS_NAME;
  if (configured !== undefined && configured !== "") {
    return configured;
  }
  const caption = commandLine([
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    CAPTION_COMMAND,
  ]);
  return caption === undefined || caption === "" ? UNKNOWN : caption;
}

/** Contract "Front door": the OS name in the status header. */
export function readOsName(
  os: Os,
  env: Readonly<Record<string, string | undefined>>,
): string {
  switch (os) {
    case "linux":
      return linuxName(env);
    case "macos":
      return macosName();
    case "windows":
      return windowsName(env);
  }
}

/**
 * The os-release `ID`, as `front_os_release_value ID` reads it: `setup` asks
 * whether this is `ubuntu`. Like the bash helper it reads the file whatever
 * the OS is, so a missing file is `unknown`.
 */
export function readOsId(
  env: Readonly<Record<string, string | undefined>>,
): string {
  return releaseFileValue(env, ID_KEY);
}
