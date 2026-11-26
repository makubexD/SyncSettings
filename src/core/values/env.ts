import type { Os } from "../config/types.ts";

/**
 * Contract "Sanitize and hydrate", "Where values come from": the environment a
 * rule's `defaultEnv` is read from. `HOME` is the program's home folder on
 * every OS: `$HOME` on Linux and macOS, `%USERPROFILE%` with forward slashes
 * on Windows (`C:/Users/u`), the form Git Bash and Claude Code's commands
 * read; any other name is read as it is. An empty `home` leaves the
 * environment unchanged.
 */
export function valueEnv(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  os: Os,
): Readonly<Record<string, string | undefined>> {
  if (home === "") {
    return env;
  }
  return { ...env, HOME: os === "windows" ? home.replaceAll("\\", "/") : home };
}
