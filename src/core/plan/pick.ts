import type { ConfigV2Entry, Os } from "../config/types.ts";
import type { SelectScope, SelectedEntry } from "../layers/select.ts";
import { machineScope } from "../machine/scope.ts";
import { expandHome, separatorFor } from "../paths.ts";
import type { RunPlan, Snapshot } from "./types.ts";

export { separatorFor };

export type OnlyOutcome =
  | { readonly ok: true; readonly paths: readonly string[] }
  | { readonly ok: false; readonly plan: RunPlan };

/**
 * The layer scope of a snapshot: its OS, the profile and machine it runs for,
 * and, with a profile or a record, the modules the machine keeps on for this
 * OS. `machineScope` treats a missing profile as every module.
 */
export function scopeFor(snapshot: Snapshot): SelectScope {
  return {
    os: snapshot.os,
    ...(snapshot.profile !== undefined ? { profile: snapshot.profile } : {}),
    ...(snapshot.machine !== undefined ? { machine: snapshot.machine } : {}),
    ...(snapshot.profile !== undefined || snapshot.record !== undefined
      ? {
          modules: machineScope(
            snapshot.config,
            snapshot.profile,
            snapshot.record,
            snapshot.os,
          ).on,
        }
      : {}),
  };
}

export function otherSeparator(separator: "/" | "\\"): string {
  return separator === "/" ? "\\" : "/";
}

export function joinPath(
  base: string,
  tail: string,
  separator: "/" | "\\",
): string {
  if (base === "") {
    return tail;
  }
  if (tail === "") {
    return base;
  }
  return base.endsWith(separator)
    ? `${base}${tail}`
    : `${base}${separator}${tail}`;
}

/** The entry's local path on this system, `localPaths` first (contract "`localPath`"). */
export function resolvedLocal(
  entry: ConfigV2Entry,
  os: Os,
  home: string,
): string {
  const raw = entry.localPaths?.[os] ?? entry.localPath ?? "";
  return expandHome(raw, os, home);
}

/** Whether the entry's values are JSON string bodies: `merge: "json"`, or a
 * file the extension marks as JSON. */
export function isJsonEntry(entry: ConfigV2Entry): boolean {
  return entry.merge === "json" || entry.file.endsWith(".json");
}

export function isAbsolutePath(path: string, separator: "/" | "\\"): boolean {
  if (separator === "/") {
    return path.startsWith("/");
  }
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\");
}

/** `normalize_path` in `scripts/linux/sync.sh`, lexically and without links. */
export function normalizePath(path: string, separator: "/" | "\\"): string {
  const unified = path.replaceAll(otherSeparator(separator), separator);
  let prefix = "";
  let rest = unified;
  if (separator === "\\" && /^[A-Za-z]:/.test(unified)) {
    prefix = `${unified.slice(0, 2)}${separator}`;
    rest = unified.slice(2);
  } else if (unified.startsWith(separator)) {
    prefix = separator;
    rest = unified.slice(1);
  }
  const parts: string[] = [];
  for (const part of rest.split(separator)) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `${prefix}${parts.join(separator)}`;
}

export function absoluteLocal(raw: string, snapshot: Snapshot): string {
  const separator = separatorFor(snapshot.os);
  let path = expandHome(raw, snapshot.os, snapshot.home);
  if (!isAbsolutePath(path, separator)) {
    path = joinPath(snapshot.cwd, path, separator);
  }
  return normalizePath(path, separator);
}

/** The entry's repo path: the layer that holds it, else the write root. */
export function primaryRepoPath(selected: SelectedEntry): string {
  return (
    selected.source?.repoPath ?? `${selected.writeRoot}${selected.entry.file}`
  );
}

export function onlySelected(
  repoPath: string,
  only: readonly string[],
): boolean {
  if (only.length === 0) {
    return true;
  }
  return only.some(
    (picked) =>
      repoPath === picked ||
      repoPath.startsWith(`${picked}/`) ||
      repoPath.startsWith(`${picked}.linked/`),
  );
}

export function entrySelected(
  selected: SelectedEntry,
  only: readonly string[],
): boolean {
  if (only.length === 0) {
    return true;
  }
  const repoPath = primaryRepoPath(selected);
  if (onlySelected(repoPath, only)) {
    return true;
  }
  return only.some(
    (picked) =>
      picked.startsWith(`${repoPath}/`) ||
      picked.startsWith(`${repoPath}.linked/`),
  );
}

export function errorPlan(message: string, code: number): RunPlan {
  return {
    steps: [],
    finish: [],
    lines: [message],
    summary: { kind: "none" },
    code,
  };
}

export function onlyFailure(argument: string): RunPlan {
  return errorPlan(`ERROR: ${argument} is not synced on this machine.`, 1);
}

/** Contract "Picking files": turn every `--only` path into the repo path it names. */
export function resolveOnly(
  snapshot: Snapshot,
  selected: readonly SelectedEntry[],
): OnlyOutcome {
  const paths: string[] = [];
  for (const argument of snapshot.only) {
    let path = argument;
    while (path.endsWith("/") && path !== "/") {
      path = path.slice(0, -1);
    }

    if (path.startsWith("dotfiles/")) {
      if (`/${path}/`.includes("/../") || path.includes(".linked/")) {
        return { ok: false, plan: onlyFailure(argument) };
      }
      const found = selected.some((entry) => {
        const repoPath = primaryRepoPath(entry);
        return (
          path === repoPath ||
          (entry.entry.merge === "dir" && path.startsWith(`${repoPath}/`))
        );
      });
      if (!found) {
        return { ok: false, plan: onlyFailure(argument) };
      }
      paths.push(path);
      continue;
    }

    const absolute = absoluteLocal(path, snapshot);
    const separator = separatorFor(snapshot.os);
    let repoPath: string | undefined;
    for (const entry of selected) {
      if (entry.entry.merge === "dconf") {
        continue;
      }
      const local = normalizePath(
        resolvedLocal(entry.entry, snapshot.os, snapshot.home),
        separator,
      );
      if (entry.entry.merge !== "dir" && absolute === local) {
        repoPath = primaryRepoPath(entry);
        break;
      }
      if (
        entry.entry.merge === "dir" &&
        absolute.startsWith(`${local}${separator}`)
      ) {
        const rest = absolute
          .slice(local.length + 1)
          .replaceAll(separator, "/");
        repoPath = `${primaryRepoPath(entry)}/${rest}`;
        break;
      }
    }
    if (repoPath === undefined) {
      return { ok: false, plan: onlyFailure(argument) };
    }
    paths.push(repoPath);
  }
  return { ok: true, paths };
}

export function regexEscape(character: string): string {
  return /[.*+?^${}()|[\]\\]/.test(character) ? `\\${character}` : character;
}

/** A bash-style glob: `*`, `?` and a bracket class. */
export function globSource(pattern: string): string {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const character = pattern[i];
    if (character === undefined) {
      break;
    }
    if (character === "*") {
      source += ".*";
      continue;
    }
    if (character === "?") {
      source += ".";
      continue;
    }
    if (character === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) {
        source += "\\[";
        continue;
      }
      let body = pattern.slice(i + 1, end);
      let negated = false;
      if (body.startsWith("!") || body.startsWith("^")) {
        negated = true;
        body = body.slice(1);
      }
      source += `[${negated ? "^" : ""}${body.replaceAll("\\", "\\\\")}]`;
      i = end;
      continue;
    }
    if (character === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) {
        source += "\\\\";
      } else {
        source += regexEscape(next);
        i++;
      }
      continue;
    }
    source += regexEscape(character);
  }
  return source;
}

export function basename(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash === -1 ? path : path.slice(slash + 1);
}

interface CompiledExclude {
  readonly leaf: RegExp;
  readonly slashPath: RegExp;
  readonly backslashPath: RegExp;
}

function compilePattern(pattern: string, flags: string): CompiledExclude {
  return {
    leaf: new RegExp(`^${globSource(pattern)}$`, flags),
    slashPath: new RegExp(`^${globSource(`*/${pattern}`)}$`, flags),
    backslashPath: new RegExp(`^${globSource(`*\\${pattern}`)}$`, flags),
  };
}

/**
 * Contract "Exclude patterns": the file name, or the end of the path. The
 * patterns are compiled once per run, then matched against every file.
 */
export function compileExcludes(
  patterns: readonly string[],
  os: Os,
): (path: string) => boolean {
  const flags = os === "windows" ? "i" : "";
  const compiled = patterns
    .filter((pattern) => pattern !== "")
    .map((pattern) => compilePattern(pattern, flags));
  if (compiled.length === 0) {
    return () => false;
  }
  return (path: string): boolean => {
    const leaf = basename(path);
    return compiled.some(
      (pattern) =>
        pattern.leaf.test(leaf) ||
        pattern.slashPath.test(path) ||
        pattern.backslashPath.test(path),
    );
  };
}
