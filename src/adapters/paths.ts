import type { Os } from "../core/config/types.ts";
import { joinHome } from "../core/paths.ts";

export { expandHome, separatorFor } from "../core/paths.ts";

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
