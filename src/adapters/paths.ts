import type { Os } from "../core/config/types.ts";

/** The separator this OS uses in a local path. */
export function separatorFor(os: Os): "/" | "\\" {
  return os === "windows" ? "\\" : "/";
}

/**
 * The user's home folder (contract "`localPath`"): `HOME` on Linux and macOS,
 * `USERPROFILE` on Windows. Absent when the variable is unset or empty.
 */
export function homeFolder(
  os: Os,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const value = os === "windows" ? env.USERPROFILE : env.HOME;
  return value === undefined || value === "" ? undefined : value;
}

function joinHome(base: string, tail: string, os: Os): string {
  if (base === "") {
    return tail;
  }
  if (tail === "") {
    return base;
  }
  const separator = separatorFor(os);
  return base.endsWith(separator) ? `${base}${tail}` : `${base}${separator}${tail}`;
}

/**
 * Expand a local path: `~/` becomes the home folder and, on Windows, every `/`
 * becomes `\` (contract "`localPath`"). `~\` is the Windows-only form.
 */
export function expandHome(raw: string, os: Os, home: string): string {
  if (raw === "~") {
    return home;
  }
  const windowsTilde = os === "windows" && raw.startsWith("~\\");
  if (raw.startsWith("~/") || windowsTilde) {
    const tail = raw.slice(2);
    return joinHome(home, os === "windows" ? tail.replaceAll("/", "\\") : tail, os);
  }
  return os === "windows" ? raw.replaceAll("/", "\\") : raw;
}

/**
 * The folder holding the sync point (contract "Sync point"), without a trailing
 * separator: `${XDG_STATE_HOME:-$HOME/.local/state}/sync-settings` on Linux and
 * macOS, `%LOCALAPPDATA%\SyncSettings` on Windows.
 */
export function stateFolder(
  os: Os,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (os === "windows") {
    const localAppData = env.LOCALAPPDATA;
    const base =
      localAppData !== undefined && localAppData !== ""
        ? localAppData
        : joinHome(home, "AppData\\Local", os);
    return joinHome(base, "SyncSettings", os);
  }
  const stateHome = env.XDG_STATE_HOME;
  const base =
    stateHome !== undefined && stateHome !== ""
      ? stateHome
      : joinHome(home, ".local/state", os);
  return joinHome(base, "sync-settings", os);
}
