import { same } from "../compare.ts";
import type { ConfigV2, ConfigV2Entry, Os, SanitizeRule } from "../config/types.ts";
import { selectEntries } from "../layers/select.ts";
import type { SelectedEntry } from "../layers/select.ts";
import { formatLine } from "../status.ts";
import type { StatusWord } from "../status.ts";
import { resolveValues } from "../values/hydrate.ts";
import { sanitize } from "../values/sanitize.ts";
import type { Values } from "../values/sanitize.ts";
import type { Action, Plan, Snapshot } from "./types.ts";

const BASE_ROOT = "dotfiles/common/";

const ALL_OS: readonly Os[] = ["windows", "linux", "macos"];

const EXCLUDE_NOTE = "matches exclude pattern";

const ORPHAN_NOTE = "no entry in sync-config.json; git rm it or add an entry";

const DCONF_NOTE = "not supported yet";

const DASHES = "  --------------------------------------------------";

const EMPTY_FOLDER_NOTE = "local folder is empty; repo files kept";

interface State {
  readonly snapshot: Snapshot;
  readonly values: Values;
  readonly only: readonly string[];
  readonly actions: Action[];
  readonly lines: string[];
  changed: number;
  skipped: number;
  hits: number;
}

type OnlyOutcome =
  | { readonly ok: true; readonly paths: readonly string[] }
  | { readonly ok: false; readonly plan: Plan };

function separatorFor(os: Os): "/" | "\\" {
  return os === "windows" ? "\\" : "/";
}

function otherSeparator(separator: "/" | "\\"): string {
  return separator === "/" ? "\\" : "/";
}

function joinPath(base: string, tail: string, separator: "/" | "\\"): string {
  if (base === "") {
    return tail;
  }
  if (tail === "") {
    return base;
  }
  return base.endsWith(separator) ? `${base}${tail}` : `${base}${separator}${tail}`;
}

/** `~/` (or `~\`) becomes the home folder; elsewhere `\` becomes `/` on Windows. */
function expandHome(raw: string, os: Os, home: string): string {
  const separator = separatorFor(os);
  if (raw === "~") {
    return home;
  }
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    const tail = raw.slice(2).replaceAll(otherSeparator(separator), separator);
    return joinPath(home, tail, separator);
  }
  return raw.replaceAll(otherSeparator(separator), separator);
}

/** The entry's local path on this system, `localPaths` first (contract "`localPath`"). */
function resolvedLocal(entry: ConfigV2Entry, os: Os, home: string): string {
  const raw = entry.localPaths?.[os] ?? entry.localPath ?? "";
  return expandHome(raw, os, home);
}

function isAbsolutePath(path: string, separator: "/" | "\\"): boolean {
  if (separator === "/") {
    return path.startsWith("/");
  }
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\");
}

/** `normalize_path` in `scripts/linux/sync.sh`, lexically and without links. */
function normalizePath(path: string, separator: "/" | "\\"): string {
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

function absoluteLocal(raw: string, snapshot: Snapshot): string {
  const separator = separatorFor(snapshot.os);
  let path = raw;
  if (path === "~") {
    path = snapshot.home;
  } else if (path.startsWith("~/") || path.startsWith("~\\")) {
    path = joinPath(snapshot.home, path.slice(2), separator);
  }
  if (!isAbsolutePath(path, separator)) {
    path = joinPath(snapshot.cwd, path, separator);
  }
  return normalizePath(path, separator);
}

/** The repo path export writes this entry to (decision 3 when no layer holds it). */
function primaryRepoPath(selected: SelectedEntry): string {
  return (
    selected.source?.repoPath ?? `${selected.writeRoot}${selected.entry.file}`
  );
}

function onlySelected(repoPath: string, only: readonly string[]): boolean {
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

function entrySelected(selected: SelectedEntry, only: readonly string[]): boolean {
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

function onlyFailure(argument: string): Plan {
  return {
    actions: [],
    lines: [`ERROR: ${argument} is not synced on this machine.`],
    code: 1,
  };
}

/** Contract "Picking files": turn every `--only` path into the repo path it names. */
function resolveOnly(snapshot: Snapshot, selected: readonly SelectedEntry[]): OnlyOutcome {
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
        return path === repoPath || (entry.entry.merge === "dir" && path.startsWith(`${repoPath}/`));
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
      if (entry.entry.merge === "dir" && absolute.startsWith(`${local}${separator}`)) {
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

function regexEscape(character: string): string {
  return /[.*+?^${}()|[\]\\]/.test(character) ? `\\${character}` : character;
}

/** A bash-style glob: `*`, `?` and a bracket class. */
function globSource(pattern: string): string {
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

function globMatches(text: string, pattern: string, caseInsensitive: boolean): boolean {
  return new RegExp(`^${globSource(pattern)}$`, caseInsensitive ? "i" : "").test(text);
}

function basename(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Contract "Exclude patterns": the file name, or the end of the path. */
function isExcluded(snapshot: Snapshot, path: string): boolean {
  const patterns = snapshot.config.excludePatterns ?? [];
  if (patterns.length === 0) {
    return false;
  }
  const caseInsensitive = snapshot.os === "windows";
  const leaf = basename(path);
  return patterns.some((pattern) => {
    if (pattern === "") {
      return false;
    }
    return (
      globMatches(leaf, pattern, caseInsensitive) ||
      globMatches(path, `*/${pattern}`, caseInsensitive) ||
      globMatches(path, `*\\${pattern}`, caseInsensitive)
    );
  });
}

function compareOptions(snapshot: Snapshot, repoPath: string, sanitized: boolean) {
  return {
    os: snapshot.os,
    shared: repoPath.startsWith(BASE_ROOT),
    sanitized,
  };
}

function pushStatus(
  state: State,
  word: StatusWord,
  label: string,
  note?: string,
): void {
  state.lines.push(formatLine(word, label, note));
  state.hits++;
}

function mkdirParent(state: State, repoPath: string): void {
  const slash = repoPath.lastIndexOf("/");
  if (slash > 0) {
    state.actions.push({ kind: "mkdir", path: repoPath.slice(0, slash) });
  }
}

function planFile(state: State, selected: SelectedEntry): void {
  const entry = selected.entry;
  const repoPath = primaryRepoPath(selected);
  if (!onlySelected(repoPath, state.only)) {
    return;
  }

  const localPath = resolvedLocal(entry, state.snapshot.os, state.snapshot.home);
  if (isExcluded(state.snapshot, localPath)) {
    pushStatus(state, "SKIPPED", repoPath, EXCLUDE_NOTE);
    return;
  }

  const local = state.snapshot.localFiles.get(localPath);
  if (local === undefined || local.kind !== "file") {
    pushStatus(state, "SKIPPED", repoPath, `local file not found: ${localPath}`);
    state.skipped++;
    return;
  }

  const rules = entry.sanitize ?? [];
  const repo = state.snapshot.repoFiles.get(repoPath);

  if (rules.length > 0) {
    const sanitized = sanitize(local.bytes, rules, state.values, {
      json: entry.file.endsWith(".json"),
    });
    if (repo !== undefined) {
      if (same(repo, sanitized, compareOptions(state.snapshot, repoPath, true))) {
        pushStatus(state, "UNCHANGED", repoPath);
      } else {
        state.actions.push({ kind: "writeRepo", path: repoPath, bytes: sanitized });
        pushStatus(state, "MODIFIED", repoPath, "sanitized");
        state.changed++;
      }
    } else {
      mkdirParent(state, repoPath);
      state.actions.push({ kind: "writeRepo", path: repoPath, bytes: sanitized });
      state.actions.push({ kind: "chmod", path: repoPath, mode: local.mode });
      pushStatus(state, "ADDED", repoPath, "sanitized");
      state.changed++;
    }
    return;
  }

  if (repo === undefined) {
    mkdirParent(state, repoPath);
    state.actions.push({ kind: "writeRepo", path: repoPath, bytes: local.bytes });
    state.actions.push({ kind: "chmod", path: repoPath, mode: local.mode });
    pushStatus(state, "ADDED", repoPath);
    state.changed++;
    return;
  }

  if (same(repo, local.bytes, compareOptions(state.snapshot, repoPath, false))) {
    pushStatus(state, "UNCHANGED", repoPath);
    return;
  }

  state.actions.push({ kind: "writeRepo", path: repoPath, bytes: local.bytes });
  state.actions.push({ kind: "chmod", path: repoPath, mode: local.mode });
  pushStatus(state, "MODIFIED", repoPath);
  state.changed++;
}

function planDir(state: State, selected: SelectedEntry): void {
  const repoPath = primaryRepoPath(selected);
  const separator = separatorFor(state.snapshot.os);
  const localDir = resolvedLocal(
    selected.entry,
    state.snapshot.os,
    state.snapshot.home,
  );

  if (!state.snapshot.localDirs.has(localDir)) {
    pushStatus(state, "SKIPPED", `${repoPath}/`, `local folder not found: ${localDir}`);
    state.skipped++;
    return;
  }

  const localPrefix = `${localDir}${separator}`;
  const localPaths = [...state.snapshot.localFiles.keys()]
    .filter((path) => path.startsWith(localPrefix))
    .sort();
  let files = 0;

  for (const localPath of localPaths) {
    const local = state.snapshot.localFiles.get(localPath);
    if (local === undefined) {
      continue;
    }
    const relative = localPath.slice(localPrefix.length).replaceAll(separator, "/");
    const label = `${repoPath}/${relative}`;

    if (local.kind === "symlink") {
      pushStatus(state, "SKIPPED", label, "symlink");
      continue;
    }
    if (isExcluded(state.snapshot, localPath)) {
      pushStatus(state, "SKIPPED", label, EXCLUDE_NOTE);
      continue;
    }

    files++;
    if (!onlySelected(label, state.only)) {
      continue;
    }
    const repo = state.snapshot.repoFiles.get(label);
    if (repo === undefined) {
      mkdirParent(state, label);
      state.actions.push({ kind: "writeRepo", path: label, bytes: local.bytes });
      state.actions.push({ kind: "chmod", path: label, mode: local.mode });
      pushStatus(state, "ADDED", label);
      state.changed++;
    } else if (same(repo, local.bytes, compareOptions(state.snapshot, label, false))) {
      pushStatus(state, "UNCHANGED", label);
    } else {
      state.actions.push({ kind: "writeRepo", path: label, bytes: local.bytes });
      state.actions.push({ kind: "chmod", path: label, mode: local.mode });
      pushStatus(state, "MODIFIED", label);
      state.changed++;
    }
  }

  const repoPrefix = `${repoPath}/`;
  const repoNames = [...state.snapshot.repoFiles.keys()]
    .filter((path) => path.startsWith(repoPrefix))
    .sort();

  if (files === 0 && repoNames.length > 0) {
    pushStatus(state, "SKIPPED", `${repoPath}/`, EMPTY_FOLDER_NOTE);
    state.skipped++;
    return;
  }

  for (const repoName of repoNames) {
    const relative = repoName.slice(repoPrefix.length);
    const localPath = `${localDir}${separator}${relative.replaceAll("/", separator)}`;
    const local = state.snapshot.localFiles.get(localPath);
    if (
      local !== undefined &&
      local.kind === "file" &&
      !isExcluded(state.snapshot, localPath)
    ) {
      continue;
    }
    if (!onlySelected(repoName, state.only)) {
      continue;
    }
    state.actions.push({ kind: "removeRepo", path: repoName });
    pushStatus(state, "REMOVED", repoName, "no longer in source");
    state.changed++;
  }
}

function planDconf(state: State, selected: SelectedEntry): void {
  const repoPath = primaryRepoPath(selected);
  if (!onlySelected(repoPath, state.only)) {
    return;
  }
  pushStatus(state, "SKIPPED", repoPath, DCONF_NOTE);
  state.skipped++;
}

function rootsFor(config: ConfigV2, entry: ConfigV2Entry): readonly string[] {
  const os = entry.os ?? config.modules[entry.module]?.os ?? ALL_OS;
  return [BASE_ROOT, ...os.map((system) => `dotfiles/${system}/`)];
}

/** Contract "Orphan report": owned by an entry on any platform. */
function orphanReport(state: State): void {
  const exact = new Set<string>();
  const folders: string[] = [];
  const linked: string[] = [];

  for (const entry of state.snapshot.config.entries) {
    for (const root of rootsFor(state.snapshot.config, entry)) {
      const repoPath = `${root}${entry.file}`;
      if (entry.merge === "dir") {
        folders.push(`${repoPath}/`);
      } else {
        exact.add(repoPath);
      }
      if (entry.scanLinks === true) {
        linked.push(`${repoPath}.linked/`);
      }
    }
  }

  for (const path of [...state.snapshot.repoFiles.keys()].sort()) {
    const owned =
      exact.has(path) ||
      folders.some((prefix) => path.startsWith(prefix)) ||
      linked.some((prefix) => path.startsWith(prefix));
    if (!owned) {
      pushStatus(state, "ORPHAN", path, ORPHAN_NOTE);
    }
  }
}

function summaryLines(state: State): readonly string[] {
  const lines: string[] = [];
  if (state.only.length > 0 && state.hits === 0) {
    lines.push("  WARNING: --only matched no file.");
  }
  lines.push("");
  lines.push(DASHES);
  if (state.changed > 0) {
    lines.push("");
    lines.push(`  ${state.changed} file(s) copied to the repo.`);
    lines.push("");
    lines.push("  Review the changes, then run  mksync push");
  } else {
    lines.push("");
    lines.push("  Repo is up to date. No changes detected.");
    if (state.skipped > 0) {
      lines.push("");
      lines.push(
        `  Note: ${state.skipped} file(s) skipped because they do not exist locally.`,
      );
      lines.push(
        "  If this is a new machine, run  ./import.sh  first to apply the repo settings.",
      );
    }
  }
  lines.push("");
  lines.push(DASHES);
  lines.push("");
  return lines;
}

/**
 * The export plan: every status line, action and the exit code the contract
 * gives export, from a snapshot and nothing else.
 */
export function planExport(snapshot: Snapshot): Plan {
  const selected = selectEntries(
    snapshot.config,
    snapshot.os,
    new Set(snapshot.repoFiles.keys()),
  );
  if (!selected.ok) {
    return { actions: [], lines: [selected.error.message], code: selected.error.code };
  }

  const only = resolveOnly(snapshot, selected.value);
  if (!only.ok) {
    return only.plan;
  }

  const rules: SanitizeRule[] = [];
  for (const entry of selected.value) {
    if (!entrySelected(entry, only.paths)) {
      continue;
    }
    if (entry.entry.merge === "dir" || entry.entry.merge === "dconf") {
      continue;
    }
    const localPath = resolvedLocal(entry.entry, snapshot.os, snapshot.home);
    const local = snapshot.localFiles.get(localPath);
    if (local?.kind === "file") {
      rules.push(...(entry.entry.sanitize ?? []));
    }
  }
  const values = resolveValues(rules, snapshot.values, {}, snapshot.env);
  if (!values.ok) {
    return { actions: [], lines: [values.error.message], code: 1 };
  }

  const state: State = {
    snapshot,
    values: values.value,
    only: only.paths,
    actions: [],
    lines: [],
    changed: 0,
    skipped: 0,
    hits: 0,
  };

  for (const entry of selected.value) {
    if (!entrySelected(entry, only.paths)) {
      continue;
    }
    switch (entry.entry.merge) {
      case "dir":
        planDir(state, entry);
        break;
      case "dconf":
        planDconf(state, entry);
        break;
      default:
        planFile(state, entry);
        break;
    }
  }

  if (only.paths.length === 0) {
    orphanReport(state);
  }

  state.lines.push(...summaryLines(state));
  return { actions: state.actions, lines: state.lines, code: 0 };
}
