/**
 * The pretty OS name `mksync status` shows, read as `front_status` and
 * `Get-OsName` read it: `SYNC_OS_RELEASE`'s `PRETTY_NAME` on Linux, `sw_vers`
 * on macOS, `SYNC_OS_NAME` or the Windows caption on Windows. `unknown` when
 * nothing can be read.
 */

import { readFileSync } from "node:fs";
import type { Os } from "../core/config/types.ts";

const UNKNOWN = "unknown";

/** The file `PRETTY_NAME` is read from, unless `SYNC_OS_RELEASE` names one. */
const DEFAULT_OS_RELEASE = "/etc/os-release";

const RELEASE_KEY = "PRETTY_NAME=";

/** The caption PowerShell prints on Windows. */
const CAPTION_COMMAND = "(Get-CimInstance Win32_OperatingSystem).Caption";

/** The quote pair `front_os_release_value` strips when it wraps the value. */
function stripQuotes(value: string): string {
  if (value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1);
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * `PRETTY_NAME`'s value from an os-release text: the last matching line wins,
 * a trailing carriage return and one wrapping quote pair come off, and an
 * empty value is `unknown`, as `front_os_release_value` reads it.
 */
function releaseValue(text: string): string {
  let value = "";
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith(RELEASE_KEY)) {
      value = line.slice(RELEASE_KEY.length);
    }
  }
  value = stripQuotes(value);
  return value === "" ? UNKNOWN : value;
}

function linuxName(
  env: Readonly<Record<string, string | undefined>>,
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
  return releaseValue(text);
}

/**
 * One command's trimmed stdout, or `undefined` when it cannot start or exits
 * non-zero (the bash `… 2>/dev/null || printf 'unknown'`).
 */
function commandLine(cmd: readonly string[]): string | undefined {
  try {
    const result = Bun.spawnSync({
      cmd: [...cmd],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) {
      return undefined;
    }
    return new TextDecoder().decode(result.stdout).trim();
  } catch {
    // A missing binary is "cannot tell".
    return undefined;
  }
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
