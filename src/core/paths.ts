import type { Os } from "./config/types.ts";

/** The separator this OS uses in a local path. */
export function separatorFor(os: Os): "/" | "\\" {
  return os === "windows" ? "\\" : "/";
}

/** Join `tail` to `base`, keeping a single separator between them. */
export function joinHome(base: string, tail: string, os: Os): string {
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
