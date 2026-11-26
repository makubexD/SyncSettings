/**
 * Contract "Sanitize and hydrate", "Where values come from": the environment a
 * rule's `defaultEnv` is read from. `HOME` is the program's home folder on
 * every OS (`$HOME` on Linux and macOS, `%USERPROFILE%` on Windows, where
 * `HOME` is usually unset); any other name is read as it is. An empty `home`
 * leaves the environment unchanged.
 */
export function valueEnv(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): Readonly<Record<string, string | undefined>> {
  return home === "" ? env : { ...env, HOME: home };
}
