/**
 * The path rules the config and the dconf adapter share: a `..` segment is
 * never allowed, and a dconf folder is `/` plus one or more `[A-Za-z0-9._-]+/`
 * parts, so nothing dumps the whole database or climbs out of its folder.
 */

const DCONF_PATH_RE = /^(\/[A-Za-z0-9._-]+)+\/$/;

const DOTDOT = "..";

const PATH_SEPARATOR_RE = /[\\/]/;

/** Whether `path` has a `..` segment, under either separator. */
export function hasDotDotSegment(path: string): boolean {
  return path.split(PATH_SEPARATOR_RE).includes(DOTDOT);
}

/** Whether `path` names a dconf folder, such as `/org/gnome/shell/`. */
export function isValidDconfPath(path: string): boolean {
  return DCONF_PATH_RE.test(path) && !hasDotDotSegment(path);
}
